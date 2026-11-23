// 验证：模型输出是不是逐字推过来的（增量事件），而不是等整段。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});

// 订阅这个机器人的事件
const res = await fetch(`${BASE}/api/conversations/${conversation.id}/events?token=${encodeURIComponent(token)}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const deltas = [];
let firstDeltaAt = 0;
let finalAt = 0;
let done = false;

(async () => {
  while (!done) {
    const { value, done: d } = await reader.read().catch(() => ({ done: true }));
    if (d) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.type === 'delta' && ev.conversationId === conversation.id) {
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        deltas.push({ t: Date.now(), text: ev.text });
      }
      if (ev.type === 'status' && ev.busy === false) finalAt = Date.now();
    }
  }
})();

const startedAt = Date.now();
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用三句话介绍一下你自己，每句一行。',
});

const deadline = Date.now() + 240_000;
let assistant = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 800));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  assistant = d.messages.filter((m) => m.role === 'assistant').at(-1);
  if (assistant) break;
}
// 给最后几个增量一点到达时间
await new Promise((r) => setTimeout(r, 1500));
done = true;
try {
  await reader.cancel();
} catch {
  /* ignore */
}

const text = deltas.map((d) => d.text).join('');
const span = deltas.length ? deltas[deltas.length - 1].t - deltas[0].t : 0;
console.log('回复：', String(assistant?.content || '').slice(0, 120));
console.log(`增量包：${deltas.length} 个，跨度 ${span}ms，首个在 ${firstDeltaAt ? firstDeltaAt - startedAt : '?'}ms，正文 ${text.length} 字`);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('收到了增量而不是只有整段', deltas.length >= 3, `${deltas.length} 个包`);
ok('增量是逐步到的（不是一次性）', deltas.length >= 2 && span >= 40, `跨度 ${span}ms`);
ok('增量拼起来和最终回复一致', !!assistant && text.trim().slice(0, 30) === String(assistant.content).trim().slice(0, 30), `${text.length} / ${String(assistant?.content || '').length} 字`);
ok('首字在整段之前到', firstDeltaAt > 0 && finalAt > 0 && firstDeltaAt < finalAt, `首字 ${firstDeltaAt - startedAt}ms / 结束 ${finalAt - startedAt}ms`);

await api('DELETE', `/api/conversations/${conversation.id}`);
process.exit(0);


