// 「关于我」：跨所有机器人共享的长期事实（偏好、习惯、背景）。
// 存在 data/about-me.json，不放进任何机器人的工作区——这样换机器人也记得你。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir, newId, now, readJson, writeJson, truncate } from './util.js';

export const ABOUT_FILE = path.join(DATA_DIR, 'about-me.json');
export const ABOUT_MAX_CHARS = 4000;
export const ABOUT_MAX_PER_CALL = 3;

const DEFAULT = { version: 1, updatedAt: 0, lines: [] };

/** 联系方式/住址这类，先问用户再记（照参考项目的规矩） */
const SENSITIVE_RULES = [
  { name: 'phone', re: /(?:\+?\d[\s-]?){7,}/ },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: 'address', re: /(路|街|道|巷|小区|号楼|栋|单元|室|address|street|road|avenue|suite|apt\.?)/i },
  { name: 'id', re: /\b\d{15,18}[\dXx]\b/ },
];

/** 看起来像密码/密钥的，任何情况下都不记 */
const SECRET_RULES = [
  /(password|passwd|pwd|密码|密钥|私钥|api[\s_-]?key|secret|token|凭据|credential)/i,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abps]-[A-Za-z0-9-]{10,}/,
];

export function detectSensitive(text) {
  const t = String(text || '');
  const hits = SENSITIVE_RULES.filter((r) => r.re.test(t)).map((r) => r.name);
  return hits;
}

export function looksSecret(text) {
  const t = String(text || '');
  return SECRET_RULES.some((re) => re.test(t));
}

export function loadAbout() {
  const raw = readJson(ABOUT_FILE, null);
  const data = raw && Array.isArray(raw.lines) ? raw : structuredClone(DEFAULT);
  data.version = 1;
  data.updatedAt = data.updatedAt || 0;
  return data;
}

function saveAbout(data) {
  ensureDir(DATA_DIR);
  data.updatedAt = now();
  writeJson(ABOUT_FILE, data);
  return data;
}

export function listAbout() {
  return loadAbout().lines;
}

export function aboutText() {
  return loadAbout()
    .lines.map((l) => l.text)
    .join('\n');
}

export function aboutChars() {
  return aboutText().length;
}

/**
 * 加一条。返回 { ok, reason?, id?, needsConfirm? }。
 * needsConfirm：含联系方式/住址，模型第一次调时会被要求先问用户（confirmSensitive=true 才落盘）。
 */
export function addAbout({ text, source = 'chat', confirmSensitive = false }) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return { ok: false, reason: '内容为空' };
  if (clean.length > 400) return { ok: false, reason: '一条最多 400 字，太长的请拆成几条' };
  if (looksSecret(clean)) return { ok: false, reason: '这看起来是密码/密钥，我不会记住这类内容' };

  const sensitive = detectSensitive(clean);
  if (sensitive.length && !confirmSensitive) {
    return {
      ok: false,
      needsConfirm: true,
      sensitive,
      reason: `这条包含${sensitive.map(sensitiveName).join('、')}。先问用户是否允许记住，用户同意后再调用并带上 confirm_sensitive=true。`,
    };
  }

  const data = loadAbout();
  if (data.lines.some((l) => l.text === clean)) {
    return { ok: true, id: data.lines.find((l) => l.text === clean).id, duplicate: true };
  }
  if (aboutChars() + clean.length > ABOUT_MAX_CHARS) {
    return { ok: false, reason: `关于我已经到 ${ABOUT_MAX_CHARS} 字上限，请先删掉过时的条目` };
  }
  const line = {
    id: newId('about'),
    text: clean,
    source,
    sensitive: sensitive.length > 0,
    createdAt: now(),
  };
  data.lines.push(line);
  saveAbout(data);
  return { ok: true, id: line.id, sensitive: line.sensitive };
}

/** 按 id 或包含的文字删除；返回删掉几条 */
export function removeAbout({ id, query }) {
  const data = loadAbout();
  const before = data.lines.length;
  if (id) data.lines = data.lines.filter((l) => l.id !== id);
  else {
    const q = String(query || '').trim();
    if (!q) return 0;
    data.lines = data.lines.filter((l) => !l.text.includes(q));
  }
  if (data.lines.length !== before) saveAbout(data);
  return before - data.lines.length;
}

/** 给系统提示用的一段（超长截断，别把上下文吃光） */
export function aboutForPrompt(maxChars = 2000) {
  const text = aboutText();
  if (!text) return '';
  return truncate(text, maxChars);
}

/**
 * 「关于我」的修改时间。机器人的系统提示是进程启动时生成的，
 * 这里给宿主一个判断依据：文件变了就把进程重启，否则新记的事它看不到。
 */
export function aboutMtime() {
  try {
    return fs.statSync(ABOUT_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function sensitiveName(kind) {
  return { phone: '电话号码', email: '邮箱', address: '住址', id: '证件号' }[kind] || kind;
}
