// 小工具：路径、JSON 读写、ID、时间、日志。全部零依赖。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const APP_ROOT = path.resolve(import.meta.dirname, '..');

/** 数据目录：默认 <app>/data，可用 WINBOT_DATA 覆盖（测试用临时目录）。 */
export const DATA_DIR = path.resolve(process.env.WINBOT_DATA || path.join(APP_ROOT, 'data'));
export const BOTS_DIR = path.join(DATA_DIR, 'bots');
export const CHANNELS_DIR = path.join(DATA_DIR, 'channels');
export const DSH_DIR = path.join(DATA_DIR, 'dsh');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const DB_FILE = path.join(DATA_DIR, 'winbot.db');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, BOTS_DIR, CHANNELS_DIR, DSH_DIR]) ensureDir(d);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再改名，避免半截文件。 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export const newId = (prefix) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

export const now = () => Date.now();

export function isoLocal(ms = now()) {
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[process.env.WINBOT_LOG || 'info'] ?? 20;

export function log(scope, ...args) {
  if (LEVELS.info < level) return;
  console.log(`${isoLocal()} [${scope}]`, ...args);
}
export function logWarn(scope, ...args) {
  if (LEVELS.warn < level) return;
  console.warn(`${isoLocal()} [${scope}]`, ...args);
}
export function logError(scope, ...args) {
  console.error(`${isoLocal()} [${scope}]`, ...args);
}
export function logDebug(scope, ...args) {
  if (LEVELS.debug < level) return;
  console.log(`${isoLocal()} [${scope}]`, ...args);
}

/** 只允许 http/https 的抓取，避免协议走私 */
export function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function slugify(s, fallback = 'item') {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || fallback;
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** 文件名只留安全字符：防止路径穿越、非法字符、超长 */
export function safeFileName(name, fallback = 'file') {
  const base = path
    .basename(String(name || fallback))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/** 拷贝目录（不跟随符号链接），用于工作区模板 */
export function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** 安全解析 JSON，失败给 null（工具参数、模型输出常不合法） */
export function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function bytesHuman(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}
