// 在真实页面里发一条长回答，采样确认文字是一点点长出来的（而不是最后一次性出现）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const PORT = 9450;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_MID = 'E:/AI_work/winbot/docs/ui-streaming.png';

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--user-data-dir=E:/AI_work/winbot/data/edge-stream', 'about:blank'],
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
await evaluate(`document.querySelector('#bot-list .bot-item')?.click()`);
await sleep(1500);
await evaluate(`document.querySelector('#btn-new-conv')?.click()`);
await sleep(1200);

const prompt = '详细介绍一下你自己：你的定位、能做的事、做事的原则、权限边界，写 8 行以上，每行一句。';
await evaluate(`(() => {
  const i = document.querySelector('#input');
  i.value = ${JSON.stringify(prompt)};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
})()`);

// 每 150ms 采样：流式气泡的字数 + 是否出现正式消息
const samples = [];
let shotTaken = false;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await sleep(150);
  const s = await evaluate(`(() => {
    const live = document.querySelector('#messages .msg.streaming .bubble');
    const msgs = document.querySelectorAll('#messages .msg.bot:not(.streaming) .bubble');
    return {
      live: live ? live.textContent.replace('▍','').length : 0,
      final: msgs.length ? msgs[msgs.length-1].textContent.length : 0,
      typing: !!document.querySelector('#messages .typing'),
    };
  })()`);
  if (s) samples.push(s);
  if (!shotTaken && s && s.live > 25) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_MID, Buffer.from(shot.data, 'base64'));
    shotTaken = true;
    console.log('抓了一张输出中的截图，此刻已输出', s.live, '字');
  }
  if (s && s.final > 60 && !s.typing) break;
}

const liveLens = samples.map((s) => s.live).filter((n) => n > 0);
const grew = liveLens.length >= 2 && Math.max(...liveLens) > Math.min(...liveLens);
console.log('采样：', JSON.stringify(samples.slice(0, 12)));
console.log(`流式样本 ${liveLens.length} 个，长度 ${liveLens.slice(0, 8).join(',')}…`);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('界面上出现了逐字气泡', liveLens.length >= 2, `${liveLens.length} 个样本`);
ok('文字是一点点变长的', grew, `从 ${Math.min(...liveLens, 0)} 到 ${Math.max(...liveLens, 0)} 字`);
ok('抓到了输出中的截图', shotTaken, SHOT_MID);
ok('最终有完整回复', samples.some((s) => s.final > 60));

ws.close();
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
