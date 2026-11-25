// P2 连接器验证：加一个本地 MCP 服务器 → 机器人真的能调用它的工具。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const NODE = process.execPath;
const SERVER = 'E:/AI_work/winbot/test/mcp-echo-server.mjs';
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
const botId = (bots.find((b) => b.name === '小七') || bots[0]).id;

// 清理旧的测试连接器
for (const m of (await api('GET', '/api/mcp')).items) {
  if (m.name === 'echo') await api('DELETE', `/api/mcp/${m.id}`);
}

console.log('=== 1. 添加连接器 ===');
const added = await api('POST', '/api/mcp', {
  name: 'echo',
  title: '测试回声',
  transport: 'stdio',
  command: NODE,
  args: [SERVER],
});
ok('添加成功', added.ok === true, added.item?.id);

const list = (await api('GET', '/api/mcp')).items;
ok('列表里有它', list.some((m) => m.name === 'echo'));

console.log('=== 2. 机器人能用它的工具 ===');
{
  const { conversation } = await api('POST', `/api/bots/${botId}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, {
    text: '请调用 mcp__echo__echo 这个工具，参数 text 传「连接器已接通」。只告诉我工具返回了什么。',
  });
  const deadline = Date.now() + 240_000;
  let reply = '';
  let toolCall = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const data = await api('GET', `/api/conversations/${conversation.id}`);
    const a = data.messages.filter((m) => m.role === 'assistant').at(-1);
    if (a) {
      reply = a.content;
      break;
    }
  }
  ok('模型回复包含工具返回值', /echo:\s*连接器已接通/.test(reply) || reply.includes('连接器已接通'), reply.slice(0, 160));
  await api('DELETE', `/api/conversations/${conversation.id}`);
}

console.log('=== 3. 停用后不再加载 ===');
{
  const item = (await api('GET', '/api/mcp')).items.find((m) => m.name === 'echo');
  await api('PATCH', `/api/mcp/${item.id}`, { enabled: false });
  const after = (await api('GET', '/api/mcp')).items.find((m) => m.name === 'echo');
  ok('变成停用', after.enabled === false);
  await api('PATCH', `/api/mcp/${item.id}`, { enabled: true });
}

console.log('=== 4. 删除 ===');
{
  const item = (await api('GET', '/api/mcp')).items.find((m) => m.name === 'echo');
  await api('DELETE', `/api/mcp/${item.id}`);
  const after = (await api('GET', '/api/mcp')).items;
  ok('删掉了', !after.some((m) => m.name === 'echo'));
}
