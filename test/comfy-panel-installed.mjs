// 在已安装的 Electron 窗口里点顶部 ComfyUI 按钮，确认右侧面板能内嵌。
import fs from 'node:fs';

const PORT = Number(process.env.WINBOT_CDP_PORT || 9452);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.WINBOT_SHOT || 'E:/AI_work/winbot/docs/ui-comfy-installed.png';

async function pages() {
  for (let i = 0; i < 60; i += 1) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('连不上调试端口');
}
const list = await pages();
const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5178')) || list.find((t) => t.type === 'page');
if (!page) throw new Error('没找到窗口页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
const waiters = new Map();
let seq = 0;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) {
    const { resolve, reject } = waiters.get(m.id);
    waiters.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    seq += 1;
    const id = seq;
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (!waiters.has(id)) return;
      waiters.delete(id);
      reject(new Error(`${method} 超时`));
    }, 30_000).unref?.();
  });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws 连不上')), 10_000);
  ws.addEventListener('open', () => {
    clearTimeout(t);
    resolve();
  });
  ws.addEventListener('error', () => reject(new Error('ws 失败')));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await sleep(1500);
await evaluate(`document.querySelector('#btn-comfy')?.click()`);
await sleep(3500);
const info = await evaluate(`(() => {
  const panel = document.querySelector('#panel');
  const frame = document.querySelector('#panel-body iframe');
  return {
    open: panel && !panel.hidden,
    title: document.querySelector('#panel-title')?.textContent || '',
    src: frame?.src || '',
    w: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
  };
})()`);
console.log('窗口面板:', JSON.stringify(info));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('saved', OUT);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('安装版里点 ComfyUI 能打开面板', info?.open === true);
ok('内嵌地址正确', String(info?.src || '').includes('8188'));
ok('面板够宽', (info?.w || 0) > 400, `${info?.w}px`);
ws.close();
setTimeout(() => process.exit(process.exitCode || 0), 200);
