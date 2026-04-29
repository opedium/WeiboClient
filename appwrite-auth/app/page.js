'use client';

import { useState, useEffect } from 'react';

const BACKEND = 'http://localhost:3001';

export default function AuthPage() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (!token) { setChecking(false); return; }
    fetch(`${BACKEND}/api/me`, { headers: { 'x-auth-token': token } })
      .then(r => r.json())
      .then(d => { if (d.ok) setUser(d.user ?? username); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  async function login(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${BACKEND}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        localStorage.setItem('auth_token', data.token);
        setUser(username);
      } else {
        setError(data.error ?? 'Invalid credentials');
      }
    } catch {
      setError('Cannot reach backend at ' + BACKEND);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem('auth_token');
    setUser(null);
  }

  if (checking) return <p style={s.center}>Loading...</p>;

  if (user) {
    return (
      <div style={s.container}>
        <div style={s.card}>
          <h2 style={s.heading}>Welcome!</h2>
          <p style={s.info}>Logged in as <strong>{user}</strong></p>
          <button style={s.btn} onClick={logout}>Logout</button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <form style={s.card} onSubmit={login}>
        <h2 style={s.heading}>Admin Login</h2>
        <input style={s.input} type="text" placeholder="Username" value={username}
          onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        <input style={s.input} type="password" placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        {error && <p style={s.error}>{error}</p>}
        <button style={s.btn} type="submit" disabled={loading || !username || !password}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
      </form>
    </div>
  );
}

const s = {
  center: { textAlign: 'center', marginTop: '40vh', fontFamily: 'sans-serif' },
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5', fontFamily: 'sans-serif' },
  card: { background: '#fff', borderRadius: 12, padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.1)', width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 14 },
  heading: { margin: 0, fontSize: 22, textAlign: 'center', color: '#1a1a2e' },
  info: { margin: 0, textAlign: 'center', fontSize: 16 },
  input: { padding: '10px 14px', border: '1px solid #ddd', borderRadius: 7, fontSize: 15, outline: 'none', width: '100%', boxSizing: 'border-box' },
  btn: { padding: '10px 0', background: '#5b7fff', color: '#fff', border: 'none', borderRadius: 7, fontSize: 15, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, margin: 0, textAlign: 'center' },
};
