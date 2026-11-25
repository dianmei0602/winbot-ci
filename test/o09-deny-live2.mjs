// O09 硬对照：必须调用 pwsh 才能拿到答案（当前时间），禁用时应拿不到。
import fs from 'node:fs';

const B = 'http://127.0.0.1:5178';
const token = fs.readFileSync(`${process.env.APPDATA}/winbot/data/ui-token`, 'utf8').trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ASK = '用 pwsh 执行 Get-Date -Format "yyyy-MM-dd HH:mm:ss"，把命令输出原样贴给我，不要猜。';

async function ask(botId, text, timeoutMs = 180000) {
  const { conversation } = await (await fetch(`${B}/api/bots/${botId}/conversations`, { method: 'POST', headers: H, body: '{}' })).json();
  await fetch(`${B}/api/conversations/${conversation.id}/send`, { method: 'POST', headers: H, body: JSON.stringify({ text }) });
  const started = Date.now();
  let d = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    d = await (await fetch(`${B}/api/conversations/${conversation.id}`, { headers: H })).json();
    const msgs = d.messages || [];
    const last = msgs[msgs.length - 1];
    if (last && (last.role === 'assistant' || last.role === 'error')) break;
  }
  const last = (d?.messages || []).slice(-1)[0] || {};
  return { role: last.role, text: String(last.content || '').slice(0, 240).replace(/\n/g, ' '), tools: (d?.tools || []).map((t) => t.name + (t.isError ? '✗' : '✓')) };
}

const bots = await (await fetch(`${B}/api/bots`, { headers: H })).json();
const bot = bots.find((b) => b.name === '小七') || bots[0];

// 1) 放开 pwsh：应能拿到真实时间
await fetch(`${B}/api/bots/${bot.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ deniedTools: [] }) });
await sleep(5000);
const free = await ask(bot.id, ASK);
console.log('[放开] tools=', JSON.stringify(free.tools));
console.log('  回复:', free.text.slice(0, 160));

// 2) 禁用 pwsh：应拿不到
await fetch(`${B}/api/bots/${bot.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ deniedTools: ['pwsh'] }) });
await sleep(5000);
const deny = await ask(bot.id, ASK);
console.log('[禁用] tools=', JSON.stringify(deny.tools));
console.log('  回复:', deny.text.slice(0, 160));

const usedFree = free.tools.some((t) => t.startsWith('pwsh'));
const usedDeny = deny.tools.some((t) => t.startsWith('pwsh'));
const hasTime = /\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/.test(free.text);
console.log('\n结论: 放开时调用了 pwsh =', usedFree, '| 拿到真实时间 =', hasTime, '| 禁用时调用了 pwsh =', usedDeny);
process.exit(usedFree && !usedDeny ? 0 : 1);
