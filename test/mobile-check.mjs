// 手机端检查：通过局域网地址打开控制台，截图 + 验证抽屉侧栏能展开。
// 需要先在设置里开启「允许局域网访问」并重启。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = 9338;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const info = await (await fetch('http://127.0.0.1:5178/api/net', { headers: { authorization: `Bearer ${token}` } })).json();
const lanUrl = (info.urls || []).find((u) => !u.url.includes('127.0.0.1'))?.url;
if (!lanUrl) {
  console.log('  · SKIP：没有局域网地址（设置 → 手机/局域网 里开启后重启即可测）；本次不判失败');
  process.exit(0);
}
console.log('  · 使用地址:', lanUrl.replace(/token=.*/, 'token=***'));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--user-data-dir=E:/AI_work/winbot/data/edge-mobile3', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
process.on('exit', () => { try { child.kill(); } catch {} });

let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
if (!wsUrl) throw new Error('CDP 没起来');

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await call('Page.enable');
await call('Page.navigate', { url: lanUrl });
await new Promise((r) => setTimeout(r, 7000));

const state = await evaluate(`JSON.stringify({
  drawer: !!document.querySelector('#btn-sidebar'),
  bots: document.querySelectorAll('.bot-item').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
  width: window.innerWidth,
  scroll: document.documentElement.scrollWidth,
})`);
const s = JSON.parse(state);
console.log('  · 页面宽度', s.width, '内容宽度', s.scroll);
const ok = (label, cond) => console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
ok('手机上能打开（局域网）', s.bots >= 1);
ok('有抽屉按钮', s.drawer);
ok('没有横向溢出', !s.overflow);

let shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('E:/AI_work/winbot/docs/ui-mobile.png', Buffer.from(shot.result.data, 'base64'));

await evaluate("document.querySelector('#btn-sidebar').click()");
await new Promise((r) => setTimeout(r, 800));
const open = await evaluate("document.querySelector('#app').classList.contains('drawer-open')");
ok('抽屉能展开', open === true);
shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('E:/AI_work/winbot/docs/ui-mobile-drawer.png', Buffer.from(shot.result.data, 'base64'));

ws.close();
child.kill();
process.exit(s.bots >= 1 && s.drawer && !s.overflow && open ? 0 : 1);
