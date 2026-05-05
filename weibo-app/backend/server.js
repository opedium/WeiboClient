// server.js — Express API server
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import { timingSafeEqual } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createClient, bidToMid } from './weibo.js';
import {
  refreshCookieViaManualLogin,
  keepAliveAllAccounts,
  resetBrowserProfile,
  checkPlaywrightRuntime,
  startQrLoginSession,
  getQrLoginStatus,
  cancelQrLoginSession,
} from './cookieRefresh.js';
import { connectDB, getCopywritingGroups, setCopywritingGroups, getAccounts, setAccounts,
         getSchedules, addSchedule, updateSchedule, deleteSchedule } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const JSON_LIMIT = process.env.JSON_LIMIT ?? '256kb';
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes('*');

const AUTH_TOKEN = String(process.env.AUTH_TOKEN ?? '').trim();
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED ?? (AUTH_TOKEN ? 'true' : 'false')).toLowerCase() === 'true';
const PUBLIC_ROUTES = new Set(['/api/login', '/api/logout', '/api/me', '/api/health']);
const MONGODB_URI = String(process.env.MONGODB_URI ?? '').trim();
const COOKIE_SECRET = String(process.env.COOKIE_SECRET ?? '').trim();

function safeTokenEqual(a, b) {
  const aa = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (aa.length === 0 || aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function randomItem(groups, groupName) {
  if (!groups || !groups.length) return null;
  const pool = groupName
    ? (groups.find(g => g.name === groupName)?.items ?? [])
    : groups.flatMap(g => g.items ?? []);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
});

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (CORS_ALLOW_ALL) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: JSON_LIMIT }));

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_ROUTES.has(req.path)) return next();
  if (!AUTH_REQUIRED) return next();
  if (!AUTH_TOKEN) {
    return res.status(500).json({ ok: false, error: 'AUTH_REQUIRED=true but AUTH_TOKEN is empty' });
  }
  const token = req.headers['x-auth-token'];
  if (safeTokenEqual(token, AUTH_TOKEN)) return next();
  return res.status(401).json({ ok: false, error: '未授权，请先登录' });
});

