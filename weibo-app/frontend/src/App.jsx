import { useState, useEffect, useCallback } from 'react';
import { OPERATIONS, GROUPS, RANDOM_SUPPORTED_OPS } from './config.js';

const API = '';  // proxied via vite to http://localhost:3001

function getToken() { return localStorage.getItem('auth_token') || ''; }

async function callApi(op, formData, account) {
  const headers = { 'x-account': String(account), 'x-auth-token': getToken() };

  if (op.method === 'UPLOAD') {
    const body = new FormData();
    for (const [k, v] of Object.entries(formData)) {
      if (v instanceof File) body.append(k, v);
      else if (v) body.append(k, v);
    }
    const res = await fetch(`${API}${op.endpoint}`, { method: 'POST', headers, body });
    return res.json();
  }

  if (op.method === 'GET') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(formData)) {
      if (v) params.set(k, v);
    }
    const url = `${API}${op.endpoint}${params.toString() ? '?' + params : ''}`;
    const res = await fetch(url, { headers });
    return res.json();
  }

  // POST JSON
  headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${op.endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(formData),
  });
  return res.json();
}

const BATCH_SUPPORTED = new Set([
  '/api/post-tweet', '/api/delete-tweet', '/api/quick-repost', '/api/repost-tweet',
  '/api/comment-tweet', '/api/reply-comment', '/api/delete-comment',
  '/api/follow-user', '/api/unfollow-user', '/api/like-tweet', '/api/unlike-tweet',
  '/api/follow-super-topic',
]);

