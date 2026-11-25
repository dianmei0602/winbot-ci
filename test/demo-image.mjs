// 生成一张图并留在会话里（给界面截图用）。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};
const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];
const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
await api('POST', `/api/conversations/${conversation.id}/send`, {
  text: '画一张：雨夜霓虹灯下的上海街角，湿漉漉的地面反射着招牌，电影感，1024x1024。画完只告诉我文件在哪。',
});
for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const d = await api('GET', `/api/conversations/${conversation.id}`);
  const m = d.messages.filter((x) => x.role === 'assistant' || x.role === 'error').at(-1);
  if (m) {
    console.log('conv:', conversation.id);
    console.log('files:', JSON.stringify(m.meta?.files || []));
    console.log('reply:', String(m.content).slice(0, 100));
    break;
  }
}
