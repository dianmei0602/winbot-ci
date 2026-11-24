// Codex 内核：每个机器人一个 `codex exec --json` 子进程。
//
// 和 DSH 后端并列，不是替换：这里同样只做「配置翻译 + 收发消息 + 事件映射」，
// 工具、沙箱、会话线程都交给 Codex 自己。
//
// 三条设计约束（都踩过）：
//   1. 绝不写全局 ~/.codex/config.toml —— Codex 桌面版和 Codex++ 都在用它，
//      写它会互相打架。每个机器人用 data/codex/<botId>/ 当独立 CODEX_HOME。
//   2. Codex 从 0.84 起只认 Responses 协议（chat/completions 已在 2026-02 移除，
//      见 openai/codex discussion #7782），provider 必须写 wire_api = "responses"。
//   3. DeepSeek 官方 /v1/responses 可用；本机 DSH 登录态的令牌只认 x-dsh-auth-token
//      请求头（Authorization: Bearer 会 401），所以 token 进 http_headers 而不进 env_key。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR, ensureDir, log, logWarn, truncate, writeText, bytesHuman } from './util.js';
import { providerById, providerReady } from './config.js';
import { ensureWorkspace, personaOf, identityBrief, workspaceOf } from './bots.js';
import { isDshAccountProvider, readDshDeepSeekToken } from './dsh-account.js';
import { aboutForPrompt, aboutMtime } from './about.js';
import { touchConversation, botUsageToday } from './db.js';

// Codex 一轮最长跑多久：超时直接掐掉，不然界面会一直转圈
export const CODEX_TURN_TIMEOUT_MS = Number(process.env.WINBOT_CODEX_TIMEOUT_MS || 30 * 60_000);

// Responses 协议下，DeepSeek 账号令牌（DSH 登录态）走这个头
const DSH_TOKEN_HEADER = 'x-dsh-auth-token';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** 找 codex 可执行文件：环境变量 → PATH → Codex 桌面版自带的 bin 目录 */
export function resolveCodexBin() {
  const fromEnv = process.env.WINBOT_CODEX_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  // 桌面版/CLI 常驻位置：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(base, entry.name, 'codex.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  } catch {
    /* 没装桌面版就算了 */
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, 'codex.exe');
    if (fs.existsSync(exe)) candidates.push(exe);
  }
  // 多个版本时取修改时间最新的
  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0] || null;
}

/** TOML 字符串：直接用 JSON 转义，两边语法在这一层通用 */
const tomlStr = (v) => JSON.stringify(String(v));

/**
 * 生成这个机器人的 Codex 配置（独立 CODEX_HOME 里的 config.toml）。
 * 返回 { base_url, wire_api, headers } 以便调用方排查。
 */
