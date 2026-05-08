import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { chromium } from 'playwright';
import ngrok from 'ngrok';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '.auth-profiles');
const COOKIE_REFRESH_MODE = String(process.env.COOKIE_REFRESH_MODE ?? 'auto').trim().toLowerCase();
const QR_LOGIN_TTL_MS = Math.max(60_000, Number.parseInt(process.env.QR_LOGIN_TTL_MS ?? '180000', 10) || 180_000);
const CAPTCHA_TTL_MS = Math.max(60_000, Number.parseInt(process.env.CAPTCHA_TTL_MS ?? '900000', 10) || 900_000);
const qrSessions = new Map();
const captchaSessions = new Map();

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
      await page.waitForSelector(sel, { timeout: 9000 });
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
  const navTimeoutMs = proxyConfig ? 120_000 : 75_000;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    proxy: proxyConfig || undefined,
  });

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
    browser = await chromium.launch({ headless: true });
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
  const safeName = slugify(accountName);
  const key = safeName ? `account-${accountIndex + 1}-${safeName}` : `account-${accountIndex + 1}`;
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

/**
 * Headless refresh: reuses the existing persistent profile so no manual login is needed.
 * Navigates to weibo.com and extracts the session cookies from the saved profile.
 * Throws if the session has expired (missing required cookies after navigation).
 */
