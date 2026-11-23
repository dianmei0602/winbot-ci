// 原始 SSE 探针：连上会话事件流，发一句话，把收到的前几行原样打印。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const j = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};
const bots = await j('GET', '/api/bots');
const bot = bots[0];
const { conversation } = await j('POST', `/api/bots/${bot.id}/conversations`, {});
console.log('conv', conversation.id);

const ac = new AbortController();
const res = await fetch(`${BASE}/api/conversations/${conversation.id}/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
console.log('SSE status', res.status, res.headers.get('content-type'));

const reader = res.body.getReader();
const dec = new TextDecoder();
let raw = '';
const types = {};
(async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    raw += chunk;
    for (const m of chunk.matchAll(/data: (\{.*\})/g)) {
      try {
        const ev = JSON.parse(m[1]);
        types[ev.type] = (types[ev.type] || 0) + 1;
      } catch {
        /* ignore */
      }
    }
  }
})();

await j('POST', `/api/conversations/${conversation.id}/send`, { text: '说一句短话' });
await new Promise((r) => setTimeout(r, 12_000));
ac.abort();
console.log('事件类型统计:', JSON.stringify(types));
console.log('原始片段:', JSON.stringify(raw.slice(0, 400)));
await fetch(`${BASE}/api/conversations/${conversation.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
process.exit(0);
