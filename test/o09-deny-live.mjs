// O09 A/B：禁用 pwsh vs 放开 pwsh，看模型侧是否真的用不了该工具
import fs from 'node:fs';

const B = 'http://127.0.0.1:5178';
const token = fs.readFileSync(`${process.env.APPDATA}/winbot/data/ui-token`, 'utf8').trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const msgs = d?.messages || [];
  const last = msgs[msgs.length - 1] || {};
  return {
    role: last.role,
    text: String(last.content || '').slice(0, 300).replace(/\n/g, ' '),
    tools: (d?.tools || []).map((t) => t.name + (t.isError ? '✗' : '✓')),
  };
}

const bots = await (await fetch(`${B}/api/bots`, { headers: H })).json();
const bot = bots.find((b) => b.name === '小七') || bots[0];
console.log('机器人:', bot.name, bot.id);

// A：禁用 pwsh
await fetch(`${B}/api/bots/${bot.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ deniedTools: ['pwsh'] }) });
await sleep(4000);
const a = await ask(bot.id, '用 pwsh 运行 echo hello，把输出原样告诉我');
console.log('\n[A 禁用 pwsh] role=', a.role);
console.log('  回复:', a.text.slice(0, 220));
console.log('  工具:', JSON.stringify(a.tools));

// B：放开 pwsh
await fetch(`${B}/api/bots/${bot.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ deniedTools: [] }) });
await sleep(4000);
const b = await ask(bot.id, '用 pwsh 运行 echo hello，把输出原样告诉我');
console.log('\n[B 放开 pwsh] role=', b.role);
console.log('  回复:', b.text.slice(0, 220));
console.log('  工具:', JSON.stringify(b.tools));

const aUsedPwsh = a.tools.some((t) => t.startsWith('pwsh'));
const bUsedPwsh = b.tools.some((t) => t.startsWith('pwsh'));
console.log('\n结论: 禁用时用了 pwsh =', aUsedPwsh, '| 放开时用了 pwsh =', bUsedPwsh);
process.exit(aUsedPwsh ? 1 : 0);
