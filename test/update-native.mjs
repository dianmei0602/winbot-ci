// electron-updater 闭环测试：通过 preload 暴露的 window.winbotUpdate 走真实 IPC。
// 前置：安装版在跑且带 --remote-debugging-port=9472；系统代理需能访问 GitHub。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.CDP_PORT || 9472);
const EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'winbot.exe');
const APP_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'resources', 'app');
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(path.join(process.env.APPDATA || '', 'winbot', 'data', 'ui-token'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (l, c, e = '') => console.log(`${c ? '  ✓' : '  ✗'} ${l}${e ? ` — ${e}` : ''}`);
let bad = 0;
const check = (l, c, e = '') => {
  if (!c) bad += 1;
  ok(l, c, e);
};
const ver = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();

// CDP 连接
let wsUrl = null;
for (let i = 0; i < 40; i += 1) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(500);
}
if (!wsUrl) throw new Error('CDP 没起来（安装版是否带 --remote-debugging-port=9472 启动？）');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const call = (m, p = {}) => new Promise((res) => { id += 1; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => {
  const r = await call('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const before = ver();
console.log('安装版当前版本:', before);
check('preload 桥存在', (await ev('typeof window.winbotUpdate')) === 'object', String(await ev('typeof window.winbotUpdate')));

console.log('--- check ---');
const c = await ev('window.winbotUpdate.check()');
console.log(JSON.stringify(c).slice(0, 300));
check('能查到新版本', c?.ok === true && c?.newer === true, `${c?.current} → ${c?.latest}`);
if (!c?.ok || !c?.newer) process.exit(1);

console.log('--- download ---');
const d = await ev('window.winbotUpdate.download()');
console.log(JSON.stringify(d).slice(0, 200));
check('下载完成', d?.ok === true, JSON.stringify(d).slice(0, 120));

console.log('--- install（会退出并安装）---');
call('Runtime.evaluate', { expression: 'window.winbotUpdate.install()', returnByValue: true });
console.log('install 已触发（应用会退出，不等回包）');
ws.close();

// 等安装完成并重启
let after = before;
const started = Date.now();
while (Date.now() - started < 8 * 60_000) {
  await sleep(5000);
  try { after = ver(); } catch { after = ''; }
  if (after === c.latest) break;
  const el = Math.round((Date.now() - started) / 1000);
  if (el % 30 === 0) console.log(`  … 等待安装（${el}s）当前 ${after || '（文件替换中）'}`);
}
console.log('安装后版本:', after);
check('版本已升级', after === c.latest, `${before} → ${after}`);
check('安装目录完整（src）', fs.existsSync(path.join(APP_DIR, 'src', 'main.js')));

let up = false;
for (let n = 0; n < 40; n += 1) {
  await sleep(2000);
  try {
    const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (h.ok) { up = true; break; }
  } catch {}
}
check('新版本自动启动并健康', up);
if (up) {
  const b = await (await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).json();
  check('数据还在', Array.isArray(b) && b.length >= 1, `${b.length} 个机器人`);
}
process.exit(bad ? 1 : 0);

