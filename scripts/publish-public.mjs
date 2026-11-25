// 把安装包发布到公开镜像仓（winbot-ci），作为「无需 token 的更新渠道」
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const token = (execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' }).match(/^password=(.+)$/m) || [])[1]?.trim();
if (!token) throw new Error('拿不到 GitHub token');
const repo = 'dianmei0602/winbot-ci';
const tag = process.argv[2] || 'v0.6.1';
const exe = process.argv[3] || 'dist/winbot-Setup-0.6.1.exe';
const name = path.basename(exe);
const notes = process.argv[4] || 'winbot 更新渠道（公开资产，无需 token）';
const h = { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', accept: 'application/vnd.github+json' };

let rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: h })).json();
if (!rel?.id) {
  rel = await (await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease: false }),
  })).json();
  if (!rel?.id) throw new Error('创建 release 失败: ' + JSON.stringify(rel).slice(0, 200));
}
console.log('release:', rel.id, rel.tag_name);

const buf = fs.readFileSync(exe);
if ((rel.assets || []).some((a) => a.name === name)) {
  console.log('资产已存在，跳过');
} else {
  const base = String(rel.upload_url).replace(/\{[^}]*\}/, '');
  const r = await fetch(`${base}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', 'content-type': 'application/octet-stream', 'content-length': String(buf.length) },
    body: buf,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`上传失败 ${r.status} ${t.slice(0, 200)}`);
  const a = JSON.parse(t);
  console.log('已上传:', a.name, Math.round(a.size / 1048576), 'MB');
}
// electron-updater 的 GitHub provider 需要 latest.yml
const yml = path.join(path.dirname(exe), 'latest.yml');
if (fs.existsSync(yml)) {
  const ybuf = fs.readFileSync(yml);
  const hasYml = (rel.assets || []).some((a) => a.name === 'latest.yml');
  if (!hasYml) {
    const ybase = String(rel.upload_url).replace(/\{[^}]*\}/, '');
    const yr = await fetch(`${ybase}?name=latest.yml`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'winbot-release', 'content-type': 'application/octet-stream', 'content-length': String(ybuf.length) },
      body: ybuf,
    });
    if (!yr.ok) console.log('latest.yml 上传失败:', yr.status, (await yr.text()).slice(0, 120));
    else console.log('已上传 latest.yml');
  }
} else {
  console.log('⚠ dist/latest.yml 不存在（electron-builder 没生成），electron-updater 会失败');
}
const latest = await (await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: h })).json();
console.log('public latest:', latest.tag_name, '| assets:', (latest.assets || []).map((a) => a.name).join(','));
console.log('download url:', (latest.assets || [])[0]?.browser_download_url);

