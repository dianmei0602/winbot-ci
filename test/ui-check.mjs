// 用 CDP（Node 内置 WebSocket）给控制台截图并检查布局。用法: node test/ui-check.mjs [width] [height]
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
const PORT = 9333;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const url = `http://127.0.0.1:5178/?token=${token}`;
const out = `E:/AI_work/winbot/data/ui-${W}x${H}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=E:/AI_work/winbot/data/edge-cdp`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);
process.on('exit', () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
});

async function pageWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来');
}

const wsUrl = await pageWs();
const ws = new WebSocket(wsUrl);
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
    }, 25_000).unref?.();
  });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('CDP WebSocket 连不上')), 10_000);
  ws.addEventListener('open', () => {
    clearTimeout(t);
    resolve();
  });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
});

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  if (process.env.WINBOT_DARK) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url });
  await sleep(4500);
  if (process.env.WINBOT_OPEN === 'settings') await send('Runtime.evaluate', { expression: "document.querySelector('#btn-settings').click()" });
  if (process.env.WINBOT_OPEN === 'bot') await send('Runtime.evaluate', { expression: "document.querySelector('#btn-bot-panel').click()" });
  if (process.env.WINBOT_OPEN === 'schedules') await send('Runtime.evaluate', { expression: "document.querySelector('#btn-schedules').click()" });
  if (process.env.WINBOT_OPEN === 'search') await send('Runtime.evaluate', { expression: "document.querySelector('#btn-search').click()" });
  if (process.env.WINBOT_OPEN === 'group') await send('Runtime.evaluate', { expression: "document.querySelector('#group-list .bot-item') && document.querySelector('#group-list .bot-item').click()" });
  if (process.env.WINBOT_OPEN) await sleep(2500);
  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
      const sheetOk = [...document.styleSheets].some((s) => (s.href || '').includes('app.css'));
      const cs = q('#input') ? getComputedStyle(q('#input')) : null;
      const center = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return {
        vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        sheetOk,
        app: box('.app'), side: box('.sidebar'), main: box('.main'), chat: box('.chat'),
        messages: box('.messages'), composer: box('.composer'), input: box('#input'), send: box('#btn-send'),
        panelHidden: q('#panel')?.hidden,
        inputBg: cs?.backgroundColor, inputBorder: cs?.borderTopColor,
        centerTag: center?.tagName, centerCls: center?.className, centerBg: center ? getComputedStyle(center).backgroundColor : null,
        mediaMatch900: matchMedia('(max-width: 900px)').matches,
      };
    })()`,
  });
  console.log(JSON.stringify(probe.result.value, null, 2));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, fs.statSync(out).size);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  child.kill();
}
setTimeout(() => process.exit(process.exitCode || 0), 300);


