// db.js — MongoDB Atlas connection with local-file fallback
import 'dotenv/config';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
}
import { MongoClient } from 'mongodb';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COPY_PATH      = path.join(__dirname, 'copywriting.json');
const COOKIES_PATH   = path.resolve(__dirname, '../../cookies.yaml');
const NAMES_PATH     = path.join(__dirname, 'account-names.json');
const PROXIES_PATH   = path.join(__dirname, 'proxies.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');

const DB_NAME        = process.env.MONGODB_DB                   ?? 'weibo_app';
const COPY_COL       = process.env.MONGODB_COLLECTION           ?? 'copywriting';
const ACCOUNTS_COL   = process.env.MONGODB_ACCOUNTS_COLLECTION  ?? 'accounts';
const SCHEDULES_COL  = process.env.MONGODB_SCHEDULES_COLLECTION ?? 'schedules';
const KEEPALIVE_LOGS_COL = process.env.MONGODB_KEEPALIVE_LOGS_COLLECTION ?? 'keepalive_logs';

let client;
let db;

export function isDBConfigured() {
  return !!process.env.MONGODB_URI;
}

export async function connectDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in environment variables.');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`Connected to MongoDB (${DB_NAME})`);
  return db;
}

async function col(name) {
  await connectDB();
  return db.collection(name);
}

// ── copywriting ────────────────────────────────────────────────────────────

function loadCopywritingFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(COPY_PATH, 'utf-8'));
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') {
      return [{ name: '默认', items: raw }];
    }
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveCopywritingFile(groups) {
  fs.writeFileSync(COPY_PATH, JSON.stringify(groups, null, 2), 'utf-8');
}

/** Returns all copywriting groups as [{ name, items }] */
export async function getCopywritingGroups() {
  if (!isDBConfigured()) return loadCopywritingFile();
  return (await col(COPY_COL))
    .find({}, { projection: { _id: 0, name: 1, items: 1 } })
    .toArray();
}

/** Replaces the entire copywriting collection with the given groups */
export async function setCopywritingGroups(groups) {
  if (!isDBConfigured()) { saveCopywritingFile(groups); return; }
  const c = await col(COPY_COL);
  await c.deleteMany({});
  if (groups.length > 0) {
    await c.insertMany(groups.map(g => ({ name: g.name, items: g.items })));
  }
}

// ── accounts ───────────────────────────────────────────────────────────────

const SECRET = process.env.COOKIE_SECRET;
const ALG = 'aes-256-gcm';

function ensureSecret() {
  if (!SECRET || Buffer.from(SECRET, 'hex').length !== 32) {
    throw new Error('COOKIE_SECRET must be a 64-char hex string (32 bytes) in .env');
  }
  return Buffer.from(SECRET, 'hex');
}

