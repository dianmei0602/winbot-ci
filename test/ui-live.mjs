// 验证「在页面里真实发一条消息」的渲染：流式片段要按气泡显示，结束后换成正式消息。
// 用法: node test/ui-live.mjs [botName] [message]
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const botName = process.argv[2] || '小七';
const message = process.argv[3] || '用两句话介绍一下你自己';
const OUT = 'E:/AI_work/winbot/data/ui-live.png';
const PORT = 9333;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (m, p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const bots = await api('GET', '/api/bots');
const bot = bots.find((b) => b.name === botName) || bots[0];

// 先开一个干净会话，别在旧会话里滚
const { conversation } = await (async () => {
  const r = await fetch(`${BASE}/api/bots/${bot.id}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  return r.json();
})();

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
    '--user-data-dir=E:/AI_work/winbot/data/edge-live',
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
    waiters.set(id, {
      resolve: (v) => resolve(v),
      reject,
    });
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
// 直接带上会话参数做不到，先正常打开再点开这个会话
await send('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(token)}` });
await sleep(4500);

// 先切到目标机器人
await evaluate(`(() => {
  const items = [...document.querySelectorAll('#bot-list .bot-item')];
  const target = items.find((n) => n.textContent.includes(${JSON.stringify(botName)})) || items[0];
  target?.click();
  return !!target;
})()`);
await sleep(1500);

// 输入并发送
const sent = await evaluate(`(() => {
  const input = document.querySelector('#input');
  if (!input) return 'no input';
  input.value = ${JSON.stringify(message)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
  return 'sent';
})()`);
console.log('send:', sent);

// 5 秒时抓一次：这时候应该已经有气泡（不是灰字）
await sleep(5000);
const mid = await evaluate(`(() => {
  const bubbles = [...document.querySelectorAll('#messages .msg.bot .bubble')].map((n) => n.textContent.trim().slice(0, 40));
  const gray = [...document.querySelectorAll('#messages .typing')].map((n) => n.textContent.trim().slice(0, 40));
  return { bubbles, gray };
})()`);
console.log('5s 时：气泡 =', JSON.stringify(mid?.bubbles), ' 灰字 =', JSON.stringify(mid?.gray));

// 等到出现正式消息（最多 3 分钟）
const deadline = Date.now() + 180_000;
let final = null;
while (Date.now() < deadline) {
  await sleep(2000);
  final = await evaluate(`(() => {
    const msgs = [...document.querySelectorAll('#messages .msg.bot')];
    const last = msgs[msgs.length - 1];
    return {
      count: msgs.length,
      lastText: last ? last.querySelector('.bubble')?.textContent.trim().slice(0, 80) : '',
      stillStreaming: !!document.querySelector('#messages .msg.streaming'),
      grayLines: document.querySelectorAll('#messages .typing').length,
    };
  })()`);
  if (final && final.lastText) break;
}
console.log('最终：', JSON.stringify(final));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('saved', OUT);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('回复渲染成了对话气泡', !!final?.lastText, final?.lastText);
ok('结束后没有残留的灰字片段', final?.grayLines === 0, `gray=${final?.grayLines}`);
ok('结束后没有残留的「正在说」', final?.stillStreaming === false);

// 清理这次测试会话
await fetch(`${BASE}/api/conversations/${conversation.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
ws.close();
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
