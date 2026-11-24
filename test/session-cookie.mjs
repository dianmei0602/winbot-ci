// 登录态：带 token 打开 → 302 + HttpOnly Cookie；之后请求不需要 URL 里带 token。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

console.log('=== 1. 带 token 打开首页 ===');
const first = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const setCookie = first.headers.get('set-cookie') || '';
check('返回 302', first.status === 302, String(first.status));
check('跳到干净地址', (first.headers.get('location') || '') === '/', first.headers.get('location'));
check('种了 cookie', setCookie.includes('winbot='), setCookie.slice(0, 60));
check('cookie 是 HttpOnly', /HttpOnly/i.test(setCookie));
check('cookie 是 SameSite=Strict', /SameSite=Strict/i.test(setCookie));
check('地址里没有 token', !(first.headers.get('location') || '').includes('token'));

console.log('=== 2. 用 cookie 访问接口 ===');
const cookie = setCookie.split(';')[0];
const withCookie = await fetch(`${BASE}/api/bots`, { headers: { cookie } });
check('带 cookie 能拿到数据', withCookie.status === 200, String(withCookie.status));

const noCookie = await fetch(`${BASE}/api/bots`);
check('没 cookie 仍然 401', noCookie.status === 401, String(noCookie.status));

console.log('=== 3. Bearer 仍然可用（脚本/测试） ===');
const bearer = await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${token}` } });
check('Bearer 可用', bearer.status === 200, String(bearer.status));

console.log('=== 4. 错误 token 不种 cookie ===');
const wrong = await fetch(`${BASE}/?token=nope`, { redirect: 'manual' });
check('错误 token 不 302', wrong.status !== 302, String(wrong.status));
check('错误 token 不种有效 cookie', !/winbot=/.test(wrong.headers.get('set-cookie') || ''));

console.log('=== 5. 有 cookie 再访问首页不循环 ===');
const again = await fetch(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
check('首页直接 200', again.status === 200, String(again.status));

process.exit(bad ? 1 : 0);
