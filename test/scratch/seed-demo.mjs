// 给演示机器人灌两条真实对话，让界面打开就有内容。
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function chat(text, waitMs = 60_000) {
  const { conversation } = await call('POST', `/api/bots/${botId}/conversations`, {});
  await call('POST', `/api/conversations/${conversation.id}/send`, { text });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const data = await call('GET', `/api/conversations/${conversation.id}`);
    const a = data.messages.filter((m) => m.role === 'assistant').at(-1);
    if (a) {
      console.log(`[${text.slice(0, 20)}] -> ${a.content.slice(0, 80)}`);
      return;
    }
  }
  console.log(`[${text.slice(0, 20)}] -> 超时`);
}
await chat('帮我把这周的工作记一下：周三要交报表，周五评审');
await chat('写个 hello.txt 放到 outputs 里，内容随便');
