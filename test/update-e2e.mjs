// 自动更新闭环 E2E：对已安装的旧版本走 检查 → 下载 → 排队安装 → 验证新版本。
// 前置：安装版已启动，配置里 repo 指向公开更新渠道（winbot-ci），并设置好代理。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const APPDATA = process.env.APPDATA || '';
const DATA = path.join(APPDATA, 'winbot', 'data');
const EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'winbot.exe');
const BASE = 'http://127.0.0.1:5178';
const PROXY = 'http://127.0.0.1:12450';
const REPO = 'dianmei0602/winbot-ci';

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

// 配置更新渠道（UPDATE_E2E_ENV_PROXY=1 时用启动期环境代理，不写 config.proxy）
const useEnvProxy = process.env.UPDATE_E2E_ENV_PROXY === '1';
const s = await (await fetch(`${BASE}/api/update/settings`, { method: 'POST', headers: H, body: JSON.stringify({ repo: REPO, proxy: useEnvProxy ? '' : PROXY, token: '' }) })).json();
console.log('设置:', JSON.stringify(s).slice(0, 140));

// 1) 检查
const c = await (await fetch(`${BASE}/api/update/check`, { headers: H })).json();
console.log('检查:', JSON.stringify({ found: c.found, latest: c.latest, current: c.current, newer: c.newer, asset: c.asset?.name }).slice(0, 200));
check('能查到新版本', c.found === true && c.newer === true, `${c.current} → ${c.latest}`);
if (!c.found || !c.newer) process.exit(1);

// 2) 下载（250MB，走代理）
const t0 = Date.now();
const d = await (await fetch(`${BASE}/api/update/download`, { method: 'POST', headers: H, body: JSON.stringify({ url: c.asset.url, name: c.asset.name }) })).json();
console.log('下载:', JSON.stringify(d).slice(0, 200), `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
check('下载完成', d.ok === true && fs.existsSync(d.path || ''), `${Math.round((d.size || 0) / 1048576)} MB`);

// 3) 排队安装
const i = await (await fetch(`${BASE}/api/update/install`, { method: 'POST', headers: H, body: JSON.stringify({ path: d.path }) })).json();
console.log('安装:', JSON.stringify(i));
check('进入排队安装', i.queued === true && i.installsOnQuit === true);

// 4) 等它退出 → 安装 → 版本变化
let after = before;
for (let n = 0; n < 60; n += 1) {
  await sleep(5000);
  try {
    after = ver();
  } catch {
    after = before;
  }
  if (after !== before) break;
  if (n % 6 === 0) console.log(`  … 等待安装（${(n + 1) * 5}s）当前 ${after}`);
}
console.log('安装后版本:', after);
check('版本已升级', after !== before, `${before} → ${after}`);

if (after !== before) {
  // 启动新版本并验证
  console.log('启动新版本…');
  spawn(EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY } }).unref();
  let up = false;
  for (let n = 0; n < 30; n += 1) {
    await sleep(2000);
    try {
      const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (h.ok) { up = true; break; }
    } catch {}
  }
  check('新版本能启动', up);
  if (up) {
    const b = await (await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).json();
    check('新版本数据还在', Array.isArray(b) && b.length >= 1, `${b.length} 个机器人`);
  }
}

process.exit(bad ? 1 : 0);

