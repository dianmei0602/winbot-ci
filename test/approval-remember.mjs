// 验证「1 小时内同类自动放行」：第一次跨工作区写要点同意，点「允许，1 小时内同类」，
// 第二次同类（另一个路径）应该不再弹审批。
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
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const OUT_DIR = 'E:\\AI_work\\winbot\\data\\approval-test';
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const f1 = `${OUT_DIR}\\a.txt`;
const f2 = `${OUT_DIR}\\b.txt`;

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});

/** 等这个机器人彻底空闲（busy=false） */
async function waitIdle(botId, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const b = (await api('GET', '/api/bots')).find((x) => x.id === botId);
    if (b && b.busy === false) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** 跑一轮：等到空闲为止 */
async function turn(text, { onApproval, timeoutMs = 240_000 } = {}) {
  await api('POST', `/api/conversations/${conversation.id}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  let last = null;
  const convId = conversation.id;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await api('GET', `/api/conversations/${conversation.id}`);
    for (const m of d.messages) {
      if (m.role === 'approval' && m.meta?.status === 'pending' && !seen.has(m.meta.approvalId)) {
        seen.add(m.meta.approvalId);
        if (onApproval) await onApproval(m.meta.approvalId);
      }
    }
    last = d.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
    const st = (await api('GET', '/api/bots')).find((x) => x.id === bot.id);
    if (last && last.role === 'assistant' && st && st.busy === false && !d.messages.some((m) => m.meta?.status === 'pending')) break;
  }
  return { approvals: seen, last };
}

console.log('=== 第一次：跨工作区写，应该弹审批 ===');
let asked1 = 0;
const r1 = await turn(`把「one」写进 ${f1}，只做这一件事，写完告诉我。`, {
  onApproval: async (id) => {
    asked1 += 1;
    const r = await api('POST', `/api/approvals/${id}`, { allow: true, remember: true });
    console.log('  批准并记住:', JSON.stringify(r));
  },
});
ok('第一次弹了审批', asked1 >= 1, `${asked1} 次`);
ok('文件真的写出来了', fs.existsSync(f1), fs.existsSync(f1) ? fs.readFileSync(f1, 'utf8').slice(0, 40) : '缺失');

console.log('=== 第二次：同类（另一个路径），应该不再问 ===');
let asked2 = 0;
const r2 = await turn(`把「two」写进 ${f2}，只做这一件事，写完告诉我。`, {
  onApproval: async (id) => {
    asked2 += 1;
    await api('POST', `/api/approvals/${id}`, { allow: true });
  },
});
ok('第二次没有再弹审批', asked2 === 0, `${asked2} 次`);
ok('第二个文件也写出来了', fs.existsSync(f2), fs.existsSync(f2) ? fs.readFileSync(f2, 'utf8').slice(0, 40) : '缺失');

await api('DELETE', `/api/conversations/${conversation.id}`);
fs.rmSync(OUT_DIR, { recursive: true, force: true });