function writeCodexConfig(bot, prov, model, home) {
  const headers = {};
  let baseURL = String(prov.baseURL || '').replace(/\/+$/, '');
  if (isDshAccountProvider(prov)) {
    const token = readDshDeepSeekToken();
    if (!token) throw new Error('读不到本机 DSH 的 DeepSeek 登录态：请先在 DSH 里登录一次');
    headers[DSH_TOKEN_HEADER] = token;
    // 账号接口的 baseURL 是站点根（https://api.deepseek.com），但 Responses 在 /v1 下；
    // 登录态只对 DeepSeek 官方域名有效
    if (!/\/v\d+$/.test(baseURL)) baseURL = `${baseURL || 'https://api.deepseek.com'}/v1`;
  } else if (prov.apiKey) {
    headers.authorization = `Bearer ${prov.apiKey}`;
  } else if (!prov.noKey) {
    throw new Error(`接口「${prov.name || prov.id}」没有 API Key`);
  }

  const lines = [
    `# winbot 自动生成，请勿手改（机器人 ${bot.id}）`,
    `model = ${tomlStr(model)}`,
    'model_provider = "winbot"',
    // 不把请求留在 OpenAI 侧做后台存储；Codex 新版已忽略这个字段，但旧版本仍认
    'model_reasoning_effort = "high"',
    '',
    '[model_providers.winbot]',
    'name = "winbot"',
    `base_url = ${tomlStr(baseURL)}`,
    // 只有 Responses 一种协议可用；写 chat 会直接启动失败
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[model_providers.winbot.http_headers]',
    ...Object.entries(headers).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`),
    '',
  ];
  writeText(path.join(home, 'config.toml'), lines.join('\n'));
  return { baseURL, headers: Object.keys(headers) };
}

/**
 * 人设写进 CODEX_HOME/AGENTS.md：Codex 会把它当全局指令读，
 * 等价于 DSH 后端的 system-prompt.personaPrefix（不拼进用户消息）。
 */
function writeCodexAgents(bot, home) {
  const about = aboutForPrompt();
  const text = [
    personaOf(bot.id).trim(),
    identityBrief(bot),
    about ? `【关于我（共享记忆，所有机器人都能看到）】\n${about}` : '',
    '【汇报文件位置时】一律写工作区相对路径（如 outputs/images/a.png），不要贴 E:\\... 这种绝对路径。除非用户明确要完整路径。',
    '【长期记忆】值得跨对话记住的事写在工作区根目录的 MEMORY.md，一行一条；需要时自己读。',
  ]
    .filter(Boolean)
    .join('\n\n');
  writeText(path.join(home, 'AGENTS.md'), text);
}

/** 把「文字 + 工作区里的附件」变成 Codex 的入参：图片走 -i，其它文件在正文点名路径 */
function buildCodexInput(bot, text, attachments = []) {
  const ws = ensureWorkspace(bot.id);
  const root = fs.realpathSync(ws);
  const images = [];
  const notes = [];
  for (const rel of attachments) {
    let real;
    try {
      real = fs.realpathSync(path.resolve(ws, rel));
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    const ext = path.extname(real).toLowerCase();
    const stat = fs.statSync(real);
    if (IMAGE_EXT.has(ext) && stat.size <= 20 * 1024 * 1024) {
      images.push(real);
      notes.push(`[图片] ${rel}`);
    } else {
      notes.push(`[文件] ${rel}（${bytesHuman(stat.size)}）`);
    }
  }
  const prompt = [text, ...notes, notes.length ? '（附件都在这个机器人的工作区里，需要时用命令打开）' : '']
    .filter(Boolean)
    .join('\n');
  return { prompt, images };
}

/** Codex 工具条目 → winbot 的工具展示（名字 + 一行摘要） */
function describeItem(item) {
  switch (item.type) {
    case 'command_execution':
      return { name: '执行命令', args: truncate(String(item.command || ''), 400) };
    case 'file_change': {
      const files = (item.changes || []).map((c) => c.path).filter(Boolean);
      return { name: '改文件', args: truncate(files.join(', '), 400) };
    }
    case 'mcp_tool_call':
      return { name: `mcp__${item.server || '?'}__${item.tool || '?'}`, args: truncate(JSON.stringify(item.arguments || {}), 400) };
    case 'web_search':
      return { name: '联网搜索', args: truncate(String(item.query || ''), 400) };
    default:
      return { name: item.type || '工具', args: '' };
  }
}

function itemIsFailed(item) {
  return item.status === 'failed' || item.status === 'declined' || !!item.error;
}

function itemResult(item) {
  if (item.type === 'command_execution') return String(item.aggregated_output || '');
  if (item.type === 'mcp_tool_call') return String(item.result || item.error || '');
  if (item.type === 'file_change') return (item.changes || []).map((c) => `${c.kind || ''} ${c.path || ''}`).join('\n');
  if (item.type === 'web_search') return String(item.result || item.query || '');
  return '';
}

export class CodexRuntime {
  constructor(bot, { emit } = {}) {
    this.bot = bot;
    this.emitFn = emit || (() => {});
    this.started = false;
    this.busyConversationId = null;
    this.currentTurn = null;
    this.providerId = bot.providerId;
    this.model = bot.model;
    this.startedAt = Date.now();
    this.pid = null;
    this.aboutAt = 0;
    this.abortInfo = null;
    // Codex 的沙箱在进程启动时定，中途改不了；定时任务的「观察模式」用它给下一轮换权限
    this.nextPreset = null;
    this.child = null;
  }

  get home() {
    return path.join(DATA_DIR, 'codex', this.bot.id);
  }

  get engine() {
    return 'codex';
  }

  emit(event) {
    this.emitFn(this.bot.id, event);
  }

  /** 三档权限 → Codex 的沙箱（同名同义，直接对映） */
  sandboxMode() {
    const p = this.nextPreset || this.bot.permission;
    if (p === 'readonly' || p === 'read-only') return 'read-only';
    if (p === 'danger-full-access' || p === 'full') return 'danger-full-access';
    return 'workspace-write';
  }

  async ensureStarted(turnContext) {
    if (this.started) {
      // 人设/关于我改过：停一下，下次拉起带上新内容（与 DSH 后端一致的行为）
      if (aboutMtime() > this.aboutAt && !this.busyConversationId) {
        log('codex', `${this.bot.id}: 关于我变了，重启进程以带上新记忆`);
        await this.stop();
      } else {
        return;
      }
    }
    const codexBin = resolveCodexBin();
    if (!codexBin) {
      throw new Error('没找到 Codex：请先安装 Codex CLI 或桌面版，或在环境变量 WINBOT_CODEX_BIN 里写完整路径');
    }
    const prov = providerById(this.bot.providerId) || defaultProvider();
    if (!prov) throw new Error('还没有可用的模型接口：请先在「设置 → 模型接口」里填一个 API Key');
    if (!providerReady(prov)) {
      throw new Error(
        isDshAccountProvider(prov)
          ? '这个接口用的是本机 DSH 的登录态，但现在没读到登录信息：请先在 DSH 里登录一次'
          : `接口「${prov.name}」没有 API Key`,
      );
    }
    const model = this.bot.model && (prov.models || []).includes(this.bot.model) ? this.bot.model : (prov.models || [])[0];
    if (!model) throw new Error(`接口「${prov.name}」没有配置模型`);
    this.providerId = prov.id;
    this.model = model;

    ensureDir(this.home);
    writeCodexConfig(this.bot, prov, model, this.home);
    writeCodexAgents(this.bot, this.home);

    this.codexBin = codexBin;
    this.started = true;
    this.turnContext = turnContext;
    this.aboutAt = aboutMtime();
    log('codex', `${this.bot.id}: ready ${prov.id}/${model} home=${this.home}`);
    this.emit({ type: 'status', status: { state: 'running', pid: null, providerId: prov.id, model, busy: false } });
  }

  /**
   * 跑一轮：拉起一个 codex exec 子进程，边读 JSONL 边广播，直到这一轮结束。
   * 返回 { text, sessionId, usage, presented, events }（与 DSH 后端同形）。
   */
  async runTurn({ conversationId, sessionId, text, channel, attachments = [], onProgress }) {
    // 每日预算：聊天和定时任务都算，超了就停
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

    const ctx = {
      conversationId,
      channel,
      sessionId,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      presented: [],
      toolNames: new Map(),
      finalText: '',
      threadId: sessionId || null,
      failed: null,
      toolSeq: 0,
    };
    this.currentTurn = ctx;
    this.emit({ type: 'status', status: { state: 'running', providerId: this.providerId, model: this.model, busy: true } });

    const { prompt, images } = buildCodexInput(this.bot, text, attachments);
    try {
      await this.spawnTurn({ ctx, prompt, images, onProgress });
    } finally {
      this.busyConversationId = null;
      this.currentTurn = null;
      this.child = null;
      this.pid = null;
      // 这一轮的权限覆盖用完就撤，避免手动聊天残留只读
      this.nextPreset = null;
      this.emit({ type: 'status', status: { state: 'running', providerId: this.providerId, model: this.model, busy: false } });
    }

    if (ctx.failed) throw new Error(ctx.failed);
    if (ctx.threadId) {
      ctx.sessionId = ctx.threadId;
      touchConversation(conversationId, { sessionId: ctx.threadId });
    }
    return {
      text: ctx.finalText,
      sessionId: ctx.threadId,
      usage: ctx.usage,
      presented: ctx.presented,
      events: [],
    };
  }

  /** 真正拉起子进程并读完事件流 */
  spawnTurn({ ctx, prompt, images, onProgress }) {
    const ws = ensureWorkspace(this.bot.id);
    const args = ['exec', '--json', '-C', ws, '-s', this.sandboxMode(), '--skip-git-repo-check'];
    for (const img of images) args.push('-i', img);
    // 续上一轮的线程；没有就新开。prompt 一律走 stdin（' - '），避免命令行长度和引号问题
    if (ctx.sessionId) {
      args.push('resume', ctx.sessionId, '-');
    } else {
      args.push('-');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(this.codexBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ws,
        env: { ...process.env, CODEX_HOME: this.home, ELECTRON_RUN_AS_NODE: undefined },
        windowsHide: true,
      });
      this.child = child;
      this.pid = child.pid || null;
      log('codex', `${this.bot.id}: exec pid=${this.pid} sandbox=${this.sandboxMode()}${ctx.sessionId ? ` resume=${ctx.sessionId}` : ''}`);

      const timer = setTimeout(() => {
        logWarn('codex', `${this.bot.id}: 超过 ${Math.round(CODEX_TURN_TIMEOUT_MS / 60000)} 分钟没结束，掐掉`);
        this.killTree(child);
      }, CODEX_TURN_TIMEOUT_MS);
      timer.unref?.();

      let buf = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) this.onLine(line, ctx, onProgress);
        }
      });
      child.stderr.on('data', (d) => {
        // Codex 会把进度、重试、警告写 stderr，只留最后一段给报错用
        stderr = (stderr + d.toString('utf8')).slice(-4000);
      });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`启动 Codex 失败：${e?.message || e}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 最后一行可能没带换行
        const tail = buf.trim();
        if (tail) this.onLine(tail, ctx, onProgress);
        if (code === 0) {
          resolve();
          return;
        }
        if (this.abortInfo) {
          resolve(); // 用户主动停的，交给 sendToBot 翻译成「已停止」
          return;
        }
        const hint = stderr.split('\n').filter(Boolean).slice(-4).join(' ');
        reject(new Error(`Codex 退出（${code}）${hint ? `：${truncate(hint, 300)}` : ''}`));
      });

      // prompt 走 stdin；写完就关，Codex 会读到底
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (e) {
        logWarn('codex', `${this.bot.id}: 写 stdin 失败 ${e?.message || e}`);
      }
    });
  }

  /** 一行 JSONL → winbot 事件 */
  onLine(line, ctx, onProgress) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（个别版本会打普通日志）忽略
    }
    const type = ev?.type;

    if (type === 'thread.started') {
      if (ev.thread_id) ctx.threadId = String(ev.thread_id);
      return;
    }
    if (type === 'turn.completed') {
      const u = ev.usage || {};
      ctx.usage.inputTokens += Number(u.input_tokens) || 0;
      ctx.usage.outputTokens += Number(u.output_tokens) || 0;
      ctx.usage.cacheReadTokens += Number(u.cached_input_tokens) || 0;
      return;
    }
    if (type === 'turn.failed') {
      ctx.failed = String(ev.error?.message || 'Codex 这一轮失败了');
      return;
    }
    if (type === 'error') {
      // 「Model metadata not found」这类警告也走 error 事件，不当成失败
      const msg = String(ev.message || '');
      if (msg && !/Model metadata/i.test(msg)) logWarn('codex', `${this.bot.id}: ${truncate(msg, 200)}`);
      return;
    }
    if (type !== 'item.completed' && type !== 'item.started' && type !== 'item.updated') return;

    const item = ev.item;
    if (!item || !item.type) return;

    if (item.type === 'agent_message') {
      const t = String(item.text || '');
      if (t) {
        ctx.finalText = t; // 一轮可能有多条，最后一条就是最终答复
        this.emit({ type: 'assistant-step', conversationId: ctx.conversationId, text: t, reasoning: '' });
        onProgress?.({ kind: 'text', text: t });
      }
      return;
    }
    if (item.type === 'reasoning') {
      const t = String(item.text || item.summary || '');
      if (t) this.emit({ type: 'assistant-step', conversationId: ctx.conversationId, text: '', reasoning: t });
      return;
    }
    if (item.type === 'todo_list') {
      // 待办清单不展开成工具步骤，只记一条，避免刷屏
      this.emit({ type: 'turn-status', conversationId: ctx.conversationId, status: 'todo' });
      return;
    }
    if (item.type === 'error') {
      const msg = String(item.message || '');
      if (msg && !/Model metadata/i.test(msg)) logWarn('codex', `${this.bot.id}: item error ${truncate(msg, 160)}`);
      return;
    }

    // 其余都是工具类：命令、改文件、MCP、联网
    if (type !== 'item.completed') return;
    const { name, args } = describeItem(item);
    const callId = `codex-${++ctx.toolSeq}`;
    this.emit({
      type: 'tool-call',
      conversationId: ctx.conversationId,
      callId,
      name,
      args: truncate(args, 400),
    });
    onProgress?.({ kind: 'tool', callId, name, args: truncate(args, 400) });
    const isError = itemIsFailed(item);
    const raw = truncate(itemResult(item), 160);
    const ws = workspaceOf(this.bot.id);
    const clean = (s) => (ws ? String(s || '').split(ws).join('').replace(/^[\\/]+/, '') : String(s || ''));
    this.emit({
      type: 'tool-result',
      conversationId: ctx.conversationId,
      callId,
      name,
      isError,
      reason: isError ? truncate(String(item.error || item.status || ''), 200) : '',
      result: clean(raw),
    });
  }

  /** Windows 上杀进程树：codex 会再拉起子命令，只 kill 父进程会留孤儿 */
  killTree(child) {
    if (!child || child.killed) return;
    const pid = child.pid;
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  /** 停止这一轮：用户点「停止」或超时 */
  async abort(reason = '用户停止') {
    this.abortInfo = { conversationId: this.busyConversationId, reason, at: Date.now() };
    log('codex', `${this.bot.id}: abort requested (${reason})`);
    if (this.child) this.killTree(this.child);
  }

  async stop() {
    this.started = false;
    if (this.child) this.killTree(this.child);
    this.child = null;
    this.pid = null;
    this.busyConversationId = null;
    this.currentTurn = null;
    log('codex', `${this.bot.id}: stopped`);
  }

  /** Codex exec 不弹逐次审批：沙箱在启动时定死，越界由 Codex 自己拒绝。
   *  保留这个方法是为了让审批接口在后端之间同形（界面点旧卡片不会崩）。 */
  resolveApproval() {
    return false;
  }

  /**
   * 定时任务的「观察模式」用：给下一轮换权限。
   * Codex 的沙箱是进程级参数，所以只对紧随其后的那一轮生效。
   */
  async setPermission(preset) {
    if (this.busyConversationId) throw new Error('这个机器人还在跑这一轮，等结束再切权限');
    this.nextPreset = preset;
    return { preset };
  }
}
