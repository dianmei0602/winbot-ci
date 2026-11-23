// 验证右侧面板可以拖拽调宽，并且宽度会被记住。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const PORT = 9454;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.WINBOT_SHOT || 'E:/AI_work/winbot/docs/ui-resize.png';

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--user-data-dir=E:/AI_work/winbot/data/edge-resize', 'about:blank'],
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(token)}` });
await sleep(4500);
await evaluate(`document.querySelector('#btn-comfy')?.click()`);
await sleep(2500);

const before = await evaluate(`(() => {
  const p = document.querySelector('#panel');
  return { w: Math.round(p.getBoundingClientRect().width), grip: !!document.querySelector('#pane-resizer') };
})()`);
console.log('拖动前:', JSON.stringify(before));

// 合成指针事件：从面板左缘往左拖 180px（面板变宽）
const drag = await evaluate(`(() => {
  const h = document.querySelector('#pane-resizer');
  const rect = h.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const y = rect.top + 40;
  h.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: startX, clientY: y, bubbles: true, cancelable: true }));
  h.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: startX - 300, clientY: y, bubbles: true }));
  h.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: startX - 300, clientY: y, bubbles: true }));
  const p = document.querySelector('#panel');
  return { w: Math.round(p.getBoundingClientRect().width), saved: localStorage.getItem('winbot.panelW') };
})()`);
console.log('拖动后:', JSON.stringify(drag));
await sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

// 刷新后是否记住
await send('Page.reload');
await sleep(4000);
await evaluate(`document.querySelector('#btn-comfy')?.click()`);
await sleep(1500);
const after = await evaluate(`(() => {
  const p = document.querySelector('#panel');
  return { w: Math.round(p.getBoundingClientRect().width), saved: localStorage.getItem('winbot.panelW') };
})()`);
console.log('刷新后:', JSON.stringify(after));

// 双击复位
await evaluate(`(() => {
  const h = document.querySelector('#pane-resizer');
  h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return localStorage.getItem('winbot.panelW');
})()`);
await sleep(400);
const reset = await evaluate(`Math.round(document.querySelector('#panel').getBoundingClientRect().width)`);
console.log('复位后宽度:', reset);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('面板上有拖拽把手', before?.grip === true);
ok('拖动后宽度变了', Math.abs((drag?.w || 0) - (before?.w || 0)) > 60, `${before?.w} → ${drag?.w}`);
ok('宽度记住了', Number(after?.saved) === drag?.w, `${after?.saved}`);
ok('刷新后仍是拖过的宽度', Math.abs((after?.w || 0) - (drag?.w || 0)) <= 2, `${after?.w}`);
ok('双击复位回默认', (reset || 0) < (drag?.w || 0) - 40, `${reset}`);

ws.close();
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);

