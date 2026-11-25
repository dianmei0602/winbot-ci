// 让机器人用 Z-Image 画一张（验证插件自动选模型）。
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

// 重启所有机器人，让它们加载新版插件
await api('PATCH', '/api/settings/comfy', {});
await new Promise((r) => setTimeout(r, 2500));
const st = await api('GET', '/api/comfy/status');
console.log('unet:', JSON.stringify(st.unet), 'clip:', JSON.stringify(st.clip), 'vae:', JSON.stringify(st.vae));

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
const t0 = Date.now();
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '用 generate_image 画一张：一只柯基坐在雨后的柏油路上，逆光，电影感，1024x1024。画完别描述画面，只说文件在哪。',
});
let last = null;
for (let i = 0; i < 200; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  last = d.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  if (last) break;
}
console.log(`用时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('role:', last?.role, 'files:', JSON.stringify(last?.meta?.files || []));
console.log('reply:', String(last?.content || '').slice(0, 100));
const rel = last?.meta?.files?.[0]?.path;
if (rel) {
  const abs = `E:/AI_work/winbot/data/bots/${bot.id}/workspace/${rel}`;
  console.log('落盘:', fs.existsSync(abs) ? `${Math.round(fs.statSync(abs).size / 1024)} KB` : '缺失');
}
console.log('conv:', conversation.id);
