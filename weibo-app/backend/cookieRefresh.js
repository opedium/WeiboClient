/**
 * ── Weibo Cookie Refresh & Keep-Alive System ──────────────────────────────────
 * 
 * Cookie Strengthening Strategies:
 * 
 * 1. REQUIRED FIELDS (Critical for session validity)
 *    - SUB: Core Weibo session identifier
 *    - XSRF-TOKEN: CSRF protection token (required for POST requests)
 *    Without both, the session is invalid and will be rejected.
 * 
 * 2. SUPPLEMENTARY FIELDS (Make cookies more resilient)
 *    - SUBP: Supplementary SUB parameter (device/browser fingerprint)
 *    - SCF: Security context flag (indicates valid authentication state)
 *    Cookies with both SUBP+SCF are considered "strong" and more resistant to expiration.
 * 
 * 3. SESSION POLLING TIMEOUT
 *    - Extended from 25s → 40s to give browser time to load all cookies
 *    - Polls multiple domains (weibo.com, sina.com.cn) for cookie sources
 *    - Waits for async cookie setting to complete (especially over slow proxies)
 * 
 * 4. MULTI-DOMAIN COOKIE HARVESTING
 *    - Collects cookies from all relevant Weibo domains
 *    - Merges them using domain priority scoring (weibo.com > www.weibo.com > sina.com.cn)
 *    - Ensures complete session state is captured
 * 
 * 5. BROWSER PROFILE PERSISTENCE
 *    - Uses Playwright persistent contexts with saved auth profiles
 *    - Profile directory structure: ~/.auth-profiles/account-{index}/
 *    - Stores all cookies, cache, and session state across refreshes
 *    - Automatic migration from old {index}-{name} format to index-only on startup
 * 
 * 6. KEEP-ALIVE SCHEDULING
 *    - Default: first refresh 6h after startup, then every 24h
 *    - Configurable via KEEP_ALIVE_INTERVAL_MS, KEEP_ALIVE_FIRST_DELAY_MS
 *    - Weak cookies (only SUB/XSRF, no SUBP/SCF) warrant more frequent refresh
 * 
 * 7. SESSION VALIDATION
 *    - Before refresh: validates current cookie still has required fields
 *    - Skips refresh if cookie already logged out/invalid
 *    - Reports health status: "strong" (all fields), "normal" (most fields), "weak" (minimal)
 * 
 * Common Issues & Solutions:
 *    - SESSION_EXPIRED: Browser profile exists but cookies didn't load
 *      → Check proxy stability, increase timeout, ensure profile dir has permissions
 *    - no_profile: Browser profile not initialized
 *      → Run QR login (startQrLoginSession) or manual login first
 *    - Weak cookies: Missing SUBP/SCF despite valid session
 *      → Normal for some accounts; refresh more frequently or re-login to refresh state
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '.auth-profiles');
const COOKIE_REFRESH_MODE = String(process.env.COOKIE_REFRESH_MODE ?? 'auto').trim().toLowerCase();
const QR_LOGIN_TTL_MS = Math.max(60_000, Number.parseInt(process.env.QR_LOGIN_TTL_MS ?? '180000', 10) || 180_000);
const CAPTCHA_TTL_MS = Math.max(60_000, Number.parseInt(process.env.CAPTCHA_TTL_MS ?? '900000', 10) || 900_000);
const qrSessions = new Map();
const captchaSessions = new Map();

// Edge browser detection
function getEdgeExecutablePath() {
  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\MicrosoftEdge.exe',
  ];
  for (const edgePath of possiblePaths) {
    if (fs.existsSync(edgePath)) return edgePath;
  }
  return null; // Fall back to system default
}

function canOpenVisibleBrowser() {
  if (COOKIE_REFRESH_MODE === 'headless') return false;
  if (COOKIE_REFRESH_MODE === 'manual') return true;
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function explainHeadfulNotAvailable(reason = '当前环境不支持可视化浏览器') {
  return `${reason}。此服务器将仅尝试无头刷新；若 Cookie 已过期，请在本地桌面环境完成刷新后再保存到服务器。`;
}

function getQrSession(sessionId) {
  const session = qrSessions.get(sessionId);
  if (!session) return null;
  const terminal = ['success', 'failed', 'cancelled', 'expired'];
  if (terminal.includes(session.status)) {
    const terminalAt = session.completedAt ? Date.parse(session.completedAt) : session.createdAt;
    if (Number.isFinite(terminalAt) && Date.now() - terminalAt > 5 * 60 * 1000) {
      qrSessions.delete(sessionId);
      return null;
    }
  }
  if (Date.now() > session.expiresAt && !['success', 'failed', 'cancelled', 'expired'].includes(session.status)) {
    session.status = 'expired';
    session.error = '二维码已过期，请重新获取';
    session.completedAt = new Date().toISOString();
    void closeQrSessionContext(sessionId);
  }
  return session;
}

async function closeQrSessionContext(sessionId) {
  const session = qrSessions.get(sessionId);
  if (!session) return;
  if (session.context) {
    try { await session.context.close(); } catch {}
    session.context = null;
  }
}

async function readQrImageDataUrl(context, page) {
  const selectors = [
    'img[node-type="qrcode_img"]',
    'img.qrcode_img',
    'img[src*="qrcode"]',
    'img[src*="qr"]',
  ];

  let src = '';
  for (const sel of selectors) {
    try {
      // Reduced from 9s to 5s — QR image usually renders within 2-3s for local connections
      await page.waitForSelector(sel, { timeout: 5000 });
      src = await page.$eval(sel, node => String(node.getAttribute('src') ?? '').trim());
      if (src) break;
    } catch {
      // Try next selector.
    }
  }

  if (!src) {
    throw new Error('未找到微博登录二维码');
  }

  if (src.startsWith('data:image/')) {
    return src;
  }

  const abs = new URL(src, page.url()).toString();
  const resp = await context.request.get(abs, {
    timeout: 20_000,
    failOnStatusCode: false,
    headers: {
      Referer: page.url(),
      Origin: 'https://passport.weibo.com',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  const body = await resp.body();
  const ct = resp.headers()['content-type'] || 'image/png';
  return `data:${ct};base64,${body.toString('base64')}`;
}

async function monitorQrSession(sessionId) {
  const session = qrSessions.get(sessionId);
  if (!session) return;
  const { context } = session;

  try {
    while (true) {
      const s = qrSessions.get(sessionId);
      if (!s) return;
      if (s.status === 'cancelled') return;
      if (Date.now() > s.expiresAt) {
        s.status = 'expired';
        s.error = '二维码已过期，请重新获取';
        s.completedAt = new Date().toISOString();
        await closeQrSessionContext(sessionId);
        return;
      }

      const cookies = await context.cookies([
        'https://weibo.com',
        'https://www.weibo.com',
        'https://login.sina.com.cn',
        'https://passport.weibo.com',
      ]);
      const cookieStr = toCookieString(cookies);
      if (hasRequiredSessionCookies(cookieStr)) {
        s.status = 'success';
        s.cookie = cookieStr;
        s.completedAt = new Date().toISOString();
        await closeQrSessionContext(sessionId);
        return;
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (error) {
    const s = qrSessions.get(sessionId);
    if (!s) return;
    s.status = 'failed';
    s.error = String(error?.message ?? error);
    s.completedAt = new Date().toISOString();
    await closeQrSessionContext(sessionId);
  }
}

export async function startQrLoginSession({ accountIndex, accountName = '', proxy = '', maxWaitMs = QR_LOGIN_TTL_MS }) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const userDataDir = profileDirForAccount(accountIndex, accountName);
  fs.mkdirSync(userDataDir, { recursive: true });

  const proxyConfig = parsePlaywrightProxy(proxy);
  // Reduced timeouts: 30s for local (usually loads in 5-15s), 60s for proxy (more unpredictable)
  const navTimeoutMs = proxyConfig ? 60_000 : 30_000;
  const edgePath = getEdgeExecutablePath();
  
  // Add timeout to browser launch
  let launchTimeoutId;
  const launchPromise = chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: edgePath || undefined,
    proxy: proxyConfig || undefined,
  });
  
  const launchWithTimeout = Promise.race([
    launchPromise,
    new Promise((_, reject) => {
      launchTimeoutId = setTimeout(
        () => reject(new Error('Browser launch timeout (45s) — profile may be corrupted')),
        45_000
      );
    })
  ]).finally(() => clearTimeout(launchTimeoutId));
  
  const context = await launchWithTimeout;

  try {
    await context.clearCookies();
    const page = context.pages()[0] ?? await context.newPage();
    await gotoWithRetry(
      page,
      'https://passport.weibo.com/sso/signin?entry=weibo&r=https%3A%2F%2Fweibo.com%2F',
      { timeoutMs: navTimeoutMs, attempts: 2 }
    );

    const qrDataUrl = await readQrImageDataUrl(context, page);
    const sessionId = randomUUID();
    const ttlMs = Math.max(60_000, Math.min(10 * 60 * 1000, Number.parseInt(maxWaitMs, 10) || QR_LOGIN_TTL_MS));
    const now = Date.now();
    const session = {
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      qrDataUrl,
      context,
      cookie: '',
      error: null,
      completedAt: null,
    };

    qrSessions.set(sessionId, session);
    void monitorQrSession(sessionId);

    return {
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      qrDataUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  } catch (error) {
    try { await context.close(); } catch {}
    throw error;
  }
}

export function getQrLoginStatus(sessionId) {
  const session = getQrSession(sessionId);
  if (!session) {
    return { found: false, status: 'not_found', error: '会话不存在或已结束' };
  }

  return {
    found: true,
    sessionId,
    accountIndex: session.accountIndex,
    accountName: session.accountName,
    status: session.status,
    error: session.error,
    qrDataUrl: session.qrDataUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
    completedAt: session.completedAt,
    cookie: session.status === 'success' ? session.cookie : '',
  };
}

export async function cancelQrLoginSession(sessionId) {
  const session = qrSessions.get(sessionId);
  if (!session) {
    return { ok: false, status: 'not_found' };
  }
  session.status = 'cancelled';
  session.error = '已取消';
  session.completedAt = new Date().toISOString();
  await closeQrSessionContext(sessionId);
  qrSessions.delete(sessionId);
  return { ok: true, status: 'cancelled' };
}

export async function checkPlaywrightRuntime() {
  let browser;
  try {
    const edgePath = getEdgeExecutablePath();
    browser = await chromium.launch({ headless: true, executablePath: edgePath || undefined });
    await browser.close();
    return { ok: true };
  } catch (error) {
    try { if (browser) await browser.close(); } catch {}
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function hasCookieField(cookieStr, key) {
  return new RegExp(`(?:^|;\\s*)${key}=`).test(cookieStr);
}

function hasRequiredSessionCookies(cookieStr) {
  // Keep aligned with backend validator: required = SUB + XSRF-TOKEN.
  return hasCookieField(cookieStr, 'SUB') && hasCookieField(cookieStr, 'XSRF-TOKEN');
}

function slugify(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function profileDirForAccount(accountIndex, accountName) {
  // Use index-only naming (robust to name changes)
  // Old format: account-1-name -> New format: account-1
  const key = `account-${accountIndex + 1}`;
  return path.join(AUTH_DIR, key);
}

function toCookieString(cookies) {
  // Prefer values that belong to weibo domains when duplicate names exist.
  const scoreDomain = (domainRaw) => {
    const d = String(domainRaw ?? '').toLowerCase();
    if (d === 'weibo.com' || d === '.weibo.com' || d.endsWith('.weibo.com')) return 3;
    if (d === 'www.weibo.com') return 2;
    if (d === 'sina.com.cn' || d === '.sina.com.cn' || d.endsWith('.sina.com.cn')) return 1;
    return 0;
  };

  const selected = new Map();
  for (const c of cookies ?? []) {
    if (!c?.name || typeof c.value !== 'string') continue;
    const prev = selected.get(c.name);
    if (!prev) {
      selected.set(c.name, c);
      continue;
    }
    const nextScore = scoreDomain(c.domain);
    const prevScore = scoreDomain(prev.domain);
    if (nextScore > prevScore) {
      selected.set(c.name, c);
    }
  }

  return Array.from(selected.values())
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function parsePlaywrightProxy(proxyStr) {
  const raw = String(proxyStr ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const out = { server };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    // Fallback for simple host:port or malformed URI; Playwright will validate later.
    return { server: raw };
  }
}

function isNavigationTimeoutError(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('Timeout') || msg.includes('ERR_TIMED_OUT');
}

async function gotoWithRetry(page, url, { timeoutMs, attempts = 2, waitUntil = 'domcontentloaded' }) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      return;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await page.waitForTimeout(1200 + i * 800);
      }
    }
  }
  throw lastError;
}

async function touchSessionLightweight(context, timeoutMs) {
  // Avoid full-page rendering (which pulls heavy sinaimg assets through proxy).
  // These endpoints are enough to validate and refresh authenticated session activity.
  const endpoints = [
    'https://weibo.com/ajax/profile/info',
    'https://weibo.com/ajax/statuses/mymblog?page=1&feature=0',
  ];
  for (const url of endpoints) {
    try {
      await context.request.get(url, {
        timeout: timeoutMs,
        failOnStatusCode: false,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'x-requested-with': 'XMLHttpRequest',
          'Referer': 'https://weibo.com',
          'Origin': 'https://weibo.com',
        },
      });
      return;
    } catch {
      // Try next endpoint.
    }
  }
  throw new Error('LIGHTWEIGHT_TOUCH_FAILED');
}

function profileHasSession(userDataDir) {
  // Chromium stores login state in a SQLite file inside Default/
  const defaultDir = path.join(userDataDir, 'Default');
  return fs.existsSync(path.join(defaultDir, 'Cookies')) || fs.existsSync(path.join(defaultDir, 'Preferences'));
}

function clearChromiumLocks(userDataDir) {
  // Chromium leaves these files when killed mid-session. They prevent relaunching the profile.
  const lockFiles = [
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonSocket'),
    path.join(userDataDir, 'SingletonCookie'),
    path.join(userDataDir, 'lockfile'),
    path.join(userDataDir, '.refresh.lock'),
    path.join(userDataDir, 'Default', 'Cookies-journal'),
    path.join(userDataDir, 'Default', 'Preferences-journal'),
  ];
  for (const f of lockFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function withProfileLock(userDataDir, fn) {
  const lockPath = path.join(userDataDir, '.refresh.lock');
  const lockFd = fs.openSync(lockPath, 'w');
  try { fs.writeSync(lockFd, `${process.pid} ${new Date().toISOString()}`); } catch {}
  try {
    return await fn();
  } finally {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// ── Profile Directory Migration ─────────────────────────────────────────────
// Migrate old format (account-N-{name}) to new format (account-N)
async function migrateProfileDirectories() {
  if (!fs.existsSync(AUTH_DIR)) return;
  
  try {
    const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
    let migratedCount = 0;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      
      // Match old format: account-N-{anything}
      const match = name.match(/^account-(\d+)(?:-.*)?$/);
      if (!match) continue;
      
      const newName = `account-${match[1]}`;
      
      // Skip if already in new format
      if (name === newName) continue;
      
      // Check if new format already exists
      const oldPath = path.join(AUTH_DIR, name);
      const newPath = path.join(AUTH_DIR, newName);
      
      if (fs.existsSync(newPath)) {
        // New format exists, remove old one
        fs.rmSync(oldPath, { recursive: true, force: true });
        console.log(`  [migration] removed old profile ${name} (new format ${newName} exists)`);
        migratedCount++;
      } else {
        // Rename old to new
        fs.renameSync(oldPath, newPath);
        console.log(`  [migration] renamed ${name} → ${newName}`);
        migratedCount++;
      }
    }
    
    if (migratedCount > 0) {
      console.log(`✅ Profile migration: ${migratedCount} directories updated to index-only format`);
    }
  } catch (err) {
    console.warn(`⚠️  Profile migration failed: ${err.message}`);
  }
}

// Run migration on module load
migrateProfileDirectories().catch(err => console.error('Migration error:', err));

/**
 * Headless refresh: reuses the existing persistent profile so no manual login is needed.
 * Navigates to weibo.com and extracts the session cookies from the saved profile.
 * Throws if the session has expired (missing required cookies after navigation).
 */
