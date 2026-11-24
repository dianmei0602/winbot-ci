// 真实模型冒烟：通过控制台发一条真消息给 DeepSeek 账号接口，看它能不能正常回。
// 用法: node test/real-smoke.mjs [botId] [message]
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const botId = process.argv[2] || 'bot-32fc0226d24f';
const message = process.argv[3] || '用一句话介绍你自己，并说出你现在的模型名字';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const { conversation } = await call('POST', `/api/bots/${botId}/conversations`, {});
console.log('conversation:', conversation.id);
const started = Date.now();
await call('POST', `/api/conversations/${conversation.id}/send`, { text: message });
const deadline = Date.now() + 180_000;
let last = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const data = await call('GET', `/api/conversations/${conversation.id}`);
  const assistant = data.messages.filter((m) => m.role === 'assistant').at(-1);
  const error = data.messages.filter((m) => m.role === 'error').at(-1);
  if (error) {
    console.log(`[error] ${error.content.slice(0, 600)}`);
    process.exit(1);
  }
  if (assistant && assistant !== last) {
    last = assistant;
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${assistant.content}`);
    break;
  }
}
if (!last) {
  console.log('超时，没有回复');
  process.exit(1);
}
const health = await call('GET', '/api/health');
console.log('bot runtime:', JSON.stringify(health.bots[botId] || {}));