function maskCookie(cookie) {
  const s = String(cookie ?? '').trim();
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}...${s.slice(-6)}`;
}

function compactCookieValue(cookie, uid = '') {
  const sub = cookieFieldValue(cookie, 'SUB');
  const normalizedUid = /^\d{10,}$/.test(String(uid)) ? String(uid).slice(0, 10) : '';
  if (!sub || !normalizedUid) return '';
  return `${normalizedUid}----${sub}`;
}

function sanitizeAccountsForResponse(accounts) {
  return (accounts ?? []).map(a => ({
    name: String(a.name ?? '').trim(),
    uid: String(a.uid ?? '').trim(),
    hasCookie: !!String(a.cookie ?? '').trim(),
    cookieMasked: maskCookie(a.cookie),
    cookieCompact: String(a.cookieCompact ?? '').trim() || compactCookieValue(a.cookie, a.uid),
    proxy: String(a.proxy ?? '').trim(),
  }));
}

function hasCookieField(cookieStr, key) {
  return new RegExp(`(?:^|;\\s*)${key}=`).test(cookieStr);
}

function cookieFieldValue(cookieStr, key) {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match?.[1] ?? '';
}

function checkCookieFields(cookieStr) {
  const required = ['SUB', 'XSRF-TOKEN'];
  const recommended = ['SUBP', 'SCF'];
  const missing = required.filter(k => !hasCookieField(cookieStr, k));
  const missingRec = recommended.filter(k => !hasCookieField(cookieStr, k));
  return { missing, missingRec };
}

function classifyBackendError(err) {
  const msg = String(err?.message ?? '');
  const code = String(err?.code ?? '');
  const status = Number(err?.response?.status ?? 0);
  // Also check response body for proxy-provider error codes
  const responseBody = String(err?.response?.data ?? '');

  const timeoutLike = /timeout|timed out|ETIMEDOUT|ECONNABORTED|ERR_TIMED_OUT/i.test(msg) ||
                      /ETIMEDOUT|ECONNABORTED/i.test(code);
  if (timeoutLike) {
    return {
      type: 'network_timeout',
      reason: '代理或网络超时',
      detail: '请求超时，通常是代理不稳定/不可达，或目标站点链路阻塞。',
    };
  }

  // Proxy-provider specific error codes (returned in message or response body)
  const proxyProviderError = /NO_HOST_CONNECTION|PROXY_ERROR|PROXY_CONNECTION|tunneling socket|CONNECT_REFUSED/i.test(msg) ||
                             /NO_HOST_CONNECTION|PROXY_ERROR/i.test(responseBody);
  if (proxyProviderError || status === 502 || status === 407) {
    return {
      type: 'network_proxy_error',
      reason: '代理无法连接目标主机',
      detail: status === 502
        ? '代理网关返回 502，该代理 IP 可能被目标站点封禁或代理服务器自身故障，请尝试切换代理 IP 或地区。'
        : status === 407
        ? '代理认证失败（407），请检查代理用户名/密码。'
        : `代理服务商返回错误（${msg || responseBody}），该 IP 无法访问目标站点，请更换代理 IP。`,
    };
  }

  const connectLike = /ECONNRESET|ECONNREFUSED|ERR_CONNECTION_CLOSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(msg) ||
                      /ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(code);
  if (connectLike) {
    return {
      type: 'network_proxy_error',
      reason: '代理或网络连接失败',
      detail: '连接被重置/拒绝或 DNS 解析失败，优先检查代理地址、账号认证和网络连通性。',
    };
  }

  if (status === 401 || status === 403 || /cookie|session|登录|未登录|invalid/i.test(msg)) {
    return {
      type: 'cookie_invalid',
      reason: 'Cookie 可能失效',
      detail: '服务端返回鉴权失败，建议先刷新 Cookie 后重试。',
    };
  }

  return {
    type: 'unknown_error',
    reason: '未知错误',
    detail: msg || '请求失败',
  };
}

async function validateCookieLive(cookieStr, proxy = '') {
  const xsrfRaw = cookieFieldValue(cookieStr, 'XSRF-TOKEN');
  const xsrfDecoded = (() => {
    try { return decodeURIComponent(xsrfRaw); } catch { return xsrfRaw; }
  })();
  const xsrfCandidates = Array.from(new Set([
    xsrfRaw,
    xsrfDecoded,
    xsrfDecoded ? encodeURIComponent(xsrfDecoded) : '',
  ].filter(Boolean)));

  const proxyOpts = (typeof proxy === 'string' && proxy.trim())
    ? (() => {
        try {
          return { httpsAgent: new HttpsProxyAgent(proxy.trim()), proxy: false };
        } catch {
          return {};
        }
      })()
    : {};

  const commonHeaders = {
    'Cookie': cookieStr,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://weibo.com',
    'Origin': 'https://weibo.com',
    'x-requested-with': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  const tryFetch = async (url, xsrfToken = '') => {
    const headers = xsrfToken
      ? { ...commonHeaders, 'x-xsrf-token': xsrfToken }
      : commonHeaders;
    const resp = await axios.get(url, {
      headers,
      validateStatus: () => true,
      timeout: 25_000,
      ...proxyOpts,
    });
    if (resp.data && typeof resp.data === 'object') return resp.data;
    const text = typeof resp.data === 'string' ? resp.data : '';
    try { return JSON.parse(text); } catch { return null; }
  };

  const urls = [
    'https://weibo.com/ajax/profile/info',
    'https://weibo.com/ajax/statuses/mymblog?page=1&feature=0',
  ];

  let seenLoginError = false;
  let seenDataFetchRestricted = false;
  let lastMessage = '';

  for (const xsrf of [...xsrfCandidates, '']) {
    for (const url of urls) {
      let data = null;
      try {
        data = await tryFetch(url, xsrf);
      } catch {
        continue;
      }

      const user = data?.data?.user ?? data?.user ?? data?.data?.list?.[0]?.user ?? null;
      if (user?.id || user?.idstr || user?.screen_name) {
        return {
          valid: true,
          uid: user.id ?? user.idstr ?? null,
          name: user.screen_name ?? user.name ?? '已验证',
          avatar: user.profile_image_url ?? null,
          reason: null,
        };
      }

      if (data?.ok === 1 && data?.data) {
        return {
          valid: true,
          uid: null,
          name: '已验证',
          avatar: null,
          reason: null,
        };
      }

      const msg = String(data?.msg ?? data?.message ?? data?.error ?? '').trim();
      if (msg) lastMessage = msg;
      if (/10017/.test(msg) || /获取数据失败\(10017\)/.test(msg)) {
        seenDataFetchRestricted = true;
      }
      if (/未登录|登录|cookie|session|invalid|expired|权限/i.test(msg)) {
        seenLoginError = true;
      }
    }
  }

  if (seenDataFetchRestricted && !seenLoginError) {
    return {
      valid: true,
      uid: null,
      name: '已验证(接口受限)',
      avatar: null,
      reason: '微博接口返回 10017（数据获取受限），Cookie 可能有效但该校验接口被风控/限流。',
    };
  }

  return {
    valid: false,
    uid: null,
    name: null,
    avatar: null,
    reason: seenLoginError
      ? (lastMessage || 'Cookie 无效或已过期')
      : (lastMessage ? `验证失败: ${lastMessage}` : '服务器返回非预期响应，请检查代理或网络'),
  };
}

const refreshLocks = new Set();
const activeQrSessionByAccount = new Map();

// helper: get account index from request (header or body)
function accountIdx(req) {
  return parseInt(req.headers['x-account'] ?? req.body?.account ?? '0', 10) || 0;
}

// helper: resolve mid — accepts numeric mid, mblogid string, or uid/mblogid
function resolveMid(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return s;              // numeric mid
  if (s.includes('/')) return bidToMid(s.split('/').pop()); // uid/mblogid → extract mblogid
  return bidToMid(s);                          // plain mblogid
}

// helper: resolve comment cid from numeric cid or full comment URL
function resolveCid(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return s;

  // For reply-comment links, rid is often the real target comment id.
  const ridMatch = s.match(/[?&]rid=(\d+)/i);
  if (ridMatch) return ridMatch[1];

  const cidMatch = s.match(/[?&]cid=(\d+)/i);
  if (cidMatch) return cidMatch[1];

  throw new Error('Invalid CID: provide numeric cid or a URL containing ?cid=');
}

// helper: resolve comment-like target from cid or full comment URL
function resolveCommentLikeTarget(val, fallbackMid = null) {
  const s = String(val ?? '').trim();
  const cid = resolveCid(s);

  let mid = null;
  const ridMatch = s.match(/[?&]rid=(\d+)/i);
  const rid = ridMatch ? ridMatch[1] : null;
  const tokenMatch = s.match(/weibo\.com\/(?:detail\/)?([^/?#]+)(?:\/([^/?#]+))?/i);
  const partA = tokenMatch?.[1] ?? null;
  const partB = tokenMatch?.[2] ?? null;

  // URL patterns:
  // 1) /detail/<mid>
  // 2) /<uid>/<mblogid>
  const postToken = partB || (partA && partA !== 'detail' ? partA : null);
  if (postToken) {
    mid = /^\d+$/.test(postToken) ? postToken : bidToMid(postToken);
  }

  if (!mid && fallbackMid) {
    mid = resolveMid(fallbackMid);
  }

  return { cid, rid, mid, hasRid: !!rid };
}

function toOriginalWeibo(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    id: status.id ?? null,
    idstr: status.idstr ?? null,
    mblogid: status.mblogid ?? null,
    text: status.text_raw ?? status.text ?? '',
    created_at: status.created_at ?? null,
    source: status.source ?? null,
    user: status.user ? {
      id: status.user.id ?? null,
      idstr: status.user.idstr ?? null,
      screen_name: status.user.screen_name ?? status.user.name ?? null,
      profile_image_url: status.user.profile_image_url ?? null,
    } : null,
  };
}

async function enrichCommentResult(client, mid, result) {
  try {
    const original = await client.fetchStatusDetail({ mid });
    return { ...result, originalWeibo: toOriginalWeibo(original) };
  } catch {
    return result;
  }
}

function wrap(fn) {
  return async (req, res) => {
    try {
      const accounts = await getAccounts();
      const idx = accountIdx(req);
      const acc = accounts[Math.min(idx, accounts.length - 1)];
      if (!acc?.cookie) throw new Error(`Account ${idx} not found`);
      const client = createClient(acc.cookie, null, acc.proxy || null);
      // resolve random content for single-call routes (same logic as batch)
      if (req.body?.useRandom && req.body?.randomField) {
        const groups = await getCopywritingGroups();
        const picked = randomItem(groups, req.body.randomGroup || null);
        if (picked) req.body = { ...req.body, [req.body.randomField]: picked };
      }
      const data = await fn(client, req);
      res.json({ ok: true, data });
    } catch (err) {
      const classified = classifyBackendError(err);
      console.error(`[${classified.type}] ${err.message}`);
      res.status(500).json({
        ok: false,
        error: `${classified.reason}: ${classified.detail}`,
        errorType: classified.type,
      });
    }
  };
}

// ── accounts ──────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ ok: true, count: accounts.length, accounts: sanitizeAccountsForResponse(accounts) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { accounts } = req.body;  // [{cookie, name, proxy}]
    if (!Array.isArray(accounts)) return res.status(400).json({ ok: false, error: 'accounts must be array' });
    const existing = await getAccounts();
    const clean = (await Promise.all(accounts.map(async (a, i) => {
        const name = String(a.name ?? '').trim();
        const incomingCookie = String(a.cookie ?? '').trim();
        const keepExisting = !!a.keepExisting;
        const cookie = incomingCookie || (keepExisting ? String(existing[i]?.cookie ?? '').trim() : '');
        const proxy = String(a.proxy ?? '').trim();
        let uid = keepExisting && !incomingCookie ? String(existing[i]?.uid ?? '').trim() : '';

        if (incomingCookie) {
          try {
            const live = await validateCookieLive(cookie, proxy);
            if (live.valid && live.uid) {
              uid = String(live.uid);
            }
          } catch {}
        }

        return { cookie, name: name || `账号 ${i + 1}`, proxy, uid };
      }))).filter(a => a.cookie);
    await setAccounts(clean);
    res.json({ ok: true, count: clean.length, accounts: sanitizeAccountsForResponse(clean) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── cookie validator ──────────────────────────────────────
app.post('/api/validate-cookie', async (req, res) => {
  const { cookie, proxy } = req.body ?? {};
  if (!cookie || typeof cookie !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 cookie' });
  }
  const cookieStr = cookie.trim();
  const proxyStr = typeof proxy === 'string' ? proxy.trim() : '';

  // 1. Check required tokens are present
  const { missing, missingRec } = checkCookieFields(cookieStr);

  if (missing.length) {
    return res.json({ ok: false, valid: false, error: `缺少必要字段: ${missing.join(', ')}`, missing, missingRec });
  }

  // 2. Live check — fetch current user's profile with the provided cookie
  try {
    const live = await validateCookieLive(cookieStr, proxyStr);
    if (live.valid) {
      return res.json({ ok: true, valid: true, missingRec, uid: live.uid, name: live.name, avatar: live.avatar });
    }
    return res.json({ ok: false, valid: false, error: live.reason, missingRec });
  } catch (e) {
    const classified = classifyBackendError(e);
    return res.json({
      ok: false,
      valid: false,
      error: `${classified.reason}: ${classified.detail}`,
      errorType: classified.type,
      missingRec,
    });
  }
});

app.post('/api/accounts/:index/reset-browser', async (req, res) => {
  const idx = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ ok: false, error: '无效账号索引' });
  }
  try {
    const accounts = await getAccounts();
    if (idx >= accounts.length) {
      return res.status(404).json({ ok: false, error: `账号 ${idx + 1} 不存在` });
    }
    const result = await resetBrowserProfile({ accountIndex: idx, accountName: accounts[idx]?.name ?? '' });
    if (result.error) {
      return res.status(500).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts/:index/refresh-cookie', async (req, res) => {
  const idx = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ ok: false, error: '无效账号索引' });
  }
  if (refreshLocks.has(idx)) {
    return res.status(409).json({ ok: false, error: '该账号正在刷新 Cookie，请稍候重试' });
  }

  refreshLocks.add(idx);
  try {
    const accounts = await getAccounts();
    if (idx >= accounts.length) {
      return res.status(404).json({ ok: false, error: `账号 ${idx + 1} 不存在` });
    }

    const maxWaitMs = Math.min(10 * 60 * 1000, Math.max(30 * 1000, Number.parseInt(req.body?.maxWaitMs ?? 180000, 10) || 180000));
    const refreshed = await refreshCookieViaManualLogin({
      accountIndex: idx,
      accountName: accounts[idx]?.name ?? '',
      proxy: accounts[idx]?.proxy ?? '',
      maxWaitMs,
      allowVisibleBrowser: false,
    });

    const check = checkCookieFields(refreshed.cookie);
    if (check.missing.length) {
      return res.status(400).json({ ok: false, error: `刷新完成但 Cookie 缺少字段: ${check.missing.join(', ')}`, missing: check.missing });
    }

    let live = { valid: false, uid: null, name: null, avatar: null, reason: '未校验' };
    try {
      live = await validateCookieLive(refreshed.cookie, accounts[idx]?.proxy ?? '');
    } catch (e) {
      live = { valid: false, uid: null, name: null, avatar: null, reason: `刷新后校验失败: ${e.message}` };
    }

    const updated = accounts.map((a, i) => (i === idx ? {
      ...a,
      cookie: refreshed.cookie,
      uid: live.valid && live.uid ? String(live.uid) : String(a.uid ?? '').trim(),
    } : a));
    await setAccounts(updated);
    const clean = sanitizeAccountsForResponse(updated);

    return res.json({
      ok: true,
      index: idx,
      account: clean[idx],
      validated: {
        valid: !!live.valid,
        uid: live.uid,
        name: live.name,
        avatar: live.avatar,
        error: live.valid ? null : live.reason,
        missingRec: check.missingRec,
      },
      message: 'Cookie 已刷新并保存',
    });
  } catch (e) {
    const msg = String(e?.message ?? '');
    if (/本地登录会话|可视化浏览器|Cookie 已过期|SESSION_EXPIRED/i.test(msg)) {
      return res.status(409).json({
        ok: false,
        error: msg,
        errorType: 'requires_qr_login',
        requiresQr: true,
      });
    }
    const classified = classifyBackendError(e);
    return res.status(500).json({ ok: false, error: `${classified.reason}: ${classified.detail}`, errorType: classified.type });
  } finally {
    refreshLocks.delete(idx);
  }
});

app.post('/api/accounts/:index/qr-login/start', async (req, res) => {
  const idx = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ ok: false, error: '无效账号索引' });
  }
  if (refreshLocks.has(idx)) {
    const existingSessionId = activeQrSessionByAccount.get(idx);
    if (existingSessionId) {
      const existing = getQrLoginStatus(existingSessionId);
      if (existing.found && existing.status === 'pending') {
        return res.status(409).json({
          ok: false,
          error: '该账号已有进行中的二维码登录会话',
          sessionId: existingSessionId,
          qrDataUrl: existing.qrDataUrl,
          expiresAt: existing.expiresAt,
        });
      }
    }
    return res.status(409).json({ ok: false, error: '该账号正在刷新 Cookie，请稍候重试' });
  }

  refreshLocks.add(idx);
  try {
    const accounts = await getAccounts();
    if (idx >= accounts.length) {
      return res.status(404).json({ ok: false, error: `账号 ${idx + 1} 不存在` });
    }

    const maxWaitMs = Math.min(10 * 60 * 1000, Math.max(60 * 1000, Number.parseInt(req.body?.maxWaitMs ?? 180000, 10) || 180000));
    const started = await startQrLoginSession({
      accountIndex: idx,
      accountName: accounts[idx]?.name ?? '',
      proxy: accounts[idx]?.proxy ?? '',
      maxWaitMs,
    });

    activeQrSessionByAccount.set(idx, started.sessionId);
    return res.json({ ok: true, ...started, message: '二维码已生成，请扫码登录' });
  } catch (e) {
    refreshLocks.delete(idx);
    activeQrSessionByAccount.delete(idx);
    const classified = classifyBackendError(e);
    return res.status(500).json({ ok: false, error: `${classified.reason}: ${classified.detail}`, errorType: classified.type });
  }
});

app.get('/api/accounts/:index/qr-login/status', async (req, res) => {
  const idx = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ ok: false, error: '无效账号索引' });
  }

  const sessionId = String(req.query.sessionId ?? '').trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: '缺少 sessionId' });
  }

  const status = getQrLoginStatus(sessionId);
  if (!status.found) {
    refreshLocks.delete(idx);
    activeQrSessionByAccount.delete(idx);
    return res.status(404).json({ ok: false, error: status.error ?? '会话不存在', status: status.status });
  }

  if (status.accountIndex !== idx) {
    return res.status(400).json({ ok: false, error: '会话与账号索引不匹配' });
  }

  if (status.status !== 'success') {
    if (status.status === 'failed' || status.status === 'expired' || status.status === 'cancelled') {
      refreshLocks.delete(idx);
      activeQrSessionByAccount.delete(idx);
    }
    return res.json({ ok: true, ...status });
  }

  try {
    const accounts = await getAccounts();
    if (idx >= accounts.length) {
      refreshLocks.delete(idx);
      activeQrSessionByAccount.delete(idx);
      return res.status(404).json({ ok: false, error: `账号 ${idx + 1} 不存在` });
    }

    const refreshedCookie = String(status.cookie ?? '').trim();
    const check = checkCookieFields(refreshedCookie);
    if (check.missing.length) {
      refreshLocks.delete(idx);
      activeQrSessionByAccount.delete(idx);
      return res.status(400).json({ ok: false, error: `扫码完成但 Cookie 缺少字段: ${check.missing.join(', ')}`, missing: check.missing });
    }

    let live = { valid: false, uid: null, name: null, avatar: null, reason: '未校验' };
    try {
      live = await validateCookieLive(refreshedCookie, accounts[idx]?.proxy ?? '');
    } catch (e) {
      live = { valid: false, uid: null, name: null, avatar: null, reason: `刷新后校验失败: ${e.message}` };
    }

    const updated = accounts.map((a, i) => (i === idx ? {
      ...a,
      cookie: refreshedCookie,
      uid: live.valid && live.uid ? String(live.uid) : String(a.uid ?? '').trim(),
    } : a));
    await setAccounts(updated);
    const clean = sanitizeAccountsForResponse(updated);

    refreshLocks.delete(idx);
    activeQrSessionByAccount.delete(idx);

    return res.json({
      ok: true,
      ...status,
      account: clean[idx],
      validated: {
        valid: !!live.valid,
        uid: live.uid,
        name: live.name,
        avatar: live.avatar,
        error: live.valid ? null : live.reason,
        missingRec: check.missingRec,
      },
      message: 'Cookie 已通过二维码登录刷新并保存',
    });
  } catch (e) {
    const classified = classifyBackendError(e);
    return res.status(500).json({ ok: false, error: `${classified.reason}: ${classified.detail}`, errorType: classified.type });
  }
});

app.post('/api/accounts/:index/qr-login/cancel', async (req, res) => {
  const idx = Number.parseInt(req.params.index, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ ok: false, error: '无效账号索引' });
  }
  const sessionId = String(req.body?.sessionId ?? '').trim() || String(activeQrSessionByAccount.get(idx) ?? '');
  if (!sessionId) {
    refreshLocks.delete(idx);
    activeQrSessionByAccount.delete(idx);
    return res.json({ ok: true, status: 'noop' });
  }

  const result = await cancelQrLoginSession(sessionId);
  refreshLocks.delete(idx);
  activeQrSessionByAccount.delete(idx);
  return res.json({ ok: true, ...result });
});

// ── tweet ─────────────────────────────────────────────────
app.post('/api/post-tweet', wrap(async (client, req) => {
  const { content, pid, mid, videoTitle, videoType } = req.body;
  return client.postTweet({ content, pid, mid, videoTitle, videoType });
}));

app.post('/api/delete-tweet', wrap(async (client, req) => {
  return client.deleteTweet({ mid: resolveMid(req.body.mid) });
}));

app.post('/api/quick-repost', wrap(async (client, req) => {
  return client.quickRepost({ mid: resolveMid(req.body.mid) });
}));

app.post('/api/repost-tweet', wrap(async (client, req) => {
  const { mid, content, visible, listId } = req.body;
  return client.repostTweet({ mid: resolveMid(mid), content, visible, listId });
}));

// ── comments ──────────────────────────────────────────────
app.post('/api/comment-tweet', wrap(async (client, req) => {
  const { mid, content } = req.body;
  const resolvedMid = resolveMid(mid);
  const result = await client.commentTweet({ mid: resolvedMid, content });
  return enrichCommentResult(client, resolvedMid, result);
}));

app.post('/api/reply-comment', wrap(async (client, req) => {
  const { mid, cid, content } = req.body;
  const resolvedMid = resolveMid(mid);
  const result = await client.replyComment({ mid: resolvedMid, cid, content });
  return enrichCommentResult(client, resolvedMid, result);
}));

app.post('/api/delete-comment', wrap(async (client, req) => {
  return client.deleteComment({ cid: req.body.cid });
}));

app.post('/api/like-comment', wrap(async (client, req) => {
  return client.likeComment(resolveCommentLikeTarget(req.body.cid));
}));

app.post('/api/batch-like-comment', wrap(async (client, req) => {
  const cidList = String(req.body.cids ?? '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  if (!cidList.length) throw new Error('cids 不能为空');
  const results = [];
  for (const cid of cidList) {
    try {
      const result = await client.likeComment(resolveCommentLikeTarget(cid));
      results.push({ cid, ...result });
    } catch (e) {
      results.push({ cid, ok: 0, error: e.message });
    }
  }
  return { ok: true, results };
}));

app.post('/api/batch-like-comment-stream', async (req, res) => {
  try {
    const cidList = String(req.body.cids ?? '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (!cidList.length) return res.status(400).json({ ok: false, error: 'cids 不能为空' });
    
    const accountDelay = Math.max(0, parseInt(req.body.delay ?? 0));
    const cidDelay = Math.max(0, parseInt(req.body.cidDelay ?? 0));
    
    const accounts = await getAccounts();
    const selectedAccounts = Array.isArray(req.body.selectedAccounts) && req.body.selectedAccounts.length
      ? req.body.selectedAccounts.filter(i => i >= 0 && i < accounts.length)
      : Array.from({ length: accounts.length }, (_, i) => i);
    
    const total = cidList.length * selectedAccounts.length;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    
    send({ type: 'start', total, cidCount: cidList.length, accountCount: selectedAccounts.length });
    
    let step = 0;
    for (let cidIdx = 0; cidIdx < cidList.length; cidIdx++) {
      const cid = cidList[cidIdx];
      for (let accIdx = 0; accIdx < selectedAccounts.length; accIdx++) {
        const accountIdx = selectedAccounts[accIdx];
        try {
          const acc = accounts[accountIdx];
          const client = createClient(acc.cookie, null, acc.proxy || null);
          const result = await client.likeComment(resolveCommentLikeTarget(cid));
          step++;
          send({ type: 'done', step, total, cid, accountIdx, result });
          
          // Account delay after each account (except last account)
          if (accIdx < selectedAccounts.length - 1 && accountDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, accountDelay));
          }
        } catch (e) {
          step++;
          send({ type: 'error', step, total, cid, accountIdx, error: e.message });
          
          if (accIdx < selectedAccounts.length - 1 && accountDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, accountDelay));
          }
        }
      }
      
      // Delay after each CID (except last CID)
      if (cidIdx < cidList.length - 1 && cidDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, cidDelay));
      }
    }
    
    send({ type: 'complete', total });
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'fatal', error: e.message })}\n\n`);
    res.end();
  }
});

