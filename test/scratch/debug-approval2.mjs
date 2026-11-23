// 看第二轮到底怎么答的：等空闲、打印全部消息、不删会话。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return JSON.parse((await r.text()) || '{}');
};
const DIR = 'E:\\AI_work\\winbot\\data\\approval-test3';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const bot = (await api('GET', '/api/bots'))[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const convId = conversation.id;
const idle = async () => {
  for (let i = 0; i < 120; i += 1) {
    const b = (await api('GET', '/api/bots')).find((x) => x.id === bot.id);
    if (b && b.busy === false) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

async function run(text, { remember = false } = {}) {
  const seen = new Set();
  await api('POST', `/api/conversations/${convId}/send`, { text });
  for (let i = 0; i < 160; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await api('GET', `/api/conversations/${convId}`);
    for (const m of d.messages) {
      if (m.role === 'approval' && m.meta?.status === 'pending' && !seen.has(m.meta.approvalId)) {
        seen.add(m.meta.approvalId);
        console.log('  审批 ->', m.meta.detail?.slice(0, 60));
        await api('POST', `/api/approvals/${m.meta.approvalId}`, { allow: true, remember });
      }
    }
    const b = (await api('GET', '/api/bots')).find((x) => x.id === bot.id);
    if (b && b.busy === false && !d.messages.some((m) => m.meta?.status === 'pending')) break;
  }
  await idle();
  return seen.size;
}

const f1 = `${DIR}\\a.txt`;
const f2 = `${DIR}\\b.txt`;
const a1 = await run(`把「one」写进 ${f1}。`, { remember: true });
console.log('第一轮审批次数:', a1, '文件:', fs.existsSync(f1));
const a2 = await run(`把「two」写进 ${f2}。`);
console.log('第二轮审批次数:', a2, '文件:', fs.existsSync(f2));

const d = await api('GET', `/api/conversations/${convId}`);
console.log('--- 消息 ---');
for (const m of d.messages) console.log(`[${m.role}]`, String(m.content).slice(0, 260).replace(/\n/g, ' / '));
console.log('conv:', convId);
