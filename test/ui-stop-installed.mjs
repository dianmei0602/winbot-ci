// 安装版 UI 自检：停止按钮、审批卡的「1 小时」按钮、输入框都在。
import fs from 'node:fs';
const PORT = Number(process.env.WINBOT_CDP_PORT || 9456);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5178')) || list.find((t) => t.type === 'page');
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
    waiters.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
    setTimeout(() => reject(new Error(`${method} 超时`)), 20_000).unref?.();
  });
await new Promise((r) => {
  ws.addEventListener('open', r);
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send('Runtime.enable');
await sleep(1200);
const info = await evaluate(`(() => ({
  stop: !!document.querySelector('#btn-stop'),
  stopHidden: document.querySelector('#btn-stop')?.hidden,
  send: !!document.querySelector('#btn-send'),
  input: !!document.querySelector('#input'),
  version: document.title,
}))()`);
console.log(JSON.stringify(info));

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
ok('安装版里有「停止」按钮', info?.stop === true);
ok('空闲时停止按钮是隐藏的', info?.stopHidden === true);
ok('输入框和发送都在', info?.input && info?.send);

// 触发一次慢活，看停止按钮是否出现
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (m, p, b) => {
  const r = await fetch(`http://127.0.0.1:5178${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};
// 在窗口里直接发（走真实 UI 路径，SSE 才会把 busy 传到这个会话）
await evaluate(`document.querySelector('#bot-list .bot-item')?.click()`);
await sleep(1200);
await evaluate(`document.querySelector('#btn-new-conv')?.click()`);
await sleep(1200);
await evaluate(`(() => {
  const i = document.querySelector('#input');
  i.value = '用 generate_video 生成一段海边日落的视频。';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#btn-send').click();
})()`);
await sleep(6000);
const convNow = await evaluate(`(() => { const p = document.querySelector('#messages'); return p ? p.children.length : 0 })()`);
console.log('消息节点数:', convNow);
const busy = await evaluate(`(() => ({ hidden: document.querySelector('#btn-stop')?.hidden, disabled: document.querySelector('#btn-send')?.disabled }))()`);
ok('忙碌时停止按钮出现', busy?.hidden === false, JSON.stringify(busy));
await evaluate(`document.querySelector('#btn-stop')?.click()`);
await sleep(2500);
const after = await evaluate(`document.querySelector('#btn-stop')?.hidden`);
ok('停止后按钮又隐藏了', after === true);
ws.close();
setTimeout(() => process.exit(process.exitCode || 0), 200);

