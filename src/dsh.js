// 智能体内核：每个机器人一个常驻 DSH 子进程（SDK over stdio JSON-RPC）。
// 这里只做「把机器人的配置翻译成 DSH 补丁 + 收发消息 + 转审批」，工具、沙箱、会话持久化都交给 DSH。
import fs from 'node:fs';
import path from 'node:path';
import { DSH_DIR, DATA_DIR, ensureDir, log, logError, logWarn, readJson, writeJson, writeText, readText, newId, tryJson, truncate, bytesHuman } from './util.js';
import { loadConfig, providerById, apiKeyEnvName, defaultProvider, providerReady } from './config.js';
import { botPaths, ensureWorkspace, getBot, identityBrief, memoryOf, personaOf, updateBot, workspaceOf } from './bots.js';
import { isDshAccountProvider, syncDshCredentials } from './dsh-account.js';
import { aboutForPrompt, aboutMtime } from './about.js';
import { skillsDir } from './skills.js';
import { mcpForBot, mcpLines } from './mcp.js';
import { addMessage, createApproval, getApproval, answerApproval, touchConversation, botUsageToday } from './db.js';

const running = new Map();
/** 每个机器人的事件订阅者（界面 SSE 和渠道都用它） */
const sinks = new Map();

export function onBotEvent(botId, fn) {
  if (!sinks.has(botId)) sinks.set(botId, new Set());
  sinks.get(botId).add(fn);
  return () => sinks.get(botId)?.delete(fn);
}

function emit(botId, event) {
  for (const fn of sinks.get(botId) || []) {
    try {
      // 带上 botId：群聊里要按发言人显示名字和头像
      fn({ ...event, botId });
    } catch (e) {
      logWarn('dsh', `sink failed: ${e?.message || e}`);
    }
  }
}

/** 让外部模块（例如服务端记完用量后）也能推一个事件给界面 */
export function emitBotEvent(botId, event) {
  emit(botId, event);
}

/** 某个机器人此刻正在跑哪个会话（电脑操作的审批卡要落进这个会话） */
export function currentConversationId(botId) {
  const rt = running.get(botId);
  return rt?.currentTurn?.conversationId || rt?.busyConversationId || null;
}

export function botStatus(botId) {
  const r = running.get(botId);
  if (!r) return { state: 'stopped', pid: null, providerId: null, model: null, busy: false };
  return {
    state: 'running',
    pid: r.pid,
    providerId: r.providerId,
    model: r.model,
    busy: !!r.busyConversationId,
    conversationId: r.busyConversationId || null,
    startedAt: r.startedAt,
  };
}

export function allStatus() {
  return Object.fromEntries(
    [...running.keys()].map((id) => [id, botStatus(id)]),
  );
}

// ---------- YAML 补丁 ----------

const yamlStr = (v) => JSON.stringify(String(v));

/** 把一个接口写成 llm-pi-ai 的 provider 条目（行数组，缩进为 4 空格起点） */
function providerLines(p, indent = '      ') {
  const api = p.api || 'openai-completions';
  const lines = [`${indent}${p.id}:`];
  const push = (s) => lines.push(`${indent}  ${s}`);
  push(`displayName: ${yamlStr(p.name || p.id)}`);
  push(`api: ${api}`);
  push(`baseURL: ${yamlStr(p.baseURL)}`);
  if (p.apiKey) push(`apiKeyEnv: ${apiKeyEnvName(p.id)}`);
  const headers = { ...(p.extraHeaders || {}) };
  if (Object.keys(headers).length) {
    push('headers:');
    for (const [k, v] of Object.entries(headers)) lines.push(`${indent}    ${k}: ${yamlStr(v)}`);
  }
  push('models:');
  for (const m of p.models || []) {
    if (typeof m === 'string') {
      lines.push(`${indent}    - id: ${yamlStr(m)}`, `${indent}      name: ${yamlStr(m.split('/').pop())}`);
    } else {
      lines.push(`${indent}    - id: ${yamlStr(m.id)}`, `${indent}      name: ${yamlStr(m.name || m.id)}`);
      if (m.contextWindow) lines.push(`${indent}      contextWindow: ${Number(m.contextWindow)}`);
      if (m.maxTokens) lines.push(`${indent}      maxTokens: ${Number(m.maxTokens)}`);
      if (Array.isArray(m.input)) lines.push(`${indent}      input: [${m.input.join(', ')}]`);
    }
  }
  return lines;
}

