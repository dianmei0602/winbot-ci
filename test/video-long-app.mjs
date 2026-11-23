// 走机器人链路验证多段视频（segments=2）。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const dataRoot = process.env.WINBOT_DATA_ROOT || 'E:/AI_work/winbot/data';
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
const bot = (await api('GET', '/api/bots')).find((b) => b.name === '小七') || (await api('GET', '/api/bots'))[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const t0 = Date.now();
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用 generate_video 生成一段 2 个镜头的视频：海边日落，海浪慢慢拍岸。512x512，segments 设为 2。',
});
let last = null;
for (let i = 0; i < 300; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  last = d.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  if (last) break;
}
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('role:', last?.role);
console.log('files:', JSON.stringify(last?.meta?.files || []));
const rel = (last?.meta?.files || []).find((f) => /\.mp4$/.test(f.path))?.path;
if (rel) {
  const abs = `${dataRoot}/bots/${bot.id}/workspace/${rel}`;
  console.log('落盘:', fs.existsSync(abs) ? `${Math.round(fs.statSync(abs).size / 1024)} KB` : '缺失');
}
console.log('conv:', conversation.id);
