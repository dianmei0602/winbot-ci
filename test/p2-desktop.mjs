// P2 电脑操作验证：截屏（免审批）→ 列窗口（免审批）→ 点击（弹审批，拒绝则不执行）。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
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
const bot = bots.find((b) => b.name === '小七') || bots[0];

// 打开电脑操作（ask 模式）
await api('PATCH', `/api/bots/${bot.id}`, { desktopUse: 'ask' });
console.log('电脑操作已打开:', (await api('GET', `/api/bots/${bot.id}`)).bot.desktopUse);

async function turn(prompt, { handleApproval = null, timeoutMs = 240_000 } = {}) {
  const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, { text: prompt });
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  let reply = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const data = await api('GET', `/api/conversations/${conversation.id}`);
    for (const m of data.messages) {
      if (m.role === 'approval' && m.meta?.status === 'pending' && !seen.has(m.meta.approvalId)) {
        seen.add(m.meta.approvalId);
        console.log('  [审批]', String(m.content).slice(0, 100));
        if (handleApproval) await handleApproval(m.meta.approvalId);
      }
    }
    const a = data.messages.filter((m) => m.role === 'assistant').at(-1);
    if (a) {
      reply = a.content;
      break;
    }
  }
  await api('DELETE', `/api/conversations/${conversation.id}`);
  return reply;
}

console.log('=== 1. 截屏（不该弹审批）===');
{
  const shotsBefore = fs.existsSync(`E:/AI_work/winbot/data/bots/${bot.id}/workspace/tmp/screenshots`)
    ? fs.readdirSync(`E:/AI_work/winbot/data/bots/${bot.id}/workspace/tmp/screenshots`).length
    : 0;
  const reply = await turn('用 desktop_screenshot 截一张屏，告诉我保存到哪个文件就行，不要做别的事。');
  const dir = `E:/AI_work/winbot/data/bots/${bot.id}/workspace/tmp/screenshots`;
  const shotsAfter = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  ok('生成了截图文件', shotsAfter > shotsBefore, `${shotsBefore} -> ${shotsAfter}`);
  ok('回复里提到截图', /截图|screenshots|png/i.test(reply), reply.slice(0, 120));
}

console.log('=== 2. 列窗口（不该弹审批）===');
{
  const reply = await turn('用 desktop_windows 看看我现在开着哪些窗口，列出前三个的标题。');
  ok('拿到了窗口列表', reply.length > 20 && /(ChatGPT|设置|cc-switch|窗口|Edge|Chrome|记事本|资源管理器)/i.test(reply), reply.slice(0, 160));
}

console.log('=== 3. 点击（必须弹审批；拒绝后不该执行）===');
{
  const reply = await turn('用 desktop_action 在屏幕坐标 (120, 120) 点一下鼠标。只做这一件事。', {
    handleApproval: async (id) => {
      const r = await api('POST', `/api/approvals/${id}`, { allow: false });
      console.log('  [审批] 已拒绝:', JSON.stringify(r));
    },
  });
  ok('回复说明被拒绝/没执行', /拒绝|没有同意|未批准|没批准|未执行|没执行|没点/.test(reply), reply.slice(0, 160));
}

// 还原：关掉电脑操作
await api('PATCH', `/api/bots/${bot.id}`, { desktopUse: 'off' });
console.log('电脑操作已还原为 off');


