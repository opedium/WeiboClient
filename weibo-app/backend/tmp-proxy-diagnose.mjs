import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getAccounts } from './db.js';

const targets = [
  'https://weibo.com/ajax/profile/info',
  'https://weibo.com/',
  'https://login.sina.com.cn/',
];

function classify(err) {
  const msg = String(err?.message ?? '');
  const code = String(err?.code ?? '');
  if (/ETIMEDOUT|ECONNABORTED|timeout|timed out|ERR_TIMED_OUT/i.test(msg) || /ETIMEDOUT|ECONNABORTED/i.test(code)) return 'network_timeout';
  if (/ECONNRESET|ECONNREFUSED|ERR_CONNECTION_CLOSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(msg) || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(code)) return 'network_proxy_error';
  return 'other_error';
}

const accounts = await getAccounts();
console.log(`accounts=${accounts.length}`);
for (let i = 0; i < accounts.length; i++) {
  const a = accounts[i] || {};
  const name = String(a.name ?? '').trim() || `账号 ${i + 1}`;
  const proxy = String(a.proxy ?? '').trim();
  console.log(`\n[${i}] ${name}`);
  if (!proxy) {
    console.log('  proxy: <none>');
    continue;
  }
  console.log(`  proxy: ${proxy.replace(/:[^:@/]{2,}@/, ':***@')}`);

  let agent;
  try {
    agent = new HttpsProxyAgent(proxy);
  } catch (e) {
    console.log(`  proxy_parse: FAIL ${e.message}`);
    continue;
  }

  for (const url of targets) {
    const start = Date.now();
    try {
      const resp = await axios.get(url, {
        httpsAgent: agent,
        proxy: false,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': '*/*',
        },
      });
      const ms = Date.now() - start;
      console.log(`  ${url} -> HTTP ${resp.status} (${ms}ms)`);
    } catch (e) {
      const ms = Date.now() - start;
      console.log(`  ${url} -> ${classify(e)} (${ms}ms) ${e.code ?? ''} ${e.message}`);
    }
  }
}
