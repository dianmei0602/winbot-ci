// 本地控制台：HTTP API + SSE + 静态页面。只监听 127.0.0.1，带访问令牌。
// 约定：每个路由 handler 都是 async (req, ctx) => 任意可 JSON 化的值；
// ctx = { params, url, res }。返回 undefined 表示已经自己写完响应。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, DATA_DIR, readText, writeText, log, logWarn, truncate, safeFileName } from './util.js';
import {
  loadConfig,
  saveConfig,
  publicConfig,
  PROVIDER_PRESETS,
  addProvider,
  updateProvider,
  removeProvider,
  modelChoices,
  providerById,
} from './config.js';
import {
  PERMISSIONS,
  createBot,
  deleteBot,
  getBot,
  listBots,
  memoryOf,
  personaOf,
  updateBot,
  workspaceOf,
  appendMemory,
} from './bots.js';
import { resolveCodexBin } from './codex.js';
import {
  answerApproval,
  createApproval,
  createConversation,
  deleteConversation,
  getApproval,
  getConversation,
  listConversations,
  listMessages,
  listToolCalls,
  addMessage,
  pendingApprovals,
  searchMessages,
  touchConversation,
  updateMessageMeta,
  addUsage,
  conversationUsage,
  botUsageToday,
  lastMessageOf,
} from './db.js';
import { allStatus, botStatus, currentConversationId, emitBotEvent, onBotEvent, restartBot, sendToBot, stopBot, resolveBotApproval, abortTurn } from './dsh.js';
import { buildSchedule, computeNextRun, describeSchedule, pauseLabel, resumeSchedule, runSchedule } from './schedules.js';
import { deleteSchedule, getGroup, getSchedule, groupConversation, insertSchedule, listSchedules, updateGroup, updateSchedule } from './db.js';
import { ABOUT_MAX_CHARS, aboutChars, addAbout, listAbout, removeAbout } from './about.js';
import { installSkillText, installSkillZip, listSkills, readSkill, removeSkill, skillsDir } from './skills.js';
import { buildMcp, validateMcp } from './mcp.js';
import { comfyStatus } from './comfy.js';
import { importTeam } from './team.js';
import { checkForUpdate, downloadUpdate, installUpdate, saveUpdateConfig, currentVersion, updateSettings } from './update.js';
import QRCode from 'qrcode';
import { netInfo } from './net.js';
import { CONNECTOR_PRESETS, findPreset } from './connectors.js';
import { addGenerated, takeGenerated } from './media.js';
import { createGroup, ensureGroupConversation, groupView, handoff, listGroupViews, removeGroup, sendToGroup } from './groups.js';
import { channelStatus, restartChannels, startOne } from './channels/index.js';

const TOKEN_FILE = path.join(DATA_DIR, 'ui-token');
const UI_DIR = path.join(APP_ROOT, 'ui');
const STARTED_AT = Date.now();

let token = '';

export function uiToken() {
  if (token) return token;
  const fromEnv = process.env.WINBOT_TOKEN;
  if (fromEnv) {
    token = fromEnv;
  } else {
    const existing = readText(TOKEN_FILE, '').trim();
    if (existing && existing.length >= 24) token = existing;
    else {
      token = crypto.randomBytes(24).toString('hex');
      writeText(TOKEN_FILE, token);
    }
  }
  return token;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, value, { 'content-type': 'application/json; charset=utf-8' });
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  // 去掉 UTF-8 BOM / 前后空白：有的客户端（PowerShell 5.1 的脚本文件）会带上
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`请求体不是合法 JSON（开头：${raw.slice(0, 40)}）`);
  }
}

function authOk(req, url) {
  const expected = uiToken();
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7) === expected) return true;
  const q = url.searchParams.get('token');
  if (q && q === expected) return true;
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)winbot=([^;]+)/);
  if (m && m[1] === expected) return true;
  return false;
}

// ---------- 路由表 ----------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, re, keys, handler });
}

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return { handler: r.handler, params };
  }
  return null;
}

const fail = (msg, status = 400) => ({ __error: msg, __status: status });

/** 用量变了就推给界面（SSE），右上角和小计可以实时更新 */
function emitUsage(botId, conversationId) {
  emitBotEvent(botId, { type: 'usage', conversationId, usage: conversationUsage(conversationId) });
}

