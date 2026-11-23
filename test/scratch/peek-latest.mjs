import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return r.json();
};
const bots = await api('/api/bots');
const bot = bots[0];
const convs = await api(`/api/bots/${bot.id}/conversations`);
console.log('最近会话:', convs.slice(0, 3).map((c) => `${c.id} ${c.title}`).join(' | '));
const latest = convs[0];
const d = await api(`/api/conversations/${latest.id}`);
for (const m of d.messages.slice(-3)) {
  console.log(`[${m.role}]`, String(m.content).slice(0, 300).replace(/\n/g, ' / '));
}
