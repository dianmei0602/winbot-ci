// 文件接口边界回归：不存在 / 目录 / 越界都必须快速给出明确状态，不能挂住。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

const cookie = (await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const bots = await (await fetch(`${BASE}/api/bots`, { headers: { cookie } })).json();
const bot = bots[0];

async function statusOf(path, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/bots/${bot.id}/file?path=${encodeURIComponent(path)}`, { headers: { cookie }, signal: ctrl.signal });
    if (r.body) await r.body.cancel();
    return { status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { status: e.name, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const missing = await statusOf('outputs/nope-none.txt');
check('不存在的文件 → 404', missing.status === 404, `${missing.status}/${missing.ms}ms`);

const dir = await statusOf('outputs');
check('目录 → 400（不再挂住）', dir.status === 400, `${dir.status}/${dir.ms}ms`);
check('目录请求在 1 秒内返回', dir.ms < 1000, `${dir.ms}ms`);

const outside = await statusOf('../../config.json');
check('越界路径 → 403/404', outside.status === 403 || outside.status === 404, `${outside.status}`);

// 找一个真实文件
const ws = `E:/AI_work/winbot/data/bots/${bot.id}/workspace`;
const files = [];
const walk = (d) => {
  if (!fs.existsSync(d) || files.length) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(`${ws}/outputs`);
if (files[0]) {
  const rel = files[0].slice(ws.length + 1).replace(/\\/g, '/');
  const got = await statusOf(rel);
  check('真实文件 → 200', got.status === 200, `${got.status}/${got.ms}ms`);
}

process.exit(bad ? 1 : 0);
