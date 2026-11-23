// 长镜头验证：一次生成 ~90 帧（走 context windows），确认走的是单段而不是拼接。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
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

const bot = (await api('GET', '/api/bots'))[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const t0 = Date.now();
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用 generate_video 生成一段约 4 秒的长镜头：雨夜街头缓慢横移，霓虹灯反光，有环境声。512x512，length 90，segments 1。',
});
let last = null;
for (let i = 0; i < 200; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  last = d.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  if (last) break;
}
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('role:', last?.role);
console.log('files:', JSON.stringify(last?.meta?.files || []));
console.log('reply:', String(last?.content || '').slice(0, 160));
console.log('conv:', conversation.id);
