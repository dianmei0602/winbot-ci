// 抓一次真实回合的 SSE：看 tool-call / tool-result 有没有发出来，以及是否落库。
import fs from 'node:fs';

const B = 'http://127.0.0.1:5178';
const DATA = `${process.env.APPDATA}/winbot/data`;
const token = fs.readFileSync(`${DATA}/ui-token`, 'utf8').trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bots = await (await fetch(`${B}/api/bots`, { headers: H })).json();
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await (await fetch(`${B}/api/bots/${bot.id}/conversations`, { method: 'POST', headers: H, body: '{}' })).json();
console.log('会话:', conversation.id);

const events = [];
const ctrl = new AbortController();
const res = await fetch(`${B}/api/conversations/${conversation.id}/events?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
console.log('SSE 状态:', res.status);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const pump = (async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type !== 'hello') events.push(ev);
        } catch {}
      }
    }
  } catch {}
})();

await sleep(1500);
await fetch(`${B}/api/conversations/${conversation.id}/send`, { method: 'POST', headers: H, body: JSON.stringify({ text: '用 pwsh 执行 Get-Date -Format "yyyyMMddHHmmss"，只把数字贴给我' }) });

const started = Date.now();
let done = false;
while (Date.now() - started < 180000 && !done) {
  await sleep(3000);
  const d = await (await fetch(`${B}/api/conversations/${conversation.id}`, { headers: H })).json();
  const last = (d.messages || []).slice(-1)[0] || {};
  if (last.role === 'assistant' || last.role === 'error') done = true;
}
ctrl.abort();
await pump.catch(() => {});

const kinds = {};
for (const e of events) kinds[e.type] = (kinds[e.type] || 0) + 1;
console.log('\nSSE 事件统计:', JSON.stringify(kinds));
for (const e of events.filter((x) => x.type.startsWith('tool'))) console.log('  ', e.type, e.name || '', (e.args || '').slice(0, 60));

// 查库
process.env.WINBOT_DATA = DATA.replace(/\\/g, '/');
const { listToolCalls } = await import('file:///E:/AI_work/winbot/src/db.js');
const rows = listToolCalls(conversation.id);
console.log('\n库里 tool_calls:', JSON.stringify(rows.map((r) => r.name + (r.isError ? '✗' : '✓'))));
const d = await (await fetch(`${B}/api/conversations/${conversation.id}`, { headers: H })).json();
console.log('API tools:', JSON.stringify((d.tools || []).map((t) => t.name)));
console.log('回复:', String((d.messages || []).slice(-1)[0]?.content || '').slice(0, 120).replace(/\n/g, ' '));
