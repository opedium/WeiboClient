import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '.auth-profiles');

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
  // Deduplicate by name to avoid cross-domain duplicates (e.g. XSRF-TOKEN)
  const seen = new Set();
  return cookies
    .filter(c => c?.name && typeof c.value === 'string')
    .filter(c => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    })
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
export async function refreshCookieViaManualLogin({ accountIndex, accountName = '', proxy = '', maxWaitMs = 180000 }) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const userDataDir = profileDirForAccount(accountIndex, accountName);
  fs.mkdirSync(userDataDir, { recursive: true });

  return withProfileLock(userDataDir, async () => {
    if (profileHasSession(userDataDir)) {
      console.log(`[cookieRefresh] account-${accountIndex + 1} has existing session — trying headless refresh`);
      try {
        return await refreshCookieHeadless({ userDataDir, proxy });
      } catch (e) {
        if (e.message === 'SESSION_EXPIRED' || isNavigationTimeoutError(e)) {
          console.log(`[cookieRefresh] account-${accountIndex + 1} headless failed (${e.message}) — opening visible browser`);
          // Session expired or transient network timeout — fall through to visible browser login below.
        } else {
          throw e;
        }
      }
    } else {
      console.log(`[cookieRefresh] account-${accountIndex + 1} no session found — opening visible browser for first-time login`);
    }

    // First-time login or expired session: open visible browser.
    return refreshCookieWithVisibleBrowser({ userDataDir, proxy, maxWaitMs });
  });
}
