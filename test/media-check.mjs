// 验证：本地生图（真实跑 ComfyUI）+ 视频缺模型时给出可执行的提示。
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
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === '小七') || bots[0];

console.log('=== ComfyUI 状态 ===');
const st = await api('GET', '/api/comfy/status');
console.log(`  up=${st.up} version=${st.version} checkpoints=${st.checkpoints.length} videoReady=${st.videoReady}`);
ok('本机 ComfyUI 在线', st.up === true);
ok('有可用 checkpoint', st.checkpoints.length > 0);

// 触发机器人重启（补丁里新增了 media 插件）
await api('PATCH', '/api/settings/comfy', { url: st.url, checkpoint: st.checkpoints[0] });
await new Promise((r) => setTimeout(r, 2500));

async function turn(text, timeoutMs = 300_000) {
  const { conversation } = await api('POST', `/api/bots/${bot.id}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, { text });
  const deadline = Date.now() + timeoutMs;
  let data = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    data = await api('GET', `/api/conversations/${conversation.id}`);
    if (data.messages.some((m) => m.role === 'assistant' || m.role === 'error')) break;
  }
  return { conversationId: conversation.id, data };
}

console.log('=== 生图 ===');
{
  const { conversationId, data } = await turn(
    '用 generate_image 工具画一张：一只橘猫坐在窗台上的木桌上，午后阳光，写实摄影风格，1024x1024。画完把文件路径告诉我，不用描述画面。',
  );
  const msg = data.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  const files = msg?.meta?.files || [];
  console.log('  回复:', String(msg?.content || '').slice(0, 120));
  console.log('  附件:', JSON.stringify(files));
  ok('没有报错', msg?.role === 'assistant', msg?.role);
  ok('消息里带了生成的文件', files.length >= 1);
  const rel = files[0]?.path;
  if (rel) {
    const abs = `E:/AI_work/winbot/data/bots/${bot.id}/workspace/${rel}`;
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    ok('文件真的落在工作区', size > 10_000, `${rel} ${Math.round(size / 1024)} KB`);
    ok('是图片类型', /\.(png|jpg|jpeg|webp)$/i.test(rel));
  }
  await api('DELETE', `/api/conversations/${conversationId}`);
}

console.log('=== 视频（没装模型，应该给出可执行的说明）===');
{
  const { conversationId, data } = await turn('用 generate_video 生成一段 2 秒的视频：一杯咖啡冒热气。', 240_000);
  const msg = data.messages.filter((m) => m.role === 'assistant' || m.role === 'error').at(-1);
  const text = String(msg?.content || '');
  console.log('  回复:', text.slice(0, 220).replace(/\n/g, ' / '));
  ok('明确说了缺什么', /缺|没装|模型/.test(text), msg?.role);
  ok('给出了要放的具体文件', /safetensors|models\/|GB/.test(text));
  await api('DELETE', `/api/conversations/${conversationId}`);
}