async function refreshCookieHeadless({ userDataDir, proxy = '' }) {
  const proxyConfig = parsePlaywrightProxy(proxy);
  const navTimeoutMs = proxyConfig ? 120_000 : 75_000;
  let context;
  try {
    clearChromiumLocks(userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      proxy: proxyConfig || undefined,
    });

    // Lightweight session touch: avoids expensive homepage assets over proxy.
    try {
      await touchSessionLightweight(context, navTimeoutMs);
    } catch {
      // Fallback to page navigation only if lightweight call path fails.
      const page = context.pages()[0] ?? await context.newPage();
      await gotoWithRetry(page, 'https://weibo.com/', { timeoutMs: navTimeoutMs, attempts: 2 });
    }

    // Some profiles set cookies asynchronously after redirects/scripts.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const cookies = await context.cookies(['https://weibo.com', 'https://www.weibo.com']);
      const cookieStr = toCookieString(cookies);
      if (hasRequiredSessionCookies(cookieStr)) {
        return { cookie: cookieStr, userDataDir, refreshedAt: new Date().toISOString() };
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
  const navTimeoutMs = proxyConfig ? 120_000 : 75_000;
  let context;
  try {
    clearChromiumLocks(userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      proxy: proxyConfig || undefined,
    });

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
 * Start a CAPTCHA verification session.
 * On headless environments: tries to use ngrok to expose a browser control interface.
 * On desktop: launches a visible browser for direct user interaction.
 */
export async function startCaptchaVerification({ accountIndex, accountName = '', cookie = '', proxy = '', maxWaitMs = CAPTCHA_TTL_MS }) {
  const proxyConfig = parsePlaywrightProxy(proxy);
  const navTimeoutMs = proxyConfig ? 120_000 : 75_000;
  
  // Detect if running on headless environment (Linux without DISPLAY)
  const isHeadlessEnvironment = process.platform === 'linux' && !process.env.DISPLAY;
  
  // For headless: try to use ngrok + headless browser
  if (isHeadlessEnvironment) {
    return await startHeadlessVerificationWithNgrok({ accountIndex, accountName, cookie, proxy: proxyConfig, navTimeoutMs, maxWaitMs });
  }

  // For desktop: launch visible browser
  const browser = await chromium.launch({
    headless: false,
    proxy: proxyConfig || undefined,
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Set the cookie before navigating
    if (cookie && typeof cookie === 'string') {
      const cookiePairs = cookie.split(';').map(pair => pair.trim());
      for (const pair of cookiePairs) {
        const [name, ...valueParts] = pair.split('=');
        if (name) {
          const value = valueParts.join('=');
          try {
            await context.addCookies([{
              name: name.trim(),
              value: value ? value.trim() : '',
              url: 'https://weibo.com',
            }]);
          } catch {
            // Cookie might not be settable, continue
          }
        }
      }
    }

    // Navigate to Weibo home
    await gotoWithRetry(page, 'https://weibo.com/', { timeoutMs: navTimeoutMs, attempts: 2 });

    const sessionId = randomUUID();
    const ttlMs = Math.max(60_000, Math.min(15 * 60 * 1000, Number.parseInt(maxWaitMs, 10) || CAPTCHA_TTL_MS));
    const now = Date.now();

    const session = {
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      browser,
      context,
      cookie: '',
      lastCookieStr: '',
      error: null,
      completedAt: null,
      monitorInterval: null,
    };

    captchaSessions.set(sessionId, session);
    void monitorCaptchaSession(sessionId);

    return {
      ok: 1,
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      message: '浏览器已打开。请在浏览器中解决 CAPTCHA 验证。',
      instructions: '1. 如果出现验证码，请完成验证。\n2. 完成后，此会话将自动检测到新的 Cookie。\n3. 请不要关闭浏览器，直到显示验证成功。',
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  } catch (error) {
    try { await context?.close(); } catch {}
    try { await browser.close(); } catch {}
    throw error;
  }
}

/**
 * Start headless verification with ngrok tunnel for remote browser access.
 */
async function startHeadlessVerificationWithNgrok({ accountIndex, accountName, cookie, proxy, navTimeoutMs, maxWaitMs }) {
  let ngrokUrl = null;
  let tunnelPort = 19999;
  
  try {
    // Check if ngrok auth token is set
    const ngrokToken = process.env.NGROK_AUTH_TOKEN;
    if (!ngrokToken) {
      console.log('[CAPTCHA] ngrok token not configured, cannot tunnel browser');
      return {
        ok: 0,
        error: '服务器配置不支持自动验证。请使用账号管理中的"验证"功能手动刷新 Cookie。',
        isHeadless: true,
        requiresManualCookie: true,
      };
    }

    // Connect ngrok
    await ngrok.authtoken(ngrokToken);
    
    // Launch headless browser (we'll create an interface to interact with it)
    const browser = await chromium.launch({
      headless: true,
      proxy: proxy || undefined,
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Set cookie
    if (cookie && typeof cookie === 'string') {
      const cookiePairs = cookie.split(';').map(pair => pair.trim());
      for (const pair of cookiePairs) {
        const [name, ...valueParts] = pair.split('=');
        if (name) {
          const value = valueParts.join('=');
          try {
            await context.addCookies([{
              name: name.trim(),
              value: value ? value.trim() : '',
              url: 'https://weibo.com',
            }]);
          } catch {}
        }
      }
    }

    // Navigate to Weibo
    await gotoWithRetry(page, 'https://weibo.com/', { timeoutMs: navTimeoutMs, attempts: 2 });

    // Start ngrok tunnel to the Playwright DevTools Protocol port
    // Note: We expose port 19999 which we'll tunnel
    const wsEndpoint = browser.wsEndpoint();
    console.log(`[CAPTCHA] Browser WS endpoint: ${wsEndpoint}`);
    
    // Start ngrok tunnel
    ngrokUrl = await ngrok.connect({
      proto: 'http',
      port: tunnelPort,
      region: 'auto',
    });
    
    console.log(`[CAPTCHA] ngrok tunnel started: ${ngrokUrl}`);

    const sessionId = randomUUID();
    const ttlMs = Math.max(60_000, Math.min(15 * 60 * 1000, Number.parseInt(maxWaitMs, 10) || CAPTCHA_TTL_MS));
    const now = Date.now();

    const session = {
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
      browser,
      context,
      page,
      ngrokUrl,
      wsEndpoint,
      cookie: '',
      lastCookieStr: '',
      error: null,
      completedAt: null,
      monitorInterval: null,
    };

    captchaSessions.set(sessionId, session);
    void monitorCaptchaSession(sessionId);

    return {
      ok: 1,
      sessionId,
      accountIndex,
      accountName,
      status: 'pending',
      isHeadless: true,
      tunnelUrl: ngrokUrl,
      message: `已通过 ngrok 隧道启动浏览器。请点击下面的链接来访问浏览器并完成验证。`,
      instructions: `1. 点击链接: ${ngrokUrl}\n2. 在打开的浏览器中解决验证码\n3. 验证完成后，此系统将自动检测并重试操作`,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  } catch (error) {
    console.error('[CAPTCHA] Error starting ngrok verification:', error.message);
    
    // Disconnect ngrok if tunnel was started
    if (ngrokUrl) {
      try {
        await ngrok.disconnect(ngrokUrl);
        await ngrok.kill();
      } catch {}
    }

    return {
      ok: 0,
      error: `无法启动远程验证: ${error.message || '未知错误'}。请使用账号管理中的"验证"功能手动刷新 Cookie。`,
      isHeadless: true,
      requiresManualCookie: true,
    };
  }
}

export function getCaptchaStatus(sessionId) {
  const session = getCaptchaSession(sessionId);
  if (!session) {
    return { found: false, status: 'not_found', error: 'CAPTCHA 会话不存在或已结束' };
  }

  return {
    found: true,
    sessionId,
    accountIndex: session.accountIndex,
    accountName: session.accountName,
    status: session.status,
    error: session.error,
    expiresAt: new Date(session.expiresAt).toISOString(),
    completedAt: session.completedAt,
    cookie: session.status === 'success' ? session.cookie : '',
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
  for (let i = 0; i < accounts.length; i++) {
    const { name = '', proxy = '' } = accounts[i];
    const userDataDir = profileDirForAccount(i, name);
    if (!profileHasSession(userDataDir)) {
      results.push({ accountIndex: i, accountName: name, ok: false, error: 'no_profile' });
      continue;
    }
    try {
      const refreshed = await withProfileLock(userDataDir, () =>
        refreshCookieHeadless({ userDataDir, proxy })
      );
      results.push({ accountIndex: i, accountName: name, ok: true, cookie: refreshed.cookie });
    } catch (e) {
      const error = isNavigationTimeoutError(e) ? 'NETWORK_TIMEOUT' : e.message;
      results.push({ accountIndex: i, accountName: name, ok: false, error });
    }
  }
  return results;
}

/**
 * Main entry point.
 * - If the account profile already has a saved session, tries a headless refresh first.
 * - Falls back to a visible browser only when no session exists or the session has expired.
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
        if (e.message === 'SESSION_EXPIRED') {
          throw new Error(explainHeadfulNotAvailable('Cookie 已过期，请改用页面二维码登录刷新'));
        }
        throw e;
      }
    }

    throw new Error(explainHeadfulNotAvailable('未找到该账号会话，请改用页面二维码登录'));
  });
}
