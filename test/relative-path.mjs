// 相对路径验证：让它写一个文件并汇报，回复里应该是相对路径，而不是 E:\...
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
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
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bot = (await api('GET', '/api/bots')).find((b) => b.name === '小七') || (await api('GET', '/api/bots'))[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '在 outputs 下写一个 note-rel.txt，内容「relative path test」。写完只告诉我文件在哪。',
});
let reply = '';
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  const m = d.messages.filter((x) => x.role === 'assistant').at(-1);
  if (m && String(m.content).trim()) {
    reply = m.content;
    break;
  }
}
console.log('回复:', reply.slice(0, 200).replace(/\n/g, ' / '));
ok('回复里没有再出现盘符绝对路径', !/[A-Za-z]:\\/.test(reply), reply.match(/[A-Za-z]:\\[^\s`)]+/)?.[0] || '');
ok('回复里是工作区相对路径', /outputs\//.test(reply) || /outputs\\/.test(reply));
await api('DELETE', `/api/conversations/${conversation.id}`);
