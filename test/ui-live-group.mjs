// 群里发一条消息，验证回复是正常对话气泡（带发言人），不是灰字备注。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const message = process.argv[2] || '用一句话说说你能帮我做什么';
const OUT = 'E:/AI_work/winbot/data/ui-live-group.png';
const PORT = 9334;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--user-data-dir=E:/AI_work/winbot/data/edge-live-group', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
);
process.on('exit', () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
});

async function wsUrlOfPage() {
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
  throw new Error('CDP 没起来');
}

const ws = new WebSocket(await wsUrlOfPage());
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
  const t = setTimeout(() => reject(new Error('CDP ws 连不上')), 10_000);
  ws.addEventListener('open', () => {
    clearTimeout(t);
    resolve();
  });
  ws.addEventListener('error', () => reject(new Error('CDP ws 失败')));
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

const opened = await evaluate(`(() => {
  const g = document.querySelector('#group-list .bot-item');
  g?.click();
  return !!g;
})()`);
console.log('打开群:', opened);
await sleep(2000);

await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = ${JSON.stringify(message)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
  return 'sent';
})()`);

const deadline = Date.now() + 180_000;
let final = null;
while (Date.now() < deadline) {
  await sleep(2000);
  final = await evaluate(`(() => {
    const msgs = [...document.querySelectorAll('#messages .msg.bot')];
    const last = msgs[msgs.length - 1];
    return {
      count: msgs.length,
      speaker: last?.querySelector('.who')?.textContent.trim().slice(0, 20) || '',
      lastText: last ? last.querySelector('.bubble')?.textContent.trim().slice(0, 60) : '',
      grayLines: document.querySelectorAll('#messages .typing').length,
      streaming: !!document.querySelector('#messages .msg.streaming'),
    };
  })()`);
  if (final?.lastText) break;
}
console.log('最终：', JSON.stringify(final));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('saved', OUT);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('群里的回复是对话气泡', !!final?.lastText, final?.lastText);
ok('气泡上标了发言人', !!final?.speaker && final.speaker !== '机器人', final?.speaker);
ok('没有残留灰字', final?.grayLines === 0);
ok('没有残留「正在说」', final?.streaming === false);
ws.close();
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
