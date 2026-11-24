import { execSync } from 'node:child_process';
import fs from 'node:fs';
const token = (execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' }).match(/^password=(.+)$/m) || [])[1] || '';
const repo = 'dianmei0602/winbot';
const tag = 'v0.5.5';
const file = 'dist/winbot-Setup-0.5.5.exe';
const name = 'winbot-Setup-0.5.5.exe';
const body = fs.readFileSync('CHANGELOG.md', 'utf8').split('## 0.5.5')[1].split('## 0.5.4')[0].trim();
const h = { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', accept: 'application/vnd.github+json' };
let rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: h })).json();
if (!rel?.id) {
  rel = await (await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }),
  })).json();
}
console.log('release:', rel.id);
const buf = fs.readFileSync(file);
if (!(rel.assets || []).some((a) => a.name === name)) {
  const base = String(rel.upload_url).replace(/\{[^}]*\}/, '');
  const r = await fetch(`${base}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', 'content-type': 'application/octet-stream', 'content-length': String(buf.length) },
    body: buf,
  });
  const a = await r.json();
  console.log('uploaded:', a.name, Math.round(a.size / 1048576), 'MB');
} else console.log('asset exists');
