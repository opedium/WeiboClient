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
const COPY_PATH    = path.join(__dirname, 'copywriting.json');
const COOKIES_PATH = path.resolve(__dirname, '../../cookies.yaml');
const NAMES_PATH   = path.join(__dirname, 'account-names.json');

const DB_NAME      = process.env.MONGODB_DB                   ?? 'weibo_app';
const COPY_COL     = process.env.MONGODB_COLLECTION           ?? 'copywriting';
const ACCOUNTS_COL = process.env.MONGODB_ACCOUNTS_COLLECTION  ?? 'accounts';

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

function loadAccountsFile() {
  const data = yaml.load(fs.readFileSync(COOKIES_PATH, 'utf-8')) ?? {};
  const cookies = data?.cookies?.web ?? [];
  let names = [];
  try { names = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf-8')); } catch {}
  return cookies.map((cookie, i) => ({ cookie, name: names[i] ?? `账号 ${i + 1}` }));
}

function saveAccountsFile(accounts) {
  const existing = yaml.load(fs.readFileSync(COOKIES_PATH, 'utf-8')) ?? {};
  existing.cookies = existing.cookies ?? {};
  existing.cookies.web = accounts.map(a => a.cookie);
  fs.writeFileSync(COOKIES_PATH, yaml.dump(existing, { lineWidth: -1 }), 'utf-8');
  fs.writeFileSync(NAMES_PATH, JSON.stringify(accounts.map(a => a.name), null, 2), 'utf-8');
}

/** Returns all accounts as [{ cookie, name }] in index order */
export async function getAccounts() {
  if (!isDBConfigured()) return loadAccountsFile();
  const docs = await (await col(ACCOUNTS_COL))
    .find({}, { projection: { _id: 0, index: 1, name: 1, cookie: 1 } })
    .sort({ index: 1 })
    .toArray();
  return docs.map(d => ({ name: d.name, cookie: decrypt(d.cookie) }));
}

/** Replaces all accounts with the given [{ cookie, name }] list */
export async function setAccounts(accounts) {
  if (!isDBConfigured()) { saveAccountsFile(accounts); return; }
  const c = await col(ACCOUNTS_COL);
  await c.deleteMany({});
  if (accounts.length > 0) {
    await c.insertMany(
      accounts.map((a, i) => ({ index: i, name: a.name, cookie: encrypt(a.cookie) }))
    );
  }
}