// ── social ────────────────────────────────────────────────
app.post('/api/follow-user', wrap(async (client, req) => {
  return client.followUser({ uid: req.body.uid });
}));

app.post('/api/unfollow-user', wrap(async (client, req) => {
  return client.unfollowUser({ uid: req.body.uid });
}));

app.post('/api/like-tweet', wrap(async (client, req) => {
  return client.likeTweet({ mid: resolveMid(req.body.mid) });
}));

app.post('/api/unlike-tweet', wrap(async (client, req) => {
  return client.unlikeTweet({ mid: resolveMid(req.body.mid) });
}));

app.post('/api/follow-super-topic', wrap(async (client, req) => {
  const { topicId, name } = req.body;
  return client.followSuperTopic({ topicId, name });
}));

app.post('/api/checkin-super-topic-by-name', wrap(async (client, req) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return { ok: 0, message: '请提供超话名称' };
  }
  
  // Search for the topic by name
  const searchResult = await client.searchSuperTopics({ keyword: name, page: 1 });
  
  // Check if search was successful and found results
  if (!searchResult?.ok || !searchResult?.data || searchResult.data.length === 0) {
    return { ok: 0, message: `未找到超话: ${name}` };
  }
  
  // Get the first result
  const topic = searchResult.data[0];
  const topicOid = topic.act_log?.oid || topic.page_id;
  
  if (!topicOid) {
    return { ok: 0, message: '无法获取超话ID' };
  }
  
  // Now check in
  const checkinResult = await client.checkinSuperTopic({ topicId: topicOid });
  
  // Add the topic info to the response
  return {
    ...checkinResult,
    topicName: topic.title,
    topicId: topicOid,
  };
}));

