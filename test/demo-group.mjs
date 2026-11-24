// 建一个演示群，并让群里说一句话（截图/演示用）。
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
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

const bots = await api('GET', '/api/bots');
let g = (await api('GET', '/api/groups')).find((x) => x.name === '写作小组');
if (!g) {
  const r = await api('POST', '/api/groups', { name: '写作小组', botIds: bots.map((b) => b.id) });
  g = r.group;
  console.log('created group', g.id);
}
const data = await api('GET', `/api/groups/${g.id}`);
if (!(data.messages || []).length) {
  await api('POST', `/api/groups/${g.id}/send`, { text: '@小七 用一句话说说这个群该干什么。' });
  // 等它答完
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await api('GET', `/api/groups/${g.id}`);
    if ((d.messages || []).some((m) => m.role === 'assistant')) break;
  }
}
const final = await api('GET', `/api/groups/${g.id}`);
console.log('group:', g.id, 'messages:', final.messages.length);
for (const m of final.messages) console.log(` [${m.role}] ${m.meta?.speakerName || ''} ${String(m.content).slice(0, 60)}`);