/** 生成这个机器人进程的补丁文件：接口、权限、人设前缀、工具开关 */
function writePatch(bot) {
  const cfg = loadConfig();
  const home = path.join(DSH_DIR, bot.id);
  ensureDir(home);
  const ws = ensureWorkspace(bot.id);
  const providers = cfg.providers.filter((p) => p.apiKey || p.noKey);
  // 系统提示里放完整人设 + 「关于我」：每个请求都会带上，模型不会自称别的身份
  const about = aboutForPrompt();
  const persona = [
    personaOf(bot.id).trim(),
    identityBrief(bot),
    about ? `【关于我（共享记忆，所有机器人都能看到）】\n${about}` : '',
    // 交付物路径统一用相对路径，界面上好认、也不暴露本机目录
    '【汇报文件位置时】一律写工作区相对路径（如 outputs/images/a.png），不要贴 E:\\... 这种绝对路径。除非用户明确要完整路径。',
  ]
    .filter(Boolean)
    .join('\n\n');
  const memoryPlugin = path.resolve(import.meta.dirname, 'dsh-plugins', 'winbot-memory.mjs');
  const desktopPlugin = path.resolve(import.meta.dirname, 'dsh-plugins', 'winbot-desktop.mjs');
  const collabPlugin = path.resolve(import.meta.dirname, 'dsh-plugins', 'winbot-collab.mjs');
  const streamPlugin = path.resolve(import.meta.dirname, 'dsh-plugins', 'winbot-stream.mjs');
  const mediaPlugin = path.resolve(import.meta.dirname, 'dsh-plugins', 'winbot-media.mjs');
  const lines = [
    `# winbot 自动生成，请勿手改（机器人 ${bot.id}）`,
    '',
    ...(providers.length
      ? ['- id: llm-pi-ai', '  config:', '    providers:', ...providers.flatMap((p) => providerLines(p))]
      : []),
    '',
    '- insert:',
    '    - id: winbot-memory',
    `      name: ${yamlStr(memoryPlugin)}`,
    '    - id: winbot-collab',
    `      name: ${yamlStr(collabPlugin)}`,
    '    - id: winbot-stream',
    `      name: ${yamlStr(streamPlugin)}`,
    '    - id: winbot-media',
    `      name: ${yamlStr(mediaPlugin)}`,
    // 连接器（MCP）：开着并且适用于这个机器人的，都挂进来
    ...mcpForBot(bot.id).flatMap((m) => mcpLines(m)),
    // 电脑操作：只在用户打开时加载（读屏免审批，动键鼠要审批）
    ...(bot.desktopUse && bot.desktopUse !== 'off'
      ? ['    - id: winbot-desktop', `      name: ${yamlStr(desktopPlugin)}`]
      : []),
    '',
    // 技能从机器人自己的目录读；自定义根目录让用户装/删技能不用碰 DSH 内部目录
    '- id: skill-filesystem',
    '  config:',
    '    customSkillDirs:',
    `      - ${yamlStr(skillsDir(bot.id))}`,
    '',
    // 人设进系统提示；不要 DSH 默认的 coding agent 身份和 "powered by" 那句
    '- id: system-prompt',
    '  config:',
    `    personaPrefix: ${yamlStr(persona)}`,
    '    includeHarnessIdentity: false',
    '',
    // 权限预设按机器人设置；越界一律 ask（由审批中心问人）
    '- id: sandbox-policy',
    '  config:',
    `    mode: ${bot.sandboxMode || 'workspace-write'}`,
    `    workspaceRoot: ${yamlStr(ws)}`,
    '',
    '- id: approval',
    '  config:',
    '    policy: ask',
    '',
    '- id: permission',
    '  config:',
    '    presets:',
    '      read-only: { sandbox: read-only, approval: ask }',
    '      workspace-write: { sandbox: workspace-write, approval: ask }',
    '      danger-full-access: { sandbox: danger-full-access, approval: ask }',
    '',
  ];
  const file = path.join(home, 'winbot.patch.yml');
  writeText(file, lines.join('\n'));
  return file;
}

