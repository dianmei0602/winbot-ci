// 送达队列：主动消息（定时任务结果）先落盘，再按免打扰/每日上限决定什么时候真的发出去。
// 这样进程重启、断网、半夜触发都不会丢消息，也不会吵人。
import { openDb } from './db.js';
import { loadConfig } from './config.js';
import { newId, now, log, logWarn } from './util.js';

const MAX_ATTEMPTS = 8;

const row = (r) => r && {
  id: r.id,
  botId: r.bot_id,
  channel: r.channel,
  target: r.target,
  text: r.text,
  kind: r.kind,
  refId: r.ref_id,
  status: r.status,
  notBefore: r.not_before,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
  sentAt: r.sent_at,
};

/** 免打扰配置（默认 22:00–08:00） */
export function quietConfig() {
  const q = loadConfig().security?.quietHours || {};
  return { enabled: q.enabled !== false, from: q.from || '22:00', to: q.to || '08:00' };
}

/** 渠道每日主动消息上限；app 不限制 */
export function dailyCap(channel) {
  const caps = loadConfig().security?.proactiveDailyCap || {};
  const v = caps[channel];
  return typeof v === 'number' ? v : channel === 'app' ? 0 : 5;
}

const minutes = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
};

/** 现在是不是免打扰时段（跨午夜也算） */
export function inQuietHours(when = new Date()) {
  const q = quietConfig();
  if (!q.enabled) return false;
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === null || to === null || from === to) return false;
  const cur = when.getHours() * 60 + when.getMinutes();
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** 免打扰结束的时刻（不在免打扰里就返回 now） */
export function quietEndsAt(when = new Date()) {
  if (!inQuietHours(when)) return when.getTime();
  const q = quietConfig();
  const to = minutes(q.to) ?? 8 * 60;
  const end = new Date(when);
  end.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end.getTime() <= when.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export function enqueue({ botId, channel, target, text, kind = 'proactive', refId = null, notBefore = 0 }) {
  const d = openDb();
  const id = newId('out');
  d.prepare(
    `INSERT INTO outbox (id, bot_id, channel, target, text, kind, ref_id, status, not_before, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, botId, channel, target || null, String(text || ''), kind, refId, notBefore, now());
  log('outbox', `queued ${id} -> ${channel}${notBefore > Date.now() ? `（延迟到 ${new Date(notBefore).toLocaleString()}）` : ''}`);
  return { id };
}

/** 某个渠道今天已经主动发了多少条 */
export function sentToday(channel) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = openDb()
    .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE channel = ? AND status = 'sent' AND sent_at >= ? AND kind != 'reply'`)
    .get(channel, start.getTime());
  return r.c || 0;
}

export function queuedItems(channel = null) {
  const d = openDb();
  const rows = channel
    ? d.prepare(`SELECT * FROM outbox WHERE status = 'queued' AND channel = ? ORDER BY created_at`).all(channel)
    : d.prepare(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY created_at`).all();
  return rows.map(row);
}

export function dueItems(at = Date.now()) {
  return openDb()
    .prepare(`SELECT * FROM outbox WHERE status = 'queued' AND not_before <= ? ORDER BY created_at`)
    .all(at)
    .map(row);
}

export function markSent(id) {
  openDb().prepare(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`).run(now(), id);
}

export function markFailed(id, error) {
  const d = openDb();
  const cur = row(d.prepare('SELECT * FROM outbox WHERE id = ?').get(id));
  const attempts = (cur?.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    d.prepare(`UPDATE outbox SET status = 'dropped', attempts = ?, last_error = ? WHERE id = ?`).run(attempts, String(error).slice(0, 500), id);
    logWarn('outbox', `dropped ${id} after ${attempts} attempts: ${error}`);
    return;
  }
  // 指数退避：1、2、4… 分钟后再试
  const delay = Math.min(60, 2 ** (attempts - 1)) * 60_000;
  d.prepare(`UPDATE outbox SET attempts = ?, last_error = ?, not_before = ? WHERE id = ?`).run(
    attempts,
    String(error).slice(0, 500),
    now() + delay,
    id,
  );
}

export function dropItem(id, reason = '') {
  openDb().prepare(`UPDATE outbox SET status = 'dropped', last_error = ? WHERE id = ?`).run(reason.slice(0, 500), id);
}

/** 把一批消息合成一条（每日上限用） */
function digestText(items) {
  const parts = items.map((i) => i.text.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `今天还有 ${parts.length} 条，一起给你：\n\n${parts.map((p, n) => `${n + 1}. ${p}`).join('\n\n')}`;
}

/**
 * 尝试把到期消息发出去。
 * deliver(channel, target, text) 由调用方注入，方便测试。
 * 返回 { sent, held, failed }。
 */
export async function flush({ deliver, at = Date.now() } = {}) {
  if (typeof deliver !== 'function') return { sent: 0, held: 0, failed: 0 };
  const items = dueItems(at);
  if (!items.length) return { sent: 0, held: 0, failed: 0 };
  const byChannel = new Map();
  for (const it of items) {
    if (!byChannel.has(it.channel)) byChannel.set(it.channel, []);
    byChannel.get(it.channel).push(it);
  }
  let sent = 0;
  let held = 0;
  let failed = 0;
  for (const [channel, list] of byChannel) {
    if (inQuietHours(new Date(at))) {
      held += list.length;
      continue;
    }
    const cap = dailyCap(channel);
    const used = sentToday(channel);
    // 每条都要重新扣配额，不能一次算完就整批发出去
    let remaining = cap > 0 ? Math.max(0, cap - used) : Infinity;
    for (const it of list) {
      if (!it.target) {
        dropItem(it.id, '没有发送目标');
        continue;
      }
      if (remaining <= 0) {
        held += 1;
        continue;
      }
      try {
        await deliver(it.channel, it.target, it.text);
        markSent(it.id);
        sent += 1;
        remaining -= 1;
      } catch (e) {
        markFailed(it.id, e?.message || String(e));
        failed += 1;
      }
    }
    // 还有没发的：合成一条，排到明天早上，免得一天里反复打扰
    if (remaining <= 0) {
      const pending = queuedItems(channel).filter((p) => p.notBefore <= at);
      if (pending.length > 1) {
        const first = pending[0];
        openDb()
          .prepare(`UPDATE outbox SET text = ?, not_before = ? WHERE id = ?`)
          .run(digestText(pending), nextDayStart(at), first.id);
        for (const p of pending.slice(1)) dropItem(p.id, '已合并进 digest');
        log('outbox', `${channel} 超过每日上限，${pending.length} 条合成 1 条排到明天`);
      }
    }
  }
  if (sent || failed) log('outbox', `flush: sent=${sent} held=${held} failed=${failed}`);
  return { sent, held, failed };
}

function nextDayStart(at) {
  const d = new Date(at);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}
