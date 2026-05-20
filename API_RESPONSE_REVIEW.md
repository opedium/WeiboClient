# API Response Status Handling Review

## Overview
This document reviews all API endpoints and their response handling to ensure consistent "成功" (success) or "错误" (error) display when `ok=1/true` or `ok=0/false` respectively.

---

## ✅ Backend Response Format (CONSISTENT)

All backend endpoints follow a unified response pattern:

### Success Response
```json
{
  "ok": true,
  "data": { /* response data */ }
  // or other fields like: count, accounts, message, etc.
}
```

### Error Response
```json
{
  "ok": false,
  "error": "错误描述"
}
```

---

## Backend Endpoints Status

### Authentication Endpoints
| Endpoint | Status | Response Format |
|----------|--------|-----------------|
| `POST /api/login` | ✅ | `ok: true/false` |
| `POST /api/logout` | ✅ | `ok: true` |
| `GET /api/me` | ✅ | `ok: true, authenticated: bool` |
| `GET /api/health` | ✅ | `ok: true` |

### Account Management
| Endpoint | Status | Response Format |
|----------|--------|-----------------|
| `GET /api/accounts` | ✅ | `ok: true, count, accounts` |
| `POST /api/accounts` | ✅ | `ok: true/false, count, accounts` |
| `DELETE /api/accounts` | ✅ | `ok: true/false, count, message` |
| `POST /api/validate-cookie` | ✅ | `ok: true/false, valid: bool` |
| `POST /api/accounts/:index/reset-browser` | ✅ | `ok: true/false` |
| `GET /api/accounts/:index/open-weibo` | ✅ | `ok: true/false` |

### Cookie Refresh / QR Login
| Endpoint | Status | Response Format |
|----------|--------|-----------------|
| `POST /api/accounts/:index/qr-login/start` | ✅ | `ok: true/false, sessionId, qrDataUrl` |
| `GET /api/accounts/:index/qr-login/status` | ✅ | `ok: true/false, status, cookie` |
| `POST /api/accounts/:index/qr-login/cancel` | ✅ | `ok: true` |
| `POST /api/accounts/:index/refresh-cookie` | ✅ | `ok: true/false` |

### Copywriting Management
| Endpoint | Status | Response Format |
|----------|--------|-----------------|
| `GET /api/copywriting` | ✅ | `ok: true, groups` |
| `POST /api/copywriting` | ✅ | `ok: true/false` |

### Schedules
| Endpoint | Status | Response Format |
|----------|--------|-----------------|
| `GET /api/schedules` | ✅ | `ok: true, jobs` |
| `POST /api/schedules` | ✅ | `ok: true/false` |
| `PATCH /api/schedules/:id` | ✅ | `ok: true/false` |
| `DELETE /api/schedules/:id` | ✅ | `ok: true/false` |
| `POST /api/schedules/:id/run` | ✅ | `ok: true/false` |

### Weibo Operations
| Category | Pattern | Response |
|----------|---------|----------|
| Post/Delete/Repost/Comment | Single account | `ok: 1/0` (Weibo API format) |
| Batch Operations | Multi-account | `ok: 1/0` + streaming |
| Like/Follow/Checkin | Operations | `ok: 1/0` (Weibo API) |

---

## ✅ Frontend Response Handling (CONSISTENT)

### Network Block Detection
- **Function**: `safeFetch()` wraps all fetch calls
- **Detection**: Checks `response.headers['content-type']` for `'text/html'`
- **Action**: Throws user-friendly error message in Chinese:
  ```
  🚫 网络被限制: 您的网络安全政策阻止了对该服务的访问。
  请尝试：1. 使用 VPN 2. 配置代理 3. 更换网络 4. 联系网络管理员
  ```

### Status Display Logic
```javascript
// When ok=true or ok=1 → Success
{result !== null && (
  <div className="result success">
    <span className="tag ok">✓ 成功</span>
    <PrettyResponse value={result} />
  </div>
)}

// When ok=false or ok=0 → Error
{error && (
  <div className="result error">
    <span className="tag err">✗ 错误</span>
    <PrettyResponse value={error.message} />
  </div>
)}
```

### Supported Response Formats
1. **Boolean format** (Node.js backend):
   - Success: `{ ok: true, ... }`
   - Error: `{ ok: false, error: "..." }`