/** 子进程环境：只给必要的键，真实 Key 只进它自己的进程 */
function childEnv(bot) {
  const cfg = loadConfig();
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ProgramFiles: process.env.ProgramFiles,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    HOME: process.env.USERPROFILE,
    LANG: 'C.UTF-8',
    DSH_HOME: path.join(DSH_DIR, bot.id),
    DSH_PERMISSION_MODE: bot.sandboxMode || 'workspace-write',
    // 电脑操作插件要回宿主问审批，这几个是它需要的
    WINBOT_BOT_ID: bot.id,
    WINBOT_WORKSPACE: ensureWorkspace(bot.id),
    WINBOT_HOST: `http://127.0.0.1:${process.env.WINBOT_PORT || loadConfig().server?.port || 5178}`,
    WINBOT_UI_TOKEN: readText(path.join(DATA_DIR, 'ui-token'), '').trim(),
    WINBOT_DESKTOP_AUTO: bot.desktopUse === 'auto' ? '1' : '0',
    WINBOT_STREAM_DEBUG: process.env.WINBOT_STREAM_DEBUG || '',
    // 本机生成能力（ComfyUI）
    WINBOT_COMFY_URL: (loadConfig().comfy || {}).url || '',
    WINBOT_COMFY_CHECKPOINT: (loadConfig().comfy || {}).checkpoint || '',
  };
  // Electron 外壳下：DSH 子进程也得用 node 身份启动（同一个可执行文件）
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  for (const p of cfg.providers) {
    if (!p.apiKey) continue;
    env[apiKeyEnvName(p.id)] = p.apiKey;
  }
  // 代理设置属于用户网络环境，照常传下去（不传任何密钥）
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

// ---------- 运行时加载 ----------

let sdkModulePromise = null;
async function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@deepseek-ai/dsh-sdk-client').catch((e) => {
      sdkModulePromise = null;
      throw e;
    });
  }
  return sdkModulePromise;
}

function resolveDshBin() {
  // 优先按这个文件自己的位置找 node_modules（打包进 asar 后 cwd 不是应用目录）
  const candidates = [
    path.resolve(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    process.env.WINBOT_DSH_BIN,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export const APPROVAL_TIMEOUT_MS = Number(process.env.WINBOT_APPROVAL_TIMEOUT_MS || 10 * 60_000);

const TOOL_LABELS = {
  write: '写文件',
  edit: '改文件',
  str_replace_editor: '改文件',
  read: '读文件',
  bash: '执行命令',
  pwsh: '执行命令',
  'computer-use': '操作电脑',
  web_fetch: '抓网页',
  web_search: '联网搜索',
};

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * 把「文字 + 工作区里的附件」拼成 SDK 的输入。
 * 图片按 image 内容块交给模型看；其它文件只在文字里点名路径，让模型用自己的只读工具打开
 * （比我们在宿主里解析各种格式可靠得多）。
 */
function buildTurnInput(bot, text, attachments = []) {
  const ws = ensureWorkspace(bot.id);
  const root = fs.realpathSync(ws);
  const blocks = [];
  const notes = [];
  for (const rel of attachments) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(ws, rel));
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + path.sep)) continue; // 只认工作区里的文件
    const stat = fs.statSync(real);
    const ext = path.extname(real).toLowerCase();
    const name = path.basename(real);
    if (IMAGE_MIME[ext] && stat.size <= 20 * 1024 * 1024) {
      blocks.push({ type: 'image', data: fs.readFileSync(real).toString('base64'), mimeType: IMAGE_MIME[ext], name });
      notes.push(`[图片] ${rel}`);
    } else {
      notes.push(`[文件] ${rel}（${bytesHuman(stat.size)}）`);
    }
  }
  if (!blocks.length && !notes.length) return text;
  const full = [text, ...notes, notes.length ? '（附件都在这个机器人的工作区里，需要时用读文件工具打开）' : '']
    .filter(Boolean)
    .join('\n');
  return [{ type: 'text', text: full }, ...blocks];
}

