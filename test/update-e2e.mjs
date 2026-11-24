// 自动更新闭环 E2E：检查 → 下载 → 排队 → 退出 → 安装（等回执）→ 验证新版本完整可用。
// 前置：安装版在跑；update 配置指向公开渠道（winbot-ci），代理按需。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const APPDATA = process.env.APPDATA || '';
const DATA = path.join(APPDATA, 'winbot', 'data');
const EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'winbot.exe');
const APP_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'resources', 'app');
const MARKER = path.join(DATA, 'update-result.json');
const BASE = 'http://127.0.0.1:5178';
const PROXY = 'http://127.0.0.1:12450';
const REPO = 'dianmei0602/winbot-ci';
const WAIT_MS = Number(process.env.UPDATE_E2E_WAIT_MS || 15 * 60_000);

const token = fs.readFileSync(path.join(DATA, 'ui-token'), 'utf8').trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};
const ver = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = ver();
console.log('安装版当前版本:', before);
if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER);

const useEnvProxy = process.env.UPDATE_E2E_ENV_PROXY === '1';
const s = await (await fetch(`${BASE}/api/update/settings`, { method: 'POST', headers: H, body: JSON.stringify({ repo: REPO, proxy: useEnvProxy ? '' : PROXY, token: '' }) })).json();
console.log('设置:', JSON.stringify(s).slice(0, 140));

// 1) 检查
const c = await (await fetch(`${BASE}/api/update/check`, { headers: H })).json();
console.log('检查:', JSON.stringify({ found: c.found, latest: c.latest, current: c.current, newer: c.newer, asset: c.asset?.name }).slice(0, 200));
check('能查到新版本', c.found === true && c.newer === true, `${c.current} → ${c.latest}`);
if (!c.found || !c.newer) process.exit(1);

// 2) 下载
const t0 = Date.now();
const d = await (await fetch(`${BASE}/api/update/download`, { method: 'POST', headers: H, body: JSON.stringify({ url: c.asset.url, name: c.asset.name, assetId: c.asset.id }) })).json();
console.log('下载:', JSON.stringify(d).slice(0, 200), `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
check('下载完成', d.ok === true && fs.existsSync(d.path || ''), `${Math.round((d.size || 0) / 1048576)} MB`);

// 3) 排队安装
const i = await (await fetch(`${BASE}/api/update/install`, { method: 'POST', headers: H, body: JSON.stringify({ path: d.path }) })).json();
console.log('安装:', JSON.stringify(i));
check('进入排队安装', i.queued === true && i.installsOnQuit === true);

// 4) 等安装回执（安装本身要 2-4 分钟，不能中途杀）
let receipt = null;
const started = Date.now();
while (Date.now() - started < WAIT_MS) {
  await sleep(5000);
  if (fs.existsSync(MARKER)) {
    try {
      receipt = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    } catch {
      receipt = null;
    }
    if (receipt) break;
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  if (elapsed % 30 === 0) console.log(`  … 等待安装回执（${elapsed}s）`);
}
console.log('安装回执:', JSON.stringify(receipt));
check('安装器已结束', !!receipt, receipt ? `exit=${receipt.exitCode}` : '超时没有回执');
check('安装器退出码为 0', receipt?.exitCode === 0, String(receipt?.exitCode));

// 5) 验证新版本完整 + 能启动
const after = fs.existsSync(EXE) ? ver() : '';
console.log('安装后版本:', after);
check('版本已升级', after === c.latest, `${before} → ${after}`);
check('安装目录完整（src 在）', fs.existsSync(path.join(APP_DIR, 'src', 'main.js')));
check('安装目录完整（node_modules 在）', fs.existsSync(path.join(APP_DIR, 'node_modules')));

if (after === c.latest) {
  console.log('启动新版本…');
  spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
  let up = false;
  for (let n = 0; n < 40; n += 1) {
    await sleep(2000);
    try {
      const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (h.ok) {
        up = true;
        break;
      }
    } catch {}
  }
  check('新版本能启动', up);
  if (up) {
    const b = await (await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).json();
    check('新版本数据还在', Array.isArray(b) && b.length >= 1, `${b.length} 个机器人`);
  }
}

process.exit(bad ? 1 : 0);
