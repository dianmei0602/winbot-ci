// 轻量迁移：老库加字段/建新表，不动已有数据。
// 放在 db.js 里 openDb() 末尾调用，启动即生效。
import { now } from './util.js';

const SCHEDULE_COLUMNS = [
  ['mode', "TEXT NOT NULL DEFAULT 'act'"], // act | observe
  ['run_budget_tokens', 'INTEGER NOT NULL DEFAULT 0'], // 0 = 不限
  ['month_budget_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['month_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['month_key', 'TEXT'], // 2026-11，用来按月重置
  ['failures', 'INTEGER NOT NULL DEFAULT 0'],
  ['paused_reason', 'TEXT'], // failures | budget | user
  ['quiet_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['last_would_say', 'TEXT'], // 观察模式下「本来会说什么」
];

export function migrate(db) {
  migrateSchedules(db);
  createOutbox(db);
  createGroups(db);
  migrateGroups(db);
  migrateConversations(db);
}

function createGroups(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bot_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- 群聊里每个机器人有自己的 DSH 会话，互不干扰
    CREATE TABLE IF NOT EXISTS group_sessions (
      group_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT,
      PRIMARY KEY (group_id, bot_id)
    );
  `);
}

function migrateGroups(db) {
  const have = columns(db, 'groups');
  if (!have.has('router')) db.exec("ALTER TABLE groups ADD COLUMN router TEXT DEFAULT 'rules'");
}

function migrateConversations(db) {
  const have = columns(db, 'conversations');
  if (!have.has('group_id')) db.exec('ALTER TABLE conversations ADD COLUMN group_id TEXT');
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

function migrateSchedules(db) {
  const have = columns(db, 'schedules');
  for (const [name, ddl] of SCHEDULE_COLUMNS) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE schedules ADD COLUMN ${name} ${ddl}`);
  }
}

function createOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'proactive',   -- schedule | digest | reply
      ref_id TEXT,                                -- 关联的规则/会话
      status TEXT NOT NULL DEFAULT 'queued',      -- queued | sent | dropped
      not_before INTEGER NOT NULL DEFAULT 0,      -- 免打扰结束前不发
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, not_before);
  `);
}

