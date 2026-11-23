// 验证：每日预算拦截、present 交付文件、未完成会话的检测。
import fs from 'node:fs';
import { createConversation, addMessage, danglingUserConversations } from '../src/db.js';

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

async function turn(text, { timeoutMs = 240_000 } = {}) {
  const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  let data = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    data = await api('GET', `/api/conversations/${conversation.id}`);
    if (data.messages.some((m) => m.role === 'assistant' || m.role === 'error')) break;
  }
  return { conversationId: conversation.id, data };
}

console.log('=== 1. 每日预算拦截 ===');
{
  await api('PATCH', `/api/bots/${bot.id}`, { dailyBudgetTokens: 1 });
  const { conversationId, data } = await turn('随便说一句话');
  const err = data.messages.filter((m) => m.role === 'error').at(-1);
  ok('超预算时明确拒绝', !!err && /每日上限/.test(err.content), String(err?.content).slice(0, 100));
  await api('DELETE', `/api/conversations/${conversationId}`);
  await api('PATCH', `/api/bots/${bot.id}`, { dailyBudgetTokens: 0 });
  const detail = await api('GET', `/api/bots/${bot.id}`);
  ok('预算已还原为不限', Number(detail.bot.dailyBudgetTokens) === 0);
  ok('接口报出今天已用量', typeof detail.usageToday?.totalTokens === 'number' && detail.usageToday.totalTokens > 0, String(detail.usageToday?.totalTokens));
}

console.log('=== 2. present 交付文件 ===');
{
  const target = `E:/AI_work/winbot/data/bots/${bot.id}/workspace/outputs/present-test.md`;
  fs.rmSync(target, { force: true });
  const { conversationId, data } = await turn(
    '在工作区 outputs 下新建 present-test.md，内容写「交付测试」，然后用 present 工具把这个文件交付给我。',
  );
  const assistant = data.messages.filter((m) => m.role === 'assistant').at(-1);
  const files = assistant?.meta?.files || [];
  ok('文件真的写出来了', fs.existsSync(target));
  ok('消息里带了交付文件', files.length >= 1, JSON.stringify(files.map((f) => f.path)));
  ok('交付路径指向那个文件', files.some((f) => String(f.path).includes('present-test.md')));
  await api('DELETE', `/api/conversations/${conversationId}`);
  fs.rmSync(target, { force: true });
}

console.log('=== 3. 未完成会话检测 ===');
{
  const conv = createConversation({ botId: bot.id, title: 'P1·未完成测试', channel: 'app' });
  addMessage({ conversationId: conv.id, role: 'user', content: '这条发出去就没有下文了', meta: {} });
  const list = danglingUserConversations();
  ok('检测到了未完成会话', list.some((c) => c.id === conv.id), `共 ${list.length} 条`);
  console.log(`  （重启后服务会给它补一条提示；会话 id: ${conv.id}）`);
  fs.writeFileSync('E:/AI_work/winbot/data/dangling-conv.txt', conv.id);
}