// ── fetch ─────────────────────────────────────────────────
app.get('/api/friends-tweets', wrap(async (client, req) => {
  return client.fetchFriendsTweets({ sinceId: req.query.sinceId });
}));

app.get('/api/my-comments', wrap(async (client, req) => {
  return client.fetchMyComments({ cursor: req.query.cursor });
}));

app.get('/api/collections', wrap(async (client) => {
  return client.fetchCollections();
}));

app.get('/api/groups', wrap(async (client) => {
  return client.fetchGroups();
}));

app.get('/api/super-topics', wrap(async (client, req) => {
  const cateId = req.query.cateId ?? '123333';
  const page = req.query.page ?? 1;
  return client.fetchSuperTopics({ cateId, page });
}));

// ── inbox / notifications ─────────────────────────────────
app.get('/api/inbox/unread-counts', wrap(async (client) => {
  return client.fetchUnreadCounts();
}));

app.get('/api/inbox/likes', wrap(async (client, req) => {
  return client.fetchLikeNotices({ sinceId: req.query.sinceId });
}));

app.get('/api/inbox/at-me-tweets', wrap(async (client, req) => {
  return client.fetchAtMeTweets({ sinceId: req.query.sinceId });
}));

app.get('/api/inbox/at-me-comments', wrap(async (client, req) => {
  return client.fetchAtMeComments({ sinceId: req.query.sinceId });
}));

