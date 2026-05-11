// src/main.js — Appwrite Function entry point
// Auth: credentials verified against Appwrite (server-side, no CORS restriction).
// Sessions: stateless HMAC tokens (8 h) — no external call per request.
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { createClient, bidToMid } from './weibo.js';
import {
  getCopywritingGroups, setCopywritingGroups,
  getAccounts, setAccounts,
} from './db.js';

const APPWRITE_ENDPOINT  = process.env.APPWRITE_ENDPOINT   ?? 'https://sgp.cloud.appwrite.io/v1';
const APPWRITE_PROJECT   = process.env.APPWRITE_PROJECT_ID ?? '69f221090023490a8740';
const SECRET             = process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex');
const TOKEN_TTL          = 8 * 60 * 60 * 1000; // 8 hours

// ── HMAC session token ───────────────────────────────────────────────────────
function issueToken() {
  const expiry  = Date.now() + TOKEN_TTL;
  const payload = `session:${expiry}`;
  const sig     = createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function isValidToken(token) {
  if (!token) return false;
  try {
    const decoded   = Buffer.from(token, 'base64url').toString('utf8');
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon < 0) return false;
    const payload   = decoded.slice(0, lastColon);
    const sig       = decoded.slice(lastColon + 1);
    const colonIdx  = payload.indexOf(':');
    if (colonIdx < 0) return false;
    const expiry    = parseInt(payload.slice(colonIdx + 1), 10);
    if (isNaN(expiry) || Date.now() > expiry) return false;
    const expected  = createHmac('sha256', SECRET).update(payload).digest('hex');
    if (sig.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Verify email/password via Appwrite (server-to-server, no CORS check) ─────
async function verifyAppwriteCredentials(email, password) {
  if (!email || !password) return { ok: false, error: '缺少邮箱或密码' };
  try {
    const r = await fetch(`${APPWRITE_ENDPOINT}/account/sessions/email`, {
      method: 'POST',
      headers: {
        'x-appwrite-project': APPWRITE_PROJECT,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    const isCredErr = (d.type ?? '').includes('invalid_credentials') || (d.message ?? '').toLowerCase().includes('invalid');
    return { ok: false, error: isCredErr ? '邮箱或密码错误' : (d.message ?? '登录失败') };
  } catch { return { ok: false, error: '登录失败，请重试' }; }
}

// ── Request helpers ─────────────────────────────────────────────────────────
function getBody(req) {
  if (req.bodyJson !== undefined && req.bodyJson !== null) return req.bodyJson;
  const raw = req.body ?? req.bodyRaw ?? '';
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function getQueryParams(req) {
  if (req.queryParams && typeof req.queryParams === 'object') return req.queryParams;
  const qs = req.query ?? req.queryString ?? '';
  if (!qs) return {};
  return Object.fromEntries(new URLSearchParams(qs));
}

function getAccountIdx(req, body) {
  return parseInt(req.headers?.['x-account'] ?? body?.account ?? '0', 10) || 0;
}

function resolveMid(val) {
  if (!val) return null;
  const s = String(val).trim();
  return /^\d+$/.test(s) ? s : bidToMid(s);
}

function randomItem(groups, groupName) {
  if (!groups?.length) return null;
  const pool = groupName
    ? (groups.find(g => g.name === groupName)?.items ?? [])
    : groups.flatMap(g => g.items ?? []);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function toOriginalWeibo(status, mid) {
  if (!status || typeof status !== 'object') return null;
  const mblogid = status.mblogid ?? null;
  const uid = status.user?.idstr ?? status.user?.id ?? null;
  const postId = status.idstr ?? status.id ?? mid;
  const canonicalUrl = (uid && mblogid) ? `https://weibo.com/${uid}/${mblogid}` : null;
  return {
    id: status.id ?? null,
    idstr: status.idstr ?? null,
    mblogid,
    text: status.text_raw ?? status.text ?? '',
    created_at: status.created_at ?? null,
    source: status.source ?? null,
    user: status.user ? {
      id: status.user.id ?? null,
      idstr: status.user.idstr ?? null,
      screen_name: status.user.screen_name ?? status.user.name ?? null,
      profile_image_url: status.user.profile_image_url ?? null,
    } : null,
    url: canonicalUrl ?? (postId ? `https://weibo.com/detail/${postId}` : null),
  };
}

async function enrichCommentResult(client, mid, result) {
  try {
    const original = await client.fetchStatusDetail({ mid });
    return { ...result, originalWeibo: toOriginalWeibo(original, mid) };
  } catch {
    return result;
  }
}

function maskCookie(cookie) {
  const s = String(cookie ?? '').trim();
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}...${s.slice(-6)}`;
}

function sanitizeAccountsForResponse(accounts) {
  return (accounts ?? []).map(a => ({
    name: String(a.name ?? '').trim(),
    hasCookie: !!String(a.cookie ?? '').trim(),
    cookieMasked: maskCookie(a.cookie),
  }));
}

// ── Validate Weibo API response ──────────────────────────────────────────────
function validateWeiboResponse(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: '错误' };
  const okValue = data.ok;
  if (okValue !== 1 && okValue !== true) return { ok: false, error: '错误' };
  return { ok: true, data };
}

// ── Wrapped handler (Weibo API with account resolution + random content) ───
async function runWrapped(req, res, fn) {
  const body = getBody(req);
  try {
    const accounts = await getAccounts();
    const idx      = getAccountIdx(req, body);
    const cookie   = accounts[Math.min(idx, accounts.length - 1)]?.cookie;
    if (!cookie) throw new Error(`Account ${idx} not found`);
    const client   = createClient(cookie);
    let resolvedBody = body;
    if (body?.useRandom && body?.randomField) {
      const groups = await getCopywritingGroups();
      const picked = randomItem(groups, body.randomGroup || null);
      if (picked) resolvedBody = { ...body, [body.randomField]: picked };
    }
    const data = await fn(client, resolvedBody, getQueryParams(req));
    const validated = validateWeiboResponse(data);
    if (!validated.ok) return res.json(validated);
    return res.json({ ok: true, data: validated.data });
  } catch (err) {
    return res.json({ ok: false, error: err.message }, 500);
  }
}

// ── Batch handlers ──────────────────────────────────────────────────────────
const batchHandlers = {
  '/api/post-tweet':         (c, b) => c.postTweet({ content: b.content, pid: b.pid, mid: b.mid, videoTitle: b.videoTitle, videoType: b.videoType }),
  '/api/delete-tweet':       (c, b) => c.deleteTweet({ mid: resolveMid(b.mid) }),
  '/api/quick-repost':       (c, b) => c.quickRepost({ mid: resolveMid(b.mid) }),
   '/api/repost-tweet':       (c, b) => c.repostTweet({ mid: resolveMid(b.mid), content: b.content, visible: b.visible, listId: b.listId }),
  '/api/comment-tweet':      (c, b) => c.commentTweet({ mid: resolveMid(b.mid), content: b.content }),
  '/api/reply-comment':      (c, b) => c.replyComment({ mid: resolveMid(b.mid), cid: b.cid, content: b.content }),
  '/api/delete-comment':     (c, b) => c.deleteComment({ cid: b.cid }),
  '/api/like-comment':       (c, b) => c.likeComment({ cid: b.cid, rid: b.rid }),
  '/api/follow-user':        (c, b) => c.followUser({ uid: b.uid }),
  '/api/unfollow-user':      (c, b) => c.unfollowUser({ uid: b.uid }),
  '/api/like-tweet':         (c, b) => c.likeTweet({ mid: resolveMid(b.mid) }),
  '/api/unlike-tweet':       (c, b) => c.unlikeTweet({ mid: resolveMid(b.mid) }),
  '/api/follow-super-topic': (c, b) => c.followSuperTopic({ topicId: b.topicId, name: b.name }),
  '/api/checkin-super-topic':(c, b) => c.checkinSuperTopic({ topicId: b.topicId }),
};

// ── Main entry point ────────────────────────────────────────────────────────
export default async ({ req, res, log, error }) => {
  const path    = req.path ?? '/';
  const method  = (req.method ?? 'GET').toUpperCase();
  const headers = req.headers ?? {};
  const token   = headers['x-auth-token'];
  const routeKey = `${method} ${path}`;

  // CORS preflight
  if (method === 'OPTIONS') return res.empty();

  // ── Public routes ─────────────────────────────────────────────────────
  if (path === '/api/login' && method === 'POST') {
    const { email, password } = getBody(req);
    const result = await verifyAppwriteCredentials(email, password);
    if (!result.ok) return res.json({ ok: false, error: result.error }, 401);
    return res.json({ ok: true, token: issueToken() });
  }

  if (path === '/api/logout' && method === 'POST') {
    return res.json({ ok: true });
  }

  if (path === '/api/me' && method === 'GET') {
    return res.json({ ok: true, authenticated: isValidToken(token) });
  }

  const isPublicRoute = routeKey === 'POST /api/login' || routeKey === 'POST /api/logout' || routeKey === 'GET /api/me';
  if (!isPublicRoute && !isValidToken(token)) {
    return res.json({ ok: false, error: '未授权，请先登录' }, 401);
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  if (path === '/api/accounts') {
    if (method === 'GET') {
      try {
        const accounts = await getAccounts();
        return res.json({ ok: true, count: accounts.length, accounts: sanitizeAccountsForResponse(accounts) });
      } catch (e) { return res.json({ ok: false, error: e.message }, 500); }
    }
    if (method === 'POST') {
      try {
        const { accounts } = getBody(req);
        if (!Array.isArray(accounts)) return res.json({ ok: false, error: 'accounts must be array' }, 400);
        const existing = await getAccounts();
        const clean = accounts
          .map((a, i) => {
            const name = String(a.name ?? '').trim();
            const incomingCookie = String(a.cookie ?? '').trim();
            const keepExisting = !!a.keepExisting;
            const cookie = incomingCookie || (keepExisting ? String(existing[i]?.cookie ?? '').trim() : '');
            return { cookie, name: name || `账号 ${i + 1}` };
          })
          .filter(a => a.cookie);
        await setAccounts(clean);
        return res.json({ ok: true, count: clean.length, accounts: sanitizeAccountsForResponse(clean) });
      } catch (e) { return res.json({ ok: false, error: e.message }, 500); }
    }
  }

  // ── Cookie validator ──────────────────────────────────────────────────
  if (path === '/api/validate-cookie' && method === 'POST') {
    const { cookie } = getBody(req);
    if (!cookie || typeof cookie !== 'string') return res.json({ ok: false, error: '缺少 cookie' }, 400);
    const cookieStr   = cookie.trim();
    const required    = ['SUB', 'XSRF-TOKEN'];
    const recommended = ['SUBP', 'SCF'];
    const missing     = required.filter(k => !new RegExp(`(?:^|;\\s*)${k}=`).test(cookieStr));
    const missingRec  = recommended.filter(k => !new RegExp(`(?:^|;\\s*)${k}=`).test(cookieStr));
    if (missing.length) return res.json({ ok: false, valid: false, error: `缺少必要字段: ${missing.join(', ')}`, missing, missingRec });
    const xsrf = (cookieStr.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/) ?? [])[1] ?? '';
    const weiboHeaders = {
      Cookie: cookieStr, 'x-xsrf-token': xsrf,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://weibo.com', 'x-requested-with': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    };
    const tryFetch = async (url) => {
      const resp = await fetch(url, { headers: weiboHeaders });
      const text = await resp.text();
      try { return JSON.parse(text); } catch { return null; }
    };
    try {
      let data = await tryFetch('https://weibo.com/ajax/statuses/mymblog?page=1&feature=0');
      if (data?.ok === 1) {
        const user = data?.data?.list?.[0]?.user ?? null;
        return res.json({ ok: true, valid: true, missingRec, uid: user?.id ?? null, name: user?.screen_name ?? '已验证', avatar: user?.profile_image_url ?? null });
      }
      if (cookieStr.match(/(?:^|;\s*)SUB=([^;]+)/)) {
        data = await tryFetch('https://weibo.com/ajax/profile/info');
        const user = data?.data?.user;
        if (user) return res.json({ ok: true, valid: true, missingRec, uid: user.id, name: user.screen_name, avatar: user.profile_image_url });
      }
      return res.json({ ok: false, valid: false, error: data ? 'Cookie 无效或已过期' : '服务器返回非 JSON 响应', missingRec });
    } catch (e) {
      return res.json({ ok: false, valid: false, error: `网络请求失败: ${e.message}`, missingRec });
    }
  }

  // ── Copywriting ───────────────────────────────────────────────────────
  if (path === '/api/copywriting') {
    if (method === 'GET') {
      try {
        const groups = await getCopywritingGroups();
        return res.json({ ok: true, groups });
      } catch (e) { return res.json({ ok: false, error: e.message }, 500); }
    }
    if (method === 'POST') {
      try {
        const { groups } = getBody(req);
        if (!Array.isArray(groups)) return res.json({ ok: false, error: 'groups must be array' }, 400);
        const clean = groups
          .filter(g => g && typeof g.name === 'string' && g.name.trim())
          .map(g => ({ name: g.name.trim(), items: (g.items ?? []).map(s => String(s).trim()).filter(Boolean) }));
        await setCopywritingGroups(clean);
        return res.json({ ok: true });
      } catch (e) { return res.json({ ok: false, error: e.message }, 500); }
    }
  }

  // ── Weibo operation routes ────────────────────────────────────────────
  const wrapRoutes = {
    'POST /api/post-tweet':         (c, b)    => c.postTweet({ content: b.content, pid: b.pid, mid: b.mid, videoTitle: b.videoTitle, videoType: b.videoType }),
    'POST /api/delete-tweet':       (c, b)    => c.deleteTweet({ mid: resolveMid(b.mid) }),
    'POST /api/quick-repost':       (c, b)    => c.quickRepost({ mid: resolveMid(b.mid) }),
    'POST /api/comment-tweet':      async (c, b) => {
      const mid = resolveMid(b.mid);
      const result = await c.commentTweet({ mid, content: b.content });
      return enrichCommentResult(c, mid, result);
    },
    'POST /api/repost-tweet':       (c, b)    => c.repostTweet({ mid: resolveMid(b.mid), content: b.content, visible: b.visible, listId: b.listId }),
    'POST /api/reply-comment':      async (c, b) => {
      const mid = resolveMid(b.mid);
      const result = await c.replyComment({ mid, cid: b.cid, content: b.content });
      return enrichCommentResult(c, mid, result);
    },
    'POST /api/delete-comment':     (c, b)    => c.deleteComment({ cid: b.cid }),
    'POST /api/like-comment':       (c, b)    => c.likeComment({ cid: b.cid, rid: b.rid }),
    'POST /api/follow-user':        (c, b)    => c.followUser({ uid: b.uid }),
    'POST /api/unfollow-user':      (c, b)    => c.unfollowUser({ uid: b.uid }),
    'POST /api/like-tweet':         (c, b)    => c.likeTweet({ mid: resolveMid(b.mid) }),
    'POST /api/unlike-tweet':       (c, b)    => c.unlikeTweet({ mid: resolveMid(b.mid) }),
    'POST /api/follow-super-topic': (c, b)    => c.followSuperTopic({ topicId: b.topicId, name: b.name }),
    'POST /api/checkin-super-topic':(c, b)    => c.checkinSuperTopic({ topicId: b.topicId }),
    'GET /api/search-super-topics': (c, b, q) => c.searchSuperTopics({ keyword: q.keyword, page: q.page }),
    'GET /api/friends-tweets':      (c, b, q) => c.fetchFriendsTweets({ sinceId: q.sinceId }),
    'GET /api/my-comments':         (c, b, q) => c.fetchMyComments({ cursor: q.cursor }),
    'GET /api/collections':         (c)       => c.fetchCollections(),
    'GET /api/groups':              (c)       => c.fetchGroups(),
  };

  if (wrapRoutes[routeKey]) return runWrapped(req, res, wrapRoutes[routeKey]);

  // ── Batch (synchronous — no SSE, serverless compatible) ───────────────
  if (path === '/api/batch-stream' && method === 'POST') {
    const { endpoint, body: params = {}, loops = 1, selectedAccounts } = getBody(req);
    const handler = batchHandlers[endpoint];
    if (!handler) return res.json({ ok: false, error: `Batch not supported for: ${endpoint}` }, 400);
    try {
      const accounts    = await getAccounts();
      const indices     = Array.isArray(selectedAccounts) && selectedAccounts.length
        ? selectedAccounts.filter(i => i >= 0 && i < accounts.length)
        : Array.from({ length: accounts.length }, (_, i) => i);
      const totalRounds = Math.max(1, Math.floor(loops));
      const copyGroups  = await getCopywritingGroups();
      const results     = [];
      for (let loop = 0; loop < totalRounds; loop++) {
        for (const i of indices) {
          const cookie = accounts[i]?.cookie;
          if (!cookie) { results.push({ account: i + 1, loop: loop + 1, totalRounds, ok: false, error: `Account ${i} not found` }); continue; }
          try {
            const client      = createClient(cookie);
            let resolved      = { ...params };
            let pickedContent = null;
            if (params.useRandom && params.randomField) {
              const picked = randomItem(copyGroups, params.randomGroup || null);
              if (picked) { resolved = { ...resolved, [params.randomField]: picked }; pickedContent = picked; }
            }
            const data = await handler(client, resolved);
            const validated = validateWeiboResponse(data);
            if (!validated.ok) {
              results.push({ account: i + 1, loop: loop + 1, totalRounds, ok: false, error: '错误' });
            } else {
              results.push({ account: i + 1, loop: loop + 1, totalRounds, ok: true, data: validated.data, pickedContent });
            }
          } catch (err) {
            results.push({ account: i + 1, loop: loop + 1, totalRounds, ok: false, error: err.message });
          }
        }
      }
      return res.json({ ok: true, results });
    } catch (e) {
      return res.json({ ok: false, error: e.message }, 500);
    }
  }

  // ── Upload picture (multipart not supported in this runtime) ──────────
  if (path === '/api/upload-picture' && method === 'POST') {
    return res.json({ ok: false, error: '图片上传功能在此部署环境中暂不支持，请使用本地模式' }, 501);
  }

  return res.json({ ok: false, error: `Not found: ${method} ${path}` }, 404);
};
