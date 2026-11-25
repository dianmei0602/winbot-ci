// 公共 CI 镜像：把当前 HEAD 导出成一个干净快照（去掉截图/大文件），推到公开仓跑 GitHub Actions。
// 用法：node scripts/mirror-ci.mjs [--dry]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 清掉外部注入的 GIT_CONFIG_*（会让 git 解析失败）
for (const k of Object.keys(process.env)) {
  if (k === 'GIT_CONFIG_COUNT' || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) delete process.env[k];
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MIRROR = 'dianmei0602/winbot-ci';
const EXCLUDE = [/^docs\/.*\.(png|jpg|jpeg|webp|gif|mp4)$/i, /^docs\/.*\.pdf$/i, /^data\//, /^dist\//];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winbot-ci-'));
try {
  // 1) 导出 HEAD 快照
  const tar = path.join(tmp, 'src.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
  run('tar', ['-x', '-f', tar, '-C', tmp]);
  fs.unlinkSync(tar);

  // 2) 去掉不该公开的东西
  let removed = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(tmp, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (EXCLUDE.some((re) => re.test(`${rel}/`))) {
          fs.rmSync(p, { recursive: true, force: true });
          removed += 1;
        } else walk(p);
      } else if (EXCLUDE.some((re) => re.test(rel))) {
        fs.unlinkSync(p);
        removed += 1;
      }
    }
  };
  walk(tmp);
  console.log(`导出快照，排除 ${removed} 个文件/目录`);

  // 3) 建孤儿提交并推
  run('git', ['init', '-q'], tmp);
  run('git', ['add', '-A'], tmp);
  run('git', ['-c', 'user.name=winbot-ci', '-c', 'user.email=ci@winbot.local', 'commit', '-q', '-m', 'sync: CI mirror'], tmp);
  const sha = run('git', ['rev-parse', '--short', 'HEAD'], tmp);
  console.log('镜像提交:', sha);
  if (process.argv.includes('--dry')) {
    console.log('--dry：不推送，目录在', tmp);
    process.exit(0);
  }
  const url = `https://github.com/${MIRROR}.git`;
  run('git', ['-c', 'http.proxy=http://127.0.0.1:12450', 'push', '--force', url, 'HEAD:main'], tmp);
  console.log('已推送 →', url);
} finally {
  if (!process.argv.includes('--dry')) fs.rmSync(tmp, { recursive: true, force: true });
}
