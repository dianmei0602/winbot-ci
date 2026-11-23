// 诊断：自动放行之后，第二轮到底发生了什么（打印全部消息，不删会话）。
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
  return t ? JSON.parse(t) : null;
};

const DIR = 'E:\\AI_work\\winbot\\data\\approval-test2';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const bots = await api('GET', '/api/bots');
const bot = bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});

// 先手动允许一次（建立 1 小时豁免）
const first = `${DIR}\\a.txt`;
await api('POST', `/api/conversations/${conversation.id}/send`, { text: `把「one」写进 ${first}。` });
let seen = new Set();
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  for (const m of d.messages) {
    if (m.role === 'approval' && m.meta?.status === 'pending' && !seen.has(m.meta.approvalId)) {
      seen.add(m.meta.approvalId);
      console.log('批准+记住', JSON.stringify(await api('POST', `/api/approvals/${m.meta.approvalId}`, { allow: true, remember: true })));
    }
  }
  if (d.messages.some((m) => m.role === 'assistant')) break;
}
console.log('第一轮文件:', fs.existsSync(first));

// 第二轮：同类
const second = `${DIR}\\b.txt`;
await api('POST', `/api/conversations/${conversation.id}/send`, { text: `把「two」写进 ${second}。` });
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  const adm = d.messages.filter((m) => m.role === 'approval');
  for (const m of adm) {
    if (m.meta?.status === 'pending' && !seen.has(m.meta.approvalId)) {
      seen.add(m.meta.approvalId);
      console.log('!! 第二轮又弹了审批', m.meta.approvalId);
      await api('POST', `/api/approvals/${m.meta.approvalId}`, { allow: true });
    }
  }
  const assistants = d.messages.filter((m) => m.role === 'assistant');
  if (assistants.length >= 2) {
    console.log('--- 全部消息 ---');
    for (const m of d.messages) console.log(`[${m.role}]`, String(m.content).slice(0, 300).replace(/\n/g, ' / '));
    break;
  }
}
console.log('第二轮文件:', fs.existsSync(second));
console.log('conv:', conversation.id);
