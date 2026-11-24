// 验证打包版能不能真正跑一轮（DSH 在 asar 里是否找得到插件/工具）。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const tokenFile = `${process.env.APPDATA}\\winbot\\data\\ui-token`;
const token = fs.readFileSync(tokenFile, 'utf8').trim();
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

let bots = await api('GET', '/api/bots');
if (!bots.length) {
  const r = await api('POST', '/api/bots', { name: '测试', avatar: 'blue', summary: '打包验证用' });
  bots = await api('GET', '/api/bots');
  console.log('建了个测试机器人:', bots[0].id);
}
const bot = bots[0];

const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '只回答两个字：可以。另外确认一下你现在能用的工具里有没有 remember。',
});

const deadline = Date.now() + 240_000;
let last = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  last = d.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  if (last) break;
}
ok('打包版能跑完一轮', !!last && last.role === 'assistant', String(last?.content || '').slice(0, 120));
ok('模型带了自己的记忆工具', /记得|remember|有/.test(String(last?.content || '')));
console.log('回复:', String(last?.content || '').slice(0, 200));
