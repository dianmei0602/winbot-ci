// 给正在运行的 Electron 窗口截图 + 在窗口里发一条消息（验证桌面壳真的能用）。
// 用法: node test/electron-check.mjs [message]
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.WINBOT_CDP_PORT || 9444);
const out = process.env.WINBOT_SHOT || 'E:/AI_work/winbot/data/electron-window.png';
const message = process.argv[2] || '在桌面窗口里说一句话：你好';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pages() {
  for (let i = 0; i < 40; i += 1) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('连不上 Electron 的调试端口（应用起了吗？）');
}

const list = await pages();
const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5178')) || list.find((t) => t.type === 'page');
if (!page) throw new Error('没找到应用页面');
console.log('page:', page.title, page.url.slice(0, 60));

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
await sleep(1500);

// 在窗口里输入并发送
const info = await evaluate(`(() => {
  const input = document.querySelector('#input');
  const bot = document.querySelector('#bot-list .bot-item');
  bot?.click();
  return { hasInput: !!input, bots: document.querySelectorAll('#bot-list .bot-item').length, title: document.title };
})()`);
console.log('窗口内容:', JSON.stringify(info));
await sleep(1200);
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = ${JSON.stringify(message)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
  return 'sent';
})()`);

// 等回复
const deadline = Date.now() + 180_000;
let got = null;
while (Date.now() < deadline) {
  await sleep(2000);
  got = await evaluate(`(() => {
    const msgs = [...document.querySelectorAll('#messages .msg.bot')];
    const last = msgs[msgs.length - 1];
    return { count: msgs.length, text: last ? last.querySelector('.bubble')?.textContent.trim().slice(0, 80) : '' };
  })()`);
  if (got?.text) break;
}
console.log('回复:', JSON.stringify(got));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('窗口里加载了控制台界面', info?.hasInput === true);
ok('窗口里能看到机器人', (info?.bots || 0) > 0, `${info?.bots} 个`);
ok('在桌面窗口里发消息能收到回复', !!got?.text, got?.text);

// 清理这次会话
ws.close();
setTimeout(() => process.exit(process.exitCode || 0), 300);

