const BASE = `http://127.0.0.1:${process.argv[2] || 5180}`;
const token = (await import('node:fs')).readFileSync(`E:/AI_work/winbot/${process.argv[3] || 'data-packtest2'}/ui-token`, 'utf8').trim();
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
const created = await api('POST', '/api/bots', { name: '测试', avatar: 'blue', summary: 'x' });
const bot = created.bot || created;
console.log('bot:', JSON.stringify(bot).slice(0, 120));
const c = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const convId = c.conversation.id;
await api('POST', `/api/conversations/${convId}/send`, { text: '说句话' });
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const d = await api('GET', `/api/conversations/${convId}`);
  const m = d.messages.filter((x) => x.role === 'assistant' || x.role === 'error').at(-1);
  if (m) {
    console.log('RESULT:', m.role, String(m.content).slice(0, 400));
    break;
  }
}