async function refreshCookieHeadless({ userDataDir, proxy = '' }) {
  const proxyConfig = parsePlaywrightProxy(proxy);
  // Reduced timeouts: 30s for local (usually loads in 5-15s), 60s for proxy (more unpredictable)
  const navTimeoutMs = proxyConfig ? 60_000 : 30_000;
  let context;
  try {
    clearChromiumLocks(userDataDir);
    const edgePath = getEdgeExecutablePath();
    
    // Add timeout to browser launch (prevents infinite hang on corrupted profiles)
    let launchTimeoutId;
    const launchPromise = chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: edgePath || undefined,
      proxy: proxyConfig || undefined,
    });
    
    const launchWithTimeout = Promise.race([
      launchPromise,
      new Promise((_, reject) => {
        launchTimeoutId = setTimeout(
          () => reject(new Error('Browser launch timeout (45s) — profile may be corrupted')),
          45_000
        );
      })
    ]).finally(() => clearTimeout(launchTimeoutId));
    
    context = await launchWithTimeout;

    // Lightweight session touch: avoids expensive homepage assets over proxy.
    try {
      await touchSessionLightweight(context, navTimeoutMs);
    } catch {
      // Fallback to page navigation only if lightweight call path fails.
      const page = context.pages()[0] ?? await context.newPage();
      await gotoWithRetry(page, 'https://weibo.com/', { timeoutMs: navTimeoutMs, attempts: 2 });
    }

    // Wait for cookies with extended polling (accounts for slow proxy/async cookie setting).
    // Check multiple cookie domains and poll longer to strengthen session detection.
    const allDomains = ['https://weibo.com', 'https://www.weibo.com', 'https://sina.com.cn'];
    const deadline = Date.now() + 40_000; // Increased from 25s to 40s for better resilience
    let lastSeenPartialCookies = { hasSub: false, hasXsrf: false };
    
    while (Date.now() < deadline) {
      const cookies = await context.cookies(allDomains);
      const cookieStr = toCookieString(cookies);
      
      // Track what we have for diagnostics
      const hasSub = hasCookieField(cookieStr, 'SUB');
      const hasXsrf = hasCookieField(cookieStr, 'XSRF-TOKEN');
      const hasSubp = hasCookieField(cookieStr, 'SUBP');
      const hasScf = hasCookieField(cookieStr, 'SCF');
      
      if (hasSub !== lastSeenPartialCookies.hasSub || hasXsrf !== lastSeenPartialCookies.hasXsrf) {
        const fields = [];
        if (hasSub) fields.push('SUB');
        if (hasXsrf) fields.push('XSRF-TOKEN');
        if (hasSubp) fields.push('SUBP');
        if (hasScf) fields.push('SCF');
        console.log(`    [cookie check] found fields: ${fields.length > 0 ? fields.join(', ') : 'none'}`);
        lastSeenPartialCookies = { hasSub, hasXsrf };
      }
      
      if (hasRequiredSessionCookies(cookieStr)) {
        // Cookie is complete — also include supplementary fields if present for strength
        const cookieWithSupp = cookieStr; // Already includes SUBP/SCF from toCookieString
        return { cookie: cookieWithSupp, userDataDir, refreshedAt: new Date().toISOString() };
      }
      
      await new Promise(r => setTimeout(r, 1200));
    }
    
    throw new Error('SESSION_EXPIRED');
  } finally {
    if (context) { try { await context.close(); } catch {} }
  }
}

