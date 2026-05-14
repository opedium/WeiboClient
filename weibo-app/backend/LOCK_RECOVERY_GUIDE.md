# Lock Recovery Guide for DigitalOcean Server

## Problem
Your server returns **409 Conflict** when trying to refresh cookies:
```
POST /api/accounts/0/refresh-cookie
Status: 409 Conflict
Message: 该账号正在刷新 Cookie，请稍候重试
```

This happens when a refresh operation hangs or crashes and never releases the lock.

## Solution

### Automatic Recovery (No Action Needed)
- Locks **auto-expire after 15 minutes** (`LOCK_TIMEOUT_MS=900000`)
- All refresh/QR requests automatically clear expired locks
- **Just wait 15 minutes** and retry — the lock will be gone

### Manual Recovery (Immediate Fix)

#### 1. **Check Lock Status** (View all active locks)
```bash
curl -X POST http://167.99.73.192/api/admin/locks/status \
  -H "x-auth-token: opedium00" \
  -H "Content-Type: application/json"
```

Response example:
```json
{
  "ok": true,
  "activeLocksCount": 1,
  "lockTimeoutMs": 900000,
  "locks": [
    {
      "accountIndex": 0,
      "lockedSince": "2026-05-14T02:28:00Z",
      "durationMs": 120000,
      "reason": "manual_refresh",
      "expired": false
    }
  ]
}
```

#### 2. **Clear a Specific Account's Lock**
```bash
curl -X POST http://167.99.73.192/api/admin/locks/clear \
  -H "x-auth-token: opedium00" \
  -H "Content-Type: application/json" \
  -d '{"accountIndex": 0}'
```

#### 3. **Clear ALL Locks** (Emergency only)
```bash
curl -X POST http://167.99.73.192/api/admin/locks/clear \
  -H "x-auth-token: opedium00" \
  -H "Content-Type: application/json" \
  -d '{"accountIndex": -1}'
```

## Recovery Sequence

1. **Try refresh again** → If gets 409, continue
2. **Check lock status** → See which account is locked and for how long
3. **If locked >15 min**: Clear the lock with `/api/admin/locks/clear`
4. **If locked <15 min**: Either
   - Wait until it auto-expires, or
   - Force clear immediately (if you're sure process crashed)
5. **Retry refresh**

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 409 error persists after 15 min | Timeout not working | Restart backend: `npm stop && npm start` |
| Lock shows `reason: "manual_refresh"` with duration >10min | Process hung (e.g., slow proxy) | Clear the lock, check proxy connectivity |
| Same account keeps getting stuck | Browser profile corrupted | Call `POST /api/accounts/0/reset-browser` to reset profile |

## Environment Variables

Set on your DigitalOcean server (`.env` file):

```bash
# Lock timeout in milliseconds (default: 15 minutes)
LOCK_TIMEOUT_MS=900000

# To use shorter timeout for faster recovery (5 minutes):
LOCK_TIMEOUT_MS=300000
```

Restart backend for changes to take effect:
```bash
npm stop
npm start
```

## Prevention

These measures prevent future lockups on headless servers:

1. **Check browser process health** — Monitor if Playwright processes are hanging
2. **Use faster proxies** — Slow proxies can timeout browser operations
3. **Set shorter keep-alive intervals** — Refresh cookies before they expire completely
4. **Monitor logs** — Look for `[lock-timeout]` messages to detect stuck operations

## When to Use Manual Lock Clear

✅ **Safe to clear**:
- Lock duration > 15 minutes
- Browser process is definitely dead (`ps aux | grep playwright` shows nothing)
- You just restarted the server and stale lock remains

❌ **NOT safe to clear**:
- Lock duration < 2 minutes (operation might still be running)
- You're unsure if process is running
- Browser is actively connected to Weibo (check backend logs)

---

**Last Updated**: May 14, 2026  
**Related Issues**: Headless server cookie refresh deadlock on DigitalOcean
