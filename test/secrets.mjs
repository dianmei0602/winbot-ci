// O23 回归：密钥不落明文 config.json；旧明文自动迁移；能解回内存。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.join(os.tmpdir(), `winbot-secrets-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [{ id: 'deepseek', apiKey: 'sk-plain-1', models: ['deepseek-chat'] }], update: { repo: 'a/b', token: 'tok-plain-1' } }), 'utf8');

const script = `
const fs = await import('node:fs');
const mod = await import('file:///${process.cwd().replace(/\\/g, '/')}/src/config.js');
const c = mod.loadConfig();
const disk = JSON.parse(fs.readFileSync('${dir.replace(/\\/g, '/')}/config.json', 'utf8'));
console.log(JSON.stringify({
  apiKeyDisk: disk.providers?.[0]?.apiKey ?? null,
  apiKeySet: disk.providers?.[0]?.apiKeySet ?? null,
  tokenDisk: disk.update?.token ?? null,
  hasToken: disk.update?.hasToken ?? null,
  secretFile: fs.existsSync('${dir.replace(/\\/g, '/')}/secrets.bin'),
  memKey: c.providers?.[0]?.apiKey ?? null,
  memToken: c.update?.token ?? null,
}));
`;
const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
  cwd: process.cwd(),
  env: { ...process.env, WINBOT_DATA: dir.replace(/\\/g, '/') },
  encoding: 'utf8',
});
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};
try {
  const out = JSON.parse((r.stdout || '').trim().split('\n').pop());
  check('config.json 里没有明文 apiKey', out.apiKeyDisk === '', JSON.stringify(out.apiKeyDisk));
  check('config.json 里没有明文 token', out.tokenDisk === '', JSON.stringify(out.tokenDisk));
  check('留了 apiKeySet 标记', out.apiKeySet === true);
  check('留了 hasToken 标记', out.hasToken === true);
  check('生成了 secrets.bin', out.secretFile === true);
  check('内存里能解回 apiKey', out.memKey === 'sk-plain-1', String(out.memKey));
  check('内存里能解回 token', out.memToken === 'tok-plain-1', String(out.memToken));
} catch (e) {
  bad += 1;
  console.log('  ✗ 子进程没输出结果：', (r.stderr || r.stdout || '').slice(0, 300));
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
