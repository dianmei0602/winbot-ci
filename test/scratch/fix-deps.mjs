// 把 electron-builder 漏掉的 @deepseek-ai 子包补进 package.json 的 dependencies。
import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/AI_work/winbot';
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const installedDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'winbot', 'resources', 'app', 'node_modules', '@deepseek-ai');
const installed = new Set(fs.existsSync(installedDir) ? fs.readdirSync(installedDir) : []);
const project = fs
  .readdirSync(path.join(root, 'node_modules', '@deepseek-ai'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const missing = project.filter((n) => !installed.has(n));
const added = {};
for (const name of missing) {
  const p = path.join(root, 'node_modules', '@deepseek-ai', name, 'package.json');
  if (!fs.existsSync(p)) continue;
  const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
  added[`@deepseek-ai/${name}`] = v;
}

pkg.dependencies = { ...pkg.dependencies, ...added };
const sorted = {};
for (const k of Object.keys(pkg.dependencies).sort()) sorted[k] = pkg.dependencies[k];
pkg.dependencies = sorted;

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('补了', Object.keys(added).length, '个依赖：');
for (const [k, v] of Object.entries(added)) console.log('  ', k, v);
