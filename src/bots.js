// 机器人注册表：一个机器人 = data/bots/<id>/ 一个目录。
//   bot.json        身份、人设、默认模型、权限、渠道白名单
//   persona.md      人设正文（可改，模板只是起点）
//   memory.md       长期记忆（纯文本，进系统提示）
//   workspace/      它的工作区根目录（DSH 的 workspaceRoot）
// 工作区以外写入由 DSH 沙箱拦下并经审批问人，见 dsh.js。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOTS_DIR, ensureDir, isoLocal, newId, readJson, readText, writeJson, writeText, log } from './util.js';
import { loadConfig, defaultProvider } from './config.js';

export const PERMISSIONS = {
  readonly: { label: '只读', sandbox: 'read-only', desc: '能读文件、查资料，不能改任何东西' },
  'workspace-write': {
    label: '工作区',
    sandbox: 'workspace-write',
    desc: '只能写自己的文件夹；要写到工作区以外，会先问你',
  },
  'danger-full-access': {
    label: '完全权限',
    sandbox: 'danger-full-access',
    desc: '不进沙箱；删除整个文件夹前仍会先问',
  },
};

const DEFAULT_PERSONA = (name) => `你是「${name}」，用户自己的 Windows 电脑上的私人助手。

说话用中文，简短、直接、像一个靠谱的同事：先给结论，再给必要的过程。不确定就说不确定，不要编。
你能读写工作区里的文件、执行命令、在用户授权后操作这台电脑；需要用户拍板时直接问，不要替他决定。

工作区的根目录就是该机器人的文件夹。你的产出默认放在这里：文档写 \`notes/\`，脚本放 \`scripts/\`，
临时文件放 \`tmp/\`，下载和素材放 \`assets/\`，最终交付物放 \`outputs/\`。

每次回复结束前，如果这次对话里有值得长期记住的事（用户的偏好、项目约定、重要结论、待办），
用 write 工具更新工作区根目录的 \`MEMORY.md\`：只写短条目，一行一条，已有的不要重复写。
`;

function botDir(id) {
  return path.join(BOTS_DIR, id);
}

export function botPaths(id) {
  const dir = botDir(id);
  return {
    dir,
    config: path.join(dir, 'bot.json'),
    persona: path.join(dir, 'persona.md'),
    memory: path.join(dir, 'memory.md'),
    workspace: path.join(dir, 'workspace'),
  };
}

function normalize(b) {
  return {
    id: b.id,
    name: b.name || '未命名机器人',
    avatar: b.avatar || 'blue',
    summary: b.summary || '',
    // 智能体内核：dsh（默认，工具/沙箱/审批全在 DSH 里）或 codex（codex exec 子进程）
    engine: b.engine === 'codex' ? 'codex' : 'dsh',
    providerId: b.providerId || null,
    model: b.model || null,
    permission: b.permission || 'workspace-write',
    memoryEnabled: b.memoryEnabled !== false,
    // 每天最多花多少 token（0 = 不限），聊天和定时任务都算进去
    dailyBudgetTokens: Math.max(0, Number(b.dailyBudgetTokens) || 0),
    // 电脑操作：off 不加载 / ask 每次问我 / auto 自动执行
    desktopUse: ['off', 'ask', 'auto'].includes(b.desktopUse) ? b.desktopUse : 'off',
    allowedSenders: Array.isArray(b.allowedSenders) ? b.allowedSenders : [],
    createdAt: b.createdAt || Date.now(),
    updatedAt: b.updatedAt || Date.now(),
  };
}

