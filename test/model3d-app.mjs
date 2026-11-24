// 让机器人真的做一个 3D 模型（图 → glb）。
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

await api('PATCH', '/api/settings/comfy', {});
await new Promise((r) => setTimeout(r, 2500));
const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const t0 = Date.now();
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用 generate_3d 做一个 3D 模型：一只陶瓷马克杯，白底，简洁。分辨率 2048、步数 20。做好告诉我文件在哪。',
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
console.log('reply:', String(last?.content || '').slice(0, 200));
const rel = (last?.meta?.files || []).find((f) => /\.glb$/i.test(f.path))?.path;
if (rel) {
  const abs = `${dataRoot}/bots/${bot.id}/workspace/${rel}`;
  console.log('落盘:', fs.existsSync(abs) ? `${Math.round(fs.statSync(abs).size / 1024)} KB` : '缺失(' + abs + ')');
}
console.log('conv:', conversation.id);
