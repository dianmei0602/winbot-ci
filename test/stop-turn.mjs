// 验证「停止这一轮」：发一个慢活，点停止，应留下「已停止」提示且机器人空闲，之后还能继续聊。
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
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});

console.log('=== 发一个慢活 ===');
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用 generate_video 生成一段视频：一只猫在窗台上睡觉，慢慢推镜头。512x512。',
});
await new Promise((r) => setTimeout(r, 12000));
const before = await api('GET', `/api/conversations/${conversation.id}`);
console.log('  消息数', before.messages.length, '最后一条', before.messages.at(-1)?.role);

console.log('=== 点停止 ===');
const stop = await api('POST', `/api/conversations/${conversation.id}/stop`, {});
console.log('  stop ->', JSON.stringify(stop));
ok('停止请求生效', stop.ok === true || stop.stopped === true);

await new Promise((r) => setTimeout(r, 2500));
const after = await api('GET', `/api/conversations/${conversation.id}`);
const hasNote = after.messages.some((m) => m.meta?.stopped || String(m.content).includes('已停止'));
ok('留下了「已停止」提示', hasNote, JSON.stringify(after.messages.map((m) => m.role)));
const status = (await api('GET', '/api/bots')).find((b) => b.id === bot.id);
console.log('  bot busy:', status?.busy);

console.log('=== 停止之后还能继续聊 ===');
await api('POST', `/api/conversations/${conversation.id}/send`, { text: '只回答两个字：在的' });
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
ok('停完还能正常回复', reply.includes('在的'), reply.slice(0, 60));
await api('DELETE', `/api/conversations/${conversation.id}`);
