// 自动更新：查 GitHub Releases、比对版本、下载安装包、静默安装。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_ROOT, DATA_DIR, log } from './util.js';
import { loadConfig, saveConfig } from './config.js';

const API = 'https://api.github.com';
const UA = 'winbot-updater';

export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 简单的版本比较：只看数字段 */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let proxyAgent = null;
async function dispatcherFor(proxy) {
  const p = String(proxy || '').trim();
  if (!p) return undefined;
  if (!proxyAgent) {
    const { ProxyAgent } = await import('undici');
    proxyAgent = new ProxyAgent(p);
    log('update', `使用代理 ${p}`);
  }
  return proxyAgent;
}

function updateCfg() {
  const cfg = loadConfig();
  const repo = String(cfg.update?.repo || 'dianmei0602/winbot').trim();
  const token = String(cfg.update?.token || process.env.WINBOT_UPDATE_TOKEN || '').trim();
  const proxy = String(cfg.update?.proxy || process.env.WINBOT_UPDATE_PROXY || '').trim();
  return { repo, token, proxy };
}

/** 查最新 release；私有仓需要 token */
export async function checkForUpdate({ repo, token } = {}) {
  const cfg = updateCfg();
  const r = repo || cfg.repo;
  const t = token || cfg.token;
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('仓库要写成 owner/name');
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  if (t) headers.authorization = `Bearer ${t}`;
  const dispatcher = await dispatcherFor(cfg.proxy);
  const res = await fetch(`${API}/repos/${r}/releases/latest`, { headers, signal: AbortSignal.timeout(20_000), ...(dispatcher ? { dispatcher } : {}) });
  if (res.status === 404) {
    return { ok: true, found: false, needsToken: !t, current: currentVersion(), repo: r, message: t ? '仓库没有 release' : '仓库是私有的或者没有 release（填一个 token 试试）' };
  }
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const data = await res.json();
  const latest = String(data.tag_name || data.name || '').replace(/^v/i, '');
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const exe = assets.find((a) => /Setup.*\.exe$/i.test(a.name) || /\.exe$/i.test(a.name)) || null;
  const current = currentVersion();
  const newer = latest ? compareVersions(latest, current) > 0 : false;
  log('update', `latest=${latest} current=${current} newer=${newer} asset=${exe?.name || '-'}`);
  return {
    ok: true,
    found: true,
    repo: r,
    current,
    latest,
    newer,
    publishedAt: data.published_at || null,
    notes: String(data.body || '').slice(0, 1200),
    asset: exe ? { name: exe.name, size: exe.size, url: exe.browser_download_url, id: exe.id } : null,
    page: data.html_url || null,
  };
}

function updateDir() {
  const dir = path.join(DATA_DIR, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 下载安装包到 data/updates，返回本地路径 */
export async function downloadUpdate({ url, name, token } = {}) {
  const cfg = updateCfg();
  if (!url) throw new Error('没有下载地址');
  const file = path.join(updateDir(), String(name || url.split('/').pop() || 'winbot-Setup.exe').replace(/[^\w.-]/g, '_'));
  const headers = { 'user-agent': UA, accept: 'application/octet-stream' };
  if (token || cfg.token) headers.authorization = `Bearer ${token || cfg.token}`;
  const dispatcher = await dispatcherFor(token ? cfg.proxy : cfg.proxy);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30 * 60_000), ...(dispatcher ? { dispatcher } : {}) });
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  const size = fs.statSync(file).size;
  log('update', `downloaded ${file} (${Math.round(size / 1024 / 1024)} MB${total ? ` / ${Math.round(total / 1024 / 1024)}` : ''})`);
  return { ok: true, path: file, size, total };
}

/** 启动安装包（NSIS /S 静默装，装完自己会退出） */
const PENDING_FILE = () => path.join(DATA_DIR, 'update-pending.json');

/**
 * 排队安装：桌面壳（Electron）轮询这个文件，先退出自己，再跑安装包。
 * 直接 spawn 安装器时 winbot 还开着，NSIS 静默装覆盖不了正在运行的文件。
 */
export function installUpdate({ file, silent = true } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('安装包不在');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE(), JSON.stringify({ file, silent: !!silent, at: Date.now() }), 'utf8');
  log('update', `queued install: ${file}`);
  return { ok: true, queued: true, installsOnQuit: true, file };
}

/** Electron 侧读取待安装任务（读完即删） */
export function takePendingInstall() {
  try {
    const p = PENDING_FILE();
    if (!fs.existsSync(p)) return null;
    const job = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.unlinkSync(p);
    if (!job?.file || !fs.existsSync(job.file)) return null;
    return job;
  } catch {
    return null;
  }
}

/** 保存更新设置（仓库 / token） */
export function saveUpdateConfig({ repo, token, proxy } = {}) {
  const cfg = loadConfig();
  cfg.update = {
    ...(cfg.update || {}),
    ...(repo !== undefined ? { repo: String(repo).trim() } : {}),
    ...(token !== undefined ? { token: String(token).trim() } : {}),
    ...(proxy !== undefined ? { proxy: String(proxy).trim() } : {}),
  };
  saveConfig(cfg);
  return { ok: true, repo: cfg.update.repo, hasToken: !!cfg.update.token, hasProxy: !!cfg.update.proxy };
}

export function updateSettings() {
  const { repo, token, proxy } = updateCfg();
  return { repo, hasToken: !!token, hasProxy: !!proxy, proxy, current: currentVersion() };
}