/** 可选的智能体内核。Codex 没装时给前端一个可读的原因，而不是等发消息才报错 */
function engineChoices() {
  const codexBin = resolveCodexBin();
  return [
    {
      id: 'dsh',
      label: 'DSH（默认）',
      desc: '工具、沙箱、审批都在 DSH 里；写到工作区外会停下来问你',
      available: true,
    },
    {
      id: 'codex',
      label: 'Codex',
      desc: '用 codex exec 跑；三档权限同名对应 Codex 沙箱，越界操作由沙箱直接拒绝，不弹审批卡',
      available: !!codexBin,
      path: codexBin || '',
      hint: codexBin
        ? '模型接口需要 Responses 协议（DeepSeek 官方 /v1/responses 可用）'
        : '没检测到 Codex：请安装 Codex CLI/桌面版，或设置 WINBOT_CODEX_BIN',
    },
  ];
}

/** 改了会影响补丁的配置（连接器/技能）后，把所有在跑的机器人重启，下条消息生效 */
async function restartAllBots() {
  await Promise.all(listBots().map((b) => restartBot(b.id)));
}

// ---- 机器人 ----

route('GET', '/api/bots', async () => {
  const status = allStatus();
  return listBots().map((b) => ({
    ...b,
    status: status[b.id] || { state: 'stopped', busy: false },
    workspace: workspaceOf(b.id),
    last: lastMessageOf(b.id),
  }));
});

route('POST', '/api/bots', async (req) => {
  const body = await readBody(req);
  try {
    const bot = createBot(body);
    return { bot };
  } catch (e) {
    // 重名直接 409，别当服务器错误
    return fail(e?.message || String(e), 409);
  }
});

route('GET', '/api/bots/:id', async (req, { params }) => {
  const bot = getBot(params.id);
  if (!bot) return fail('没有这个机器人', 404);
  return {
    bot,
    persona: personaOf(params.id),
    memory: memoryOf(params.id),
    workspace: workspaceOf(params.id),
    status: botStatus(params.id),
    usageToday: botUsageToday(params.id),
    permissions: PERMISSIONS,
  };
});

route('PATCH', '/api/bots/:id', async (req, { params }) => {
  const body = await readBody(req);
  const cur = getBot(params.id);
  if (!cur) return fail('没有这个机器人', 404);
  const before = { engine: cur.engine, providerId: cur.providerId, model: cur.model, permission: cur.permission, desktopUse: cur.desktopUse };
  const bot = updateBot(params.id, body);
  if (
    before.engine !== bot.engine ||
    before.providerId !== bot.providerId ||
    before.model !== bot.model ||
    before.permission !== bot.permission ||
    before.desktopUse !== bot.desktopUse ||
    typeof body.persona === 'string' ||
    typeof body.memory === 'string'
  ) {
    await restartBot(params.id);
  }
  return { bot };
});

route('DELETE', '/api/bots/:id', async (req, { params, url }) => {
  const keep = url.searchParams.get('keep') === '1';
  await stopBot(params.id);
  return { ok: deleteBot(params.id, { keepWorkspace: keep }) };
});

route('POST', '/api/bots/:id/memory', async (req, { params }) => {
  const body = await readBody(req);
  appendMemory(params.id, body.text || '');
  return { memory: memoryOf(params.id) };
});

route('POST', '/api/bots/:id/upload', async (req, { params }) => {
  const bot = getBot(params.id);
  if (!bot) return fail('没有这个机器人', 404);
  const body = await readBody(req, 40 * 1024 * 1024);
  const raw = String(body.data || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) return fail('没有文件内容');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) return fail('文件是空的');
  if (buf.length > 30 * 1024 * 1024) return fail('单个文件不能超过 30 MB');
  const ws = workspaceOf(bot.id);
  const dir = path.join(ws, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeFileName(body.name || 'upload.bin');
  const rel = path.join('assets', `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}`).replace(/\\/g, '/');
  fs.writeFileSync(path.join(ws, rel), buf);
  const ext = path.extname(safe).toLowerCase();
  const kind = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? 'image' : 'file';
  return { path: rel, name: safe, size: buf.length, kind };
});

