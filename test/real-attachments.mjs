// 图片/文件输入 + 用量的端到端验证：上传 → 发消息 → 模型读图 → 文件落盘 → 用量记账。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const botId = process.argv[2] || 'bot-32fc0226d24f';
const ws = `E:/AI_work/winbot/data/bots/${botId}/workspace`;

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

const img = fs.readFileSync('E:/AI_work/winbot/data/vision-test.png').toString('base64');
const up = await call('POST', `/api/bots/${botId}/upload`, { name: 'vision-test.png', data: img });
console.log('upload:', JSON.stringify(up));

// 文件能不能被读回来（界面图片走这个接口）
const fileRes = await fetch(`${BASE}/api/bots/${botId}/file?path=${encodeURIComponent(up.path)}&token=${encodeURIComponent(token)}`);
console.log('file serve:', fileRes.status, fileRes.headers.get('content-type'), (await fileRes.arrayBuffer()).byteLength, 'bytes');

// 再传一个文本文件
const txt = Buffer.from('这是一份测试笔记：明天下午三点开会，记得带合同。', 'utf8').toString('base64');
const up2 = await call('POST', `/api/bots/${botId}/upload`, { name: '测试笔记.txt', data: txt });
console.log('upload2:', JSON.stringify(up2));

const { conversation } = await call('POST', `/api/bots/${botId}/conversations`, {});
console.log('conversation:', conversation.id);
await call('POST', `/api/conversations/${conversation.id}/send`, {
  text: '这两张附件里分别是什么？图里的编号报给我，笔记里写的开会时间也报给我。',
  attachments: [up.path, up2.path],
});

const deadline = Date.now() + 240_000;
let data = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  data = await call('GET', `/api/conversations/${conversation.id}`);
  if (data.messages.some((m) => m.role === 'assistant' || m.role === 'error')) break;
}
console.log('=== messages ===');
for (const m of data.messages) console.log(`[${m.role}] ${String(m.content).slice(0, 300)}`);
console.log('=== usage ===', JSON.stringify(data.usage));
const userMsg = data.messages.find((m) => m.role === 'user');
console.log('user attachments:', JSON.stringify(userMsg?.meta?.attachments));
const assistant = data.messages.find((m) => m.role === 'assistant');
console.log('assistant usage meta:', JSON.stringify(assistant?.meta?.usage));

// 附件文件确实在工作区
for (const rel of userMsg?.meta?.attachments || []) {
  const p = `${ws}/${rel}`;
  console.log('exists:', rel, fs.existsSync(p), fs.existsSync(p) ? fs.statSync(p).size : 0);
}
