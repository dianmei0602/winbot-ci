// 定时规则验证：建一条「每秒级」的间隔规则 → 等它自动跑 → 看会话里有没有结果。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const botId = process.argv[2] || 'bot-32fc0226d24f';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// 清掉上一次测试留下的规则
for (const s of await call('GET', `/api/schedules?botId=${botId}`)) {
  if (s.title.startsWith('自测')) await call('DELETE', `/api/schedules/${s.id}`);
}

console.log('=== 建一条 1 分钟后跑的规则 ===');
const created = await call('POST', '/api/schedules', {
  botId,
  title: '自测·报时',
  prompt: '告诉我现在几点，用一句话。',
  kind: 'interval',
  everyMinutes: 1,
  channel: 'app',
});
console.log('schedule:', JSON.stringify(created.schedule));

console.log('=== 立即运行 ===');
const ran = await call('POST', `/api/schedules/${created.schedule.id}/run`, {});
console.log('run:', JSON.stringify({ ok: ran.ok, quiet: ran.quiet, text: String(ran.text).slice(0, 200) }));

console.log('=== 会话内容 ===');
const convId = (await call('GET', `/api/conversations/${ran.conversationId}`))?.conversation?.id;
const data = await call('GET', `/api/conversations/${convId}`);
for (const m of data.messages) console.log(`[${m.role}] ${String(m.content).slice(0, 200)}`);
console.log('usage:', JSON.stringify(data.usage));

console.log('=== 规则状态 ===');
const list = await call('GET', `/api/schedules?botId=${botId}`);
for (const s of list) console.log(`${s.title} | ${s.when} | enabled=${s.enabled} | last=${s.lastStatus} | next=${new Date(s.nextRunAt).toLocaleString()}`);

console.log('=== 等自动触发（最长 100 秒）===');
const target = list.find((s) => s.id === created.schedule.id);
const deadline = Date.now() + 100_000;
let auto = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = (await call('GET', `/api/schedules?botId=${botId}`)).find((s) => s.id === created.schedule.id);
  if (cur.lastRunAt && cur.lastRunAt !== target.lastRunAt) {
    auto = cur;
    break;
  }
}
console.log(auto ? `自动触发成功：${auto.lastStatus} / next=${new Date(auto.nextRunAt).toLocaleString()}` : '没有等到自动触发');
const after = await call('GET', `/api/conversations/${convId}`);
console.log('会话消息数:', after.messages.length);
for (const m of after.messages.slice(-2)) console.log(`[${m.role}] ${String(m.content).slice(0, 120)}`);
