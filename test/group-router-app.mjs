// 群聊路由实测：建一个 model 路由的群，不 @ 任何人，看谁答、理由是什么。
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

const bots = (await api('GET', '/api/bots')).filter((b) => !b.name.startsWith('测试'));
if (bots.length < 2) throw new Error('需要两个机器人');
for (const g of (await api('GET', '/api/groups')).filter((x) => x.name.startsWith('路由测试'))) {
  await api('DELETE', `/api/groups/${g.id}`);
}
const { group } = await api('POST', '/api/groups', { name: '路由测试', botIds: bots.slice(0, 2).map((b) => b.id), router: 'model' });
console.log('群:', group.name, '成员:', group.members.map((m) => m.name).join('、'), '路由:', group.router);

await api('POST', `/api/groups/${group.id}/send`, { text: '帮我把这段稿子的措辞改顺一点，别动意思。' });
let data = null;
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  data = await api('GET', `/api/groups/${group.id}`);
  if ((data.messages || []).some((m) => m.role === 'assistant')) break;
}
const reply = (data.messages || []).filter((m) => m.role === 'assistant').at(-1);
ok('群里有人回答了', !!reply, reply?.meta?.speakerName || '');
ok('回复绑定了发言人', !!reply?.meta?.speakerBotId, reply?.meta?.speakerBotId || '');

const log = fs.readFileSync('data/server.log', 'utf8');
const line = log.split('\n').reverse().find((l) => l.includes('router(') && l.includes('->'));
ok('日志里有路由决策', !!line, (line || '').slice(0, 160));
ok('走的是 model 路由', /router\(model\)/.test(line || ''), '');

await api('DELETE', `/api/groups/${group.id}`);
console.log('已清理测试群');
