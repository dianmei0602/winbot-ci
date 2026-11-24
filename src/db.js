// 本地 SQLite：会话、消息、审批。只在本机 data/winbot.db。
// 会话的「模型侧历史」在 DSH 自己的会话日志里（data/dsh/<botId>/sessions），
// 这里只存给人看的副本和审批记录，便于界面展示与跨渠道续聊。
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ensureDirs, now, newId } from './util.js';
import { migrate } from './db-migrate.js';

let db = null;

export function openDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'app',
      external_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_bot ON conversations(bot_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conv_ext ON conversations(channel, external_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      conversation_id TEXT,
      session_id TEXT,
      tool TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'app',
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_approval_pending ON approvals(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 每次模型调用的 token 记账：界面的「上下文用量」和以后的预算都靠它
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_conv ON usage(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id, created_at);

    -- 定时规则：到点让某个机器人跑一轮，结果回到它自己的会话/渠道
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'daily',      -- daily | weekly | interval
      at TEXT DEFAULT '08:00',                 -- daily / weekly 的时刻
      days TEXT NOT NULL DEFAULT '[]',         -- weekly 的星期（0=周日）
      every_minutes INTEGER DEFAULT 60,        -- interval 的间隔
      channel TEXT NOT NULL DEFAULT 'app',     -- app | telegram | slack | discord
      target TEXT,                             -- 渠道里的 chat/channel id
      conversation_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,
      last_result TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_next ON schedules(enabled, next_run_at);
  `);
  migrate(db);
  return db;
}

const convRow = (r) =>
  r && {
    id: r.id,
    botId: r.bot_id,
    title: r.title,
    channel: r.channel,
    externalId: r.external_id,
    sessionId: r.session_id,
    groupId: r.group_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function createConversation({ botId, title = '', channel = 'app', externalId = null, groupId = null }) {
  const d = openDb();
  const id = newId('conv');
  const t = now();
  d.prepare(
    `INSERT INTO conversations (id, bot_id, title, channel, external_id, group_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, botId, title, channel, externalId, groupId, t, t);
  return convRow(d.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
}

/** 群聊里换发言人：把会话的 bot_id 改成当前说话的那个 */
export function setConversationSpeaker(conversationId, botId) {
  openDb().prepare('UPDATE conversations SET bot_id = ?, updated_at = ? WHERE id = ?').run(botId, now(), conversationId);
}

export function getConversation(id) {
  return convRow(openDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id));
}

export function findConversation({ channel, externalId }) {
  return convRow(
    openDb()
      .prepare('SELECT * FROM conversations WHERE channel = ? AND external_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(channel, externalId),
  );
}

export function lastMessageOf(botId) {
  const row = openDb()
    .prepare(
      `SELECT m.content, m.role, m.created_at FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.bot_id = ? ORDER BY m.created_at DESC LIMIT 1`,
    )
    .get(botId);
  if (!row) return null;
  return { text: String(row.content || '').slice(0, 120), role: row.role, at: row.created_at };
}

export function listConversations(botId, limit = 50) {
  return openDb()
    .prepare('SELECT * FROM conversations WHERE bot_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(botId, limit)
    .map(convRow);
}

export function touchConversation(id, patch = {}) {
  const d = openDb();
  const cur = getConversation(id);
  if (!cur) return null;
  const next = {
    title: patch.title ?? cur.title,
    session_id: patch.sessionId ?? cur.sessionId,
    updated_at: now(),
  };
  d.prepare('UPDATE conversations SET title = ?, session_id = ?, updated_at = ? WHERE id = ?').run(
    next.title,
    next.session_id,
    next.updated_at,
    id,
  );
  return getConversation(id);
}

export function deleteConversation(id) {
  openDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

const msgRow = (r) =>
  r && {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    meta: safeJson(r.meta),
    createdAt: r.created_at,
  };

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function addMessage({ conversationId, role, content, meta = {} }) {
  const d = openDb();
  const id = newId('msg');
  const t = now();
  d.prepare('INSERT INTO messages (id, conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    conversationId,
    role,
    String(content ?? ''),
    JSON.stringify(meta ?? {}),
    t,
  );
  d.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conversationId);
  return { id, conversationId, role, content, meta, createdAt: t };
}

export function listMessages(conversationId, limit = 500) {
  return openDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ?')
    .all(conversationId, limit)
    .map(msgRow);
}

/** 原地改一条消息的 meta（审批卡状态这类），不新增消息 */
export function updateMessageMeta(id, meta) {
  openDb().prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta ?? {}), id);
}

export function searchMessages(q, { limit = 50, botId = null } = {}) {
  const like = `%${String(q).replace(/[%_]/g, '')}%`;
  const d = openDb();
  const rows = botId
    ? d
        .prepare(
          `SELECT m.*, c.bot_id, c.title, c.channel FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.content LIKE ? AND c.bot_id = ? ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(like, botId, limit)
    : d
        .prepare(
          `SELECT m.*, c.bot_id, c.title, c.channel FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(like, limit);
  return rows.map((r) => ({ ...msgRow(r), botId: r.bot_id, title: r.title, channel: r.channel }));
}

// ---------- 审批 ----------

export function createApproval({ botId, conversationId, sessionId, tool, detail, reason, channel = 'app' }) {
  const d = openDb();
  const id = newId('appr');
  d.prepare(
    `INSERT INTO approvals (id, bot_id, conversation_id, session_id, tool, detail, reason, channel, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, botId, conversationId, sessionId, tool, detail || '', reason || '', channel, now());
  return getApproval(id);
}

const apprRow = (r) =>
  r && {
    id: r.id,
    botId: r.bot_id,
    conversationId: r.conversation_id,
    sessionId: r.session_id,
    tool: r.tool,
    detail: r.detail,
    reason: r.reason,
    channel: r.channel,
    status: r.status,
    answer: r.answer,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };

export function getApproval(id) {
  return apprRow(openDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id));
}

export function pendingApprovals(botId = null) {
  const d = openDb();
  const rows = botId
    ? d.prepare("SELECT * FROM approvals WHERE status = 'pending' AND bot_id = ? ORDER BY created_at").all(botId)
    : d.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all();
  return rows.map(apprRow);
}

export function answerApproval(id, answer, status) {
  const d = openDb();
  d.prepare('UPDATE approvals SET status = ?, answer = ?, answered_at = ? WHERE id = ? AND status = ?').run(
    status,
    answer || '',
    now(),
    id,
    'pending',
  );
  return getApproval(id);
}

export function expireApprovals(reason = '运行时已结束') {
  openDb()
    .prepare("UPDATE approvals SET status = 'cancelled', answer = ?, answered_at = ? WHERE status = 'pending'")
    .run(reason, now());
}

// ---------- 未完成的会话 ----------

/**
 * 最后一条消息是用户发的（没有回复也没有报错）——说明进程在它处理中间退出了。
 * 启动时给这些会话补一条提示，请用户重发，而不是让它沉默。
 */
export function danglingUserConversations(withinDays = 14) {
  const since = now() - withinDays * 86_400_000;
  const rows = openDb()
    .prepare(
      `SELECT c.id, c.bot_id, c.title FROM conversations c
       WHERE c.updated_at >= ?
         AND (SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) = 'user'`,
    )
    .all(since);
  return rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title }));
}

// ---------- 群聊 ----------

const groupRow = (r) =>
  r && {
    id: r.id,
    name: r.name,
    botIds: safeJson(r.bot_ids),
    router: r.router === 'model' ? 'model' : 'rules',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export function listGroups() {
  return openDb()
    .prepare('SELECT * FROM groups ORDER BY updated_at DESC')
    .all()
    .map(groupRow);
}

export function getGroup(id) {
  return groupRow(openDb().prepare('SELECT * FROM groups WHERE id = ?').get(id));
}

export function insertGroup({ id, name, botIds }) {
  const t = now();
  openDb()
    .prepare('INSERT INTO groups (id, name, bot_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, JSON.stringify(botIds), t, t);
  return getGroup(id);
}

export function updateGroup(id, patch) {
  const cur = getGroup(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  openDb()
    .prepare('UPDATE groups SET name = ?, bot_ids = ?, router = ?, updated_at = ? WHERE id = ?')
    .run(next.name, JSON.stringify(next.botIds || []), next.router === 'model' ? 'model' : 'rules', now(), id);
  return getGroup(id);
}

export function deleteGroup(id) {
  openDb().prepare('DELETE FROM groups WHERE id = ?').run(id);
  openDb().prepare('DELETE FROM group_sessions WHERE group_id = ?').run(id);
}

/** 群聊的那条会话（一个群一条，消息共享） */
export function groupConversation(groupId) {
  const row = openDb()
    .prepare("SELECT * FROM conversations WHERE group_id = ? AND channel = 'group' ORDER BY created_at LIMIT 1")
    .get(groupId);
  return convRow(row);
}

export function getGroupSession(groupId, botId) {
  const row = openDb().prepare('SELECT session_id FROM group_sessions WHERE group_id = ? AND bot_id = ?').get(groupId, botId);
  return row?.session_id || null;
}

export function setGroupSession(groupId, botId, sessionId) {
  openDb()
    .prepare(
      'INSERT INTO group_sessions (group_id, bot_id, session_id) VALUES (?, ?, ?) ON CONFLICT(group_id, bot_id) DO UPDATE SET session_id = excluded.session_id',
    )
    .run(groupId, botId, sessionId);
}

// ---------- 用量 ----------

export function addUsage({ conversationId, botId, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) {
  openDb()
    .prepare(
      `INSERT INTO usage (conversation_id, bot_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(conversationId, botId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, now());
}

export function conversationUsage(conversationId) {
  const r = openDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COALESCE(SUM(cache_write_tokens),0) AS cacheWrite,
              COUNT(*) AS turns
       FROM usage WHERE conversation_id = ?`,
    )
    .get(conversationId);
  return { inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite, turns: r.turns };
}

export function botUsageToday(botId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = openDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COUNT(*) AS turns
       FROM usage WHERE bot_id = ? AND created_at >= ?`,
    )
    .get(botId, start.getTime());
  return {
    inputTokens: r.input,
    outputTokens: r.output,
    cacheReadTokens: r.cacheRead,
    totalTokens: r.input + r.output + r.cacheRead,
    turns: r.turns,
  };
}

// ---------- 定时规则 ----------

const schedRow = (r) =>
  r && {
    id: r.id,
    botId: r.bot_id,
    title: r.title,
    prompt: r.prompt,
    kind: r.kind,
    at: r.at,
    days: safeJson(r.days),
    everyMinutes: r.every_minutes,
    channel: r.channel,
    target: r.target,
    conversationId: r.conversation_id,
    enabled: !!r.enabled,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastResult: r.last_result,
    createdAt: r.created_at,
    // 分寸相关
    mode: r.mode || 'act',
    runBudgetTokens: r.run_budget_tokens || 0,
    monthBudgetTokens: r.month_budget_tokens || 0,
    monthTokens: r.month_tokens || 0,
    monthKey: r.month_key || null,
    failures: r.failures || 0,
    pausedReason: r.paused_reason || null,
    quietEnabled: r.quiet_enabled !== 0,
    lastWouldSay: r.last_would_say || null,
  };

export function listSchedules(botId = null) {
  const d = openDb();
  const rows = botId
    ? d.prepare('SELECT * FROM schedules WHERE bot_id = ? ORDER BY created_at').all(botId)
    : d.prepare('SELECT * FROM schedules ORDER BY created_at').all();
  return rows.map(schedRow);
}

export function getSchedule(id) {
  return schedRow(openDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

export function insertSchedule(s) {
  const d = openDb();
  d.prepare(
    `INSERT INTO schedules (id, bot_id, title, prompt, kind, at, days, every_minutes, channel, target, conversation_id,
       enabled, next_run_at, created_at, mode, run_budget_tokens, month_budget_tokens, month_tokens, month_key, quiet_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.botId,
    s.title || '',
    s.prompt,
    s.kind,
    s.at || '08:00',
    JSON.stringify(s.days || []),
    s.everyMinutes || 60,
    s.channel || 'app',
    s.target || null,
    s.conversationId || null,
    1,
    s.nextRunAt,
    now(),
    s.mode || 'act',
    s.runBudgetTokens || 0,
    s.monthBudgetTokens || 0,
    0,
    monthKey(),
    s.quietEnabled === false ? 0 : 1,
  );
  return getSchedule(s.id);
}

export function monthKey(when = new Date()) {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
}

export function updateSchedule(id, patch) {
  const cur = getSchedule(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  openDb()
    .prepare(
      `UPDATE schedules SET title = ?, prompt = ?, kind = ?, at = ?, days = ?, every_minutes = ?,
        channel = ?, target = ?, conversation_id = ?, enabled = ?, next_run_at = ?,
        mode = ?, run_budget_tokens = ?, month_budget_tokens = ?, month_tokens = ?, month_key = ?,
        failures = ?, paused_reason = ?, quiet_enabled = ?, last_would_say = ? WHERE id = ?`,
    )
    .run(
      next.title,
      next.prompt,
      next.kind,
      next.at,
      JSON.stringify(next.days || []),
      next.everyMinutes,
      next.channel,
      next.target,
      next.conversationId,
      next.enabled ? 1 : 0,
      next.nextRunAt,
      next.mode,
      next.runBudgetTokens || 0,
      next.monthBudgetTokens || 0,
      next.monthTokens || 0,
      next.monthKey || monthKey(),
      next.failures || 0,
      next.pausedReason || null,
      next.quietEnabled ? 1 : 0,
      next.lastWouldSay || null,
      id,
    );
  return getSchedule(id);
}

export function markScheduleRun(id, { at, status, result, nextRunAt, tokens = 0, wouldSay = null }) {
  const cur = getSchedule(id);
  const thisMonth = monthKey();
  const monthTokens = (cur?.monthKey === thisMonth ? cur.monthTokens || 0 : 0) + tokens;
  openDb()
    .prepare(
      `UPDATE schedules SET last_run_at = ?, last_status = ?, last_result = ?, next_run_at = ?,
        month_tokens = ?, month_key = ?, last_would_say = ? WHERE id = ?`,
    )
    .run(at, status, result ?? null, nextRunAt, monthTokens, thisMonth, wouldSay, id);
  return getSchedule(id);
}

export function resetScheduleMonth(id) {
  openDb().prepare('UPDATE schedules SET month_tokens = 0, month_key = ? WHERE id = ?').run(monthKey(), id);
  return getSchedule(id);
}

export function deleteSchedule(id) {
  openDb().prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

// ---------- 渠道状态（Telegram offset 之类） ----------

export function getState(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM channel_state WHERE key = ?').get(key);
  if (!row) return fallback;
  return safeJson(row.value);
}

export function setState(key, value) {
  openDb()
    .prepare('INSERT INTO channel_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}





