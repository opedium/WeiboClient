// server.js — Express API server
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, bidToMid } from './weibo.js';
import { connectDB, getCopywritingGroups, setCopywritingGroups, getAccounts, setAccounts } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function randomItem(groups, groupName) {
  if (!groups || !groups.length) return null;
  const pool = groupName
    ? (groups.find(g => g.name === groupName)?.items ?? [])
    : groups.flatMap(g => g.items ?? []);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// helper: get account index from request (header or body)
function accountIdx(req) {
  return parseInt(req.headers['x-account'] ?? req.body?.account ?? '0', 10) || 0;
}

// helper: resolve mid — accepts numeric mid or mblogid string
function resolveMid(val) {
  if (!val) return null;
  const s = String(val).trim();
  return /^\d+$/.test(s) ? s : bidToMid(s);
}

function wrap(fn) {
  return async (req, res) => {
    try {
      const accounts = await getAccounts();
      const idx = accountIdx(req);
      const cookie = accounts[Math.min(idx, accounts.length - 1)]?.cookie;
      if (!cookie) throw new Error(`Account ${idx} not found`);
      const client = createClient(cookie);
      // resolve random content for single-call routes (same logic as batch)
      if (req.body?.useRandom && req.body?.randomField) {
        const groups = await getCopywritingGroups();
        const picked = randomItem(groups, req.body.randomGroup || null);
        if (picked) req.body = { ...req.body, [req.body.randomField]: picked };
      }
      const data = await fn(client, req);
      res.json({ ok: true, data });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// ── accounts ──────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ ok: true, count: accounts.length, accounts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { accounts } = req.body;  // [{cookie, name}]
    if (!Array.isArray(accounts)) return res.status(400).json({ ok: false, error: 'accounts must be array' });
    const clean = accounts
      .map(a => ({ cookie: String(a.cookie ?? '').trim(), name: String(a.name ?? '').trim() }))
      .filter(a => a.cookie);
    await setAccounts(clean);
    res.json({ ok: true, count: clean.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── cookie validator ──────────────────────────────────────
app.post('/api/validate-cookie', async (req, res) => {
  const { cookie } = req.body ?? {};
  if (!cookie || typeof cookie !== 'string') {
    return res.status(400).json({ ok: false, error: '缺少 cookie' });
  }
  const cookieStr = cookie.trim();

  // 1. Check required tokens are present
  const required = ['SUB', 'XSRF-TOKEN'];
  const recommended = ['SUBP', 'SCF'];
  const missing = required.filter(k => !new RegExp(`(?:^|;\\s*)${k}=`).test(cookieStr));
  const missingRec = recommended.filter(k => !new RegExp(`(?:^|;\\s*)${k}=`).test(cookieStr));

  if (missing.length) {
    return res.json({ ok: false, valid: false, error: `缺少必要字段: ${missing.join(', ')}`, missing, missingRec });
  }

  // 2. Live check — fetch current user's mymblog (no uid needed, requires auth)
  const xsrf = (cookieStr.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/) ?? [])[1] ?? '';
  const commonHeaders = {
    'Cookie': cookieStr,
    'x-xsrf-token': xsrf,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://weibo.com',
    'x-requested-with': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*',
  };
  const tryFetch = async (url) => {
    const resp = await fetch(url, { headers: commonHeaders });
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return null; }
  };
  try {
    // Primary: mymblog returns ok=1 when authenticated; user info in first post
    let data = await tryFetch('https://weibo.com/ajax/statuses/mymblog?page=1&feature=0');
    if (data?.ok === 1) {
      const user = data?.data?.list?.[0]?.user ?? null;
      return res.json({ ok: true, valid: true, missingRec,
        uid: user?.id ?? null,
        name: user?.screen_name ?? '已验证',
        avatar: user?.profile_image_url ?? null });
    }
    // Fallback: profile/info with uid extracted from SUB cookie
    const subMatch = cookieStr.match(/(?:^|;\s*)SUB=([^;]+)/);
    if (subMatch) {
      // try profile info with no uid — Weibo sometimes returns current user
      data = await tryFetch('https://weibo.com/ajax/profile/info');
      const user = data?.data?.user;
      if (user) {
        return res.json({ ok: true, valid: true, missingRec, uid: user.id, name: user.screen_name, avatar: user.profile_image_url });
      }
    }
    const reason = data ? 'Cookie 无效或已过期' : '服务器返回非 JSON 响应';
    return res.json({ ok: false, valid: false, error: reason, missingRec });
  } catch (e) {
    return res.json({ ok: false, valid: false, error: `网络请求失败: ${e.message}`, missingRec });
  }
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
  const { mid, content } = req.body;
  return client.repostTweet({ mid: resolveMid(mid), content });
}));

// ── comments ──────────────────────────────────────────────
app.post('/api/comment-tweet', wrap(async (client, req) => {
  const { mid, content } = req.body;
  return client.commentTweet({ mid: resolveMid(mid), content });
}));

app.post('/api/reply-comment', wrap(async (client, req) => {
  const { mid, cid, content } = req.body;
  return client.replyComment({ mid: resolveMid(mid), cid, content });
}));

app.post('/api/delete-comment', wrap(async (client, req) => {
  return client.deleteComment({ cid: req.body.cid });
}));

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
  '/api/post-tweet':        (c, b) => c.postTweet({ content: b.content, pid: b.pid, mid: b.mid, videoTitle: b.videoTitle, videoType: b.videoType }),
  '/api/delete-tweet':      (c, b) => c.deleteTweet({ mid: resolveMid(b.mid) }),
  '/api/quick-repost':      (c, b) => c.quickRepost({ mid: resolveMid(b.mid) }),
  '/api/repost-tweet':      (c, b) => c.repostTweet({ mid: resolveMid(b.mid), content: b.content }),
  '/api/comment-tweet':     (c, b) => c.commentTweet({ mid: resolveMid(b.mid), content: b.content }),
  '/api/reply-comment':     (c, b) => c.replyComment({ mid: resolveMid(b.mid), cid: b.cid, content: b.content }),
  '/api/delete-comment':    (c, b) => c.deleteComment({ cid: b.cid }),
  '/api/follow-user':       (c, b) => c.followUser({ uid: b.uid }),
  '/api/unfollow-user':     (c, b) => c.unfollowUser({ uid: b.uid }),
  '/api/like-tweet':        (c, b) => c.likeTweet({ mid: resolveMid(b.mid) }),
  '/api/unlike-tweet':      (c, b) => c.unlikeTweet({ mid: resolveMid(b.mid) }),
  '/api/follow-super-topic':(c, b) => c.followSuperTopic({ topicId: b.topicId, name: b.name }),
};

// SSE streaming batch — sends one event per account as it completes
app.post('/api/batch-stream', async (req, res) => {
  const { endpoint, body: params = {}, delay = 3000, loops = 1, roundDelay = 0, selectedAccounts } = req.body;
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
  const totalRounds = Math.max(1, Math.floor(loops));
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

  send({ type: 'start', total, totalRounds, accountCount });

  const waitMs = async (ms, label) => {
    let remaining = ms;
    while (remaining > 0) {
      send({ type: 'waiting', label, remaining, total });
      const tick = Math.min(1000, remaining);
      await new Promise(r => setTimeout(r, tick));
      remaining -= tick;
    }
  };

  for (let loop = 0; loop < totalRounds; loop++) {
    if (loop > 0 && roundDelay > 0) {
      await waitMs(roundDelay, `第 ${loop + 1} 轮开始前等待`);
    }
    for (let pos = 0; pos < indices.length; pos++) {
      const i = indices[pos];
      const stepNum = loop * accountCount + pos + 1;
      if (pos > 0 && delay > 0) {
        await waitMs(delay, `账号 ${i + 1} 等待中`);
      }
      send({ type: 'running', account: i + 1, loop: loop + 1, totalRounds, step: stepNum, total });
      try {
        const cookie = accounts[i]?.cookie;
        if (!cookie) throw new Error(`Account ${i} not found`);
        const client = createClient(cookie);
        const resolved = resolveParams(params);
        const pickedContent = (params.useRandom && params.randomField) ? (resolved[params.randomField] ?? null) : null;
        const data = await handler(client, resolved);
        send({ type: 'result', account: i + 1, loop: loop + 1, totalRounds, step: stepNum, total, ok: true, data, pickedContent });
      } catch (err) {
        console.error(`Batch loop ${loop + 1} account ${i + 1}:`, err.message);
        send({ type: 'result', account: i + 1, loop: loop + 1, totalRounds, step: stepNum, total, ok: false, error: err.message });
      }
    }
  }

  send({ type: 'done', total });
  res.end();
});

// ── start ─────────────────────────────────────────────────
import { execSync } from 'child_process';

const PORT = 3001;

async function start() {
  const server = app.listen(PORT, () => console.log(`Weibo backend running on http://localhost:${PORT}`));

  server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use — killing conflicting process…`);
    try {
      const result = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf-8' });
      const pids = [...new Set(
        result.split('\n')
          .filter(l => l.includes('LISTENING'))
          .map(l => l.trim().split(/\s+/).pop())
          .filter(p => p && p !== '0')
      )];
      for (const p of pids) {
        try { execSync(`taskkill /F /PID ${p}`); console.log(`Killed PID ${p}`); } catch {}
      }
    } catch {}
    setTimeout(() => {
      server.close();
      app.listen(PORT, () => console.log(`Weibo backend running on http://localhost:${PORT}`));
    }, 500);
  } else {
    console.error(err);
  }
  });
}

start().catch(err => { console.error('Failed to start:', err.message); process.exit(1); });