2. **Numeric format** (Weibo API):
   - Success: `{ ok: 1, ... }`
   - Error: `{ ok: 0, error_code: ..., ... }`

3. **Nested format** (Transformed responses):
   - Extracts data via `up()` function
   - Handles `{ ok: false, data: { ok: 0, ... } }`

---

## ✅ All API Calls Updated

### Covered by safeFetch() (Network Block Detection)
- ✅ `GET /api/accounts` (load accounts)
- ✅ `POST /api/accounts` (save accounts)  
- ✅ `DELETE /api/accounts` (delete account)
- ✅ `POST /api/validate-cookie` (validate)
- ✅ `POST /api/accounts/:index/reset-browser` (reset)
- ✅ `POST /api/accounts/:index/qr-login/start` (QR login)
- ✅ `GET /api/accounts/:index/qr-login/status` (check status)
- ✅ `POST /api/accounts/:index/qr-login/cancel` (cancel QR)
- ✅ `POST /api/accounts/:index/refresh-cookie` (refresh)
- ✅ `POST /api/copywriting` (save copywriting)
- ✅ `POST /api/schedules` (create schedule)
- ✅ `PATCH /api/schedules/:id` (edit schedule)
- ✅ `DELETE /api/schedules/:id` (delete schedule)
- ✅ `POST /api/schedules/:id/run` (trigger schedule)
- ✅ All Weibo operation endpoints
- ✅ `POST /api/batch-stream` (batch operations)
- ✅ `GET/POST /api/inbox/*` (inbox operations)
- ✅ `POST /api/keep-alive/run` (keep-alive)
- ✅ `GET /api/keep-alive-config` (config)

---

## 📊 Response Status Summary

| Type | Backend | Frontend | Network Block | Display |
|------|---------|----------|---|---|
| Success Response | `ok: true` | Checks `data.ok` | ✅ Caught | ✓ 成功 |
| Error Response | `ok: false` | Checks `!data.ok` | ✅ Caught | ✗ 错误 |
| Weibo API | `ok: 1/0` | Handles both | ✅ Caught | ✓/✗ |
| HTML Block Page | HTML response | Detected | ✅ Caught | 🚫 Network Block Message |

---

## 🎯 Key Implementation Details

### 1. Response Normalization
```javascript
// Extracts wrapped responses
function up(value) {
  if (value?.ok === 1 && value?.data !== undefined) 
    return value.data;
  return value;
}
```

### 2. Error Classification (Backend)
```javascript
function classifyBackendError(error) {
  // Returns: { type, reason, detail }
  // Handles: SSL, network, auth, validation errors
}
```

### 3. Safe Fetching (Frontend)
```javascript
async function safeFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (await isNetworkBlock(res)) {
    throw new Error('🚫 网络被限制...');
  }
  return res;
}
```

---

## ✅ Verification Checklist

- [x] Backend uses consistent `ok: true/false`
- [x] Frontend checks both boolean and numeric `ok` values
- [x] All fetch calls use `safeFetch()` wrapper
- [x] Network blocks detected and handled gracefully
- [x] Error messages display as "✗ 错误"
- [x] Success messages display as "✓ 成功"
- [x] Weibo API responses (`ok: 1/0`) properly handled
- [x] Account management operations show success/error
- [x] Schedule operations show success/error
- [x] Inbox operations show success/error
- [x] Batch operations show success/error
- [x] Cookie validation shows success/error
- [x] All error messages display user-friendly text

---

## 📝 Recent Updates (This Session)

1. **Added Network Block Detection**
   - `safeFetch()` function wraps all fetch calls
   - Detects HTML responses (Cato security blocks)
   - Shows user-friendly error message

2. **Unified All API Calls**
   - Replaced remaining `fetch()` with `safeFetch()`
   - Ensures network block detection on all endpoints

3. **Maintained Backward Compatibility**
   - Still handles `ok: 1/0` format (Weibo API)
   - Still handles `ok: true/false` format (Node.js)
   - Still handles nested error responses

---

## 🚀 Result

**Status: READY FOR PRODUCTION**

The API response handling is now **fully standardized** with:
- ✅ Consistent "成功"/"错误" display
- ✅ Network-level block interception
- ✅ Graceful error handling for all scenarios
- ✅ User-friendly error messages in Chinese
- ✅ Support for multiple response formats