// ── AccountsPanel ─────────────────────────────────────────
function AccountsPanel({ onCountChange }) {
  const [accounts, setAccounts] = useState([]);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [validating, setValidating] = useState({});   // {index: true/false}
  const [validResults, setValidResults] = useState({}); // {index: {valid, name, uid, avatar, error, missingRec}}

  useEffect(() => {
    fetch('/api/accounts', { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) setAccounts(d.accounts ?? []);
    }).catch(() => {});
  }, []);

  const update = (i, field, value) => {
    setAccounts(a => a.map((acc, idx) => idx === i ? { ...acc, [field]: value } : acc));
    if (field === 'cookie') setValidResults(v => { const n = { ...v }; delete n[i]; return n; });
  };

  const addAccount = () =>
    setAccounts(a => [...a, { cookie: '', name: `账号 ${a.length + 1}` }]);

  const removeAccount = (i) => {
    setAccounts(a => a.filter((_, idx) => idx !== i));
    setValidResults(v => { const n = { ...v }; delete n[i]; return n; });
  };

  const validate = async (i) => {
    const cookie = accounts[i]?.cookie?.trim();
    if (!cookie) return;
    setValidating(v => ({ ...v, [i]: true }));
    try {
      const res = await fetch('/api/validate-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({ cookie }),
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
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? '保存失败');
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      if (onCountChange) onCountChange(data.count, accounts.map(a => a.name));
    } catch (err) {
      setSaveError(err.message);
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
              <button className="copy-del" onClick={() => removeAccount(i)}>删除</button>
            </div>
            <textarea
              className="cookie-input"
              value={acc.cookie}
              onChange={e => update(i, 'cookie', e.target.value)}
              placeholder="粘贴完整 Cookie 字符串（需包含 SUB 和 XSRF-TOKEN）"
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
    fetch('/api/copywriting', { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) {
        setGroups(d.groups ?? []);
        setActiveIdx(0);
      }
    }).catch(() => {});
  }, []);

  const save = async () => {
    try {
      const res = await fetch('/api/copywriting', {
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

function OperationForm({ op, account, accountCount, accountNames }) {
  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const [batchResults, setBatchResults] = useState(null);   // array of completed results
  const [batchStatus, setBatchStatus] = useState(null);     // { current, total, waiting, remaining }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState(null); // null = all
  const [delay, setDelay] = useState(3000);
  const [loops, setLoops] = useState(1);
  const [roundDelay, setRoundDelay] = useState(0);
  const [useRandom, setUseRandom] = useState(false);
  const [randomGroup, setRandomGroup] = useState('');
  const [copyGroups, setCopyGroups] = useState([]);

  const canBatch = accountCount > 1 && BATCH_SUPPORTED.has(op.endpoint);
  const canRandom = RANDOM_SUPPORTED_OPS.has(op.endpoint);

  // load group names when random is toggled on
  useEffect(() => {
    if (useRandom && copyGroups.length === 0) {
      fetch('/api/copywriting', { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
        if (d.ok) setCopyGroups(d.groups ?? []);
      }).catch(() => {});
    }
  }, [useRandom]);

  // reset when operation changes
  useEffect(() => {
    setValues({});
    setResult(null);
    setBatchResults(null);
    setBatchStatus(null);
    setError(null);
    setBatchMode(false);
    setSelectedAccounts(null);
    setUseRandom(false);
    setRandomGroup('');
    setLoops(1);
    setRoundDelay(0);
  }, [op.id]);

  const handleChange = (name, value) => setValues(v => ({ ...v, [name]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setBatchResults(null);
    setBatchStatus(null);
    try {
      if (batchMode) {
        const res = await fetch('/api/batch-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': getToken() },
          body: JSON.stringify({
            endpoint: op.endpoint,
            body: { ...values, useRandom: canRandom && useRandom, randomField: 'content', randomGroup: randomGroup || null },
            delay,
            loops,
            roundDelay,
            selectedAccounts: selectedAccounts,
          }),
        });
        if (!res.ok || !res.body) {
          const text = await res.text();
          let msg;
          try { msg = JSON.parse(text).error; } catch { msg = `服务器错误 (${res.status})，请重启后端。`; }
          throw new Error(msg);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const collected = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop(); // keep incomplete line
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === 'start') {
              setBatchStatus({ current: 0, total: evt.total, waiting: false, remaining: 0 });
            } else if (evt.type === 'running') {
              setBatchStatus({ label: `第 ${evt.loop}/${evt.totalRounds} 轮 · ${accountNames?.[evt.account - 1] ?? `账号 ${evt.account}`}`, step: evt.step, total: evt.total, waiting: false, remaining: 0 });
            } else if (evt.type === 'waiting') {
              setBatchStatus(s => ({ ...s, label: evt.label, waiting: true, remaining: evt.remaining }));
            } else if (evt.type === 'result') {
              collected.push({ account: evt.account, loop: evt.loop, totalRounds: evt.totalRounds, ok: evt.ok, data: evt.data, error: evt.error, pickedContent: evt.pickedContent });
              setBatchResults([...collected]);
              setBatchStatus(s => ({ ...s, waiting: false }));
            } else if (evt.type === 'done') {
              setBatchStatus(null);
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
              <label className="delay-label">
                循环
                <input
                  type="number"
                  className="delay-input"
                  value={loops}
                  min={1}
                  step={1}
                  onChange={e => setLoops(Math.max(1, Number(e.target.value)))}
                />
                轮
              </label>
              <label className="delay-label">
                轮间隔
                <input
                  type="number"
                  className="delay-input"
                  value={roundDelay}
                  min={0}
                  step={500}
                  onChange={e => setRoundDelay(Number(e.target.value))}
                />
                ms
              </label>
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
          <pre>{error}</pre>
        </div>
      )}
      {result !== null && (
        <div className="result success">
          <span className="tag ok">✓ 成功</span>
          <pre>{JSON.stringify(result, null, 2)}</pre>
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
                {r.pickedContent && <div className="picked-content">📝 {r.pickedContent}</div>}
                <pre>{JSON.stringify(r.ok ? r.data : r.error, null, 2)}</pre>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [selected, setSelected] = useState(OPERATIONS[0]);
  const [showCopywriting, setShowCopywriting] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [account, setAccount] = useState(0);
  const [accountCount, setAccountCount] = useState(1);
  const [accountNames, setAccountNames] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Check if already authenticated
  useEffect(() => {
    const token = getToken();
    if (!token) { setAuthChecked(true); return; }
    fetch('/api/me', { headers: { 'x-auth-token': token } })
      .then(r => r.json())
      .then(d => { if (d.ok) setAuthed(true); })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  const refreshAccounts = useCallback(() => {
    fetch('/api/accounts', { headers: { 'x-auth-token': getToken() } }).then(r => r.json()).then(d => {
      if (d.ok) {
        setAccountCount(d.count);
        setAccountNames((d.accounts ?? []).map(a => a.name));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => { if (authed) refreshAccounts(); }, [authed, refreshAccounts]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        localStorage.setItem('auth_token', data.token);
        setAuthed(true);
      } else {
        setLoginError(data.error ?? '登录失败');
      }
    } catch {
      setLoginError('网络错误，请重试');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': getToken() } }).catch(() => {});
    localStorage.removeItem('auth_token');
    setAuthed(false);
  };

  const selectOp = (op) => { setSelected(op); setShowCopywriting(false); setShowAccounts(false); setSidebarOpen(false); };

  if (!authChecked) return null;

  if (!authed) {
    return (
      <div className="login-overlay">
        <form className="login-box" onSubmit={handleLogin}>
          <h2>微博客户端</h2>
          <input
            type="text"
            placeholder="用户名"
            value={loginUser}
            onChange={e => setLoginUser(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            type="password"
            placeholder="密码"
            value={loginPass}
            onChange={e => setLoginPass(e.target.value)}
            autoComplete="current-password"
            required
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <button type="submit" disabled={loginLoading}>
            {loginLoading ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    );
  }

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
                  className={`nav-item${!showCopywriting && !showAccounts && selected.id === op.id ? ' active' : ''}`}
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
              onClick={() => { setShowAccounts(true); setShowCopywriting(false); setSidebarOpen(false); }}
            >
              👤 账号管理
            </button>
            <button
              className={`nav-item${showCopywriting ? ' active' : ''}`}
              onClick={() => { setShowCopywriting(true); setSidebarOpen(false); }}
            >
              📝 文案库
            </button>
            <button className="nav-item" onClick={handleLogout}>退出登录</button>
          </div>
        </nav>
      </aside>
      <main className="main">
        {showAccounts
          ? <AccountsPanel onCountChange={(n, names) => { setAccountCount(n); setAccountNames(names ?? []); setAccount(a => Math.min(a, Math.max(0, n - 1))); }} />
          : showCopywriting
          ? <CopywritingPanel />
          : <OperationForm key={selected.id} op={selected} account={account} accountCount={accountCount} accountNames={accountNames} />
        }
      </main>
    </div>
  );
}