route('GET', '/api/bots/:id/file', async (req, { params, url, res }) => {
  const bot = getBot(params.id);
  if (!bot) return fail('没有这个机器人', 404);
  const rel = url.searchParams.get('path') || '';
  const ws = workspaceOf(bot.id);
  const root = fs.realpathSync(ws);
  let real;
  try {
    real = fs.realpathSync(path.resolve(ws, rel));
  } catch {
    return fail('文件不存在', 404);
  }
  if (real !== root && !real.startsWith(root + path.sep)) return fail('只能读工作区里的文件', 403);
  // 目录 / 特殊文件不能当文件流出去，否则流会报错、连接一直挂着
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return fail('文件不存在', 404);
  }
  if (!stat.isFile()) return fail('只能读文件，不能读目录', 400);
  res.writeHead(200, {
    'content-type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const stream = fs.createReadStream(real);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.pipe(res);
  return undefined;
});

route('POST', '/api/bots/:id/stop', async (req, { params }) => {
  const ok = await stopBot(params.id);
  return { ok };
});

// ---- 群聊 ----

route('GET', '/api/groups', async () => listGroupViews());

route('POST', '/api/groups', async (req) => {
  const body = await readBody(req);
  try {
    const r = createGroup({ name: body.name, botIds: body.botIds, router: body.router });
    return { group: groupView(r.group), conversation: r.conversation };
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

route('GET', '/api/groups/:id', async (req, { params }) => {
  const g = getGroup(params.id);
  if (!g) return fail('没有这个群', 404);
  ensureGroupConversation(params.id);
  const view = groupView(g);
  const conv = view.conversationId ? getConversation(view.conversationId) : null;
  return { group: view, conversation: conv, messages: conv ? listMessages(conv.id) : [], usage: conv ? conversationUsage(conv.id) : null };
});

route('PATCH', '/api/groups/:id', async (req, { params }) => {
  const body = await readBody(req);
  const g = updateGroup(params.id, {
    ...(body.name ? { name: String(body.name) } : {}),
    ...(Array.isArray(body.botIds) ? { botIds: body.botIds.filter((id) => getBot(id)) } : {}),
  });
  if (!g) return fail('没有这个群', 404);
  return { group: groupView(g) };
});

route('DELETE', '/api/groups/:id', async (req, { params }) => {
  const convId = removeGroup(params.id);
  if (convId) deleteConversation(convId);
  return { ok: true };
});

route('GET', '/api/groups/:id/events', async (req, { params, res }) => {
  const g = getGroup(params.id);
  if (!g) return fail('没有这个群', 404);
  ensureGroupConversation(params.id);
  const view = groupView(g);
  if (!view.conversationId) return fail('这个群还没有会话', 404);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  write({ type: 'hello', conversationId: view.conversationId, groupId: params.id });
  // 群里每个机器人都可能回答，订阅所有成员的事件，只转发这个群的会话
  const offs = view.members.map((m) =>
    onBotEvent(m.id, (ev) => {
      if (ev.conversationId && ev.conversationId !== view.conversationId) return;
      write(ev);
    }),
  );
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15_000);
  ping.unref?.();
  await new Promise((resolve) => {
    const done = () => {
      clearInterval(ping);
      for (const off of offs) off();
      resolve();
    };
    req.on('close', done);
    req.on('error', done);
  });
  return undefined;
});

route('POST', '/api/groups/:id/stop', async (req, { params }) => {
  const g = getGroup(params.id);
  if (!g) return fail('没有这个群', 404);
  const conv = groupConversation(params.id);
  if (!conv) return { ok: false };
  const ok = await abortTurn(conv.botId);
  if (ok) addMessage({ conversationId: conv.id, role: 'note', content: '已停止（你按的停止）。', meta: { stopped: true } });
  return { ok, stopped: ok };
});

route('POST', '/api/groups/:id/send', async (req, { params, res }) => {
  const g = getGroup(params.id);
  if (!g) return fail('没有这个群', 404);
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  if (!text) return fail('消息是空的');
  sendJson(res, 200, { ok: true });
  (async () => {
    try {
      await sendToGroup({ groupId: params.id, text });
    } catch (e) {
      const conv = groupConversation(params.id);
      if (conv) addMessage({ conversationId: conv.id, role: 'error', content: `出错了：${e?.message || e}`, meta: { channel: 'group' } });
    }
  })();
  return undefined;
});

route('POST', '/api/handoff', async (req) => {
  const body = await readBody(req);
  try {
    const r = await handoff({ fromBotId: body.fromBotId, toBot: body.toBot, task: body.task });
    return r;
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

// ---- 手机 / 远程访问 ----

route('GET', '/api/net', async () => ({
  ...netInfo(),
}));

route('POST', '/api/net', async (req) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  cfg.server = { ...(cfg.server || {}), host: body.lan ? '0.0.0.0' : '127.0.0.1' };
  saveConfig(cfg);
  return { ok: true, lan: !!body.lan, restartRequired: true };
});

// 二维码（手机扫码打开控制台）；用 qrcode 生成 SVG，不引前端依赖
route('GET', '/api/qr', async (req, { url }) => {
  const text = String(url.searchParams.get('text') || '');
  if (!text) return fail('缺 text');
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    return { ok: true, svg };
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

// ---- 自动更新 ----

route('GET', '/api/update/check', async (req, { url }) => {
  try {
    const r = await checkForUpdate({ repo: url.searchParams.get('repo') || undefined });
    return { ...r, settings: updateSettings() };
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

route('POST', '/api/update/settings', async (req) => {
  const body = await readBody(req);
  return saveUpdateConfig({ repo: body.repo, token: body.token === '' ? '' : body.token, proxy: body.proxy === '' ? '' : body.proxy });
});

route('POST', '/api/update/download', async (req) => {
  const body = await readBody(req);
  try {
    return await downloadUpdate({ url: body.url, name: body.name, assetId: body.assetId });
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

route('POST', '/api/update/install', async (req) => {
  const body = await readBody(req);
  try {
    return installUpdate({ file: body.path, silent: body.silent !== false });
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

// ---- 团队包 ----

route('POST', '/api/teams/import', async (req) => {
  const body = await readBody(req);
  try {
    const r = importTeam(String(body.text || ''));
    await restartAllBots();
    return { ok: true, ...r };
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

// ---- 连接器（MCP） ----

route('GET', '/api/mcp', async () => {
  const cfg = loadConfig();
  return {
    items: (cfg.mcp || []).map((m) => ({ ...m, ...(m.env ? { env: Object.fromEntries(Object.keys(m.env).map((k) => [k, '••••••'])) } : {}) })),
  };
});

// 应用连接模板
route('GET', '/api/connectors/presets', async () => ({ presets: CONNECTOR_PRESETS }));

route('POST', '/api/connectors/install', async (req) => {
  const body = await readBody(req);
  const preset = findPreset(String(body.presetId || ''));
  if (!preset) return fail('没有这个模板', 404);
  const env = {};
  for (const e of preset.env || []) {
    const v = String((body.env || {})[e.key] || '').trim();
    if (!v) {
      if (e.required) return fail(`缺少 ${e.key}`, 400);
      continue;
    }
    env[e.key] = v;
  }
  const item = buildMcp({
    name: String(body.name || preset.name),
    title: preset.title,
    transport: 'stdio',
    command: preset.command,
    args: preset.args,
    env,
  });
  const err = validateMcp(item);
  if (err) return fail(err);
  const cfg = loadConfig();
  cfg.mcp = [...(cfg.mcp || []).filter((m) => m.name !== item.name), item];
  saveConfig(cfg);
  await restartAllBots();
  return { ok: true, item };
});

route('POST', '/api/mcp', async (req) => {
  const body = await readBody(req);
  const m = buildMcp(body);
  const err = validateMcp(m);
  if (err) return fail(err);
  const cfg = loadConfig();
  cfg.mcp = [...(cfg.mcp || []), m];
  saveConfig(cfg);
  await restartAllBots();
  return { ok: true, item: m };
});

route('PATCH', '/api/mcp/:id', async (req, { params }) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  const idx = (cfg.mcp || []).findIndex((m) => m.id === params.id);
  if (idx < 0) return fail('没有这个连接器', 404);
  const next = { ...cfg.mcp[idx], ...body };
  // 空字符串的 env 值当没填（界面打码回来的是空）
  if (body.env) next.env = Object.fromEntries(Object.entries(body.env).filter(([, v]) => v !== '' && v !== '••••••'));
  const err = validateMcp(next);
  if (err) return fail(err);
  cfg.mcp[idx] = next;
  saveConfig(cfg);
  await restartAllBots();
  return { ok: true, item: next };
});

route('DELETE', '/api/mcp/:id', async (req, { params }) => {
  const cfg = loadConfig();
  cfg.mcp = (cfg.mcp || []).filter((m) => m.id !== params.id);
  saveConfig(cfg);
  await restartAllBots();
  return { ok: true };
});

// ---- 技能 ----

route('GET', '/api/bots/:id/skills', async (req, { params }) => {
  const bot = getBot(params.id);
  if (!bot) return fail('没有这个机器人', 404);
  return { dir: skillsDir(params.id), skills: listSkills(params.id) };
});

route('POST', '/api/bots/:id/skills', async (req, { params }) => {
  const bot = getBot(params.id);
  if (!bot) return fail('没有这个机器人', 404);
  const body = await readBody(req, 30 * 1024 * 1024);
  try {
    if (body.zip) {
      const r = installSkillZip(params.id, Buffer.from(String(body.zip).replace(/^data:[^;]+;base64,/, ''), 'base64'));
      await restartBot(params.id);
      return { ok: true, ...r, skills: listSkills(params.id) };
    }
    const slug = installSkillText(params.id, { slug: body.slug, text: body.text });
    await restartBot(params.id);
    return { ok: true, slug, skills: listSkills(params.id) };
  } catch (e) {
    return fail(e?.message || String(e));
  }
});

route('GET', '/api/bots/:id/skills/:slug', async (req, { params }) => {
  const text = readSkill(params.id, params.slug);
  if (text === null) return fail('没有这个技能', 404);
  return { slug: params.slug, text };
});

route('DELETE', '/api/bots/:id/skills/:slug', async (req, { params }) => {
  const okDel = removeSkill(params.id, params.slug);
  await restartBot(params.id);
  return { ok: okDel, skills: listSkills(params.id) };
});

// ---- 会话 ----

route('GET', '/api/bots/:id/conversations', async (req, { params }) => listConversations(params.id, 100));

// 导出会话：Markdown，带时间、发言人、文件
route('GET', '/api/conversations/:id/export', async (req, { params, res }) => {
  const conv = getConversation(params.id);
  if (!conv) return fail('没有这个会话', 404);
  const bot = conv.botId ? getBot(conv.botId) : null;
  const group = conv.groupId ? getGroup(conv.groupId) : null;
  const msgs = listMessages(params.id, 5000);
  const fmt = (t) => {
    const d = new Date(Number(t) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const lines = [
    `# ${group ? `群聊：${group.name}` : `与 ${bot?.name || '机器人'} 的对话`}`,
    '',
    `- 会话 ID：${conv.id}`,
    `- 导出时间：${fmt(Date.now())}`,
    `- 消息数：${msgs.length}`,
    '',
    '---',
    '',
  ];
  for (const m of msgs) {
    const who = m.role === 'user' ? '我' : m.meta?.speakerName || bot?.name || '机器人';
    lines.push(`### ${who} · ${fmt(m.createdAt)}`, '');
    lines.push(String(m.content || '').trim() || '（空）', '');
    for (const f of m.meta?.files || []) {
      lines.push(`- 📎 ${f.path}${f.description ? `（${f.description}）` : ''}`);
    }
    if (m.meta?.files?.length) lines.push('');
  }
  const body = lines.join('\n');
  const name = group ? `群聊-${group.name}` : bot?.name || '会话';
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="winbot-${encodeURIComponent(name)}-${params.id.slice(-6)}.md"`,
  });
  res.end(body);
  return undefined;
});

route('POST', '/api/bots/:id/conversations', async (req, { params }) => {
  const body = await readBody(req);
  return { conversation: createConversation({ botId: params.id, title: body.title || '', channel: 'app' }) };
});

route('GET', '/api/conversations/:id', async (req, { params }) => {
  const conv = getConversation(params.id);
  if (!conv) return fail('没有这个会话', 404);
  return { conversation: conv, messages: listMessages(params.id), tools: listToolCalls(params.id), usage: conversationUsage(params.id) };
});

route('DELETE', '/api/conversations/:id', async (req, { params }) => {
  deleteConversation(params.id);
  return { ok: true };
});

route('GET', '/api/conversations/:id/events', async (req, { params, res }) => {
  const conv = getConversation(params.id);
  if (!conv) return fail('没有这个会话', 404);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const write = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  write({ type: 'hello', conversationId: params.id, botId: conv.botId });
  const off = onBotEvent(conv.botId, (ev) => {
    if (ev.conversationId && ev.conversationId !== params.id) return;
    write(ev);
  });
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15_000);
  ping.unref?.();
  await new Promise((resolve) => {
    const done = () => {
      clearInterval(ping);
      off();
      resolve();
    };
    req.on('close', done);
    req.on('error', done);
  });
  return undefined;
});

// 停止这一轮（把机器人进程掐掉，会话记录留着）
route('POST', '/api/conversations/:id/stop', async (req, { params }) => {
  const conv = getConversation(params.id);
  if (!conv) return fail('没有这个会话', 404);
  const ok = await abortTurn(conv.botId);
  if (ok) addMessage({ conversationId: params.id, role: 'note', content: '已停止（你按的停止）。这一轮没做完，可以直接重发。', meta: { stopped: true } });
  return { ok, stopped: ok };
});

route('POST', '/api/conversations/:id/send', async (req, { params, res }) => {
  const conv = getConversation(params.id);
  if (!conv) return fail('没有这个会话', 404);
  const body = await readBody(req, 40 * 1024 * 1024);
  const text = String(body.text || '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments.map(String).slice(0, 8) : [];
  if (!text && !attachments.length) return fail('消息是空的');
  const userMsg = addMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    meta: { channel: 'app', ...(attachments.length ? { attachments } : {}) },
  });
  if (!conv.title) touchConversation(conv.id, { title: truncate(text.replace(/\s+/g, ' ') || '（附件）', 30) });
  sendJson(res, 200, { ok: true, message: userMsg });
  // 异步跑，进度走 SSE
  (async () => {
    try {
      const r = await sendToBot({
        botId: conv.botId,
        conversationId: conv.id,
        sessionId: getConversation(conv.id)?.sessionId || null,
        text,
        attachments,
        channel: 'app',
      });
      if (r.usage) addUsage({ conversationId: conv.id, botId: conv.botId, ...r.usage });
      // 这一轮生成的文件（图片/视频）+ 模型主动 present 的
      // present 的 + 生成的，按路径去重
      const files = [...new Map([...(r.presented || []), ...takeGenerated(conv.botId)].map((f) => [f.path, f])).values()];
      addMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: r.text || '（这一轮没有产出文字）',
        meta: { channel: 'app', ...(r.usage ? { usage: r.usage } : {}), ...(files.length ? { files } : {}) },
      });
      emitUsage(conv.botId, conv.id);
    } catch (e) {
      if (e?.code === 'aborted') {
        // 提示已由 /stop 接口写过，这里只吞掉错误，别记成失败
      } else {
        addMessage({ conversationId: conv.id, role: 'error', content: `出错了：${e?.message || e}`, meta: {} });
      }
    }
  })();
  return undefined;
});

route('GET', '/api/search', async (req, { url }) => {
  const q = (url.searchParams.get('q') || '').trim();
  const botId = url.searchParams.get('botId') || null;
  if (!q) return [];
  return searchMessages(q, { limit: 50, botId });
});

// ---- 「关于我」共享记忆 ----

route('GET', '/api/about', async () => ({
  lines: listAbout(),
  chars: aboutChars(),
  maxChars: ABOUT_MAX_CHARS,
}));

route('POST', '/api/about', async (req) => {
  const body = await readBody(req);
  const r = addAbout({ text: body.text, source: body.source || 'you', confirmSensitive: true });
  if (!r.ok) return fail(r.reason || '没记上');
  await restartAllBots();
  return { ok: true, line: listAbout().find((l) => l.id === r.id) || null, chars: aboutChars() };
});

route('DELETE', '/api/about/:id', async (req, { params }) => {
  const n = removeAbout({ id: params.id });
  if (n) await restartAllBots();
  return { removed: n, chars: aboutChars() };
});

// ---- 定时规则 ----

const scheduleView = (s) => ({
  ...s,
  botName: getBot(s.botId)?.name || s.botId,
  when: describeSchedule(s),
  pausedLabel: s.pausedReason ? pauseLabel(s.pausedReason) : '',
});

route('GET', '/api/schedules', async (req, { url }) => {
  const botId = url.searchParams.get('botId');
  return listSchedules(botId || null).map(scheduleView);
});

route('POST', '/api/schedules', async (req) => {
  const body = await readBody(req);
  const s = buildSchedule(body);
  insertSchedule(s);
  return { schedule: scheduleView(getSchedule(s.id)) };
});

route('PATCH', '/api/schedules/:id', async (req, { params }) => {
  const body = await readBody(req);
  const cur = getSchedule(params.id);
  if (!cur) return fail('没有这条规则', 404);
  const timingChanged = ['kind', 'at', 'days', 'everyMinutes'].some((k) => k in body);
  const patch = { ...body };
  delete patch.id;
  if ('enabled' in patch) patch.enabled = !!patch.enabled;
  if (timingChanged) patch.nextRunAt = computeNextRun({ ...cur, ...patch });
  if (patch.enabled === true && !patch.nextRunAt) patch.nextRunAt = computeNextRun(cur);
  const next = updateSchedule(params.id, patch);
  return { schedule: scheduleView(next) };
});

route('DELETE', '/api/schedules/:id', async (req, { params }) => {
  deleteSchedule(params.id);
  return { ok: true };
});

route('POST', '/api/schedules/:id/run', async (req, { params }) => {
  const r = await runSchedule(params.id, { manual: true });
  return { ...r, schedule: scheduleView(getSchedule(params.id)) };
});

route('POST', '/api/schedules/:id/resume', async (req, { params }) => {
  const s = resumeSchedule(params.id);
  if (!s) return fail('没有这条规则', 404);
  return { schedule: scheduleView(s) };
});

// ---- 生成的文件（生图/生视频） ----

route('POST', '/api/media/generated', async (req) => {
  const body = await readBody(req);
  const botId = String(body.botId || '');
  if (!getBot(botId)) return fail('没有这个机器人', 404);
  addGenerated(botId, body.files || []);
  return { ok: true, count: (body.files || []).length };
});

route('GET', '/api/comfy/status', async () => comfyStatus());

// 生图/生视频开跑：界面据此把 ComfyUI 面板打开，让用户看着跑
route('POST', '/api/media/started', async (req) => {
  const body = await readBody(req);
  const botId = String(body.botId || '');
  if (!getBot(botId)) return fail('没有这个机器人', 404);
  emitBotEvent(botId, {
    type: 'media-start',
    botId,
    conversationId: currentConversationId(botId),
    kind: body.kind === 'video' ? 'video' : 'image',
    prompt: String(body.prompt || '').slice(0, 120),
  });
  return { ok: true };
});

// ---- 模型输出的实时增量 ----

route('POST', '/api/stream/probe', async (req) => {
  const body = await readBody(req);
  log('stream', `probe ${body.stage || '?'} from ${body.botId || '?'}`);
  return { ok: true };
});

route('POST', '/api/stream/delta', async (req) => {
  const body = await readBody(req);
  const botId = String(body.botId || '');
  const text = String(body.text || '');
  if (!botId || !text) return { ok: true };
  if (!getBot(botId)) return fail('没有这个机器人', 404);
  const conversationId = currentConversationId(botId);
  emitBotEvent(botId, { type: 'delta', botId, conversationId, text });
  return { ok: true };
});

// ---- 电脑操作的审批（插件通过本地 HTTP 来问） ----

const desktopPending = new Map(); // approvalId -> resolve(allow)

route('POST', '/api/desktop/request', async (req) => {
  const body = await readBody(req);
  const botId = String(body.botId || '');
  if (!getBot(botId)) return fail('没有这个机器人', 404);
  const convId = currentConversationId(botId);
  if (!convId) return fail('现在没有正在进行的对话，无法弹审批卡片', 409);
  const tool = String(body.tool || '电脑操作');
  const detail = String(body.detail || '');
  const row = createApproval({
    botId,
    conversationId: convId,
    sessionId: null,
    tool,
    detail,
    reason: '',
    channel: 'app',
  });
  addMessage({
    conversationId: convId,
    role: 'approval',
    content: `${tool}${detail ? `：${detail}` : ''}`,
    meta: { approvalId: row.id, tool, detail, reason: '', status: 'pending' },
  });
  emitBotEvent(botId, { type: 'approval', approval: row });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!desktopPending.has(row.id)) return;
      desktopPending.delete(row.id);
      answerApproval(row.id, '5 分钟没有回答，按拒绝处理', 'cancelled');
      emitBotEvent(botId, { type: 'approval-resolved', approvalId: row.id, status: 'cancelled' });
      resolve(false);
    }, 5 * 60_000);
    timer.unref?.();
    desktopPending.set(row.id, (allow) => {
      clearTimeout(timer);
      resolve(allow);
    });
  });
  return { allow: outcome };
});

// ---- 审批 ----

route('GET', '/api/approvals', async () => pendingApprovals());

route('POST', '/api/approvals/:id', async (req, { params }) => {
  const body = await readBody(req);
  const row = getApproval(params.id);
  if (!row) return fail('没有这条审批', 404);
  if (row.status !== 'pending') return fail('这条审批已经处理过了', 409);
  const allow = body.allow === true || body.answer === 'allow';
  const remember = body.remember === true;
  let applied = resolveBotApproval(row.botId, row.id, allow, { remember });
  // 电脑操作的审批不在机器人运行时里等，走自己的 pending 表
  if (!applied && desktopPending.has(row.id)) {
    const fn = desktopPending.get(row.id);
    desktopPending.delete(row.id);
    answerApproval(row.id, allow ? '已允许（仅这一次）' : '已拒绝', allow ? 'allowed' : 'rejected');
    emitBotEvent(row.botId, { type: 'approval-resolved', approvalId: row.id, status: allow ? 'allowed' : 'rejected' });
    fn(allow);
    applied = true;
  }
  if (!applied) {
    answerApproval(row.id, '运行时已不在，审批作废', 'cancelled');
    return { ok: false, applied: false, warning: '机器人进程已停止，这条审批作废' };
  }
  // 消息里那张卡片也要落状态，刷新页面后不会又显示成待处理
  if (row.conversationId) {
    const target = listMessages(row.conversationId).find((m) => m.role === 'approval' && m.meta?.approvalId === row.id);
    if (target) updateMessageMeta(target.id, { ...target.meta, status: allow ? 'allowed' : 'rejected', answeredAt: Date.now() });
  }
  return { ok: true, applied: true, allow };
});

// ---- 设置 ----

route('GET', '/api/settings', async () => ({
  config: publicConfig(),
  presets: PROVIDER_PRESETS,
  modelChoices: modelChoices(),
  update: updateSettings(),
  channels: channelStatus(),
  dataDir: DATA_DIR,
  comfy: loadConfig().comfy,
  permissionModes: PERMISSIONS,
  engines: engineChoices(),
}));

route('POST', '/api/settings/provider', async (req) => {
  const body = await readBody(req);
  const exists = body.id && providerById(body.id);
  if (exists) {
    const patch = { ...body };
    delete patch.id;
    if (patch.apiKey === '') delete patch.apiKey;
    const p = updateProvider(body.id, patch);
    return { provider: p ? { ...p, apiKey: p.apiKey ? '••••••' : '' } : null };
  }
  const p = addProvider(body);
  return { provider: { ...p, apiKey: p.apiKey ? '••••••' : '' } };
});

route('DELETE', '/api/settings/provider/:id', async (req, { params }) => {
  removeProvider(params.id);
  return { ok: true };
});

route('PATCH', '/api/settings/channels/:name', async (req, { params }) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  const name = params.name;
  if (!cfg.channels[name]) return fail('没有这个渠道', 404);
  cfg.channels[name] = { ...cfg.channels[name], ...body };
  if (name === 'wechat' || name === 'feishu') cfg.channels[name].enabled = false;
  saveConfig(cfg);
  const started = cfg.channels[name].enabled ? await startOne(name) : false;
  return {
    channel: { ...cfg.channels[name], ...(cfg.channels[name].token ? { token: '••••••' } : {}) },
    started,
  };
});

route('POST', '/api/settings/defaultProvider', async (req) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  cfg.defaultProviderId = body.id || null;
  saveConfig(cfg);
  return { ok: true };
});

route('PATCH', '/api/settings/comfy', async (req) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  cfg.comfy = { ...(cfg.comfy || {}), ...(body || {}) };
  saveConfig(cfg);
  await restartAllBots();
  return { comfy: cfg.comfy, status: await comfyStatus() };
});

route('PATCH', '/api/settings/security', async (req) => {
  const body = await readBody(req);
  const cfg = loadConfig();
  cfg.security = { ...cfg.security, ...body };
  saveConfig(cfg);
  return { security: cfg.security };
});

route('POST', '/api/settings/reload-channels', async () => {
  await restartChannels();
  return { ok: true, channels: channelStatus() };
});

route('GET', '/api/health', async () => ({
  ok: true,
  pid: process.pid,
  node: process.version,
  startedAt: STARTED_AT,
  uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
  bots: allStatus(),
  channels: channelStatus(),
}));

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(UI_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(UI_DIR)) return send(res, 403, 'forbidden');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  } catch {
    return send(res, 404, 'not found');
  }
}

// ---------- 服务 ----------

export function createServer() {
  const cfg = loadConfig();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname === '/health') return sendJson(res, 200, { ok: true });
      if (!pathname.startsWith('/api/')) {
        // 页面本身不含数据；数据接口才要令牌
        if (pathname === '/' || pathname === '/index.html') {
          // 用 ?token= 打开时：种一个 HttpOnly Cookie，再 302 到不带 token 的地址（地址栏/历史里不留令牌）
          const q = url.searchParams.get('token');
          if (q && q === uiToken()) {
            res.writeHead(302, {
              'set-cookie': `winbot=${encodeURIComponent(q)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
              location: '/',
            });
            res.end();
            return undefined;
          }
          return serveStatic(res, pathname);
        }
        if (pathname.startsWith('/assets/')) {
          return serveStatic(res, pathname);
        }
        if (!authOk(req, url)) return send(res, 401, 'unauthorized');
        return serveStatic(res, pathname);
      }
      if (!authOk(req, url)) return sendJson(res, 401, { error: '未授权：缺少访问令牌' });
      const hit = match(req.method, pathname);
      if (!hit) return sendJson(res, 404, { error: '没有这个接口' });
      const out = await hit.handler(req, { params: hit.params, url, res });
      if (out === undefined) return undefined;
      if (out && out.__error) return sendJson(res, out.__status || 400, { error: out.__error });
      return sendJson(res, 200, out);
    } catch (e) {
      logWarn('http', `${req.method} ${pathname} failed: ${e?.stack || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: e?.message || String(e) });
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return undefined;
    }
  });
  server.on('error', (e) => logWarn('http', `server error: ${e?.message || e}`));
  return { server, cfg };
}

export function startServer() {
  const { server, cfg } = createServer();
  const port = Number(process.env.WINBOT_PORT || cfg.server.port || 5178);
  const host = cfg.server.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/?token=${uiToken()}`;
      resolve({ server, url, port });
    });
  });
}

export { uiToken as token };








