export function listBots() {
  ensureDir(BOTS_DIR);
  const out = [];
  for (const entry of fs.readdirSync(BOTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readJson(botPaths(entry.name).config, null);
    if (meta) out.push(normalize(meta));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function getBot(id) {
  if (!id) return null;
  const meta = readJson(botPaths(id).config, null);
  return meta ? normalize(meta) : null;
}

export function botExists(id) {
  return !!getBot(id);
}

export function personaOf(id) {
  return readText(botPaths(id).persona, '');
}

export function memoryOf(id) {
  return readText(botPaths(id).memory, '');
}

/** 首次创建时的目录骨架：机器人也要能自己整理产出 */
function scaffoldWorkspace(ws) {
  ensureDir(ws);
  for (const sub of ['notes', 'scripts', 'tmp', 'assets', 'outputs']) ensureDir(path.join(ws, sub));
  const agents = path.join(ws, 'AGENTS.md');
  if (!fs.existsSync(agents)) {
    writeText(
      agents,
      `# 工作约定\n\n` +
        `- 产出放 outputs/，笔记放 notes/，脚本放 scripts/，临时文件放 tmp/，素材放 assets/。\n` +
        `- 工作区里已有你的长期记忆（MEMORY.md），需要时读它。\n`,
    );
  }
  const memory = path.join(ws, 'MEMORY.md');
  if (!fs.existsSync(memory)) {
    writeText(memory, `# 长期记忆\n\n<!-- 一行一条，越短越好；机器人自己维护 -->\n`);
  }
}

export function createBot(input = {}) {
  const name = String(input.name || '新机器人').trim().slice(0, 24) || '新机器人';
  // 群聊里 @ 是按名字认人的，重名会认错——新建时直接挡住
  const clash = listBots().find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`已经有同名机器人「${clash.name}」，换一个名字（群聊 @ 是按名字认人的）`);
  let id = input.id ? String(input.id) : newId('bot');
  if (!/^[a-z0-9-]{3,40}$/.test(id)) id = newId('bot');
  while (botExists(id)) id = newId('bot');

  const paths = botPaths(id);
  ensureDir(paths.dir);
  const prov = input.providerId ? null : defaultProvider();
  const meta = normalize({
    id,
    name,
    avatar: input.avatar,
    summary: input.summary || '我自己的助手',
    engine: input.engine,
    providerId: input.providerId || prov?.id || null,
    model: input.model || prov?.models?.[0] || null,
    permission: PERMISSIONS[input.permission] ? input.permission : loadConfig().security.defaultPermission,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  writeJson(paths.config, meta);
  writeText(paths.persona, input.persona || DEFAULT_PERSONA(name));
  if (!fs.existsSync(paths.memory)) writeText(paths.memory, `# ${name} 的长期记忆\n\n`);
  scaffoldWorkspace(paths.workspace);
  log('bots', `created ${id} (${name})`);
  return meta;
}

export function updateBot(id, patch) {
  const cur = getBot(id);
  if (!cur) return null;
  const next = normalize({ ...cur, ...patch, id, updatedAt: Date.now() });
  writeJson(botPaths(id).config, next);
  if (typeof patch.persona === 'string') writeText(botPaths(id).persona, patch.persona);
  if (typeof patch.memory === 'string') writeText(botPaths(id).memory, patch.memory);
  return next;
}

export function deleteBot(id, { keepWorkspace = false } = {}) {
  const paths = botPaths(id);
  if (!fs.existsSync(paths.dir)) return false;
  if (keepWorkspace) {
    const backup = path.join(BOTS_DIR, `${id}-data-${Date.now()}`);
    ensureDir(backup);
    if (fs.existsSync(paths.workspace)) fs.renameSync(paths.workspace, path.join(backup, 'workspace'));
    fs.rmSync(paths.dir, { recursive: true, force: true });
  } else {
    fs.rmSync(paths.dir, { recursive: true, force: true });
  }
  return true;
}

/** 长期记忆：按日期追加（界面可读，模型下次请求可见） */
export function appendMemory(id, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const file = botPaths(id).memory;
  const cur = readText(file, `# ${getBot(id)?.name || id} 的长期记忆\n\n`);
  const entry = `- ${isoLocal()} ${clean.replace(/\s+/g, ' ')}\n`;
  writeText(file, cur.endsWith('\n') ? cur + entry : `${cur}\n${entry}`);
}

export function workspaceOf(id) {
  return botPaths(id).workspace;
}

export function ensureWorkspace(id) {
  const ws = workspaceOf(id);
  scaffoldWorkspace(ws);
  return ws;
}

/** 机器人自述：给模型看的一段身份+权限说明（拼在人设后面） */
export function identityBrief(bot) {
  const perm = PERMISSIONS[bot.permission] || PERMISSIONS['workspace-write'];
  return `【身份】你是 ${bot.name}，一个住在用户 Windows 电脑上的私人助手。
【权限】当前是「${perm.label}」：${perm.desc}。
【风格】中文、简短、可靠；不编造事实，不假装做过没做的事。
【记忆】关于用户的稳定事实（偏好、习惯、背景）用 remember 工具存进共享的「关于我」，所有机器人都能看到；
要删掉过时的就用 forget，想确认记了什么用 recall_about_me。项目细节、临时结论写在工作区根目录的 MEMORY.md。
涉及电话、邮箱、住址这类信息，先问用户是否允许记住；密码、密钥一律不记。`;
}

export function randomAvatar() {
  const list = ['blue', 'green', 'purple', 'orange', 'red', 'yellow'];
  return list[crypto.randomInt(list.length)];
}


