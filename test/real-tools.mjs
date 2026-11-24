// 真实模型下的工具与审批验证。
// 1) 让它写一个文件到工作区 → 检查文件真的出现
// 2) 让它写到工作区外 → 等审批卡 → 拒绝 → 检查文件不存在
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const botId = process.argv[2] || 'bot-32fc0226d24f';
const ws = `E:/AI_work/winbot/data/bots/${botId}/workspace`;
const outside = 'E:/AI_work/winbot/outside-real-test.txt';

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

async function newConv() {
  return (await call('POST', `/api/bots/${botId}/conversations`, {})).conversation.id;
}

/** 发一条消息，等审批；有审批就按 allow 回答，最后等回复 */
async function turn(convId, text, { approve = null, timeoutMs = 180_000 } = {}) {
  await call('POST', `/api/conversations/${convId}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  let approved = 0;
  let reply = null;
  const answered = new Set();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const data = await call('GET', `/api/conversations/${convId}`);
    for (const m of data.messages) {
      if (m.role === 'approval' && m.meta?.status === 'pending' && approve !== null && !answered.has(m.meta.approvalId)) {
        answered.add(m.meta.approvalId);
        console.log(`  [approval] ${m.content.slice(0, 120)} -> ${approve ? '允许' : '拒绝'}`);
        try {
          await call('POST', `/api/approvals/${m.meta.approvalId}`, { allow: approve });
          approved += 1;
        } catch (e) {
          console.log('  [approval] 回答失败:', e.message.slice(0, 120));
        }
      }
    }
    const a = data.messages.filter((m) => m.role === 'assistant').at(-1);
    const e = data.messages.filter((m) => m.role === 'error').at(-1);
    if (e) return { reply: `[错误] ${e.content}`, approved };
    if (a) {
      reply = a.content;
      break;
    }
  }
  return { reply: reply || '（超时）', approved };
}

fs.rmSync(outside, { force: true });
fs.rmSync(`${ws}/outputs/real-test.md`, { force: true });

console.log('=== 1) 写工作区 ===');
{
  const conv = await newConv();
  const r = await turn(conv, '在工作区 outputs 目录下新建 real-test.md，只写一行：这是真实模型写的。写完告诉我。', { approve: null });
  console.log('  reply:', r.reply.slice(0, 200));
  console.log('  file exists:', fs.existsSync(`${ws}/outputs/real-test.md`));
  if (fs.existsSync(`${ws}/outputs/real-test.md`)) console.log('  content:', fs.readFileSync(`${ws}/outputs/real-test.md`, 'utf8').trim().slice(0, 80));
}

console.log('=== 2) 写工作区外（应触发审批，拒绝） ===');
{
  const conv = await newConv();
  const r = await turn(conv, '请把「审批测试」这四个字写进 E:\\AI_work\\winbot\\outside-real-test.txt（在工作区外面），这是我有意让你做的。', { approve: false });
  console.log('  reply:', r.reply.slice(0, 250));
  console.log('  approvals:', r.approved);
  console.log('  outside file exists:', fs.existsSync(outside));
}

console.log('=== 3) 写工作区外（批准） ===');
{
  const conv = await newConv();
  const r = await turn(conv, '再试一次：把「审批测试」写进 E:\\AI_work\\winbot\\outside-real-test.txt，这次我会同意。', { approve: true });
  console.log('  reply:', r.reply.slice(0, 250));
  console.log('  approvals:', r.approved);
  console.log('  outside file exists:', fs.existsSync(outside));
  if (fs.existsSync(outside)) console.log('  content:', fs.readFileSync(outside, 'utf8').trim().slice(0, 80));
}

