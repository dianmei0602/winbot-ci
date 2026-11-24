// 验证：生图时右侧自动出现 ComfyUI 面板（内嵌可以运行）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const PORT = 9451;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.WINBOT_SHOT || 'E:/AI_work/winbot/docs/ui-comfy.png';

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--user-data-dir=E:/AI_work/winbot/data/edge-comfy', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
);
process.on('exit', () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
});

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error('CDP 没起来');
}
const ws = new WebSocket(await wsUrl());
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
    }, 40_000).unref?.();
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(token)}` });
await sleep(4500);
await evaluate(`document.querySelector('#bot-list .bot-item')?.click()`);
await sleep(1200);
await evaluate(`document.querySelector('#btn-new-conv')?.click()`);
await sleep(1200);

await evaluate(`(() => {
  const i = document.querySelector('#input');
  i.value = '画一张：一只柴犬坐在樱花树下，下午逆光，1024x1024。只告诉我文件在哪。';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
})()`);

// 等右侧面板出现
let panelInfo = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  panelInfo = await evaluate(`(() => {
    const panel = document.querySelector('#panel');
    const frame = document.querySelector('#panel-body iframe');
    return {
      open: panel && !panel.hidden,
      title: document.querySelector('#panel-title')?.textContent || '',
      frameSrc: frame?.src || '',
      frameH: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
    };
  })()`);
  if (panelInfo?.open && panelInfo.frameSrc) break;
}
console.log('面板:', JSON.stringify(panelInfo));
await sleep(6000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('saved', OUT);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('右侧面板自动打开了', panelInfo?.open === true);
ok('标题是 ComfyUI', panelInfo?.title === 'ComfyUI', panelInfo?.title);
ok('内嵌的是 ComfyUI 地址', String(panelInfo?.frameSrc || '').includes('8188'), panelInfo?.frameSrc);
ok('iframe 有实际高度', (panelInfo?.frameH || 0) > 300, `${panelInfo?.frameH}px`);

ws.close();
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
