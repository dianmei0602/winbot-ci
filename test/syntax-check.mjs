// 语法自检：把 src / ui / electron / test 里的 JS 全部 node --check 一遍。
// 不需要服务器、不需要网络，适合放进 CI。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['src', 'ui', 'electron', 'test', 'scripts'];
const skipDir = new Set(['node_modules', 'scratch', '.git']);
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDir.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
}

for (const r of roots) walk(r);
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad += 1;
    console.log(`  ✗ ${f}`);
    console.log(String(e.stderr || e.message).split('\n').slice(0, 3).join('\n'));
  }
}
console.log(`  语法检查：${files.length - bad}/${files.length} 通过`);
process.exit(bad ? 1 : 0);
