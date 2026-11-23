// 安装队列：POST /api/update/install 应当只「排队」，等桌面壳退出后再装。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

const flag = 'E:/AI_work/winbot/data/update-pending.json';
const dummy = 'E:/AI_work/winbot/data/fake-setup.exe';
if (fs.existsSync(flag)) fs.unlinkSync(flag);
fs.writeFileSync(dummy, 'MZ fake installer for test');

const r = await (await fetch(`${BASE}/api/update/install`, { method: 'POST', headers: H, body: JSON.stringify({ path: dummy }) })).json();
console.log('  返回:', JSON.stringify(r).slice(0, 160));
check('接口返回排队状态', r.queued === true && r.installsOnQuit === true);
check('写了待安装标记', fs.existsSync(flag), flag);
if (fs.existsSync(flag)) {
  const job = JSON.parse(fs.readFileSync(flag, 'utf8'));
  check('标记里是安装包路径', job.file === dummy, job.file);
}

// 不存在的安装包必须拒绝
const miss = await fetch(`${BASE}/api/update/install`, { method: 'POST', headers: H, body: JSON.stringify({ path: 'E:/nope.exe' }) });
check('不存在的安装包被拒', miss.status >= 400, String(miss.status));

// 未配 token 时检查更新要标 needsToken
const upd = await (await fetch(`${BASE}/api/update/check`, { headers: H })).json();
check('未配 token 时标了 needsToken', upd.needsToken === true, JSON.stringify({ found: upd.found, needsToken: upd.needsToken }));

for (const f of [flag, dummy]) if (fs.existsSync(f)) fs.unlinkSync(f);
process.exit(bad ? 1 : 0);
