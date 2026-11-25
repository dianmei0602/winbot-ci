// P3 群聊 + 机器人互派验证。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
if (bots.length < 2) {
  console.log('需要至少两个机器人，先建一个小八');
  await api('POST', '/api/bots', { name: '小八', avatar: 'purple', summary: '接活型，负责查资料和跑命令' });
}
const all = await api('GET', '/api/bots');
const [a, b] = all;

// 清理旧测试群
for (const g of await api('GET', '/api/groups')) {
  if (g.name.startsWith('P3·')) await api('DELETE', `/api/groups/${g.id}`);
}

console.log('=== 1. 建群 ===');
const { group, conversation } = await api('POST', '/api/groups', { name: 'P3·测试群', botIds: [a.id, b.id] });
ok('群建好了', !!group.id, `${group.name} / ${group.members.map((m) => m.name).join('、')}`);
ok('群有共享会话', !!conversation?.id);

async function groupTurn(text, { timeoutMs = 240_000 } = {}) {
  const before = (await api('GET', `/api/groups/${group.id}`)).messages || [];
  const beforeCount = before.filter((m) => m.role === 'assistant').length;
  await api('POST', `/api/groups/${group.id}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  let msgs = before;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const data = await api('GET', `/api/groups/${group.id}`);
    msgs = data.messages || [];
    const assistant = msgs.filter((m) => m.role === 'assistant');
    const errors = msgs.filter((m) => m.role === 'error');
    if (errors.length) return { msgs, last: null, error: errors.at(-1).content };
    if (assistant.length > beforeCount) break;
  }
  const assistant = msgs.filter((m) => m.role === 'assistant');
  return { msgs, last: assistant.at(-1) };
}

console.log('=== 2. 没 @ 时由第一个成员回答 ===');
{
  const { last } = await groupTurn('一句话说说你是谁。');
  ok('有人回答了', !!last, last ? `${last.meta?.speakerName}: ${String(last.content).slice(0, 60)}` : '');
  ok('记了发言人', !!last?.meta?.speakerBotId);
}

console.log('=== 3. @ 指定成员 ===');
{
  const gview = (await api('GET', `/api/groups/${group.id}`)).group;
  const target = all.find((x) => x.id !== gview.lastSpeakerId);
  const { last } = await groupTurn(`@${target.name} 一句话说说你是谁。`);
  ok('被 @ 的那个回答了', last?.meta?.speakerBotId === target.id, `期望 ${target.name}，实际 ${last?.meta?.speakerName}`);
}

console.log('=== 4. 群聊历史共享 ===');
{
  const data = await api('GET', `/api/groups/${group.id}`);
  ok('消息都在同一个会话里', data.messages.length >= 4, `${data.messages.length} 条`);
  ok('发言人各不相同', new Set(data.messages.filter((m) => m.role === 'assistant').map((m) => m.meta?.speakerBotId)).size >= 2);
}

console.log('=== 5. 机器人互派（ask_another_bot）===');
{
  // 让 a 把活交给 b
  const { conversation: c } = await api('POST', `/api/bots/${a.id}/conversations`, {});
  await api('POST', `/api/conversations/${c.id}/send`, {
    text: `用 ask_another_bot 工具把这件事交给「${b.name}」：「请只回复四个字：收到任务」。然后把它回的原话告诉我。`,
  });
  const deadline = Date.now() + 300_000;
  let reply = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const data = await api('GET', `/api/conversations/${c.id}`);
    const x = data.messages.filter((m) => m.role === 'assistant').at(-1);
    if (x) {
      reply = x.content;
      break;
    }
  }
  ok('发起方拿到了对方的回复', /收到任务/.test(reply), reply.slice(0, 160));
  // 互派产生了一条独立的 handoff 会话
  const handoffs = (await api('GET', `/api/bots/${b.id}/conversations`)).filter((x) => x.channel === 'handoff');
  ok('目标机器人有自己的交接会话', handoffs.length >= 1, `${handoffs.length} 个`);
  await api('DELETE', `/api/conversations/${c.id}`);
}

console.log('=== 6. 删除群 ===');
{
  await api('DELETE', `/api/groups/${group.id}`);
  const left = await api('GET', '/api/groups');
  ok('群删掉了', !left.some((g) => g.id === group.id));
}