/** 工具名 + 参数 → 给用户看的一句话 */
function describeApproval(toolName, params) {
  const label = TOOL_LABELS[toolName] || toolName;
  const detail = params?.reason ? String(params.reason) : '';
  return { label, detail };
}

// ---------- 审批的临时豁免 ----------

/** 审批归类：同一类操作在一个小时内可以自动放行（只按大类，不按具体路径） */
export function approvalKind(toolName, params) {
  const t = String(toolName || '').toLowerCase();
  const r = String(params?.reason || '').toLowerCase();
  if (t.includes('desktop') || r.includes('desktop')) return 'desktop';
  if (t.includes('mcp') || r.includes('mcp')) return 'mcp';
  if (r.includes('sandbox') || r.includes('escalate')) return 'sandbox';
  if (t.includes('bash') || t.includes('shell') || t.includes('command') || r.includes('命令')) return 'shell';
  if (t.includes('写') || t.includes('文件')) return 'file';
  if (t.includes('write') || t.includes('edit') || t.includes('fs') || r.includes('文件')) return 'file';
  return `tool:${t || 'unknown'}`;
}

const ALLOW_TTL_MS = 60 * 60_000;

// ---------- 单个机器人的运行时 ----------

class BotRuntime {
  constructor(bot) {
    this.bot = bot;
    this.harness = null;
    this.started = false;
    this.busyConversationId = null;
    this.providerId = bot.providerId;
    this.model = bot.model;
    this.startedAt = Date.now();
    this.pending = new Map(); // approvalId -> resolve
    this.pid = null;
    // 用户点了「1 小时内同类自动放行」：kind -> 到期时间
    this.autoAllow = new Map();
    // 审批 id -> 类别（创建时算好，回答时直接查，避免拿中文标签重新分类）
    this.kindOf = new Map();
    // 用户点了「停止」：记下是哪一轮，便于把报错翻译成「已停止」
    this.abortInfo = null;
    // 启动时「关于我」的版本；文件变了就说明它该重启了
    this.aboutAt = 0;
  }

  get home() {
    return path.join(DSH_DIR, this.bot.id);
  }