function encrypt(plaintext) {
  const key = ensureSecret();
  const iv  = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(ciphertext) {
  const key = ensureSecret();
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

function cookieFieldValue(cookieStr, key) {
  const match = String(cookieStr ?? '').match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match?.[1] ?? '';
}

function compactCookie(cookieStr, uid = '') {
  const sub = cookieFieldValue(cookieStr, 'SUB');
  if (!sub) return '';
  const normalizedUid = /^\d{10,}$/.test(String(uid)) ? String(uid).slice(0, 10) : '';
  if (!normalizedUid) return '';
  return `${normalizedUid}----${sub}`;
}

function loadAccountsFile() {
  const data = yaml.load(fs.readFileSync(COOKIES_PATH, 'utf-8')) ?? {};
  const cookies = data?.cookies?.web ?? [];
  let names = [];
  let proxies = [];
  try { names = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf-8')); } catch {}
  try { proxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf-8')); } catch {}
  return cookies.map((cookie, i) => ({ cookie, name: names[i] ?? `账号 ${i + 1}`, proxy: proxies[i] ?? '' }));
}

function saveAccountsFile(accounts) {
  const existing = yaml.load(fs.readFileSync(COOKIES_PATH, 'utf-8')) ?? {};
  existing.cookies = existing.cookies ?? {};
  existing.cookies.web = accounts.map(a => a.cookie);
  fs.writeFileSync(COOKIES_PATH, yaml.dump(existing, { lineWidth: -1 }), 'utf-8');
  fs.writeFileSync(NAMES_PATH, JSON.stringify(accounts.map(a => a.name), null, 2), 'utf-8');
  fs.writeFileSync(PROXIES_PATH, JSON.stringify(accounts.map(a => a.proxy ?? ''), null, 2), 'utf-8');
}

/** Returns all accounts as [{ cookie, name, proxy }] in index order */
export async function getAccounts() {
  if (!isDBConfigured()) return loadAccountsFile();
  const docs = await (await col(ACCOUNTS_COL))
    .find({}, { projection: { _id: 0, index: 1, name: 1, cookie: 1, proxy: 1, uid: 1, cookieCompact: 1 } })
    .sort({ index: 1 })
    .toArray();
  return docs.map(d => ({
    name: d.name,
    cookie: decrypt(d.cookie),
    uid: d.uid ? String(d.uid) : '',
    cookieCompact: d.cookieCompact ? String(d.cookieCompact) : '',
    proxy: d.proxy ? (() => { try { return decrypt(d.proxy); } catch { return ''; } })() : '',
  }));
}

/** Replaces all accounts with the given [{ cookie, name, proxy }] list */
export async function setAccounts(accounts) {
  if (!isDBConfigured()) { saveAccountsFile(accounts); return; }
  const c = await col(ACCOUNTS_COL);
  await c.deleteMany({});
  if (accounts.length > 0) {
    await c.insertMany(
      accounts.map((a, i) => ({
        index: i,
        name: a.name,
        cookie: encrypt(a.cookie),
        uid: a.uid ? String(a.uid) : '',
        cookieCompact: compactCookie(a.cookie, a.uid),
        proxy: a.proxy ? encrypt(a.proxy) : '',
      }))
    );
  }
}

// ── schedules ──────────────────────────────────────────────────────────────

function loadSchedulesFile() {
  try { return JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf-8')); } catch { return []; }
}
function saveSchedulesFile(schedules) {
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2), 'utf-8');
}

/** Returns all schedule jobs */
export async function getSchedules() {
  if (!isDBConfigured()) {
    // heal file jobs that lack an id
    const list = loadSchedulesFile();
    let changed = false;
    for (const j of list) {
      if (!j.id) {
        j.id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        changed = true;
      }
    }
    if (changed) saveSchedulesFile(list);
    return list;
  }
  const c = await col(SCHEDULES_COL);
  const docs = await c.find({}).sort({ scheduledAt: 1 }).toArray();
  // heal MongoDB jobs that lack an id, expose _id as _dbId
  const ops = [];
  for (const doc of docs) {
    if (!doc.id) {
      const newId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      doc.id = newId;
      ops.push(c.updateOne({ _id: doc._id }, { $set: { id: newId } }));
    }
    doc._dbId = String(doc._id);
    delete doc._id;
  }
  if (ops.length) await Promise.all(ops);
  return docs;
}

/** Add a new schedule job */
export async function addSchedule(job) {
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fullJob = { id, ...job };
  if (!isDBConfigured()) {
    const list = loadSchedulesFile();
    list.push(fullJob);
    saveSchedulesFile(list);
    return fullJob;
  }
  await (await col(SCHEDULES_COL)).insertOne({ ...fullJob });
  return fullJob;
}

/** Patch fields on an existing schedule by id */
export async function updateSchedule(id, patch) {
  if (!isDBConfigured()) {
    const list = loadSchedulesFile();
    const idx = list.findIndex(j => j.id === id);
    if (idx !== -1) { list[idx] = { ...list[idx], ...patch }; saveSchedulesFile(list); }
    return;
  }
  await (await col(SCHEDULES_COL)).updateOne({ id }, { $set: patch });
}

/** Delete a schedule job by id or _dbId */
export async function deleteSchedule(id) {
  if (!isDBConfigured()) {
    saveSchedulesFile(loadSchedulesFile().filter(j => j.id !== id));
    return;
  }
  const c = await col(SCHEDULES_COL);
  // try by logical id first, then fall back to MongoDB _id string
  const res = await c.deleteOne({ id });
  if (res.deletedCount === 0) {
    try {
      const { ObjectId } = await import('mongodb');
      await c.deleteOne({ _id: new ObjectId(id) });
    } catch { /* not a valid ObjectId, ignore */ }
  }
}

// ── keep-alive logs ───────────────────────────────────────────────────────

/** Save a keep-alive log entry */
export async function saveKeepAliveLog(log) {
  if (!isDBConfigured()) return; // Keep in-memory only if no DB configured
  const c = await col(KEEPALIVE_LOGS_COL);
  await c.insertOne({
    ranAt: new Date(log.ranAt),
    results: log.results,
    createdAt: new Date(),
  });
}

/** Get keep-alive log history (latest first) */
export async function getKeepAliveLogs(limit = 20) {
  if (!isDBConfigured()) return [];
  const c = await col(KEEPALIVE_LOGS_COL);
  return c
    .find({}, { projection: { _id: 1, ranAt: 1, results: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/** Get latest keep-alive log */
export async function getLatestKeepAliveLog() {
  if (!isDBConfigured()) return null;
  const c = await col(KEEPALIVE_LOGS_COL);
  return c.findOne({}, { sort: { createdAt: -1 } });
}

/** Save keep-alive configuration to MongoDB */
export async function saveKeepAliveConfig(intervalMs, firstDelayMs) {
  if (!isDBConfigured()) return null;
  const c = await col(KEEPALIVE_LOGS_COL);
  return c.updateOne(
    { _id: 'keep-alive-config' },
    {
      $set: {
        intervalMs,
        firstDelayMs,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/** Load keep-alive configuration from MongoDB */
export async function getKeepAliveConfig() {
  if (!isDBConfigured()) return null;
  const c = await col(KEEPALIVE_LOGS_COL);
  return c.findOne({ _id: 'keep-alive-config' });
}