app.get('/api/inbox/comments', wrap(async (client, req) => {
  return client.fetchCommentNotices({ sinceId: req.query.sinceId });
}));

app.get('/api/inbox/dm-list', wrap(async (client, req) => {
  return client.fetchDmList({ page: req.query.page ? Number(req.query.page) : 1 });
}));

app.get('/api/inbox/dm-chat', wrap(async (client, req) => {
  if (!req.query.uid) return { error: 'uid is required' };
  return client.fetchDmChat({ uid: req.query.uid, sinceId: req.query.sinceId });
}));

app.post('/api/inbox/dm-send', wrap(async (client, req) => {
  const { uid, content } = req.body ?? {};
  if (!uid) throw new Error('uid is required');
  if (!content || !String(content).trim()) throw new Error('content is required');
  return client.sendDm({ uid, content });
}));

// ── copywriting ──────────────────────────────────────────
app.get('/api/copywriting', async (req, res) => {
  try {
    const groups = await getCopywritingGroups();
    res.json({ ok: true, groups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/copywriting', async (req, res) => {
  const { groups } = req.body;
  if (!Array.isArray(groups)) return res.status(400).json({ ok: false, error: 'groups must be array' });
  const clean = groups
    .filter(g => g && typeof g.name === 'string' && g.name.trim())
    .map(g => ({ name: g.name.trim(), items: (g.items ?? []).map(s => String(s).trim()).filter(Boolean) }));
  try {
    await setCopywritingGroups(clean);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── upload ────────────────────────────────────────────────
app.post('/api/upload-picture', upload.single('image'), wrap(async (client, req) => {
  if (!req.file) throw new Error('No image file provided');
  return client.uploadPicture(req.file.buffer, req.body.watermark ?? '');
}));

// ── batch ─────────────────────────────────────────────────
const batchHandlers = {
  '/api/post-tweet':        (c, b) => {
    if (!b.content || !String(b.content).trim()) throw new Error('content 不能为空');
    return c.postTweet({ content: b.content, pid: b.pid, mid: b.mid, videoTitle: b.videoTitle, videoType: b.videoType });
  },
  '/api/delete-tweet':      (c, b) => c.deleteTweet({ mid: resolveMid(b.mid) }),
  '/api/quick-repost':      (c, b) => c.quickRepost({ mid: resolveMid(b.mid) }),
  '/api/repost-tweet':      (c, b) => c.repostTweet({ mid: resolveMid(b.mid), content: b.content, visible: b.visible, listId: b.listId }),
  '/api/comment-tweet':     async (c, b) => {
    const mid = resolveMid(b.mid);
    const result = await c.commentTweet({ mid, content: b.content });
    return enrichCommentResult(c, mid, result);
  },
  '/api/reply-comment':     async (c, b) => {
    const mid = resolveMid(b.mid);
    const result = await c.replyComment({ mid, cid: b.cid, content: b.content });
    return enrichCommentResult(c, mid, result);
  },
  '/api/delete-comment':    (c, b) => c.deleteComment({ cid: b.cid }),
  '/api/like-comment':      (c, b) => c.likeComment(resolveCommentLikeTarget(b.cid)),
  '/api/follow-user':       (c, b) => c.followUser({ uid: b.uid }),
  '/api/unfollow-user':     (c, b) => c.unfollowUser({ uid: b.uid }),
  '/api/like-tweet':        (c, b) => c.likeTweet({ mid: resolveMid(b.mid) }),
  '/api/unlike-tweet':      (c, b) => c.unlikeTweet({ mid: resolveMid(b.mid) }),
  '/api/follow-super-topic':(c, b) => c.followSuperTopic({ topicId: b.topicId, name: b.name }),
};

const loopableBatchEndpoints = new Set(['/api/quick-repost', '/api/repost-tweet']);

// SSE streaming batch — sends one event per account as it completes
app.post('/api/batch-stream', async (req, res) => {
  const { endpoint, body: params = {}, delay = 3000, selectedAccounts, loops = 1, roundDelay = 0 } = req.body;
  const handler = batchHandlers[endpoint];
  if (!handler) {
    res.status(400).json({ ok: false, error: `Batch not supported for: ${endpoint}` });
    return;
  }

  const accounts = await getAccounts();
  // selectedAccounts is an array of 0-based indices, or null/undefined = all
  const indices = Array.isArray(selectedAccounts) && selectedAccounts.length
    ? selectedAccounts.filter(i => i >= 0 && i < accounts.length)
    : Array.from({ length: accounts.length }, (_, i) => i);
  const accountCount = indices.length;
  const totalRounds = loopableBatchEndpoints.has(endpoint) ? Math.max(1, Math.floor(Number(loops) || 1)) : 1;
  const interAccountDelay = Math.max(0, Number(delay) || 0);
  const interRoundDelay = totalRounds > 1 ? Math.max(0, Number(roundDelay) || 0) : 0;
  const total = accountCount * totalRounds;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // resolve random content source once for the whole batch
  const copyGroups = await getCopywritingGroups();
  const resolveParams = (p) => {
    if (!p.useRandom || !p.randomField) return p;
    const picked = randomItem(copyGroups, p.randomGroup || null);
    if (!picked) return p;
    return { ...p, [p.randomField]: picked };
  };

  send({ type: 'start', total, accountCount, totalRounds });

  const waitMs = async (ms, label) => {
    let remaining = ms;
    while (remaining > 0) {
      send({ type: 'waiting', label, remaining, total });
      const tick = Math.min(1000, remaining);
      await new Promise(r => setTimeout(r, tick));
      remaining -= tick;
    }
  };

  let stepNum = 0;
  for (let loop = 0; loop < totalRounds; loop++) {
    if (loop > 0 && interRoundDelay > 0) {
      await waitMs(interRoundDelay, `第 ${loop + 1} 轮开始前等待`);
    }
    for (let pos = 0; pos < indices.length; pos++) {
      const i = indices[pos];
      stepNum += 1;
      if (pos > 0 && interAccountDelay > 0) {
        await waitMs(interAccountDelay, `账号 ${i + 1} 等待中`);
      }
      send({ type: 'running', account: i + 1, step: stepNum, total, loop: loop + 1, totalRounds });
      try {
        const acc = accounts[i];
        if (!acc?.cookie) throw new Error(`Account ${i} not found`);
        const client = createClient(acc.cookie, null, acc.proxy || null);
        const resolved = resolveParams(params);
        const pickedContent = (params.useRandom && params.randomField) ? (resolved[params.randomField] ?? null) : null;
        const data = await handler(client, resolved);
        send({ type: 'result', account: i + 1, step: stepNum, total, loop: loop + 1, totalRounds, ok: true, data, pickedContent });
      } catch (err) {
        console.error(`Batch account ${i + 1}:`, err.message);
        send({ type: 'result', account: i + 1, step: stepNum, total, loop: loop + 1, totalRounds, ok: false, error: err.message });
      }
    }
  }

  send({ type: 'done', total });
  res.end();
});

// ── schedules ─────────────────────────────────────────────
const runningJobs = new Set();

app.get('/api/schedules', async (_req, res) => {
  try {
    const jobs = await getSchedules();
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const {
      name,
      endpoint,
      body = {},
      delay = 3000,
      loops = 1,
      roundDelay = 0,
      selectedAccounts,
      scheduledAt,
      repeatMinutes,
      repeatCount,
    } = req.body ?? {};

    if (!batchHandlers[endpoint]) {
      return res.status(400).json({ ok: false, error: `Batch not supported for: ${endpoint}` });
    }
    if (!scheduledAt) {
      return res.status(400).json({ ok: false, error: 'scheduledAt is required' });
    }

    const job = await addSchedule({
      name: String(name ?? '').trim(),
      endpoint,
      body,
      delay: Number(delay) || 0,
      loops: Math.max(1, Number(loops) || 1),
      roundDelay: Number(roundDelay) || 0,
      selectedAccounts: Array.isArray(selectedAccounts) ? selectedAccounts : [],
      scheduledAt: new Date(scheduledAt).toISOString(),
      repeatMinutes: repeatMinutes ? Math.max(1, Number(repeatMinutes) || 0) : null,
      repeatCount: repeatCount ? Math.max(1, Number(repeatCount) || 0) : null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true, job });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/schedules/:id', async (req, res) => {
  try {
    const {
      name,
      endpoint,
      body = {},
      delay = 3000,
      loops = 1,
      roundDelay = 0,
      selectedAccounts,
      scheduledAt,
      repeatMinutes,
      repeatCount,
    } = req.body ?? {};

    if (!batchHandlers[endpoint]) {
      return res.status(400).json({ ok: false, error: `Batch not supported for: ${endpoint}` });
    }
    if (!scheduledAt) {
      return res.status(400).json({ ok: false, error: 'scheduledAt is required' });
    }

    const patch = {
      name: String(name ?? '').trim(),
      endpoint,
      body,
      delay: Number(delay) || 0,
      loops: Math.max(1, Number(loops) || 1),
      roundDelay: Number(roundDelay) || 0,
      selectedAccounts: Array.isArray(selectedAccounts) ? selectedAccounts : [],
      scheduledAt: new Date(scheduledAt).toISOString(),
      repeatMinutes: repeatMinutes ? Math.max(1, Number(repeatMinutes) || 0) : null,
      repeatCount: repeatCount ? Math.max(1, Number(repeatCount) || 0) : null,
      status: 'pending',
      runCount: 0,
    };

    await updateSchedule(req.params.id, patch);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    await deleteSchedule(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/schedules/:id/run', async (req, res) => {
  try {
    const jobs = await getSchedules();
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
    void runScheduleJob(job);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function runScheduleJob(job) {
  if (!job?.id || runningJobs.has(job.id)) return;
  const handler = batchHandlers[job.endpoint];
  if (!handler) {
    await updateSchedule(job.id, {
      status: 'failed',
      lastRunAt: new Date().toISOString(),
      lastResult: `Batch not supported for: ${job.endpoint}`,
    });
    return;
  }

  runningJobs.add(job.id);
  try {
    await updateSchedule(job.id, {
      status: 'running',
      lastRunAt: new Date().toISOString(),
      lastResult: null,
    });

    const accounts = await getAccounts();
    const indices = Array.isArray(job.selectedAccounts) && job.selectedAccounts.length
      ? job.selectedAccounts.filter(i => i >= 0 && i < accounts.length)
      : Array.from({ length: accounts.length }, (_, i) => i);

    if (!indices.length) {
      throw new Error('No valid accounts selected');
    }

    const totalRounds = Math.max(1, Math.floor(Number(job.loops) || 1));
    const delay = Math.max(0, Number(job.delay) || 0);
    const roundDelay = Math.max(0, Number(job.roundDelay) || 0);
    const copyGroups = await getCopywritingGroups();
    const resolveParams = (params) => {
      if (!params?.useRandom || !params.randomField) return params;
      const picked = randomItem(copyGroups, params.randomGroup || null);
      if (!picked) return params;
      return { ...params, [params.randomField]: picked };
    };

    const results = [];
    for (let loop = 0; loop < totalRounds; loop++) {
      if (loop > 0 && roundDelay > 0) {
        await new Promise(r => setTimeout(r, roundDelay));
      }
      for (let pos = 0; pos < indices.length; pos++) {
        if (pos > 0 && delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
        const accountIndex = indices[pos];
        const acc = accounts[accountIndex];
        if (!acc?.cookie) throw new Error(`Account ${accountIndex} not found`);
        const client = createClient(acc.cookie, null, acc.proxy || null);
        const payload = resolveParams(job.body ?? {});
        const data = await handler(client, payload);
        results.push({ account: accountIndex + 1, loop: loop + 1, ok: true, data });
      }
    }

    const patch = {
      lastRunAt: new Date().toISOString(),
      lastResult: results,
    };
    
    // Handle repetition with optional repeat count limit
    if (job.repeatMinutes) {
      const runCount = (job.runCount ?? 0) + 1;
      const shouldContinue = !job.repeatCount || runCount < job.repeatCount;
      
      if (shouldContinue) {
        patch.status = 'pending';
        patch.scheduledAt = new Date(Date.now() + Number(job.repeatMinutes) * 60 * 1000).toISOString();
        patch.runCount = runCount;
      } else {
        patch.status = 'done';
        patch.runCount = runCount;
      }
    } else {
      patch.status = 'done';
    }
    
    await updateSchedule(job.id, patch);
  } catch (err) {
    await updateSchedule(job.id, {
      status: 'failed',
      lastRunAt: new Date().toISOString(),
      lastResult: err.message,
    });
  } finally {
    runningJobs.delete(job.id);
  }
}

// ── auth ──────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (!AUTH_REQUIRED) {
    return res.json({ ok: true, token: '', mode: 'auth_disabled' });
  }
  if (!AUTH_TOKEN) {
    return res.status(500).json({ ok: false, error: '服务端未配置 AUTH_TOKEN' });
  }
  const provided = String(req.body?.token ?? '').trim();
  if (!safeTokenEqual(provided, AUTH_TOKEN)) {
    return res.status(401).json({ ok: false, error: '登录失败：Token 不正确' });
  }
  return res.json({ ok: true, token: AUTH_TOKEN });
});

app.post('/api/logout', (_req, res) => {
  return res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!AUTH_REQUIRED) {
    return res.json({ ok: true, authenticated: true, mode: 'auth_disabled' });
  }
  const token = req.headers['x-auth-token'];
  return res.json({ ok: true, authenticated: safeTokenEqual(token, AUTH_TOKEN), mode: 'token' });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    authRequired: AUTH_REQUIRED,
    corsMode: CORS_ALLOW_ALL ? 'allow_all' : 'allow_list',
  });
});

function startScheduler() {
  const poll = async () => {
    try {
      const jobs = await getSchedules();
      const now = Date.now();
      for (const job of jobs) {
        if (job.status !== 'pending' || !job.scheduledAt) continue;
        const runAt = new Date(job.scheduledAt).getTime();
        if (!Number.isFinite(runAt) || runAt > now) continue;
        void runScheduleJob(job);
      }
    } catch (err) {
      console.error('Scheduler poll failed:', err.message);
    }
  };

  void poll();
  setInterval(() => { void poll(); }, 30_000);
}

// ── cookie keep-alive ────────────────────────────────────
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 24 * 60 * 60 * 1000; // default: every 24 hours
const KEEP_ALIVE_FIRST_DELAY_MS = Number(process.env.KEEP_ALIVE_FIRST_DELAY_MS) || 6 * 60 * 60 * 1000; // default: 6h after startup

let keepAliveLog = null; // { ranAt, results: [{accountIndex, accountName, ok, error?}] }

app.get('/api/keep-alive-log', (_req, res) => {
  res.json({ ok: true, log: keepAliveLog });
});

function startCookieKeepAlive() {
  const run = async () => {
    try {
      const accounts = await getAccounts();
      if (!accounts.length) return;
      const results = await keepAliveAllAccounts(accounts);
      const updated = accounts.map((a, i) => {
        const r = results.find(x => x.accountIndex === i);
        return r?.ok && r.cookie ? { ...a, cookie: r.cookie } : a;
      });
      await setAccounts(updated);
      keepAliveLog = {
        ranAt: new Date().toISOString(),
        results: results.map(({ accountIndex, accountName, ok, error }) => ({ accountIndex, accountName, ok, error: error ?? null })),
      };
      const ok = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok && r.error !== 'no_profile').length;
      if (ok || fail) console.log(`Cookie keep-alive: ${ok} refreshed, ${fail} failed`);
    } catch (err) {
      console.error('Cookie keep-alive failed:', err.message);
    }
  };

  // Run first time after KEEP_ALIVE_FIRST_DELAY_MS (default 6h), then every KEEP_ALIVE_INTERVAL_MS (default 24h).
  console.log(`Cookie keep-alive: first run in ${Math.round(KEEP_ALIVE_FIRST_DELAY_MS / 3_600_000 * 10) / 10}h, then every ${Math.round(KEEP_ALIVE_INTERVAL_MS / 3_600_000 * 10) / 10}h`);
  setTimeout(() => { void run(); }, KEEP_ALIVE_FIRST_DELAY_MS);
  setInterval(() => { void run(); }, KEEP_ALIVE_INTERVAL_MS);
}

// ── start ─────────────────────────────────────────────────
async function start() {
  if (AUTH_REQUIRED && !AUTH_TOKEN) {
    throw new Error('AUTH_REQUIRED=true but AUTH_TOKEN is empty. Refusing to start.');
  }
  if (MONGODB_URI && !/^[0-9a-fA-F]{64}$/.test(COOKIE_SECRET)) {
    throw new Error('MONGODB_URI is set but COOKIE_SECRET is missing/invalid. Set COOKIE_SECRET to a 64-char hex string.');
  }
  if (!AUTH_REQUIRED) {
    console.warn('[security] Auth middleware is disabled (AUTH_REQUIRED=false).');
  }
  if (CORS_ALLOW_ALL) {
    console.warn('[security] CORS is set to allow all origins. Set CORS_ORIGINS in production.');
  }

  const playwright = await checkPlaywrightRuntime();
  if (!playwright.ok) {
    console.warn(`[cookieRefresh] Playwright runtime check failed: ${playwright.error}`);
    console.warn('[cookieRefresh] On Ubuntu, run: npx playwright install ; npx playwright install-deps');
  }

  const server = app.listen(PORT, () => {
    console.log(`Weibo backend running on http://localhost:${PORT}`);
    startScheduler();
    // Keep-alive disabled — use the 刷新Cookie button manually to avoid proxy traffic.
    // startCookieKeepAlive();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the conflicting process or set PORT to a different value.`);
      process.exit(1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

start().catch(err => { console.error('Failed to start:', err.message); process.exit(1); });