  async ensureStarted(turnContext) {
    if (this.started) return;
    const prov = providerById(this.bot.providerId) || defaultProvider();
    if (!prov) throw new Error('还没有可用的模型接口：请先在「设置 → 模型接口」里填一个 API Key');
    if (!providerReady(prov)) {
      throw new Error(
        isDshAccountProvider(prov)
          ? '这个接口用的是本机 DSH 的登录态，但现在没读到登录信息：请先在 DSH 里登录一次'
          : `接口「${prov.name}」没有 API Key`,
      );
    }
    // 用本机 DSH 登录态时，先把凭据带进这个机器人自己的 DSH_HOME（账号服务只读自己的 home）
    if (isDshAccountProvider(prov)) syncDshCredentials(this.home);
    const model = this.bot.model && (prov.models || []).includes(this.bot.model) ? this.bot.model : (prov.models || [])[0];
    if (!model) throw new Error(`接口「${prov.name}」没有配置模型`);
    this.providerId = prov.id;
    this.model = model;

    const sdk = await loadSdk();
    const dshBin = resolveDshBin();
    const patch = writePatch({ ...this.bot, sandboxMode: this.sandboxMode() });
    this.turnContext = turnContext;

    const harness = new sdk.DeepSeekHarness({
      profile: 'sdk',
      ...(dshBin ? { dshBin } : {}),
      dshHome: this.home,
      patches: [patch],
      cwd: ensureWorkspace(this.bot.id),
      // 重要：DSH 子进程自己的工作目录必须是应用根目录，否则它在工作区里找不到
      // node_modules 里的插件包（ERR_MODULE_NOT_FOUND），会话工作区靠 cwd 参数单独指定。
      env: childEnv(this.bot),
      provider: this.providerId,
      model: this.model,
      approvalRequests: true,
      initializeTimeoutMs: 30_000,
      onUserQuestion: async () => ({ cancelled: true }),
    });

    harness.client.start();
    harness.client.onRequest(async (method, params) => {
      if (method !== 'approval/request') throw new Error(`unsupported request: ${method}`);
      return await this.onApprovalRequest(params);
    });
    await harness.start();
    this.harness = harness;
    this.started = true;
    this.aboutAt = aboutMtime();
    const child = harness.client?.child;
    this.pid = child?.pid || null;
    log('dsh', `${this.bot.id}: started pid=${this.pid} ${prov.id}/${model}`);
    emit(this.bot.id, { type: 'status', status: botStatus(this.bot.id) });
  }

  sandboxMode() {
    const p = this.bot.permission;
    if (p === 'readonly') return 'read-only';
    if (p === 'danger-full-access' || p === 'full') return 'danger-full-access';
    return 'workspace-write';
  }

