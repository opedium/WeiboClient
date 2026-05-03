import { useState, useEffect, useCallback, Component } from 'react';
import { OPERATIONS, GROUPS, RANDOM_SUPPORTED_OPS, BATCH_SUPPORTED_ENDPOINTS, SCHEDULABLE_OPERATIONS } from './config.js';

const API = import.meta.env.VITE_API_URL ?? 'https://69f23082000a285e26a7.69f221090023490a8740.sgp.appwrite.run';

function getToken() { return localStorage.getItem('auth_token') || ''; }

function formatJsonForDisplay(value) {
  if (typeof value === 'string') {
    const s = value.trim();
    const looksLikeJson =
      (s.startsWith('{') && s.endsWith('}')) ||
      (s.startsWith('[') && s.endsWith(']'));
    if (looksLikeJson) {
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ value }) {
  return (
    <pre className="json-pretty">
      <code>{formatJsonForDisplay(value)}</code>
    </pre>
  );
}

function stripHtml(input) {
  return String(input ?? '').replace(/<[^>]+>/g, '').trim();
}

function normalizePayload(value) {
  const root = value && typeof value === 'object' ? value : null;
  if (root?.ok === 1 && root?.data !== undefined) return root.data;
  return value;
}

function extractListLike(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const candidates = ['list', 'data', 'statuses', 'groups', 'collections', 'items',
                      'notices', 'cards', 'comments', 'attitudes', 'results', 'feeds'];
  for (const key of candidates) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function extractUserName(item) {
  if (!item || typeof item !== 'object') return '';
  const user = item.user;
  if (user && typeof user === 'object') {
    return stripHtml(user.screen_name ?? user.name ?? '');
  }
  return stripHtml(item.screen_name ?? item.name ?? '');
}

function isTextEntity(item) {
  if (!item || typeof item !== 'object') return false;
  if (stripHtml(item.text ?? item.text_raw ?? item.comment ?? '')) return true;
  if (item.source_status && typeof item.source_status === 'object') return true;
  if (item.notice_type || (item.type && typeof item.type === 'string' && item.type.includes('_'))) return true;
  if (item.user && typeof item.user === 'object' && stripHtml(item.user.screen_name ?? '')) return true;
  return false;
}

const NOTICE_VERBS = {
  like_status: '赞了你的微博', like_comment: '赞了你的评论',
  comment_status: '评论了你的微博', repost_status: '转发了你的微博',
  mention_status: '@了你', mention_comment: '在评论中@了你',
  follow: '关注了你', attitude: '赞了',
};

function OriginalCard({ original, label = '原微博' }) {
  if (!original || typeof original !== 'object') return null;
  const text = stripHtml(original.text ?? original.text_raw ?? '');
  const user = stripHtml(original.user?.screen_name ?? original.user?.name ?? '');
  const meta = [stripHtml(original.created_at ?? ''), stripHtml(original.source ?? '')].filter(Boolean).join(' ');
  const uid = original.user?.idstr ?? original.user?.id ?? null;
  const mblogid = original.mblogid ?? null;
  const url = original.url
    || ((uid && mblogid) ? `https://weibo.com/${uid}/${mblogid}` : '')
    || (original.id ? `https://weibo.com/detail/${original.id}` : '');
  if (!text && !url) return null;
  return (
    <div className="original-card">
      <div className="original-title">{label}</div>
      {user && <div className="original-user">{user}</div>}
      {text && <div className="original-text">{text}</div>}
      {meta && <div className="original-meta">{meta}</div>}
      {url && <a className="original-link" href={url} target="_blank" rel="noreferrer noopener">打开微博</a>}
    </div>
  );
}

function EntityCard({ item, opId }) {
  if (item == null) return null;
  if (typeof item !== 'object') {
    return <div className="entity-meta">{String(item)}</div>;
  }

  const text = stripHtml(item.text ?? item.text_raw ?? item.comment ?? '');
  const createdAt = stripHtml(item.created_at ?? item.create_time ?? item.time ?? '');
  const source = stripHtml(item.source ?? item.region_name ?? item.from ?? '');
  const userName = extractUserName(item);

  // Resolve "original" context: prefer originalWeibo, fall back to source_status
  const original = (item.originalWeibo && typeof item.originalWeibo === 'object')
    ? item.originalWeibo
    : (item.source_status && typeof item.source_status === 'object') ? item.source_status
    : null;
  const fallbackOriginalId = item.rootidstr ?? item.rootid ?? null;
  const fallbackUrl = fallbackOriginalId ? `https://weibo.com/detail/${fallbackOriginalId}` : '';

  // Notification verb
  const noticeType = String(item.notice_type ?? item.type ?? '');
  const noticeVerb = NOTICE_VERBS[noticeType] ?? null;

  // User card (follow notice, user search result, etc.)
  const isUserItem = !text && !original && !noticeVerb &&
    typeof item.screen_name === 'string' && item.screen_name;
  if (isUserItem) {
    const name = stripHtml(item.screen_name ?? item.name ?? '');
    const uid = item.idstr ?? item.id ?? null;
    const desc = stripHtml(item.description ?? item.remark ?? '');
    const extra = [];
    if (item.followers_count != null) extra.push(`粉丝 ${item.followers_count}`);
    if (item.friends_count != null) extra.push(`关注 ${item.friends_count}`);
    if (item.statuses_count != null) extra.push(`微博 ${item.statuses_count}`);
    return (
      <div className="post-card">
        <div className="post-user">{name}</div>
        {uid && <div className="post-meta">UID: {uid}{extra.length ? ' · ' + extra.join(' · ') : ''}</div>}
        {desc && <div className="post-content" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{desc}</div>}
      </div>
    );
  }

  if (text) {
    return (
      <div className="post-card">
        {(userName || noticeVerb) && (
          <div className="post-user">
            {userName}
            {noticeVerb && <span className="notice-verb"> · {noticeVerb}</span>}
          </div>
        )}
        <div className="post-content">{text}</div>
        {(createdAt || source) && (
          <div className="post-meta">
            {createdAt}
            {source ? ` ${source.startsWith('来自') ? source : `来自${source}`}` : ''}
          </div>
        )}
        <OriginalCard original={original} label={item.source_status ? '相关微博' : '原微博'} />
        {!original && fallbackUrl && (
          <a className="original-link" style={{ display: 'inline-flex', marginTop: 8 }} href={fallbackUrl} target="_blank" rel="noreferrer noopener">打开原微博</a>
        )}
      </div>
    );
  }

  // No own text — notice item (like, follow, repost, etc.) or item with source_status only
  if (noticeVerb || original || userName) {
    return (
      <div className="post-card">
        {(userName || noticeVerb) && (
          <div className="post-user">
            {userName}
            {noticeVerb && <span className="notice-verb"> · {noticeVerb}</span>}
          </div>
        )}
        {createdAt && <div className="post-meta">{createdAt}</div>}
        <OriginalCard original={original} label={noticeVerb ? '相关内容' : '原微博'} />
        {!original && fallbackUrl && (
          <a className="original-link" style={{ display: 'inline-flex', marginTop: 8 }} href={fallbackUrl} target="_blank" rel="noreferrer noopener">打开微博</a>
        )}
      </div>
    );
  }

  const title = stripHtml(item.name ?? item.title ?? item.group_name ?? item.display_name ?? opId ?? '结果');
  const idLike = item.idstr ?? item.id ?? item.mid ?? item.mblogid ?? item.cid ?? item.uid ?? null;
  const extra = [];
  if (item.member_count != null) extra.push(`成员 ${item.member_count}`);
  if (item.followers_count != null) extra.push(`粉丝 ${item.followers_count}`);
  if (item.friendships_count != null) extra.push(`关注 ${item.friendships_count}`);
  if (item.statuses_count != null) extra.push(`微博 ${item.statuses_count}`);
  if (item.total_number != null) extra.push(`总数 ${item.total_number}`);
  if (item.ok != null && typeof item.ok !== 'object') extra.push(`ok=${item.ok}`);

  return (
    <div className="entity-card">
      <div className="entity-title">{title || '操作完成'}</div>
      <div className="entity-meta">
        {idLike != null ? `ID: ${idLike}` : '已返回结果'}
        {extra.length ? ` · ${extra.join(' · ')}` : ''}
      </div>
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return <div className="entity-meta" style={{ color: 'var(--err, #c00)' }}>渲染出错: {String(this.state.error)}</div>;
    }
    return this.props.children;
  }
}

const LIST_PAGE = 20;

function PrettyResponse({ value, opId }) {
  const [showAll, setShowAll] = useState(false);
  const payload = normalizePayload(value);
  const list = extractListLike(payload);

  if (Array.isArray(list) && list.length > 0) {
    const allItems = list;
    const limit = showAll ? allItems.length : Math.min(allItems.length, LIST_PAGE);
    const items = allItems.slice(0, limit);
    // Prefer text/notice-type items for cleaner display, but only if a meaningful
    // subset qualifies — otherwise show everything as cards (avoids dropping data).
    const textItems = items.filter(isTextEntity);
    const finalItems = textItems.length > items.length * 0.5 ? textItems : items;
    return (
      <div className="card-list">
        {finalItems.map((item, idx) => (
          <ErrorBoundary key={idx}><EntityCard item={item} opId={opId} /></ErrorBoundary>
        ))}
        {allItems.length > LIST_PAGE && (
          <button
            className="btn-secondary"
            style={{ marginTop: 4, fontSize: '0.82rem' }}
            onClick={() => setShowAll(v => !v)}
          >
            {showAll ? `▲ 收起（共 ${allItems.length} 条）` : `▼ 展示全部 ${allItems.length} 条（当前 ${LIST_PAGE}）`}
          </button>
        )}
        <details className="post-raw-json">
          <summary>查看原始 JSON</summary>
          <JsonBlock value={value} />
        </details>
      </div>
    );
  }

  if (payload && typeof payload === 'object') {
    return (
      <div className="card-list">
        <ErrorBoundary><EntityCard item={payload} opId={opId} /></ErrorBoundary>
        <details className="post-raw-json">
          <summary>查看原始 JSON</summary>
          <JsonBlock value={value} />
        </details>
      </div>
    );
  }

  if (typeof payload === 'string') {
    return <div className="entity-meta">{payload}</div>;
  }

  return (
    <JsonBlock value={value} />
  );
}

const API_TIMEOUT_MS = Math.max(
  30_000,
  Number.parseInt(import.meta.env.VITE_API_TIMEOUT_MS ?? '90000', 10) || 90_000
);

async function callApi(op, formData, account) {
  const headers = { 'x-account': String(account), 'x-auth-token': getToken() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    if (op.method === 'UPLOAD') {
      const body = new FormData();
      for (const [k, v] of Object.entries(formData)) {
        if (v instanceof File) body.append(k, v);
        else if (v) body.append(k, v);
      }
      const res = await fetch(`${API}${op.endpoint}`, { method: 'POST', headers, body, signal: controller.signal });
      return res.json();
    }

    if (op.method === 'GET') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(formData)) {
        if (v) params.set(k, v);
      }
      const url = `${API}${op.endpoint}${params.toString() ? '?' + params : ''}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      return res.json();
    }

    // POST JSON
    headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${op.endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(formData),
      signal: controller.signal,
    });
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `请求超时（>${API_TIMEOUT_MS / 1000}s）。更可能是代理/网络问题（不是前端能直接判断为 Cookie 问题）。请先在账号管理里点“验证”，若验证通过则 Cookie 基本有效。`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const BATCH_SUPPORTED = BATCH_SUPPORTED_ENDPOINTS;
const LOOPABLE_BATCH_ENDPOINTS = new Set(['/api/quick-repost', '/api/repost-tweet']);

// ── AccountsPanel ─────────────────────────────────────────
function AccountsPanel({ onCountChange }) {
  const [accounts, setAccounts] = useState([]);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [validating, setValidating] = useState({});   // {index: true/false}
  const [refreshing, setRefreshing] = useState({});   // {index: true/false}
  const [validResults, setValidResults] = useState({}); // {index: {valid, name, uid, avatar, error, missingRec}}
  const [keepAliveLog, setKeepAliveLog] = useState(null);
  const [resetting, setResetting] = useState({}); // {index: true/false}

  useEffect(() => {
    fetch(`${API}/api/accounts`, { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) {
        setAccounts((d.accounts ?? []).map(a => ({
          name: a.name ?? '',
          cookie: '',
          hasCookie: !!a.hasCookie,
          cookieMasked: a.cookieMasked ?? '',
          proxy: a.proxy ?? '',
        })));
      }
    }).catch(() => {});
    fetch(`${API}/api/keep-alive-log`, { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok && d.log) setKeepAliveLog(d.log);
    }).catch(() => {});
  }, []);

  const update = (i, field, value) => {
    setAccounts(a => a.map((acc, idx) => idx === i
      ? { ...acc, [field]: value, ...(field === 'cookie' && value.trim() ? { hasCookie: true } : {}) }
      : acc
    ));
    if (field === 'cookie') setValidResults(v => { const n = { ...v }; delete n[i]; return n; });
  };

  const addAccount = () =>
    setAccounts(a => [...a, { cookie: '', name: `账号 ${a.length + 1}`, hasCookie: false, cookieMasked: '', proxy: '' }]);

  const removeAccount = (i) => {
    setAccounts(a => a.filter((_, idx) => idx !== i));
    setValidResults(v => { const n = { ...v }; delete n[i]; return n; });
  };

  const validate = async (i) => {
    const cookie = accounts[i]?.cookie?.trim();
    if (!cookie) return;
    const proxy = String(accounts[i]?.proxy ?? '').trim();
    setValidating(v => ({ ...v, [i]: true }));
    try {
      const res = await fetch(`${API}/api/validate-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({ cookie, proxy }),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        data = { ok: false, valid: false, error: `服务器返回异常响应 (HTTP ${res.status})` };
      }
      setValidResults(v => ({ ...v, [i]: data }));
      // auto-fill name if blank and we got a real username
      if (data.valid && data.name && (!accounts[i].name || accounts[i].name.startsWith('账号 '))) {
        update(i, 'name', data.name);
      }
    } catch (e) {
      setValidResults(v => ({ ...v, [i]: { valid: false, error: e.message } }));
    } finally {
      setValidating(v => ({ ...v, [i]: false }));
    }
  };

  const save = async () => {
    setSaveError(null);
    try {
      const res = await fetch(`${API}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({
          accounts: accounts.map(a => ({
            name: a.name,
            cookie: a.cookie,
            keepExisting: !!a.hasCookie && !String(a.cookie ?? '').trim(),
            proxy: a.proxy ?? '',
          })),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? '保存失败');
      if (Array.isArray(data.accounts)) {
        setAccounts(data.accounts.map(a => ({
          name: a.name ?? '',
          cookie: '',
          hasCookie: !!a.hasCookie,
          cookieMasked: a.cookieMasked ?? '',
          proxy: a.proxy ?? '',
        })));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      if (onCountChange) onCountChange(data.count, accounts.map(a => a.name));
    } catch (err) {
      setSaveError(err.message);
    }
  };

  const resetBrowser = async (i) => {
    if (!window.confirm(`重置账号 ${i + 1}（${accounts[i]?.name || ''}）的浏览器缓存？\n这将删除该账号的 Chromium 配置文件，下次刷新 Cookie 时需重新手动登录。`)) return;
    setResetting(v => ({ ...v, [i]: true }));
    setSaveError(null);
    try {
      const res = await fetch(`${API}/api/accounts/${i}/reset-browser`, {
        method: 'POST',
        headers: { 'x-auth-token': getToken() },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? '重置失败');
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(`账号 ${i + 1} 重置失败: ${err.message}`);
    } finally {
      setResetting(v => ({ ...v, [i]: false }));
    }
  };

  const refreshCookie = async (i) => {
    setSaveError(null);
    setRefreshing(v => ({ ...v, [i]: true }));
    try {
      const res = await fetch(`${API}/api/accounts/${i}/refresh-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({ maxWaitMs: 180000 }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`服务器返回异常响应 (HTTP ${res.status})`); }
      if (!data.ok) throw new Error(data.error ?? '刷新失败');

      const refreshed = data.account ?? null;
      if (refreshed) {
        setAccounts(prev => prev.map((acc, idx) => idx === i ? {
          ...acc,
          cookie: '',
          name: refreshed.name ?? acc.name,
          hasCookie: !!refreshed.hasCookie,
          cookieMasked: refreshed.cookieMasked ?? acc.cookieMasked,
          proxy: refreshed.proxy ?? acc.proxy,
        } : acc));
      }

      if (data.validated) {
        setValidResults(v => ({ ...v, [i]: data.validated }));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setSaveError(`账号 ${i + 1} 刷新失败: ${err.message}`);
    } finally {
      setRefreshing(v => ({ ...v, [i]: false }));
    }
  };

  return (
    <div className="op-form">
      <h2>账号管理</h2>
      <p className="copy-hint">添加或删除微博账号 Cookie，修改后点击"验证"检查有效性，确认无误后保存。</p>

      {accounts.map((acc, i) => {
        const vr = validResults[i];
        return (
          <div key={i} className={`account-card${vr ? (vr.valid ? ' card-valid' : ' card-invalid') : ''}`}>
            <div className="account-card-header">
              <span className="account-card-num">{i + 1}</span>
              <input
                className="account-name-input"
                value={acc.name}
                onChange={e => update(i, 'name', e.target.value)}
                placeholder="账号备注（如用户名）"
              />
              <button
                className="btn-validate"
                onClick={() => validate(i)}
                disabled={validating[i] || !acc.cookie.trim()}
                title="验证 Cookie 有效性"
              >
                {validating[i] ? '验证中…' : '验证'}
              </button>
              <button
                className="btn-validate"
                onClick={() => refreshCookie(i)}
                disabled={!!refreshing[i]}
                title="打开浏览器手动登录并自动保存 Cookie"
              >
                {refreshing[i] ? '刷新中…' : '刷新Cookie'}
              </button>
              <button
                className="btn-reset-browser"
                onClick={() => resetBrowser(i)}
                disabled={!!resetting[i]}
                title="清除该账号的浏览器缓存和 session，下次刷新 Cookie 时重新登录"
              >
                {resetting[i] ? '重置中…' : '重置浏览器'}
              </button>
              <button className="copy-del" onClick={() => removeAccount(i)}>删除</button>
            </div>
            <textarea
              className="cookie-input"
              value={acc.cookie}
              onChange={e => update(i, 'cookie', e.target.value)}
              placeholder={acc.hasCookie && !acc.cookie.trim()
                ? `已保存: ${acc.cookieMasked}（留空则保持不变；如需更新请粘贴新 Cookie）`
                : '粘贴完整 Cookie 字符串（需包含 SUB 和 XSRF-TOKEN）'}
              rows={3}
              spellCheck={false}
            />
            {vr && (
              <div className={`cookie-status ${vr.valid ? 'status-ok' : 'status-fail'}`}>
                {vr.valid ? (
                  <>
                    {vr.avatar && <img className="status-avatar" src={vr.avatar} alt="" />}
                    <span>✓ 有效 · {vr.name}（UID {vr.uid}）</span>
                    {vr.missingRec?.length > 0 && <span className="status-warn"> · 建议补充: {vr.missingRec.join(', ')}</span>}
                  </>
                ) : (
                  <span>✗ {vr.error}{vr.missingRec?.length > 0 ? ` · 建议补充: ${vr.missingRec.join(', ')}` : ''}</span>
                )}
              </div>
            )}
            <div className="proxy-row">
              <span className="proxy-label">代理</span>
              <input
                className="proxy-input"
                value={acc.proxy ?? ''}
                onChange={e => update(i, 'proxy', e.target.value)}
                placeholder="http://user:pass@host:port（可选）"
                spellCheck={false}
              />
            </div>
          </div>
        );
      })}

      <div className="account-actions">
        <button className="btn-add" onClick={addAccount}>+ 添加账号</button>
        <button className="btn-submit" onClick={save} disabled={accounts.length === 0}>
          {saved ? '✓ 已保存' : `保存（${accounts.length} 个账号）`}
        </button>
      </div>
      {saveError && <div className="account-error">{saveError}</div>}

      {keepAliveLog && (
        <div className="keep-alive-log">
          <div className="keep-alive-log-title">自动 Cookie 保活记录 · {new Date(keepAliveLog.ranAt).toLocaleString()}</div>
          <div className="keep-alive-log-rows">
            {keepAliveLog.results.filter(r => r.error !== 'no_profile').map(r => (
              <span key={r.accountIndex} className={`keep-alive-badge ${r.ok ? 'badge-ok' : 'badge-fail'}`}>
                {r.accountName || `账号 ${r.accountIndex + 1}`} {r.ok ? '✓' : `✗ ${r.error ?? ''}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── CopywritingPanel ─────────────────────────────────────
function CopywritingPanel() {
  const [groups, setGroups] = useState([]);        // [{name, items:[]}]
  const [activeIdx, setActiveIdx] = useState(0);
  const [draft, setDraft] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [saved, setSaved] = useState(false);
  const [editingIdx, setEditingIdx] = useState(null); // rename in-place
  const [editName, setEditName] = useState('');

  useEffect(() => {
    fetch(`${API}/api/copywriting`, { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) {
        setGroups(d.groups ?? []);
        setActiveIdx(0);
      }
    }).catch(() => {});
  }, []);

  const save = async () => {
    try {
      const res = await fetch(`${API}/api/copywriting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({ groups }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? '保存失败');
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  };

  const totalItems = groups.reduce((s, g) => s + (g.items?.length ?? 0), 0);
  const active = groups[activeIdx] ?? null;

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    setGroups(g => [...g, { name, items: [] }]);
    setActiveIdx(groups.length);
    setNewGroupName('');
  };

  const deleteGroup = (i) => {
    setGroups(g => g.filter((_, idx) => idx !== i));
    setActiveIdx(prev => Math.max(0, prev >= i ? prev - 1 : prev));
  };

  const startRename = (i) => { setEditingIdx(i); setEditName(groups[i].name); };
  const commitRename = (i) => {
    const name = editName.trim();
    if (name) setGroups(g => g.map((grp, idx) => idx === i ? { ...grp, name } : grp));
    setEditingIdx(null);
  };

  const addItem = () => {
    const text = draft.trim();
    if (!text || !active) return;
    setGroups(g => g.map((grp, idx) => idx === activeIdx ? { ...grp, items: [...grp.items, text] } : grp));
    setDraft('');
  };

  const removeItem = (itemIdx) => {
    setGroups(g => g.map((grp, idx) => idx === activeIdx
      ? { ...grp, items: grp.items.filter((_, i) => i !== itemIdx) }
      : grp
    ));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addItem(); }
  };

  return (
    <div className="op-form">
      <h2>文案库</h2>
      <p className="copy-hint">按分组管理文案，批量执行时可选择从某个分组随机抽取。</p>

      {/* group tabs */}
      <div className="copy-tabs">
        {groups.map((g, i) => (
          <div key={i} className={`copy-tab${activeIdx === i ? ' active' : ''}`} onClick={() => setActiveIdx(i)}>
            {editingIdx === i ? (
              <input
                className="copy-tab-rename"
                value={editName}
                autoFocus
                onChange={e => setEditName(e.target.value)}
                onBlur={() => commitRename(i)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(i); e.stopPropagation(); }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span onDoubleClick={e => { e.stopPropagation(); startRename(i); }}>
                {g.name} <span className="copy-tab-count">{g.items?.length ?? 0}</span>
              </span>
            )}
            <button className="copy-tab-del" onClick={e => { e.stopPropagation(); deleteGroup(i); }}>×</button>
          </div>
        ))}
        <div className="copy-tab-add">
          <input
            className="copy-tab-new-input"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addGroup(); }}
            placeholder="新建分组..."
          />
          <button className="btn-add" onClick={addGroup}>+</button>
        </div>
      </div>

      {/* items in active group */}
      {active ? (<>
        <div className="field" style={{ marginTop: 16 }}>
          <label>添加到「{active.name}」</label>
          <div className="copy-add-row">
            <textarea
              className="copy-draft"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入文案，按 Enter 或点击添加"
              rows={3}
            />
            <button type="button" className="btn-add" onClick={addItem}>添加</button>
          </div>
        </div>
        <div className="copy-list">
          {active.items?.length === 0 && <div className="copy-empty">暂无文案，请添加</div>}
          {active.items?.map((item, i) => (
            <div key={i} className="copy-item">
              <span className="copy-index">{i + 1}</span>
              <span className="copy-text">{item}</span>
              <button className="copy-del" onClick={() => removeItem(i)}>×</button>
            </div>
          ))}
        </div>
      </>) : (
        <div className="copy-empty" style={{ marginTop: 24 }}>请先新建一个分组</div>
      )}

      {totalItems > 0 && (
        <button className="btn-submit" style={{ marginTop: 16 }} onClick={save}>
          {saved ? '✓ 已保存' : `保存文案库（共 ${totalItems} 条）`}
        </button>
      )}
    </div>
  );
}

// ── SchedulesPanel ────────────────────────────────────────
const STATUS_LABEL = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败' };
const STATUS_CLS   = { pending: 'sched-pending', running: 'sched-running', done: 'sched-done', failed: 'sched-failed' };

function SchedulesPanel({ accountNames }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // form state
  const [showForm, setShowForm] = useState(false);
  const [formOp, setFormOp] = useState(SCHEDULABLE_OPERATIONS[0] ?? null);
  const [formFields, setFormFields] = useState({});
  const [formScheduledAt, setFormScheduledAt] = useState('');
  const [formRepeat, setFormRepeat] = useState('');
  const [formAccounts, setFormAccounts] = useState([0]);
  const [formName, setFormName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetch(`${API}/api/schedules`, { headers: { 'x-auth-token': getToken() } })
      .then(r => r.json())
      .then(d => { if (d.ok) setJobs(d.jobs ?? []); else setError(d.error ?? '加载失败'); })
      .catch(() => setError('网络错误'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 15s when there are pending/running jobs
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'running');
    if (!hasActive) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const deleteJob = async (job) => {
    if (!confirm('确认删除该定时任务？')) return;
    const id = job.id || job._dbId;
    if (!id) { alert('任务缺少 ID，无法删除，请刷新页面后重试'); return; }
    try {
      const r = await fetch(`${API}/api/schedules/${id}`, { method: 'DELETE', headers: { 'x-auth-token': getToken() } });
      const d = await r.json();
      if (!d.ok) alert(d.error ?? '删除失败');
    } catch { alert('网络错误，删除失败'); }
    load();
  };

  const runNow = async (id) => {
    const r = await fetch(`${API}/api/schedules/${id}/run`, { method: 'POST', headers: { 'x-auth-token': getToken() } });
    const d = await r.json();
    if (!d.ok) alert(d.error ?? '执行失败');
    else { alert('已触发执行'); load(); }
  };

  const submitJob = async () => {
    if (!formOp) return;
    if (!formScheduledAt) { setFormError('请选择执行时间'); return; }
    // validate required fields
    for (const f of (formOp.fields ?? [])) {
      if (f.required && !String(formFields[f.name] ?? '').trim()) {
        setFormError(`"${f.label}" 不能为空`); return;
      }
    }
    setSubmitting(true); setFormError('');
    try {
      const body = {
        name: formName || `${formOp.label} - ${new Date(formScheduledAt).toLocaleString()}`,
        endpoint: formOp.endpoint,
        body: formFields,
        selectedAccounts: formAccounts,
        scheduledAt: new Date(formScheduledAt).toISOString(),
        repeatMinutes: formRepeat ? Number(formRepeat) : undefined,
        delay: 1000,
        loops: 1,
        roundDelay: 500,
      };
      const r = await fetch(`${API}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? '创建失败');
      setShowForm(false); setFormName(''); setFormFields({}); setFormScheduledAt(''); setFormRepeat(''); setFormAccounts([0]);
      load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAccount = (idx) => {
    setFormAccounts(prev =>
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    );
  };

  return (
    <div className="schedules-panel">
      <div className="panel-header-row">
        <h2 className="panel-title">定时任务</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={load}>刷新</button>
          <button className="btn-submit" onClick={() => setShowForm(v => !v)}>
            {showForm ? '取消' : '+ 新建任务'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="sched-form">
          <div className="sched-form-row">
            <label>任务名称</label>
            <input className="sched-input" value={formName} onChange={e => setFormName(e.target.value)} placeholder="（可选）自定义名称" />
          </div>
          <div className="sched-form-row">
            <label>操作</label>
            <select className="sched-select" value={formOp?.endpoint ?? ''} onChange={e => {
              const op = SCHEDULABLE_OPERATIONS.find(o => o.endpoint === e.target.value);
              setFormOp(op ?? null);
              setFormFields({});
            }}>
              {SCHEDULABLE_OPERATIONS.map(o => (
                <option key={o.endpoint} value={o.endpoint}>{o.group} · {o.label}</option>
              ))}
            </select>
          </div>
          {formOp?.fields?.map(f => (
            <div key={f.name} className="sched-form-row">
              <label>{f.label}</label>
              <input
                className="sched-input"
                value={formFields[f.name] ?? ''}
                onChange={e => setFormFields(prev => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.placeholder ?? ''}
              />
            </div>
          ))}
          <div className="sched-form-row">
            <label>执行时间</label>
            <input type="datetime-local" className="sched-input" value={formScheduledAt} onChange={e => setFormScheduledAt(e.target.value)} />
          </div>
          <div className="sched-form-row">
            <label>重复间隔（分钟）</label>
            <input type="number" className="sched-input" value={formRepeat} onChange={e => setFormRepeat(e.target.value)} placeholder="留空则不重复" min="1" style={{ width: 120 }} />
          </div>
          <div className="sched-form-row">
            <label>账号</label>
            <div className="sched-account-chips">
              {(accountNames?.length ? accountNames : ['默认账号']).map((name, idx) => (
                <button
                  key={idx}
                  className={`sched-chip ${formAccounts.includes(idx) ? 'sched-chip-on' : ''}`}
                  onClick={() => toggleAccount(idx)}
                  type="button"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          {formError && <div className="sched-form-error">{formError}</div>}
          <button className="btn-submit" onClick={submitJob} disabled={submitting}>
            {submitting ? '创建中…' : '创建任务'}
          </button>
        </div>
      )}

      {loading && <div className="sched-empty">加载中…</div>}
      {error && <div className="sched-form-error">{error}</div>}
      {!loading && !error && jobs.length === 0 && <div className="sched-empty">暂无定时任务</div>}

      <div className="sched-list">
        {jobs.map(job => (
          <div key={job.id} className="sched-job-card">
            <div className="sched-job-header">
              <span className="sched-job-name">{job.name || job.endpoint}</span>
              <span className={`sched-status-badge ${STATUS_CLS[job.status] ?? ''}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
            </div>
            <div className="sched-job-meta">
              <span>操作: {job.endpoint}</span>
              <span>计划时间: {job.scheduledAt ? new Date(job.scheduledAt).toLocaleString() : '—'}</span>
              {job.repeatMinutes && <span>每 {job.repeatMinutes} 分钟重复</span>}
              {job.lastRunAt && <span>上次执行: {new Date(job.lastRunAt).toLocaleString()}</span>}
            </div>
            {job.lastResult && (
              <div className="sched-job-result">{typeof job.lastResult === 'string' ? job.lastResult : JSON.stringify(job.lastResult)}</div>
            )}
            <div className="sched-job-actions">
              <button className="btn-secondary" onClick={() => runNow(job.id || job._dbId)}>立即执行</button>
              <button className="btn-danger" onClick={() => deleteJob(job)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── InboxPanel ────────────────────────────────────────────
const INBOX_TABS = [
  { id: 'counts',      label: '未读数',   endpoint: '/api/inbox/unread-counts', method: 'GET', params: {} },
  { id: 'likes',       label: '点赞',     endpoint: '/api/inbox/likes',          method: 'GET', hasSince: true },
  { id: 'at-tweets',   label: '@我微博',  endpoint: '/api/inbox/at-me-tweets',   method: 'GET', hasSince: true },
  { id: 'at-comments', label: '@我评论',  endpoint: '/api/inbox/at-me-comments', method: 'GET', hasSince: true },
  { id: 'comments',    label: '评论通知', endpoint: '/api/inbox/comments',       method: 'GET', hasSince: true },
  { id: 'dms',         label: '私信',     endpoint: '/api/inbox/dm-list',        method: 'GET', hasSince: false },
];

function InboxPanel({ account }) {
  const [tab, setTab] = useState('counts');
  const [unreadCounts, setUnreadCounts] = useState(null);
  const [tabData, setTabData] = useState({});       // { [tabId]: data | null }
  const [tabLoading, setTabLoading] = useState({}); // { [tabId]: bool }
  const [tabError, setTabError] = useState({});     // { [tabId]: string }
  const [sinceId, setSinceId] = useState({});       // { [tabId]: string }
  // DM sub-state
  const [openDmUid, setOpenDmUid] = useState(null);
  const [dmChat, setDmChat] = useState(null);
  const [dmChatLoading, setDmChatLoading] = useState(false);
  const [dmChatError, setDmChatError] = useState(null);
  const [dmContent, setDmContent] = useState('');
  const [dmSending, setDmSending] = useState(false);
  const [dmSendResult, setDmSendResult] = useState(null);

  const headers = useCallback(() => ({
    'x-account': String(account),
    'x-auth-token': getToken(),
  }), [account]);

  // fetch unread counts on mount and on tab changes
  useEffect(() => {
    fetch(`${API}/api/inbox/unread-counts`, { headers: headers() })
      .then(r => r.json())
      .then(d => { if (d.ok) setUnreadCounts(d.data ?? d); })
      .catch(() => {});
  }, [account, headers]);

  const loadTab = useCallback(async (tabId, since = '') => {
    const tabDef = INBOX_TABS.find(t => t.id === tabId);
    if (!tabDef) return;
    setTabLoading(v => ({ ...v, [tabId]: true }));
    setTabError(v => ({ ...v, [tabId]: null }));
    try {
      const params = new URLSearchParams();
      if (since) params.set('sinceId', since);
      if (tabId === 'dms' && since) params.set('page', since);
      const url = `${API}${tabDef.endpoint}${params.toString() ? '?' + params : ''}`;
      const res = await fetch(url, { headers: headers() });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? '请求失败');
      setTabData(v => ({ ...v, [tabId]: d.data ?? d }));
    } catch (e) {
      setTabError(v => ({ ...v, [tabId]: e.message }));
    } finally {
      setTabLoading(v => ({ ...v, [tabId]: false }));
    }
  }, [headers]);

  // load tab data when switching tabs
  useEffect(() => {
    if (tab !== 'counts' && !tabData[tab] && !tabLoading[tab]) {
      loadTab(tab);
    }
  }, [tab]);  // eslint-disable-line

  const loadDmChat = useCallback(async (uid) => {
    setOpenDmUid(uid);
    setDmChat(null);
    setDmChatError(null);
    setDmSendResult(null);
    setDmContent('');
    setDmChatLoading(true);
    try {
      const res = await fetch(`${API}/api/inbox/dm-chat?uid=${encodeURIComponent(uid)}`, { headers: headers() });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? '加载失败');
      setDmChat(d.data ?? d);
    } catch (e) {
      setDmChatError(e.message);
    } finally {
      setDmChatLoading(false);
    }
  }, [headers]);

  const sendDm = useCallback(async () => {
    if (!openDmUid || !dmContent.trim()) return;
    setDmSending(true);
    setDmSendResult(null);
    try {
      const res = await fetch(`${API}/api/inbox/dm-send`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: openDmUid, content: dmContent.trim() }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error ?? '发送失败');
      setDmSendResult({ ok: true });
      setDmContent('');
      // refresh thread
      loadDmChat(openDmUid);
    } catch (e) {
      setDmSendResult({ ok: false, error: e.message });
    } finally {
      setDmSending(false);
    }
  }, [openDmUid, dmContent, headers, loadDmChat]);

  // ── unread count badges ─────────────────────────────────
  const renderCounts = () => {
    if (!unreadCounts) return <div className="inbox-empty">加载中…</div>;
    const raw = unreadCounts?.data ?? unreadCounts;
    const pairs = Object.entries(raw ?? {}).filter(([, v]) => v != null && typeof v !== 'object');
    if (!pairs.length) return <JsonBlock value={unreadCounts} />;
    const labelMap = { follower: '新粉丝', cmt: '评论', like: '点赞', atme: '@提及',
                       dm: '私信', system: '系统', unread_msg_count: '未读消息' };
    return (
      <div className="inbox-count-grid">
        {pairs.map(([key, val]) => (
          <div key={key} className="inbox-count-card">
            <div className="inbox-count-val">{val}</div>
            <div className="inbox-count-key">{labelMap[key] ?? key}</div>
          </div>
        ))}
      </div>
    );
  };

  // ── DM list / thread ────────────────────────────────────
  const renderDms = () => {
    const data = tabData['dms'];
    if (tabLoading['dms']) return <div className="inbox-empty">加载中…</div>;
    if (tabError['dms']) return <div className="inbox-tab-error">{tabError['dms']}</div>;
    if (!data) return <div className="inbox-empty">暂无数据</div>;

    // If a conversation is open, show thread + compose
    if (openDmUid !== null) {
      const msgs = (() => {
        const d = dmChat?.data ?? dmChat;
        if (Array.isArray(d)) return d;
        if (d && Array.isArray(d.list)) return d.list;
        return [];
      })();
      return (
        <div className="dm-thread">
          <button className="btn-secondary" style={{ marginBottom: 14 }} onClick={() => setOpenDmUid(null)}>
            ← 返回
          </button>
          {dmChatLoading && <div className="inbox-empty">加载中…</div>}
          {dmChatError && <div className="inbox-tab-error">{dmChatError}</div>}
          <div className="dm-messages">
            {msgs.map((m, i) => {
              const isMe = m.sender_type === 1 || m.is_self || m.isSelf;
              const text = stripHtml(m.text ?? m.content ?? m.message ?? '');
              const time = m.created_at ?? m.time ?? '';
              return (
                <div key={i} className={`dm-bubble-row ${isMe ? 'dm-me' : 'dm-other'}`}>
                  <div className="dm-bubble">
                    {text && <div className="dm-text">{text}</div>}
                    {time && <div className="dm-time">{time}</div>}
                  </div>
                </div>
              );
            })}
            {msgs.length === 0 && !dmChatLoading && <div className="inbox-empty">暂无消息记录</div>}
          </div>
          <div className="dm-compose">
            <textarea
              className="dm-compose-input"
              value={dmContent}
              onChange={e => setDmContent(e.target.value)}
              placeholder="输入私信内容…"
              rows={3}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); } }}
            />
            <button className="btn-submit" onClick={sendDm} disabled={dmSending || !dmContent.trim()}>
              {dmSending ? '发送中…' : '发送'}
            </button>
            {dmSendResult && (
              <div className={dmSendResult.ok ? 'inbox-send-ok' : 'inbox-tab-error'}>
                {dmSendResult.ok ? '✓ 发送成功' : `✗ ${dmSendResult.error}`}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Conversation list
    const convos = (() => {
      const d = data?.data ?? data;
      if (Array.isArray(d)) return d;
      if (d && Array.isArray(d.list)) return d.list;
      return [];
    })();

    return (
      <div className="inbox-feed">
        {convos.length === 0 && <div className="inbox-empty">暂无私信</div>}
        {convos.map((c, i) => {
          const name = stripHtml(c.user?.screen_name ?? c.user?.name ?? c.sender_screen_name ?? c.name ?? '');
          const uid = c.user?.idstr ?? c.user?.id ?? c.uid ?? c.sender_uid ?? '';
          const preview = stripHtml(c.lastmsg?.text ?? c.text ?? c.last_text ?? c.preview ?? '');
          const time = c.lastmsg?.created_at ?? c.created_at ?? c.time ?? '';
          return (
            <div key={i} className="inbox-dm-card" onClick={() => uid && loadDmChat(String(uid))}>
              <div className="inbox-dm-name">{name || uid || '未知用户'}</div>
              {preview && <div className="inbox-dm-preview">{preview}</div>}
              {time && <div className="inbox-dm-time">{time}</div>}
            </div>
          );
        })}
        {uid => uid && (
          <div className="inbox-dm-manual">
            <span>直接发私信给 UID：</span>
            <input
              className="dm-uid-input"
              placeholder="用户 UID"
              onKeyDown={e => { if (e.key === 'Enter' && e.target.value.trim()) loadDmChat(e.target.value.trim()); }}
            />
          </div>
        )}
      </div>
    );
  };

  // ── generic notification tab ────────────────────────────
  const renderGenericTab = (tabId) => {
    const data = tabData[tabId];
    const loading = tabLoading[tabId];
    const err = tabError[tabId];
    const since = sinceId[tabId] ?? '';

    const items = (() => {
      if (!data) return null;
      const d = data?.data ?? data;
      if (Array.isArray(d)) return d;
      const candidates = ['list', 'statuses', 'notices', 'comments', 'attitudes', 'cards', 'items', 'results', 'feeds'];
      for (const key of candidates) {
        if (d && Array.isArray(d[key])) return d[key];
      }
      return null;
    })();

    const nextSince = (() => {
      const d = data?.data ?? data;
      return d?.since_id ?? d?.sinceId ?? null;
    })();

    return (
      <div className="inbox-feed">
        {err && <div className="inbox-tab-error">{err}</div>}
        {loading && <div className="inbox-empty">加载中…</div>}
        {!loading && !err && items === null && !data && <div className="inbox-empty">暂无数据</div>}
        {items && items.map((item, i) => (
          <ErrorBoundary key={i}><EntityCard item={item} opId={tabId} /></ErrorBoundary>
        ))}
        {items && items.length === 0 && <div className="inbox-empty">暂无通知</div>}
        <div className="inbox-pagination">
          <button
            className="btn-secondary"
            disabled={loading}
            onClick={() => loadTab(tabId, since)}
          >
            {loading ? '加载中…' : '刷新'}
          </button>
          {nextSince && (
            <button
              className="btn-secondary"
              disabled={loading}
              onClick={() => {
                setSinceId(v => ({ ...v, [tabId]: String(nextSince) }));
                loadTab(tabId, String(nextSince));
              }}
            >
              下一页 →
            </button>
          )}
        </div>
        {data && (
          <details className="post-raw-json" style={{ marginTop: 8 }}>
            <summary>查看原始 JSON</summary>
            <JsonBlock value={data} />
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="op-form">
      <div className="inbox-header">
        <h2>收件箱</h2>
        <button
          className="btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            fetch(`${API}/api/inbox/unread-counts`, { headers: headers() })
              .then(r => r.json())
              .then(d => { if (d.ok) setUnreadCounts(d.data ?? d); })
              .catch(() => {});
          }}
        >
          刷新未读数
        </button>
      </div>

      {/* unread badge strip */}
      {unreadCounts && (() => {
        const raw = unreadCounts?.data ?? unreadCounts;
        const pairs = Object.entries(raw ?? {}).filter(([, v]) => v != null && typeof v !== 'object' && Number(v) > 0);
        const labelMap = { follower: '粉丝', cmt: '评论', like: '点赞', atme: '@', dm: '私信', system: '系统', unread_msg_count: '消息' };
        if (!pairs.length) return null;
        return (
          <div className="inbox-badge-strip">
            {pairs.map(([key, val]) => (
              <span key={key} className="inbox-unread-badge">{labelMap[key] ?? key} {val}</span>
            ))}
          </div>
        );
      })()}

      {/* tabs */}
      <div className="inbox-tabs">
        {INBOX_TABS.map(t => (
          <button
            key={t.id}
            className={`inbox-tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="inbox-body">
        {tab === 'counts' && renderCounts()}
        {tab === 'dms'    && renderDms()}
        {tab !== 'counts' && tab !== 'dms' && renderGenericTab(tab)}
      </div>

      {/* quick DM by UID (always visible at bottom) */}
      {tab === 'dms' && openDmUid === null && (
        <div className="inbox-dm-manual">
          <span>发私信给 UID：</span>
          <input
            className="dm-uid-input"
            placeholder="输入用户 UID 后按 Enter"
            onKeyDown={e => { if (e.key === 'Enter' && e.target.value.trim()) loadDmChat(e.target.value.trim()); }}
          />
        </div>
      )}
    </div>
  );
}

function OperationForm({ op, account, accountCount, accountNames }) {
  const initialValuesFromFields = useCallback((fields) => {
    const out = {};
    for (const f of (fields ?? [])) {
      if (f.default !== undefined) out[f.name] = f.default;
    }
    return out;
  }, []);

  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const [batchResults, setBatchResults] = useState(null);   // array of completed results
  const [batchStatus, setBatchStatus] = useState(null);     // { current, total, waiting, remaining }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState(null); // null = all
  const [delay, setDelay] = useState(3000);
  const [cidDelay, setCidDelay] = useState(0);
  const [loops, setLoops] = useState(1);
  const [roundDelay, setRoundDelay] = useState(3000);
  const [useRandom, setUseRandom] = useState(false);
  const [randomGroup, setRandomGroup] = useState('');
  const [copyGroups, setCopyGroups] = useState([]);

  const canBatch = accountCount > 1 && BATCH_SUPPORTED.has(op.endpoint);
  const canLoopBatch = LOOPABLE_BATCH_ENDPOINTS.has(op.endpoint);
  const needsCidDelay = op.endpoint === '/api/batch-like-comment-stream';
  const canRandom = RANDOM_SUPPORTED_OPS.has(op.endpoint);

  // load group names when random is toggled on
  useEffect(() => {
    if (useRandom && copyGroups.length === 0) {
      fetch(`${API}/api/copywriting`, { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
        if (d.ok) setCopyGroups(d.groups ?? []);
      }).catch(() => {});
    }
  }, [useRandom]);

  // reset when operation changes
  useEffect(() => {
    setValues(initialValuesFromFields(op.fields));
    setResult(null);
    setBatchResults(null);
    setBatchStatus(null);
    setError(null);
    setBatchMode(false);
    setSelectedAccounts(null);
    setLoops(1);
    setRoundDelay(3000);
    setUseRandom(false);
    setRandomGroup('');
  }, [op.id, op.fields, initialValuesFromFields]);

  const handleChange = (name, value) => setValues(v => ({ ...v, [name]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setBatchResults(null);
    setBatchStatus(null);
    try {
      if (op.isBatch) {
        // Self-contained batch endpoint (e.g. /api/batch-like-comment-stream):
        // handles multi-account logic internally — call it directly.
        const res = await fetch(`${API}${op.endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
          body: JSON.stringify({
            ...values,
            delay,
            cidDelay,
            selectedAccounts: selectedAccounts,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          let msg;
          try { msg = JSON.parse(text).error; } catch { msg = `服务器错误 (${res.status})`; }
          throw new Error(msg);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const results = [];
        outer2: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            if (evt.type === 'start') {
              setBatchStatus({ step: 0, total: evt.total, waiting: false, label: `${evt.cidCount ?? 0} CIDs × ${evt.accountCount ?? 0} 账号` });
            } else if (evt.type === 'done' || evt.type === 'error') {
              results.push({
                account: (evt.accountIdx ?? 0) + 1,
                loop: 1, totalRounds: 1,
                ok: evt.type !== 'error',
                data: evt.result ?? null,
                error: evt.error ?? null,
                label: `CID ${evt.cid ?? ''} / 账号 ${(evt.accountIdx ?? 0) + 1}`,
              });
              setBatchResults([...results]);
              setBatchStatus(s => s ? { ...s, step: evt.step ?? results.length } : s);
            } else if (evt.type === 'complete') {
              setBatchStatus(null);
              break outer2;
            } else if (evt.type === 'fatal') {
              throw new Error(evt.error ?? '批量请求失败');
            }
          }
        }
      } else if (batchMode) {
        const res = await fetch(`${API}/api/batch-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
          body: JSON.stringify({
            endpoint: op.endpoint,
            body: { ...values, useRandom: canRandom && useRandom, randomField: 'content', randomGroup: randomGroup || null },
            delay,
            ...(needsCidDelay ? { cidDelay } : {}),
            loops: canLoopBatch ? loops : 1,
            roundDelay: canLoopBatch ? roundDelay : 0,
            selectedAccounts: selectedAccounts,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          let msg;
          try { msg = JSON.parse(text).error; } catch { msg = `服务器错误 (${res.status})`; }
          throw new Error(msg);
        }
        // Read SSE stream line by line
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const results = [];
        let streamTotalRounds = 1;
        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop(); // keep last potentially incomplete line
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            if (evt.type === 'start') {
              streamTotalRounds = evt.totalRounds ?? 1;
              setBatchStatus({ step: 0, total: evt.total, waiting: false, label: '' });
            } else if (evt.type === 'running') {
              setBatchStatus({ step: evt.step, total: evt.total, waiting: false,
                label: `${streamTotalRounds > 1 ? `第${evt.loop ?? 1}轮 · ` : ''}${accountNames?.[evt.account - 1] ?? `账号 ${evt.account}`}` });
            } else if (evt.type === 'waiting') {
              setBatchStatus(s => ({ ...(s ?? {}), step: s?.step ?? 0, total: evt.total,
                waiting: true, label: evt.label, remaining: evt.remaining }));
            } else if (evt.type === 'result') {
              results.push({ account: evt.account, loop: evt.loop ?? 1, totalRounds: evt.totalRounds ?? 1,
                ok: evt.ok, data: evt.data, error: evt.error, pickedContent: evt.pickedContent ?? null });
              setBatchResults([...results]);
              setBatchStatus(s => s ? { ...s, step: evt.step, waiting: false } : s);
            } else if (evt.type === 'done') {
              setBatchStatus(null);
              break outer;
            }
          }
        }
      } else {
        const body = canRandom && useRandom
          ? { ...values, useRandom: true, randomField: 'content', randomGroup: randomGroup || null }
          : values;
        const data = await callApi(op, body, account);
        if (data.ok) setResult(data.data);
        else setError(data.error ?? '请求失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="op-form">
      <h2>{op.label}</h2>
      <form onSubmit={handleSubmit}>
        {op.fields.map(field => {
          const isRandomField = useRandom && field.name === 'content';
          const effectiveRequired = field.required && !isRandomField;
          return (
          <div className="field" key={field.name}>
            <label>
              {field.label}
              {effectiveRequired && <span className="req">*</span>}
              {isRandomField && <span className="random-badge">随机</span>}
            </label>
            {field.type === 'textarea' ? (
              <textarea
                value={values[field.name] ?? ''}
                onChange={e => handleChange(field.name, e.target.value)}
                placeholder={isRandomField ? '留空则从文案库随机选取' : (field.placeholder ?? '')}
                required={effectiveRequired}
                rows={4}
              />
            ) : field.type === 'file' ? (
              <input
                type="file"
                accept={field.accept}
                required={effectiveRequired}
                onChange={e => handleChange(field.name, e.target.files[0])}
              />
            ) : field.type === 'select' ? (
              <select
                value={values[field.name] ?? field.default ?? ''}
                onChange={e => handleChange(field.name, e.target.value)}
                required={effectiveRequired}
              >
                {(field.options ?? []).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={values[field.name] ?? ''}
                onChange={e => handleChange(field.name, e.target.value)}
                placeholder={field.placeholder ?? ''}
                required={effectiveRequired}
              />
            )}
          </div>
          );
        })}

        {canRandom && (
          <div className="random-row">
            <label className="batch-toggle">
              <input
                type="checkbox"
                checked={useRandom}
                onChange={e => setUseRandom(e.target.checked)}
              />
              随机文案（从文案库随机选取内容）
            </label>
            {useRandom && copyGroups.length > 0 && (
              <select
                className="group-select"
                value={randomGroup}
                onChange={e => setRandomGroup(e.target.value)}
              >
                <option value="">全部分组</option>
                {copyGroups.map(g => (
                  <option key={g.name} value={g.name}>{g.name}（{g.items?.length ?? 0}条）</option>
                ))}
              </select>
            )}
          </div>
        )}

        {canBatch && (
          <div className="batch-row">
            <label className="batch-toggle">
              <input
                type="checkbox"
                checked={batchMode}
                onChange={e => { setBatchMode(e.target.checked); setSelectedAccounts(null); }}
              />
              批量执行
            </label>
            {batchMode && (<>
              <div className="account-picker">
                {Array.from({ length: accountCount }, (_, i) => {
                  const checked = selectedAccounts === null || selectedAccounts.includes(i);
                  return (
                    <label key={i} className={`account-chip${checked ? ' chip-on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          setSelectedAccounts(prev => {
                            const all = prev === null
                              ? Array.from({ length: accountCount }, (_, j) => j)
                              : [...prev];
                            if (e.target.checked) {
                              const next = [...new Set([...all, i])].sort((a, b) => a - b);
                              return next.length === accountCount ? null : next;
                            } else {
                              const next = all.filter(x => x !== i);
                              return next.length === 0 ? [i] : next; // prevent deselecting all
                            }
                          });
                        }}
                        style={{ display: 'none' }}
                      />
                      {accountNames?.[i] ?? `账号 ${i + 1}`}
                    </label>
                  );
                })}
              </div>
              <label className="delay-label">
                账号间隔
                <input
                  type="number"
                  className="delay-input"
                  value={delay}
                  min={0}
                  step={500}
                  onChange={e => setDelay(Number(e.target.value))}
                />
                ms
              </label>
              {needsCidDelay && (
                <label className="delay-label">
                  CID间隔
                  <input
                    type="number"
                    className="delay-input"
                    value={cidDelay}
                    min={0}
                    step={500}
                    onChange={e => setCidDelay(Number(e.target.value))}
                  />
                  ms
                </label>
              )}
              {canLoopBatch && (
                <>
                  <label className="delay-label">
                    循环次数
                    <input
                      type="number"
                      className="delay-input"
                      value={loops}
                      min={1}
                      step={1}
                      onChange={e => setLoops(Math.max(1, Number(e.target.value) || 1))}
                    />
                    次
                  </label>
                  {loops > 1 && (
                    <label className="delay-label">
                      轮间隔
                      <input
                        type="number"
                        className="delay-input"
                        value={roundDelay}
                        min={0}
                        step={500}
                        onChange={e => setRoundDelay(Math.max(0, Number(e.target.value) || 0))}
                      />
                      ms
                    </label>
                  )}
                </>
              )}
            </>)}
          </div>
        )}

        <button type="submit" className="btn-submit" disabled={loading}>
          {loading ? (batchMode ? '批量执行中...' : '请求中...') : (batchMode ? '批量执行' : '执行')}
        </button>
      </form>

      {error && (
        <div className="result error">
          <span className="tag err">✗ 错误</span>
          <PrettyResponse value={error} opId={op.id} />
        </div>
      )}
      {result !== null && (
        <div className="result success">
          <span className="tag ok">✓ 成功</span>
          <PrettyResponse value={result} opId={op.id} />
        </div>
      )}
      {batchStatus && (
        <div className="batch-progress">
          <div className="batch-progress-bar">
            <div
              className="batch-progress-fill"
              style={{ width: `${((batchStatus.step ?? 0) / batchStatus.total) * 100}%` }}
            />
          </div>
          <div className="batch-progress-label">
            {batchStatus.waiting
              ? `${batchStatus.label}… ${(batchStatus.remaining / 1000).toFixed(1)}s`
              : `${batchStatus.label} 执行中… (${batchStatus.step ?? 0}/${batchStatus.total})`}
          </div>
        </div>
      )}
      {batchResults && (() => {
        const ok = batchResults.filter(r => r.ok).length;
        const fail = batchResults.length - ok;
        const done = !batchStatus && !loading;
        return (
          <div className="batch-results">
            {done && (
              <div className="batch-summary">
                <span className="batch-summary-ok">✓ 成功 {ok} 个</span>
                {fail > 0 && <span className="batch-summary-fail">✗ 失败 {fail} 个</span>}
              </div>
            )}
            {batchResults.map((r, idx) => (
              <div key={idx} className={`result ${r.ok ? 'success' : 'error'}`}>
                <span className={`tag ${r.ok ? 'ok' : 'err'}`}>
                  {r.totalRounds > 1 ? `第${r.loop}轮 ` : ''}{accountNames?.[r.account - 1] ?? `账号 ${r.account}`} — {r.ok ? '✓ 成功' : '✗ 失败'}
                </span>
                <PrettyResponse value={r.ok ? r.data : r.error} opId={op.id} />
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

export default function App() {
  const [selected, setSelected] = useState(OPERATIONS[0]);
  const [showCopywriting, setShowCopywriting] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [account, setAccount] = useState(0);
  const [accountCount, setAccountCount] = useState(1);
  const [accountNames, setAccountNames] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refreshAccounts = useCallback(() => {
    fetch(`${API}/api/accounts`, { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) {
        setAccountCount(d.count);
        setAccountNames((d.accounts ?? []).map(a => a.name));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => { refreshAccounts(); }, [refreshAccounts]);

  const selectOp = (op) => { setSelected(op); setShowCopywriting(false); setShowAccounts(false); setShowSchedules(false); setShowInbox(false); setSidebarOpen(false); };

  return (
    <div className="layout">
      <button className="hamburger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">☰</button>
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">微博客户端</div>
          {accountCount > 1 && (
            <div className="account-select">
              <label>账号</label>
              <select value={account} onChange={e => setAccount(Number(e.target.value))}>
                {Array.from({ length: accountCount }, (_, i) => (
                  <option key={i} value={i}>{accountNames[i] ?? `账号 ${i + 1}`}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <nav>
          {GROUPS.map(group => (
            <div key={group} className="nav-group">
              <div className="nav-group-label">{group}</div>
              {OPERATIONS.filter(o => o.group === group).map(op => (
                <button
                  key={op.id}
                  className={`nav-item${!showCopywriting && !showAccounts && !showSchedules && selected.id === op.id ? ' active' : ''}`}
                  onClick={() => selectOp(op)}
                >
                  {op.label}
                </button>
              ))}
            </div>
          ))}
          <div className="nav-group">
            <div className="nav-group-label">工具</div>
            <button
              className={`nav-item${showAccounts ? ' active' : ''}`}
              onClick={() => { setShowAccounts(true); setShowCopywriting(false); setShowSchedules(false); setSidebarOpen(false); }}
            >
              👤 账号管理
            </button>
            <button
              className={`nav-item${showCopywriting ? ' active' : ''}`}
              onClick={() => { setShowCopywriting(true); setShowAccounts(false); setShowSchedules(false); setSidebarOpen(false); }}
            >
              📝 文案库
            </button>
            <button
              className={`nav-item${showSchedules ? ' active' : ''}`}
              onClick={() => { setShowSchedules(true); setShowAccounts(false); setShowCopywriting(false); setShowInbox(false); setSidebarOpen(false); }}
            >
              ⏰ 定时任务
            </button>
            <button
              className={`nav-item${showInbox ? ' active' : ''}`}
              onClick={() => { setShowInbox(true); setShowAccounts(false); setShowCopywriting(false); setShowSchedules(false); setSidebarOpen(false); }}
            >
              📬 收件箱
            </button>
          </div>
        </nav>
      </aside>
      <main className="main">
        {showAccounts
          ? <AccountsPanel onCountChange={(n, names) => { setAccountCount(n); setAccountNames(names ?? []); setAccount(a => Math.min(a, Math.max(0, n - 1))); }} />
          : showCopywriting
          ? <CopywritingPanel />
          : showSchedules
          ? <SchedulesPanel accountNames={accountNames} />
          : showInbox
          ? <InboxPanel account={account} />
          : <OperationForm key={selected.id} op={selected} account={account} accountCount={accountCount} accountNames={accountNames} />
        }
      </main>
    </div>
  );
}
