// 一条命令走完发版：跑测试 → 升版本 → 构建 → 发布 Release → 推送 → 刷 CI 镜像。
// 用法：node scripts/release.mjs --notes "这次改了什么" [--skip-tests] [--minor]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const REPO = 'dianmei0602/winbot';
const MIRROR = 'dianmei0602/winbot-ci';
const PROXY = process.env.WINBOT_GIT_PROXY || 'http://127.0.0.1:12450';

for (const k of Object.keys(process.env)) {
  if (k === 'GIT_CONFIG_COUNT' || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) delete process.env[k];
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const notes = val('--notes', '常规更新');
const step = (msg) => console.log(`\n▸ ${msg}`);

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const next = has('--minor') ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
const installer = `winbot-Setup-${next}.exe`;
const distExe = path.join(ROOT, 'dist', installer);

if (!has('--skip-tests')) {
  step('跑快检');
  execFileSync(process.execPath, ['test/run-verify.mjs'], { cwd: ROOT, stdio: 'inherit' });
}

// 发布前拦一道：这个脚本会 git add -A 把整个工作区打包发版，
// 工作区里如果还躺着别的半成品（比如正在改的功能），会被一起打进这个版本、
// 提交信息却只写「release: x.y.z」。这种事真发生过，所以默认拒绝，确认后才放行。
{
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) {
    const lines = dirty.split('\n').filter(Boolean);
    console.log(`\n⚠ 工作区有 ${lines.length} 处未提交的改动，会被一起打进这个版本：`);
    for (const l of lines.slice(0, 20)) console.log(`   ${l}`);
    if (lines.length > 20) console.log(`   …还有 ${lines.length - 20} 处`);
    if (!has('--allow-dirty')) {
      console.log('\n   确认这些改动确实要一起发，就加 --allow-dirty 重跑；');
      console.log('   不想带上就 git stash 之后再来。\n');
      process.exit(1);
    }
    console.log('\n   （--allow-dirty 已确认，继续）\n');
  }
}

step(`升版本 ${pkg.version} → ${next}`);
pkg.version = next;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  const old = `winbot-Setup-${pkg.version.replace(/^\d+\.\d+\./, '')}`; // 占位，下面按实际替换
  let r = fs.readFileSync(readmePath, 'utf8');
  r = r.replace(/winbot-Setup-\d+\.\d+\.\d+\.exe/g, installer);
  fs.writeFileSync(readmePath, r, 'utf8');
}

const changelogPath = path.join(ROOT, 'CHANGELOG.md');
if (fs.existsSync(changelogPath)) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const head = fs.readFileSync(changelogPath, 'utf8');
  const entry = `# 更新日志\n\n## ${next} — ${notes}（${stamp}）\n\n- ${notes}\n`;
  fs.writeFileSync(changelogPath, head.replace('# 更新日志\n', entry), 'utf8');
}

step('构建安装包');
execFileSync('cmd.exe', ['/c', 'node_modules\\.bin\\electron-builder.cmd --win nsis --x64 --publish never'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    ELECTRON_RUN_AS_NODE: '',
  },
});
if (!fs.existsSync(distExe)) throw new Error(`构建产物不存在：${distExe}`);

const sha = crypto.createHash('sha256').update(fs.readFileSync(distExe)).digest('hex');
fs.appendFileSync(path.join(ROOT, 'dist', 'SHA256SUMS.txt'), `${installer}  sha256=${sha}\n`, 'utf8');
console.log(`sha256 ${sha}`);

step('推主仓 + tag');
const git = (...a) => execFileSync('git', ['-c', `http.proxy=${PROXY}`, ...a], { cwd: ROOT, stdio: 'inherit' });
execFileSync('git', ['add', '-A'], { cwd: ROOT, stdio: 'inherit' });
execFileSync('git', ['-c', 'user.name=winbot', '-c', 'user.email=winbot@localhost', 'commit', '-q', '-m', `release: ${next} — ${notes}`], { cwd: ROOT, stdio: 'inherit' });
execFileSync('git', ['tag', `v${next}`], { cwd: ROOT, stdio: 'inherit' });
git('push', 'origin', 'main');
git('push', 'origin', `v${next}`);

function curl(args, timeoutMs = 900_000) {
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'curl 失败').slice(0, 300));
  return r.stdout;
}

async function withRetry(fn, times = 3) {
  let last;
  for (let i = 0; i < times; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.log(`  ! 第 ${i + 1} 次失败：${e.message.slice(0, 120)}，2s 后重试`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw last;
}

step('发布 GitHub Release');
const cred = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const token = (cred.stdout.match(/^password=(.+)$/m) || [])[1]?.trim();
if (!token) throw new Error('拿不到 GitHub token');
const h = { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', accept: 'application/vnd.github+json' };
const body = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(`## ${next}`)[1].split('\n## ')[0].trim();
const payloadPath = path.join(ROOT, 'data', '.release.json');
fs.writeFileSync(payloadPath, JSON.stringify({ tag_name: `v${next}`, name: `v${next}`, body, draft: false, prerelease: false }), 'utf8');
let rel = JSON.parse(curl(['-sS', '--http1.1', '--max-time', '90', '-x', PROXY, '-H', `Authorization: Bearer ${token}`, '-H', 'User-Agent: winbot-release', 'https://api.github.com/repos/' + REPO + '/releases/tags/v' + next]));
if (!rel?.id) {
  rel = JSON.parse(curl(['-sS', '--http1.1', '--max-time', '120', '-x', PROXY, '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'User-Agent: winbot-release', '-H', 'Content-Type: application/json', '--data-binary', '@' + payloadPath, 'https://api.github.com/repos/' + REPO + '/releases']));
}
fs.unlinkSync(payloadPath);
if (!(rel.assets || []).some((a) => a.name === installer)) {
  const base = String(rel.upload_url).replace(/\{[^}]*\}/, '');
  const out = curl(['-sS', '--http1.1', '--max-time', '1800', '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'User-Agent: winbot-release', '-H', 'Content-Type: application/octet-stream', '--data-binary', '@' + distExe, `${base}?name=${encodeURIComponent(installer)}`]);
  const a = JSON.parse(out);
  if (!a.name) throw new Error('上传失败：' + out.slice(0, 200));
  console.log(`已上传 ${a.name}（${Math.round(a.size / 1048576)} MB）`);
}

step('发布到公开更新渠道（无需 token）');
const pub = spawnSync(process.execPath, ['scripts/publish-public.mjs', `v${next}`, distExe, `${notes}（公开更新渠道）`], { cwd: ROOT, stdio: 'inherit' });
if (pub.status !== 0) console.log('⚠ 公开渠道发布失败，但主仓已发布');

step('刷新公共 CI 镜像');
execFileSync(process.execPath, ['scripts/mirror-ci.mjs'], { cwd: ROOT, stdio: 'inherit' });

console.log(`\n✓ 发布完成：v${next}（${installer}，sha256 ${sha.slice(0, 12)}…）`);