  /** DSH 请求一次审批：入库、广播，等界面/渠道回答 */
  async onApprovalRequest(params) {
    const tool = String(params?.toolName || 'tool');
    const sessionId = String(params?.sessionId || '');
    const { label, detail } = describeApproval(tool, params);
    const ctx = this.currentTurn;
    const kind = approvalKind(tool, params);
    const until = this.autoAllow.get(kind) || 0;

    // 一小时内同一类操作放行过：不再打断用户，只留一条记录
    if (until > Date.now()) {
      const row = createApproval({
        botId: this.bot.id,
        conversationId: ctx?.conversationId || null,
        sessionId,
        tool: label,
        detail: detail || '',
        reason: String(params?.reason || ''),
        channel: ctx?.channel || 'app',
      });
      answerApproval(row.id, `自动放行（1 小时内同类已允许，${kind}）`, 'allowed');
      emit(this.bot.id, { type: 'approval-resolved', approvalId: row.id, status: 'allowed', auto: true });
      log('dsh', `${this.bot.id}: approval auto-allowed ${row.id} kind=${kind}`);
      return { outcome: 'allowed-once' };
    }

    const row = createApproval({
      botId: this.bot.id,
      conversationId: ctx?.conversationId || null,
      sessionId,
      tool: label,
      detail: detail || '',
      reason: String(params?.reason || ''),
      channel: ctx?.channel || 'app',
    });
    this.kindOf.set(row.id, kind);
    // 消息里留一张卡：越界操作要等用户点头
    if (ctx?.conversationId) {
      addMessage({
        conversationId: ctx.conversationId,
        role: 'approval',
        content: `${label}${detail ? `：${detail}` : ''}`,
        meta: { approvalId: row.id, tool: label, detail, reason: row.reason, status: 'pending' },
      });
    }
    emit(this.bot.id, { type: 'approval', approval: row });
    log('dsh', `${this.bot.id}: approval ${row.id} ${label} ${truncate(detail, 80)}`);

    const outcome = await new Promise((resolve) => {
      this.pending.set(row.id, resolve);
      const timer = setTimeout(() => {
        if (!this.pending.has(row.id)) return;
        this.pending.delete(row.id);
        answerApproval(row.id, `${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟没有回答，按拒绝处理`, 'cancelled');
        emit(this.bot.id, { type: 'approval-resolved', approvalId: row.id, status: 'cancelled' });
        resolve('rejected');
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(row.id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
    return { outcome };
  }

  resolveApproval(approvalId, allow, opts = {}) {
    const fn = this.pending.get(approvalId);
    if (!fn) return false;
    this.pending.delete(approvalId);
    // 「1 小时内同类都允许」：记下这一类，下次不再问
    if (allow && opts.remember) {
      const row = getApproval(approvalId);
      if (row) {
        const kind = this.kindOf.get(approvalId) || approvalKind(row.tool, { reason: row.reason });
        this.autoAllow.set(kind, Date.now() + ALLOW_TTL_MS);
        log('dsh', `${this.bot.id}: 自动放行 ${kind} 一小时`);
      }
    }
    answerApproval(
      approvalId,
      allow ? (opts.remember ? '已允许（1 小时内同类不再问）' : '已允许（仅这一次）') : '已拒绝',
      allow ? 'allowed' : 'rejected',
    );
    fn(allow ? 'allowed-once' : 'rejected');
    emit(this.bot.id, { type: 'approval-resolved', approvalId, status: allow ? 'allowed' : 'rejected' });
    return true;
  }

  /** 用户点「停止」：记下这一轮，然后把进程掐掉；runTurn 的报错会被翻译成「已停止」 */
  async abort(reason = '用户停止') {
    this.abortInfo = { conversationId: this.busyConversationId, reason, at: Date.now() };
    log('dsh', `${this.bot.id}: abort requested (${reason})`);
    await this.stop();
  }

  /**
   * 只把「这一轮的用户消息」送进去。
   * 人设和身份已经在系统提示里（writePatch 的 personaPrefix），不要再重复拼进用户消息，
   * 否则模型会把整段人设当成「用户说的话」，还容易在回复里念出来。
   * 长期记忆仍在工作区 MEMORY.md，需要时由模型自己读。
   */
  promptWithPersona(text) {
    return text;
  }

  /**
   * 跑一轮：发消息（可带附件）、边收事件边广播，直到这一轮结束。
   * 返回 { text, sessionId, usage }。
   */
  async runTurn({ conversationId, sessionId, text, channel, attachments = [], onProgress }) {
    // 每日预算：聊天和定时任务都算，超了就停，不会悄悄烧钱
    const budget = Number(this.bot.dailyBudgetTokens) || 0;
    if (budget > 0) {
      const used = botUsageToday(this.bot.id);
      if (used.totalTokens >= budget) {
        throw new Error(
          `今天已经用了 ${used.totalTokens} tokens，超过你设的每日上限 ${budget}。` +
            `明天再用，或者到「机器人设置」里调高上限。`,
        );
      }
    }
    await this.ensureStarted({ conversationId, channel });
    if (this.busyConversationId) throw new Error('这个机器人还在处理上一条消息，稍等一下再发');
    this.busyConversationId = conversationId;
    const ctx = { conversationId, channel, sessionId };
    this.currentTurn = ctx;
    emit(this.bot.id, { type: 'status', status: botStatus(this.bot.id), busy: true });

    const session = this.harness.session(sessionId || undefined);
    if (sessionId) {
      try {
        await this.harness.client.resumeSession(sessionId);
        log('dsh', `${this.bot.id}: resumed ${sessionId}`);
      } catch (e) {
        logWarn('dsh', `${this.bot.id}: resume ${sessionId} failed (${e?.message || e}), starting a new session`);
        ctx.sessionId = null;
        touchConversation(conversationId, { sessionId: null });
      }
    }

    // 这一轮的用量（模型可能分多步，逐步累加）
    ctx.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    ctx.presented = [];
    const input = buildTurnInput(this.bot, text, attachments);
    let result;
    try {
      result = await session.run(input, {
        onNotification: (n) => this.onNotification(n, ctx, onProgress),
      });
    } finally {
      this.busyConversationId = null;
      this.currentTurn = null;
      emit(this.bot.id, { type: 'status', status: botStatus(this.bot.id), busy: false });
      // 这一轮没答完的审批作废（包括轮次异常结束时挂着的）
      for (const [id, fn] of [...this.pending]) {
        this.pending.delete(id);
        answerApproval(id, '这一轮已结束', 'cancelled');
        fn('cancelled');
      }
    }

    const sid = result?.sessionId || ctx.sessionId;
    if (sid) {
      ctx.sessionId = sid;
      touchConversation(conversationId, { sessionId: sid });
    }
    return { text: result?.finalResponse || '', sessionId: sid, usage: ctx.usage, presented: ctx.presented || [], events: result?.events || [] };
  }

  onNotification(n, ctx, onProgress) {
    const method = n?.method;
    const params = n?.params || {};
    if (method === 'session.event') {
      const ev = params.event || {};
      const sid = params.sessionId;
      // 子代理的事件先忽略（宿主只关心主会话）
      if (ctx.sessionId && sid && sid !== ctx.sessionId) return;
      const type = ev.type;
      const data = ev.data || {};
      if (type === 'tool/call') {
        const name = String(data.name || '');
        // present 是「交付文件」：记下来，回合结束时界面里给可点的文件卡片
        if (name === 'present') {
          const args = tryJson(String(data.arguments || ''));
          for (const f of args?.files || []) {
            if (f?.path) ctx.presented.push({ path: String(f.path), description: String(f.description || '') });
          }
        }
        const callId = String(data.callId || '');
        if (callId) {
          ctx.toolNames = ctx.toolNames || new Map();
          ctx.toolNames.set(callId, name);
        }
        onProgress?.({ kind: 'tool', callId, name, args: truncate(String(data.arguments || ''), 400) });
        emit(this.bot.id, {
          type: 'tool-call',
          conversationId: ctx.conversationId,
          callId,
          name,
          args: truncate(String(data.arguments || ''), 400),
        });
      } else if (type === 'tool/result') {
        // 结果里带 isError / error.reason，界面用它显示 ✓ / ✗
        const msg = data.message || {};
        const callId = String(msg.toolCallId || data.error?.callId || '');
        const isError = !!msg.isError || !!data.error;
        const ws = workspaceOf(this.bot.id);
        const clean = (t) => (ws ? String(t || '').split(ws).join('').replace(/^[\\/]+/, '') : String(t || ''));
        emit(this.bot.id, {
          type: 'tool-result',
          conversationId: ctx.conversationId,
          callId,
          name: (ctx.toolNames && ctx.toolNames.get(callId)) || '',
          isError,
          reason: clean(truncate(String(data.error?.reason || ''), 200)),
          result: clean(truncate(blocksToText(msg.content || []), 160)),
        });
      } else if (type === 'assistant/message') {
        const msg = data.message || {};
        // token 记账：模型一条回复可能分多步，逐步累加
        if (data.usage && ctx.usage) {
          ctx.usage.inputTokens += Number(data.usage.inputTokens) || 0;
          ctx.usage.outputTokens += Number(data.usage.outputTokens) || 0;
          ctx.usage.cacheReadTokens += Number(data.usage.cacheReadTokens) || 0;
          ctx.usage.cacheWriteTokens += Number(data.usage.cacheWriteTokens) || 0;
        }
        const text = blocksToText(msg.content);
        const reasoning = blocksToText(msg.content, 'reasoning');
        if (text || reasoning) {
          emit(this.bot.id, {
            type: 'assistant-step',
            conversationId: ctx.conversationId,
            text,
            reasoning,
            interrupted: !!data.interrupted,
          });
        }
      }
      return;
    }
    if (method === 'session.status') {
      emit(this.bot.id, { type: 'turn-status', conversationId: ctx.conversationId, status: params.status });
    }
  }

  async stop() {
    const h = this.harness;
    this.started = false;
    this.harness = null;
    this.pid = null;
    running.delete(this.bot.id);
    for (const [id, fn] of this.pending) {
      this.pending.delete(id);
      answerApproval(id, '运行时已停止', 'cancelled');
      fn('cancelled');
    }
    if (h) {
      try {
        await h.close();
        log('dsh', `${this.bot.id}: closed`);
      } catch (e) {
        logWarn('dsh', `${this.bot.id}: close failed ${e?.message || e}`);
      }
    }
    emit(this.bot.id, { type: 'status', status: botStatus(this.bot.id) });
  }
}

function blocksToText(content, want = 'text') {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === want)
    .map((b) => (want === 'text' ? b.text : b.text || b.summary || ''))
    .filter(Boolean)
    .join('\n');
}

// ---------- 对外 API ----------

export function getRuntime(botId) {
  return running.get(botId) || null;
}

export async function ensureRuntime(botId) {
  const bot = getBot(botId);
  if (!bot) throw new Error(`没有这个机器人：${botId}`);
  let rt = running.get(botId);
  if (rt) {
    // 「关于我」被改过（界面里加了一条，或机器人自己 remember 了）：重启后新提示才生效
    if (rt.started && aboutMtime() > rt.aboutAt && !rt.busyConversationId) {
      log('dsh', `${botId}: 关于我变了，重启进程以带上新记忆`);
      await rt.stop();
      rt = null;
    } else {
      return rt;
    }
  }
  rt = new BotRuntime(bot);
  running.set(botId, rt);
  return rt;
}

/** 发一条消息给某个机器人，返回最终文本 */
export async function sendToBot({ botId, conversationId, sessionId, text, channel = 'app', attachments = [], onProgress }) {
  const bot = getBot(botId);
  if (!bot) throw new Error(`没有这个机器人：${botId}`);
  const rt = await ensureRuntime(botId);
  rt.bot = bot;
  try {
    return await rt.runTurn({ conversationId, sessionId, text, channel, attachments, onProgress });
  } catch (e) {
    // 用户点了停止：把进程崩溃那种报错翻译掉，别让界面显示「出错」
    if (rt.abortInfo && (!rt.abortInfo.conversationId || rt.abortInfo.conversationId === conversationId)) {
      const err = new Error('已停止');
      err.code = 'aborted';
      throw err;
    }
    throw e;
  }
}

/**
 * 把某个会话的权限预设切一下（DSH 原生命令 /permission）。
 * 观察模式用它真的把会话降到只读，而不是只在提示词里求模型别动手。
 */
export async function setSessionPermission({ botId, sessionId, preset }) {
  const rt = await ensureRuntime(botId);
  await rt.ensureStarted({ conversationId: null, channel: 'schedule' });
  const session = rt.harness.session(sessionId || undefined);
  const r = await session.run(`/permission ${preset}`);
  log('dsh', `${botId}: permission -> ${preset}${sessionId ? ` (${sessionId})` : ''}`);
  return { text: r?.finalResponse || '', sessionId: r?.sessionId || sessionId || null };
}

export async function stopBot(botId) {
  const rt = running.get(botId);
  if (!rt) return false;
  await rt.stop();
  return true;
}

/** 模型/权限/人设改了：停掉进程，下次发消息用新配置 */
export async function restartBot(botId) {
  await stopBot(botId);
}

export async function stopAll() {
  await Promise.all([...running.keys()].map((id) => stopBot(id)));
}

export function resolveBotApproval(botId, approvalId, allow, opts = {}) {
  const rt = running.get(botId);
  if (!rt) return false;
  return rt.resolveApproval(approvalId, allow, opts);
}

/** 停止这个机器人正在跑的这一轮 */
export async function abortTurn(botId) {
  const rt = running.get(botId);
  if (!rt || !rt.busyConversationId) return false;
  await rt.abort('用户点了停止');
  return true;
}

export { writePatch };