/**
 * Manual login: opens a visible browser for the user to log in.
 * Only needed the first time or when the session has expired.
 */
async function refreshCookieWithVisibleBrowser({ userDataDir, proxy = '', maxWaitMs = 180000 }) {
  const proxyConfig = parsePlaywrightProxy(proxy);
  // Reduced timeouts: 30s for local (usually loads in 5-15s), 60s for proxy (more unpredictable)
  const navTimeoutMs = proxyConfig ? 60_000 : 30_000;
  let context;
  try {
    clearChromiumLocks(userDataDir);
    const edgePath = getEdgeExecutablePath();
    
    // Add timeout to browser launch
    let launchTimeoutId;
    const launchPromise = chromium.launchPersistentContext(userDataDir, {
      headless: false,
      executablePath: edgePath || undefined,
      viewport: { width: 1280, height: 900 },
      proxy: proxyConfig || undefined,
    });
    
    const launchWithTimeout = Promise.race([
      launchPromise,
      new Promise((_, reject) => {
        launchTimeoutId = setTimeout(
          () => reject(new Error('Browser launch timeout (45s) — profile may be corrupted')),
          45_000
        );
      })
    ]).finally(() => clearTimeout(launchTimeoutId));
    
    context = await launchWithTimeout;

    // Clear stale cookies so the user sees a fresh login page.
    await context.clearCookies();

    const page = context.pages()[0] ?? await context.newPage();

    // Best-effort navigation — if it times out the browser stays open so
    // the user can navigate manually. Never close the browser on nav failure.
    try {
      await gotoWithRetry(
        page,
        'https://passport.weibo.com/sso/signin?entry=weibo&r=https%3A%2F%2Fweibo.com%2F',
        { timeoutMs: navTimeoutMs, attempts: 2 }
      );
    } catch {
      // Navigation failed (slow proxy, DNS, etc.) — browser is still open.
      // Poll below; user can manually navigate inside the window.
    }

    const deadline = Date.now() + Math.max(30000, maxWaitMs);
    let lastNavRecovery = 0;
    while (Date.now() < deadline) {
      // Gather cookies from all relevant domains (SUB can be set on sina.com.cn or weibo.com).
      const cookies = await context.cookies([
        'https://weibo.com',
        'https://www.weibo.com',
        'https://login.sina.com.cn',
        'https://passport.weibo.com',
        'https://weibo.cn',
      ]);
      const cookieStr = toCookieString(cookies);
      if (hasRequiredSessionCookies(cookieStr)) {
        return { cookie: cookieStr, userDataDir, refreshedAt: new Date().toISOString() };
      }

      // After QR scan, Weibo redirects through login.sina.com.cn to set cookies.
      // If that domain is blocked/unreachable, the page lands on a Chrome error screen.
      // Recovery: navigate directly to weibo.com — it will read the session from the
      // browser's internal store and set the weibo.com cookies we need.
      const currentUrl = page.url();
      const isErrorPage = currentUrl.startsWith('chrome-error://') ||
                          currentUrl.includes('ERR_CONNECTION_CLOSED') ||
                          currentUrl.includes('ERR_CONNECTION_REFUSED');
      const isStuckOnSina = currentUrl.includes('login.sina.com.cn');

      if ((isErrorPage || isStuckOnSina) && Date.now() - lastNavRecovery > 8000) {
        lastNavRecovery = Date.now();
        console.log('[cookieRefresh] detected error/blocked page, navigating to weibo.com to recover session...');
        try {
          // Try lightweight endpoint first to reduce proxy bandwidth during recovery.
          await page.goto('https://weibo.com/ajax/profile/info', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {
          try {
            await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            // If weibo.com also fails, just keep polling.
          }
        }
      }

      await page.waitForTimeout(1500);
    }

    throw new Error('等待登录超时：请在打开的浏览器中完成登录后重试');
  } finally {
    if (context) { try { await context.close(); } catch {} }
  }
}

/**
 * Kill any Chromium/Chrome process that was launched with the given userDataDir.
 * On Windows, zombie processes hold file locks that prevent profile deletion.
 */
function killChromiumForProfile(userDataDir) {
  const dirName = path.basename(userDataDir);
  try {
    // Match by profile directory name in the command line — specific enough to avoid
    // killing unrelated browser instances.
    execSync(
      `powershell -NoProfile -Command "` +
      `Get-WmiObject Win32_Process | ` +
      `Where-Object { ($_.Name -like 'chrom*') -and ($_.CommandLine -like '*${dirName.replace(/'/g, '')}*') } | ` +
      `ForEach-Object { $_.Terminate() }"`,
      { stdio: 'ignore', timeout: 8000 }
    );
  } catch { /* ignore — process may already be gone */ }
}

/**
 * Reset: delete the persistent Chromium profile for an account so the next
 * refresh starts from a clean slate (no stale cookies, cache, or session state).
 */
export async function resetBrowserProfile({ accountIndex, accountName = '' }) {
  const userDataDir = profileDirForAccount(accountIndex, accountName);
  if (!fs.existsSync(userDataDir)) {
    return { reset: false, userDataDir };
  }

  // Kill any zombie Chromium holding file locks on this profile.
  killChromiumForProfile(userDataDir);

  // Give the OS a moment to release file handles after process termination.
  await new Promise(r => setTimeout(r, 1500));

  fs.rmSync(userDataDir, { recursive: true, force: true });

  if (fs.existsSync(userDataDir)) {
    return { reset: false, userDataDir, error: '浏览器进程可能仍在运行，无法删除配置文件。请稍候重试。' };
  }
  return { reset: true, userDataDir };
}

// ── CAPTCHA Verification Session ──────────────────────────────

function getCaptchaSession(sessionId) {
  const session = captchaSessions.get(sessionId);
  if (!session) return null;
  const terminal = ['success', 'failed', 'cancelled', 'expired'];
  if (terminal.includes(session.status)) {
    const terminalAt = session.completedAt ? Date.parse(session.completedAt) : session.createdAt;
    if (Number.isFinite(terminalAt) && Date.now() - terminalAt > 5 * 60 * 1000) {
      captchaSessions.delete(sessionId);
      return null;
    }
  }
  if (Date.now() > session.expiresAt && !['success', 'failed', 'cancelled', 'expired'].includes(session.status)) {
    session.status = 'expired';
    session.error = 'CAPTCHA 验证会话已过期，请重新获取';
    session.completedAt = new Date().toISOString();
    void closeCaptchaSessionContext(sessionId);
  }
  return session;
}

async function closeCaptchaSessionContext(sessionId) {
  const session = captchaSessions.get(sessionId);
  if (!session) return;
  if (session.context) {
    try { await session.context.close(); } catch {}
    session.context = null;
  }
  if (session.browser) {
    try { await session.browser.close(); } catch {}
    session.browser = null;
  }
  if (session.monitorInterval) {
    clearInterval(session.monitorInterval);
    session.monitorInterval = null;
  }
}

async function monitorCaptchaSession(sessionId) {
  const session = captchaSessions.get(sessionId);
  if (!session) return;
  const { context } = session;

  try {
    let consecutiveEmpty = 0;
    const maxEmpty = 300; // 300 checks = ~10 minutes of no cookie activity (give user plenty of time)
    let checkCount = 0;

    while (true) {
      checkCount++;
      const s = captchaSessions.get(sessionId);
      if (!s) return;
      if (s.status === 'cancelled') return;
      if (Date.now() > s.expiresAt) {
        s.status = 'expired';
        s.error = 'CAPTCHA 验证会话已过期（超过15分钟）';
        s.completedAt = new Date().toISOString();
        console.log(`[CAPTCHA] Session ${sessionId.slice(0, 8)}... expired after ${checkCount * 2}s`);
        await closeCaptchaSessionContext(sessionId);
        return;
      }

      // Check if cookies have been updated (user completed CAPTCHA or login)
      // Try multiple domain options since cookies might be on any Weibo domain
      let cookies = await context.cookies(['https://weibo.com', 'https://www.weibo.com']);
      if (!cookies || cookies.length === 0) {
        cookies = await context.cookies(); // Get all cookies if specific domain didn't work
      }
      const cookieStr = toCookieString(cookies);
      
      // Also check for verification success indicators
      // Sometimes after CAPTCHA is solved, we might see other cookies or page state changes
      const allCookies = await context.cookies();
      const hasAnySessionIndicators = allCookies.length > 3; // More than just basic cookies

      // Debug: log cookies detected
      const hasSub = hasCookieField(cookieStr, 'SUB');
      const hasXsrf = hasCookieField(cookieStr, 'XSRF-TOKEN');
      if (checkCount % 10 === 1) { // Log every ~20 seconds
        console.log(`[CAPTCHA] Session ${sessionId.slice(0, 8)}... check #${checkCount}: SUB=${hasSub}, XSRF-TOKEN=${hasXsrf}, cookies=${cookieStr.split(';').length} items`);
      }

      // If session cookies are present, assume CAPTCHA was solved
      if (hasRequiredSessionCookies(cookieStr)) {
        s.status = 'success';
        s.cookie = cookieStr;
        s.completedAt = new Date().toISOString();
        console.log(`[CAPTCHA] Session ${sessionId.slice(0, 8)}... SUCCESS! Required cookies detected after ${checkCount * 2}s`);
        await closeCaptchaSessionContext(sessionId);
        return;
      }

      // Count consecutive empty/no-change periods
      if (s.lastCookieStr && s.lastCookieStr === cookieStr) {
        consecutiveEmpty++;
      } else {
        consecutiveEmpty = 0;
        s.lastCookieStr = cookieStr;
      }

      // If cookies haven't changed for too long, give up
      if (consecutiveEmpty > maxEmpty) {
        s.status = 'timeout';
        s.error = `CAPTCHA 验证超时：${checkCount * 2}秒内未检测到验证成功。请检查浏览器是否正常显示，或手动完成验证后刷新页面。`;
        s.completedAt = new Date().toISOString();
        console.log(`[CAPTCHA] Session ${sessionId.slice(0, 8)}... TIMEOUT after ${checkCount * 2}s (no cookie changes for ${consecutiveEmpty * 2}s)`);
        await closeCaptchaSessionContext(sessionId);
        return;
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (error) {
    const s = captchaSessions.get(sessionId);
    if (!s) return;
    s.status = 'failed';
    s.error = String(error?.message ?? error);
    s.completedAt = new Date().toISOString();
    await closeCaptchaSessionContext(sessionId);
  }
}

/**
 * CAPTCHA verification is not supported.
 * Users must manually log in to their account and solve the CAPTCHA.
 */
export async function startCaptchaVerification({ accountIndex, accountName = '' }) {
  console.log(`[CAPTCHA] CAPTCHA detected for account ${accountIndex} (${accountName}) - manual verification required`);
  
  return {
    ok: 0,
    error: '账号需要进行 CAPTCHA 验证。\n\n请在您的浏览器中手动登录微博账号并完成验证，然后在此处更新 Cookie。',
    requiresManualVerification: true,
    status: 'manual_required',
  };
}

export function getCaptchaStatus(sessionId) {
  // CAPTCHA verification is not supported
  return {
    found: false,
    status: 'not_found',
    error: 'CAPTCHA 自动验证不再支持',
  };
}

export async function cancelCaptchaSession(sessionId) {
  const session = captchaSessions.get(sessionId);
  if (!session) {
    return { ok: false, status: 'not_found' };
  }
  session.status = 'cancelled';
  session.error = '已取消';
  session.completedAt = new Date().toISOString();
  await closeCaptchaSessionContext(sessionId);
  captchaSessions.delete(sessionId);
  return { ok: true, status: 'cancelled' };
}

/**
 * Keep-alive: silently visits weibo.com with each account's headless browser to
 * refresh cookie expiry dates and detect expired sessions early.
 * Returns an array of { accountIndex, accountName, ok, cookie?, error? }.
 */
export async function keepAliveAllAccounts(accounts) {
  const results = [];
  // Process accounts sequentially with delay to prevent memory exhaustion
  // (Fixes OOM crashes on servers with limited memory)
  const DELAY_BETWEEN_REFRESHES_MS = 2000; // 2s between account refreshes
  
  for (let i = 0; i < accounts.length; i++) {
    const { name = '', cookie = '', proxy = '' } = accounts[i];
    const userDataDir = profileDirForAccount(i, name);
    const acctLabel = `账号 ${i + 1}(${name})`;
    
    if (!profileHasSession(userDataDir)) {
      console.log(`  ⚠️  ${acctLabel}: no_profile (${userDataDir})`);
      results.push({ accountIndex: i, accountName: name, ok: false, error: 'no_profile' });
      // Small delay even for no_profile to avoid hammering system
      if (i < accounts.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
      continue;
    }

    // ── VALIDATE COOKIE BEFORE REFRESH ──────────────────────────────────────
    // Check if the stored cookie is still valid (not logged out/expired)
    if (cookie && cookie.trim()) {
      const validation = await validateCookieBasic(cookie);
      if (!validation.valid) {
        console.log(`  ❌ ${acctLabel}: cookie invalid (${validation.reason}) — skipping refresh`);
        results.push({ accountIndex: i, accountName: name, ok: false, error: `COOKIE_INVALID: ${validation.reason}` });
        if (i < accounts.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
        continue;
      }
      // Warn if cookie health is weak
      if (validation.health && validation.health !== 'strong') {
        console.log(`  ⚠️  ${acctLabel}: cookie health is "${validation.health}" (consider more frequent refreshes)`);
      }
    }

    try {
      const refreshed = await withProfileLock(userDataDir, () =>
        refreshCookieHeadless({ userDataDir, proxy })
      );
      
      // Validate the extracted cookies before marking as success
      const cookieValidation = await validateCookieBasic(refreshed.cookie);
      if (!cookieValidation.valid) {
        console.log(`  ⚠️  ${acctLabel}: extracted cookie invalid (${cookieValidation.reason})`);
        results.push({ accountIndex: i, accountName: name, ok: false, error: `EXTRACTED_COOKIE_INVALID: ${cookieValidation.reason}` });
      } else {
        console.log(`  ✅ ${acctLabel}: success (cookie updated, health: ${cookieValidation.health})`);
        results.push({ accountIndex: i, accountName: name, ok: true, cookie: refreshed.cookie });
      }
    } catch (e) {
      const error = isNavigationTimeoutError(e) ? 'NETWORK_TIMEOUT' : e.message;
      console.log(`  ❌ ${acctLabel}: ${error}`);
      results.push({ accountIndex: i, accountName: name, ok: false, error });
    }
    
    // Delay between refreshes to let memory be reclaimed
    if (i < accounts.length - 1) {
      console.log(`  ⏳ Waiting ${DELAY_BETWEEN_REFRESHES_MS}ms before next account...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REFRESHES_MS));
    }
  }
  return results;
}

/**
 * Validates a cookie by checking if it has required fields and can be used for API calls.
 * Returns { valid, reason, health }
 */
async function validateCookieBasic(cookieStr) {
  // Check required fields
  if (!hasRequiredSessionCookies(cookieStr)) {
    const hasSub = hasCookieField(cookieStr, 'SUB');
    const hasXsrf = hasCookieField(cookieStr, 'XSRF-TOKEN');
    const missing = [];
    if (!hasSub) missing.push('SUB');
    if (!hasXsrf) missing.push('XSRF-TOKEN');
    return { valid: false, reason: `缺少必要字段: ${missing.join(', ')}`, health: 'critical' };
  }
  
  // Check for supplementary fields that strengthen the session
  const hasSubp = hasCookieField(cookieStr, 'SUBP');
  const hasScf = hasCookieField(cookieStr, 'SCF');
  const suppFields = (hasSubp ? 1 : 0) + (hasScf ? 1 : 0);
  
  // Health assessment: more supplementary fields = stronger cookie
  let health = 'weak';
  if (suppFields === 2) {
    health = 'strong'; // Has both SUBP and SCF
  } else if (suppFields === 1) {
    health = 'normal'; // Has one of them
  }
  
  return { valid: true, reason: null, health };
}


/**
 * Main entry point.
 * - If the account profile already has a saved session, tries a headless refresh first.
 * - Falls back to QR login if headless refresh fails for any reason.
 */
export async function refreshCookieViaManualLogin({ accountIndex, accountName = '', proxy = '', maxWaitMs = 180000, allowVisibleBrowser = false }) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const userDataDir = profileDirForAccount(accountIndex, accountName);
  fs.mkdirSync(userDataDir, { recursive: true });

  return withProfileLock(userDataDir, async () => {
    if (profileHasSession(userDataDir)) {
      console.log(`[cookieRefresh] account-${accountIndex + 1} has existing session — trying headless refresh`);
      try {
        return await refreshCookieHeadless({ userDataDir, proxy });
      } catch (e) {
        // Headless refresh failed (SESSION_EXPIRED, network error, etc.) → fall back to QR login
        console.log(`[cookieRefresh] account-${accountIndex + 1} headless refresh failed: ${e.message}, falling back to QR login`);
        throw new Error(explainHeadfulNotAvailable('Cookie 已过期或无法刷新，请改用页面二维码登录'));
      }
    }

    throw new Error(explainHeadfulNotAvailable('未找到该账号会话，请改用页面二维码登录'));
  });
}

/**
 * Opens a visible browser window with pre-stored cookies (no login needed).
 * - Local desktop: Launches Edge browser with cookies injected
 * - Remote server: Returns authenticated redirect link for client's browser
 */
export async function openAccountInBrowser({ accountIndex, accountName = '', cookieString = '', proxy = '' }) {
  if (!cookieString || !cookieString.trim()) {
    return { ok: false, error: '账户没有保存 Cookie，请先添加账户' };
  }

  if (!hasRequiredSessionCookies(cookieString)) {
    return { ok: false, error: 'Cookie 无效（缺少 SUB 或 XSRF-TOKEN）' };
  }

  // Detect if we're on a server without GUI (headless)
  const isHeadless = !canOpenVisibleBrowser();
  
  if (isHeadless) {
    // Return authenticated redirect link for mobile/remote browsers
    console.log(`[openAccountInBrowser] headless mode detected, returning auth link for account-${accountIndex + 1}`);
    return {
      ok: true,
      mode: 'link',
      link: `/api/accounts/${accountIndex}/open-weibo`,
      message: `点击下方链接在浏览器中打开已登录的账户`,
      accountIndex,
      accountName,
    };
  }

  // Local desktop: Launch visible Edge browser
  console.log(`[openAccountInBrowser] desktop mode, launching Edge for account-${accountIndex + 1}...`);
  
  const proxyConfig = parsePlaywrightProxy(proxy);
  let browser;
  let context;

  try {
    // Launch browser with Edge
    const edgePath = getEdgeExecutablePath();
    browser = await chromium.launch({
      headless: false,
      executablePath: edgePath || undefined,
      proxy: proxyConfig || undefined,
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    // Parse and inject cookies
    const cookiePairs = cookieString.split(';').map(c => c.trim()).filter(Boolean);
    const cookies = cookiePairs.map(pair => {
      const [name, ...valueParts] = pair.split('=');
      return {
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: '.weibo.com',
        path: '/',
      };
    });

    await context.addCookies(cookies);

    // Open weibo.com with cookies already set
    const page = await context.newPage();
    try {
      await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (navError) {
      // Navigation error is OK - browser is still open, user can navigate manually
      console.log(`[openAccountInBrowser] navigation had issue: ${navError.message}`);
    }

    // Browser stays open; don't close it
    console.log(`[openAccountInBrowser] Edge browser opened successfully for account-${accountIndex + 1}`);
    return {
      ok: true,
      mode: 'edge',
      message: `已在 Edge 浏览器中打开账户"${accountName || `account-${accountIndex + 1}`}"`,
      accountIndex,
      accountName,
    };
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    console.error(`[openAccountInBrowser] failed for account-${accountIndex + 1}:`, error.message);
    return {
      ok: false,
      error: `打开浏览器失败: ${String(error?.message ?? error)}`,
    };
  }
}
