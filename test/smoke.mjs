// 控制台 API 冒烟测试（Node 24，UTF-8 干净）。用法：node test/smoke.mjs
import fs from 'node:fs';

const BASE = process.env.WINBOT_BASE || 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();

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

const t0 = Date.now();
console.log('== health ==');
console.log(JSON.stringify(await call('GET', '/api/health')));

console.log('== bots ==');
let bots = await call('GET', '/api/bots');
let bot = bots.find((b) => b.name === '小七');
if (!bot) {
  const created = await call('POST', '/api/bots', {
    name: '小七',
    avatar: 'green',
    persona: '你是小七，说话简短、有点冷幽默，擅长整理文件和写脚本。',
  });
  bot = created.bot;
}
console.log(`bot: ${bot.id} ${bot.name}`);

// 指向本地 mock 模型（跑完会切回来，别把真实模型配置改坏）
const before = { providerId: bot.providerId, model: bot.model };
await call('PATCH', `/api/bots/${bot.id}`, { providerId: 'mock', model: 'mock-model' });
console.log('patched to mock provider');

console.log('== conversation ==');
const { conversation } = await call('POST', `/api/bots/${bot.id}/conversations`, {});
console.log(`conv: ${conversation.id}`);

console.log('== send ==');
await call('POST', `/api/conversations/${conversation.id}/send`, { text: '帮我写一个 hello.txt，写进 outputs 里' });

const deadline = Date.now() + 180_000;
let messages = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const data = await call('GET', `/api/conversations/${conversation.id}`);
  messages = data.messages;
  if (messages.some((m) => m.role === 'assistant' || m.role === 'error')) break;
}
console.log(`== messages (${messages.length}, ${Math.round((Date.now() - t0) / 1000)}s) ==`);
for (const m of messages) console.log(`[${m.role}] ${m.content}`);

console.log('== workspace files ==');
const ws = `E:/AI_work/winbot/data/bots/${bot.id}/workspace`;
function walk(dir, prefix = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
    else console.log(`  ${prefix}${e.name} (${fs.statSync(p).size}B)`);
  }
}
walk(ws);

console.log('== bot status ==');
console.log(JSON.stringify((await call('GET', '/api/health')).bots));

// 还原机器人原来的模型接口，别让测试把真实配置留在 mock 上
// （run-e2e 会自己统一还原，所以它跑的时候传 WINBOT_NO_RESTORE=1 跳过这里）
if (before.providerId && !process.env.WINBOT_NO_RESTORE) {
  await call('PATCH', `/api/bots/${bot.id}`, { providerId: before.providerId, model: before.model });
  console.log(`restored provider: ${before.providerId} / ${before.model}`);
} else if (before.providerId) {
  console.log(`provider restore skipped (WINBOT_NO_RESTORE)`);
}
