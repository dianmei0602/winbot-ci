// 更新：版本比较单测 + 真实查 GitHub（token 从 git 凭据管理器取）。
import { execSync } from 'node:child_process';
import { compareVersions, checkForUpdate, currentVersion } from '../src/update.js';

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

console.log('=== 版本比较 ===');
check('0.4.0 > 0.3.3', compareVersions('0.4.0', '0.3.3') === 1);
check('v1.2.3 == 1.2.3', compareVersions('v1.2.3', '1.2.3') === 0);
check('0.10.0 > 0.9.9', compareVersions('0.10.0', '0.9.9') === 1);
check('当前版本能读到', /^\d+\.\d+\.\d+/.test(currentVersion()), currentVersion());

console.log('=== 查 GitHub（真实请求） ===');
const token = (() => {
  try {
    const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
    return (out.match(/^password=(.+)$/m) || [])[1] || '';
  } catch {
    return '';
  }
})();
if (!token) {
  console.log('  没拿到 GitHub token，跳过真实请求');
} else {
  const r = await checkForUpdate({ repo: 'dianmei0602/winbot', token });
  console.log('  返回:', JSON.stringify(r).slice(0, 320));
  check('接口没报错', r.ok === true);
  if (r.found) {
    check('能拿到最新版本号', !!r.latest, r.latest);
    check('能判断是否有更新', typeof r.newer === 'boolean', `newer=${r.newer}`);
  } else {
    check('没有 release 时给出说明', !!r.message, r.message);
  }
}

process.exit(bad ? 1 : 0);
