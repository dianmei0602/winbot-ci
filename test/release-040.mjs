// 建 GitHub Release 并上传安装包，然后验证更新检查。
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const token = (() => {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  return (out.match(/^password=(.+)$/m) || [])[1] || '';
})();
if (!token) throw new Error('没有 GitHub token');

const repo = 'dianmei0602/winbot';
const tag = 'v0.4.0';
const exe = 'dist/winbot-Setup-0.4.0.exe';
const notes = [
  '新界面（Telegram 风格，全中文）：搜索、机器人列表带最后一句与时间、底部「自动化 / 插件与连接 / 设置」、标题栏模型下拉与「＋ 任务」。',
  '',
  '自动更新：设置 → 更新，填仓库与 token 即可查 GitHub Releases、下载并静默安装。',
].join('\n');

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'winbot-release',
      accept: 'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

let release = null;
try {
  release = await api('GET', `/repos/${repo}/releases/tags/${tag}`);
  console.log('release 已存在:', release.id);
} catch {
  release = await api('POST', `/repos/${repo}/releases`, {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: false,
    prerelease: false,
  });
  console.log('release 已创建:', release.id, release.html_url);
}

// 上传安装包
const bytes = fs.readFileSync(exe);
const name = 'winbot-Setup-0.4.0.exe';
const existing = (release.assets || []).find((a) => a.name === name);
if (existing) {
  console.log('资产已存在，跳过上传');
} else {
  const uploadUrl = String(release.upload_url).replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'winbot-release',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
    },
    body: bytes,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传失败 ${res.status} ${text.slice(0, 300)}`);
  const asset = JSON.parse(text);
  console.log('已上传:', asset.name, Math.round(asset.size / 1024 / 1024), 'MB');
}

// 验证更新检查
const { checkForUpdate } = await import('file:///E:/AI_work/winbot/src/update.js');
const r = await checkForUpdate({ repo, token });
console.log('checkForUpdate:', JSON.stringify({ latest: r.latest, current: r.current, newer: r.newer, asset: r.asset?.name }, null, 0));
