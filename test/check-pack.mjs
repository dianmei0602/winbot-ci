// 打包自检：安装/解包后的 app 里，@deepseek-ai 的包是否和开发目录一致。
// 少一个 peer 包，DSH 就起不来（界面上表现为一直转圈到超时）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'winbot', 'resources', 'app'),
  path.join(root, 'dist', 'win-unpacked', 'resources', 'app'),
].filter((p) => fs.existsSync(p));

const list = (dir) => new Set(fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

const dev = list(path.join(root, 'node_modules', '@deepseek-ai'));
console.log(`开发目录 @deepseek-ai: ${dev.size} 个包`);

let bad = 0;
for (const app of targets) {
  const packed = list(path.join(app, 'node_modules', '@deepseek-ai'));
  const missing = [...dev].filter((n) => !packed.has(n));
  const extra = [...packed].filter((n) => !dev.has(n));
  console.log(`\n${app}`);
  console.log(`  包数 ${packed.size}，缺失 ${missing.length}，多出 ${extra.length}`);
  if (missing.length) {
    bad += 1;
    for (const m of missing) console.log(`    ✗ ${m}`);
  }
  if (extra.length) for (const e of extra.slice(0, 5)) console.log(`    ? ${e}`);
  // 关键 peer 包抽查
  for (const must of ['dsh-sdk-protocol', 'dsh-llm', 'dsh-session']) {
    if (!packed.has(must)) {
      bad += 1;
      console.log(`    ✗ 关键包缺失：${must}`);
    }
  }
}
if (!targets.length) {
  // CI（Linux）没有安装版/解包产物：跳过而不是失败，本地/发版前仍会真跑
  if (process.env.CI) {
    console.log('CI 环境没有打包产物，跳过打包自检');
    process.exit(0);
  }
  console.log('没找到打包产物（先 npm run dist -- --dir）');
  process.exit(1);
}
process.exit(bad ? 1 : 0);
