// 验证：新记的事，下一条消息就能用上（不靠手动重启）。
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
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];

// 清掉上一轮的测试条目
for (const l of (await api('GET', '/api/about')).lines) {
  if (l.text.includes('蓝色风筝')) await api('DELETE', `/api/about/${l.id}`);
}

async function ask(text, { timeoutMs = 200_000 } = {}) {
  const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  let reply = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await api('GET', `/api/conversations/${conversation.id}`);
    const a = d.messages.filter((m) => m.role === 'assistant').at(-1);
    if (a) {
      reply = a.content;
      break;
    }
  }
  await api('DELETE', `/api/conversations/${conversation.id}`);
  return reply;
}

console.log('=== 1. 界面里加一条关于我，然后开新对话问它 ===');
await api('POST', '/api/about', { text: '他的暗号是蓝色风筝-9281。' });
const r1 = await ask('只回答：我的暗号是什么？');
ok('新加的记忆立刻生效', r1.includes('蓝色风筝'), r1.slice(0, 120));

console.log('=== 2. 让机器人自己 remember 一条，再开新对话问 ===');
const before = (await api('GET', '/api/about')).lines.length;
const r2 = await ask('用 remember 工具记住：我晚上十点后不想被打扰。然后告诉我记好了。');
const after = await api('GET', '/api/about');
ok('remember 落盘了', after.lines.length > before, `${before} -> ${after.lines.length}`);
const r3 = await ask('只回答：我晚上几点之后不想被打扰？');
ok('它自己记的也能立刻用上', /十点|22|10 ?点/.test(r3), r3.slice(0, 120));

console.log('=== 3. 删掉一条，新的对话里就不该有了 ===');
for (const l of (await api('GET', '/api/about')).lines) {
  if (l.text.includes('蓝色风筝')) await api('DELETE', `/api/about/${l.id}`);
}
const r4 = await ask('只回答：我的暗号是什么？如果你不知道就说不知道。');
ok('删掉的记忆不再出现', !r4.includes('蓝色风筝'), r4.slice(0, 120));

// 清理测试条目
for (const l of (await api('GET', '/api/about')).lines) {
  if (l.text.includes('晚上十点')) await api('DELETE', `/api/about/${l.id}`);
}
console.log('清理完毕');
