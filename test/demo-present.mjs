// 造一条带交付文件的消息（截图用）。
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
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '在 outputs 下写一份 200 字左右的自我介绍草稿 self-intro.md，然后用 present 交付给我。',
});
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  if (d.messages.some((m) => m.role === 'assistant')) {
    const a = d.messages.filter((m) => m.role === 'assistant').at(-1);
    console.log('files:', JSON.stringify(a.meta?.files || []));
    console.log('conversation:', conversation.id);
    break;
  }
}
