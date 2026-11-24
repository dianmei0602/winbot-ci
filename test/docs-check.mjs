// 文档一致性：版本号、安装包名、功能清单状态别互相打架。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/^\uFEFF/, '');
let bad = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const features = read('docs/FEATURES.md');

ok('package.json 有版本号', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version);

// README 里写的安装包名，应该和 dist 里最新的产物对得上
const mentioned = [...readme.matchAll(/winbot-Setup-(\d+\.\d+\.\d+)\.exe/g)].map((m) => m[1]);
const distExists = fs.existsSync(path.join(root, 'dist'));
const built = distExists
  ? fs.readdirSync(path.join(root, 'dist')).filter((f) => /^winbot-Setup-.*\.exe$/.test(f))
  : [];
if (!mentioned.length) {
  ok('README 提到了安装包名', false);
} else if (!distExists) {
  console.log('  · CI 无 dist，跳过「安装包是否存在/最新」两项');
} else {
  ok('README 提到的安装包存在', built.some((f) => f.includes(mentioned[0])), `${mentioned[0]} / 实际: ${built.join(',') || '无'}`);
  if (built.length) {
    // 按版本号数字比较，不是字符串（0.6.10 要排在 0.6.9 后面）
    const verOf = (f) => (f.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const newest = built
      .map((f) => ({ f, v: verOf(f) }))
      .filter((x) => x.v.length === 3)
      .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2])
      .at(-1)?.f.match(/(\d+\.\d+\.\d+)/)?.[1];
    ok('README 的包名是最新版本', mentioned[0] === newest, `README ${mentioned[0]} vs dist ${newest}`);
  }
}

// FEATURES 不该把没做的写成已做
ok('FEATURES 保留「还没做」章节', features.includes('## 二、还没做的'));
ok('FEATURES 标了 3D 贴图未做', features.includes('3D 带贴图'));
ok('FEATURES 标了代码签名未做', features.includes('代码签名'));
ok('FEATURES 没有把 Tripo 说成本地可部署', !/Tripo.*(本地部署|部署到本地)/.test(features));

// 已实现的功能不能还挂在「没做」里
ok('FEATURES 有自动更新（已做）', /✅[^\n]*自动更新/.test(features));
ok('FEATURES 没把自动更新写成没做', !/⛔ \| 自动更新/.test(features));
ok('FEATURES 有手机访问（局域网）', features.includes('手机访问（局域网）'));
const cmp = fs.readFileSync(path.join(root, 'docs/compare-openmausbot.html'), 'utf8');
ok('对比页没把自动更新写成没有', !cmp.includes("'自动更新', '❌'"));
ok('对比页没写「只监听 127.0.0.1」', !cmp.includes('只监听 127.0.0.1'));

// 收口计划在不在
ok('收口计划存在', fs.existsSync(path.join(root, 'docs/superpowers/plans/2026-11-22-winbot-0.3.0-closure.md')));

// 数据目录不能被提交
const gi = read('.gitignore');
ok('.gitignore 忽略 data/', /^data\/$/m.test(gi));
ok('.gitignore 忽略 node_modules/', /^node_modules\/$/m.test(gi));
ok('.gitignore 忽略 dist/', /^dist\/$/m.test(gi));

process.exit(bad ? 1 : 0);
