// 技能：每个机器人一个目录 data/bots/<id>/skills/<slug>/SKILL.md，
// 通过补丁里的 skill-filesystem.customSkillDirs 接进 DSH。
// 支持：列、粘贴 SKILL.md 新建、导入 ZIP、删除。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir, readText, safeFileName, slugify, writeText } from './util.js';
import { botPaths, ensureWorkspace } from './bots.js';

export function skillsDir(botId) {
  return path.join(botPaths(botId).dir, 'skills');
}

/** 解析 SKILL.md 的 YAML 头（只用得上 name / description） */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: null, description: null, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { name: meta.name || null, description: meta.description || null, body: m[2], meta };
}

/**
 * 极简 ZIP 解压：只支持 store / deflate，够装常见的技能包。
 * 不处理 zip64 和加密；遇到就跳过该文件。
 */
export function readZip(buf) {
  const files = [];
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    // Windows 的 Compress-Archive 会用反斜杠，统一成正斜杠再判断
    const name = rawName.replace(/\\/g, '/');
    if (!name || name.endsWith('/')) continue;
    if (name.includes('..') || path.posix.isAbsolute(name)) continue; // 防穿越
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    try {
      data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    } catch {
      data = null;
    }
    if (data) files.push({ name, data });
  }
  return files;
}

/** 列出一个机器人的技能 */
export function listSkills(botId) {
  const dir = skillsDir(botId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = readText(file, '');
    const fm = parseFrontmatter(text);
    out.push({
      slug: entry.name,
      name: fm.name || entry.name,
      description: fm.description || '',
      whenToUse: fm.meta?.whenToUse || '',
      bytes: text.length,
      updatedAt: fs.statSync(file).mtimeMs,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 用文本装一个技能（SKILL.md 全文）；返回 slug */
export function installSkillText(botId, { slug, text }) {
  const content = String(text || '').trim();
  if (!content) throw new Error('内容是空的');
  if (content.length > 200_000) throw new Error('SKILL.md 太大了（上限 200KB）');
  const fm = parseFrontmatter(content);
  if (!fm.name) throw new Error('SKILL.md 开头要有 YAML 头，至少包含 name 和 description');
  const dir = skillsDir(botId);
  ensureDir(dir);
  let id = slugify(slug || fm.name, 'skill');
  // 同名就覆盖，别生成 skill-2 这种猜不到的东西
  const target = path.join(dir, id);
  ensureDir(target);
  writeText(path.join(target, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`);
  return id;
}

/**
 * 从 ZIP 装：找到包里的 SKILL.md（允许外面套一层目录），
 * 把整个目录解到 skills/<slug>/ 下，脚本和资源一起带过去。
 */
export function installSkillZip(botId, buffer) {
  if (!buffer?.length) throw new Error('空文件');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('ZIP 不能超过 20MB');
  const files = readZip(buffer);
  if (!files.length) throw new Error('ZIP 里没有文件');
  // 找最浅的 SKILL.md
  const skillFiles = files
    .filter((f) => /(^|\/)SKILL\.md$/i.test(f.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (!skillFiles.length) throw new Error('ZIP 里没有 SKILL.md');
  const root = skillFiles[0].name.replace(/SKILL\.md$/i, ''); // 可能为空
  const fm = parseFrontmatter(skillFiles[0].data.toString('utf8'));
  if (!fm.name) throw new Error('SKILL.md 缺少 name');
  const slug = slugify(fm.name, 'skill');
  const target = path.join(skillsDir(botId), slug);
  ensureDir(target);
  let written = 0;
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rel = f.name.slice(root.length);
    if (!rel || rel.endsWith('/')) continue;
    const dest = path.join(target, rel);
    const resolved = path.resolve(dest);
    if (!resolved.startsWith(path.resolve(target) + path.sep)) continue; // 防穿越
    ensureDir(path.dirname(resolved));
    fs.writeFileSync(resolved, f.data);
    written += 1;
  }
  if (!written) throw new Error('ZIP 解出来是空的');
  return { slug, files: written };
}

export function removeSkill(botId, slug) {
  const dir = path.join(skillsDir(botId), safeFileName(slug, 'skill'));
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function readSkill(botId, slug) {
  const file = path.join(skillsDir(botId), safeFileName(slug, 'skill'), 'SKILL.md');
  return fs.existsSync(file) ? readText(file, '') : null;
}

/** 技能可以带脚本；跑之前把工作区也准备好，免得技能里写相对路径没地方放 */
export function ensureSkillWorkspace(botId) {
  ensureWorkspace(botId);
  ensureDir(skillsDir(botId));
}
