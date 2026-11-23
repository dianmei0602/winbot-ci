// 定时规则：到点让某个机器人跑一轮，结果回到它自己的会话（或指定渠道）。
// 调度用的是「每 30 秒扫一次到期项」，比链式 setTimeout 更能扛住休眠、时钟跳变和进程重启。
//
// 这里的重点是「分寸」：
//   - 预算：单次 / 每月 token 上限，超了自动暂停，不会悄悄烧钱
//   - 观察模式：只读地跑一遍，只记下「本来会说什么」，不发不动
//   - 免打扰：夜里只排队，不推送
//   - 每日上限：主动消息太多时合成一条，明天再发
//   - 失败暂停：连续 3 次出错就停下等你处理
import {
  addMessage,
  addUsage,
  createConversation,
  getSchedule,
  getConversation,
  listSchedules,
  markScheduleRun,
  monthKey,
  touchConversation,
  updateSchedule,
} from './db.js';
import { getBot } from './bots.js';
import { botUsageToday } from './db.js';
import { sendToBot, emitBotEvent, setSessionPermission } from './dsh.js';
import { deliverToChannel } from './channels/index.js';
import { enqueue, flush, quietEndsAt, inQuietHours } from './outbox.js';
import { log, logWarn, newId } from './util.js';

/** 「没什么值得说的就回这个」，宿主见到就不打扰用户 */
export const QUIET_MARK = '[安静]';

const TICK_MS = 30_000;
let timer = null;
let outboxTimer = null;
let running = new Set();

/** 下一次该跑的时间（毫秒）。算不出来返回 0。 */
export function computeNextRun(s, from = Date.now()) {
  if (s.kind === 'interval') {
    const every = Math.max(5, Number(s.everyMinutes) || 60) * 60_000;
    return from + every;
  }
  const at = /^(\d{1,2}):(\d{2})$/.exec(String(s.at || '08:00'));
  const hour = at ? Math.min(23, Number(at[1])) : 8;
  const minute = at ? Math.min(59, Number(at[2])) : 0;
  const base = new Date(from);
  for (let i = 0; i <= 8; i += 1) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hour, minute, 0, 0);
    if (d.getTime() <= from) continue;
    if (s.kind === 'weekly') {
      const days = Array.isArray(s.days) && s.days.length ? s.days.map(Number) : [base.getDay()];
      if (!days.includes(d.getDay())) continue;
    }
    return d.getTime();
  }
  return 0;
}

export function nextRunFor(s) {
  return computeNextRun(s, Date.now());
}

/** 建一条规则（带下一次时间） */
export function buildSchedule(input) {
  const bot = getBot(input.botId);
  if (!bot) throw new Error('没有这个机器人');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('要写清楚到点让它干什么');
  const kind = ['daily', 'weekly', 'interval'].includes(input.kind) ? input.kind : 'daily';
  const s = {
    id: newId('sched'),
    botId: bot.id,
    title: String(input.title || '').trim() || prompt.slice(0, 20),
    prompt,
    kind,
    at: input.at || '08:00',
    days: Array.isArray(input.days) ? input.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    everyMinutes: Math.max(5, Number(input.everyMinutes) || 60),
    channel: input.channel || 'app',
    target: input.target || null,
    mode: input.mode === 'observe' ? 'observe' : 'act',
    runBudgetTokens: Math.max(0, Number(input.runBudgetTokens) || 0),
    monthBudgetTokens: Math.max(0, Number(input.monthBudgetTokens) || 0),
    quietEnabled: input.quietEnabled !== false,
    enabled: true,
  };
  s.nextRunAt = computeNextRun(s);
  return s;
}

/** 把一轮的输入整理成给人看的时间描述 */
export function describeSchedule(s) {
  if (s.kind === 'interval') return `每 ${s.everyMinutes} 分钟`;
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (s.kind === 'weekly') {
    const days = (s.days || []).length ? s.days : [];
    return `${days.map((d) => names[d]).join('、') || '每周'} ${s.at}`;
  }
  return `每天 ${s.at}`;
}

export function pauseLabel(reason) {
  return {
    failures: '连续失败，已暂停',
    budget: '预算用完，已暂停',
    user: '手动暂停',
  }[reason] || (reason ? `已暂停（${reason}）` : '');
}

async function ensureConversation(s) {
  const existing = s.conversationId ? getConversation(s.conversationId) : null;
  if (existing) return existing;
  const conv = createConversation({ botId: s.botId, title: `⏰ ${s.title}`, channel: 'schedule', externalId: s.id });
  updateSchedule(s.id, { conversationId: conv.id });
  return conv;
}

function pause(id, reason) {
  updateSchedule(id, { pausedReason: reason });
  const s = getSchedule(id);
  emitBotEvent(s.botId, { type: 'schedule-run', scheduleId: id, status: 'paused', text: pauseLabel(reason) });
  return s;
}

/** 恢复：清掉失败计数和暂停原因，重新排期 */
export function resumeSchedule(id) {
  const s = getSchedule(id);
  if (!s) return null;
  const next = updateSchedule(id, {
    enabled: true,
    failures: 0,
    pausedReason: null,
    nextRunAt: computeNextRun(s) || Date.now() + 60_000,
  });
  return next;
}

/** 月度用量跨月自动归零 */
function monthReset(s) {
  if (s.monthKey === monthKey()) return s;
  return updateSchedule(s.id, { monthTokens: 0, monthKey: monthKey() });
}

/**
 * 跑一条规则。manual = 用户点「立即运行」（忽略暂停，但仍然算预算）。
 * 返回 { ok, quiet, observe, text, conversationId }。
 */
export async function runSchedule(id, { manual = false } = {}) {
  if (running.has(id)) return { ok: false, text: '这条规则正在跑' };
  let s = getSchedule(id);
  if (!s) return { ok: false, text: '没有这条规则' };
  if (s.pausedReason && !manual) return { ok: false, text: pauseLabel(s.pausedReason), paused: true };
  s = monthReset(s);
  if (s.monthBudgetTokens > 0 && s.monthTokens >= s.monthBudgetTokens) {
    pause(id, 'budget');
    return { ok: false, text: `本月预算 ${s.monthBudgetTokens} tokens 已用完，已暂停`, paused: true };
  }
  const bot = getBot(s.botId);
  if (!bot) return { ok: false, text: '机器人被删了' };
  // 机器人自己的每日预算也管着定时任务，别让它在后台把额度烧光
  const dailyBudget = Number(bot.dailyBudgetTokens) || 0;
  if (dailyBudget > 0 && botUsageToday(bot.id).totalTokens >= dailyBudget) {
    pause(id, 'budget');
    return { ok: false, text: `今天这个机器人的预算（${dailyBudget} tokens）已经用完，已暂停`, paused: true };
  }

  running.add(id);
  const startedAt = Date.now();
  const observe = s.mode === 'observe';
  try {
    const conv = await ensureConversation(s);
    addMessage({
      conversationId: conv.id,
      role: 'user',
      content: `${manual ? '（手动运行）' : `（定时触发 · ${describeSchedule(s)}）`}${observe ? '（观察模式）' : ''}${s.prompt}`,
      meta: { channel: 'schedule', scheduleId: s.id, manual, observe },
    });
    // 观察模式真的把会话切到只读，而不是只在提示词里说一句
    try {
      const preset = observe
        ? 'read-only'
        : bot.permission === 'readonly'
          ? 'read-only'
          : bot.permission === 'danger-full-access'
            ? 'danger-full-access'
            : 'workspace-write';
      await setSessionPermission({ botId: s.botId, sessionId: getConversation(conv.id)?.sessionId || null, preset });
    } catch (e) {
      logWarn('schedule', `切权限失败（继续跑）: ${e?.message || e}`);
    }

    const r = await sendToBot({
      botId: s.botId,
      conversationId: conv.id,
      sessionId: getConversation(conv.id)?.sessionId || null,
      text: observe
        ? `${s.prompt}\n\n（这是观察模式：你只有只读权限，不要尝试改动任何东西。请按要求查证，然后写出你本来会报告给用户的内容。）`
        : `${s.prompt}\n\n（这是定时任务的自动运行。如果这次没有新东西值得告诉用户，就只回复 ${QUIET_MARK}，不要解释。）`,
      channel: 'schedule',
    });
    const usage = r.usage || {};
    const tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0);
    if (r.usage) addUsage({ conversationId: conv.id, botId: s.botId, ...r.usage });
    const text = (r.text || '').trim();
    const quiet = !observe && text.startsWith(QUIET_MARK);

    let body = '';
    if (observe) body = text;
    else if (!quiet) body = text || '（这次没有产出）';
    if (body) {
      addMessage({
        conversationId: conv.id,
        role: 'assistant',
        content: observe ? `（观察，未执行）${body}` : body,
        meta: { channel: 'schedule', observe, ...(r.usage ? { usage: r.usage } : {}) },
      });
    }
    touchConversation(conv.id, {});

    // 只有 act + 有内容 + 指定了外部渠道，才排队推送
    let queued = false;
    if (!observe && !quiet && body && s.channel !== 'app' && s.target) {
      const notBefore = s.quietEnabled ? quietEndsAt() : 0;
      enqueue({ botId: s.botId, channel: s.channel, target: s.target, text: `⏰ ${s.title}\n\n${body}`, kind: 'schedule', refId: s.id, notBefore });
      queued = true;
    }

    const next = markScheduleRun(s.id, {
      at: startedAt,
      status: observe ? 'observe' : quiet ? 'quiet' : 'ok',
      result: (observe ? body : quiet ? QUIET_MARK : body).slice(0, 2000),
      nextRunAt: computeNextRun(s),
      tokens,
      wouldSay: observe ? body.slice(0, 2000) : null,
    });
    // 预算检查：这一轮花超了单次上限，或者月度额度用完了，就暂停
    if (s.runBudgetTokens > 0 && tokens > s.runBudgetTokens) {
      pause(s.id, 'budget');
      emitBotEvent(s.botId, { type: 'schedule-run', scheduleId: s.id, status: 'paused', text: `单次用了 ${tokens} tokens，超过上限 ${s.runBudgetTokens}，已暂停` });
    } else if (s.monthBudgetTokens > 0 && next.monthTokens >= s.monthBudgetTokens) {
      pause(s.id, 'budget');
    } else {
      // 成功一次就把失败计数清掉
      if (s.failures) updateSchedule(s.id, { failures: 0 });
    }

    emitBotEvent(s.botId, {
      type: 'schedule-run',
      scheduleId: s.id,
      status: observe ? 'observe' : quiet ? 'quiet' : 'ok',
      conversationId: conv.id,
      text: body.slice(0, 500),
      queued,
      tokens,
    });
    log('schedule', `${s.id} (${s.title}) 跑完：${observe ? '观察' : quiet ? '安静' : `${body.length} 字`} / ${tokens} tokens${queued ? ' / 已排队' : ''}`);
    return { ok: true, quiet, observe, text: body, conversationId: conv.id, tokens, queued };
  } catch (e) {
    const msg = e?.message || String(e);
    const failures = (s.failures || 0) + 1;
    markScheduleRun(s.id, { at: startedAt, status: 'error', result: msg.slice(0, 2000), nextRunAt: computeNextRun(s) });
    updateSchedule(s.id, { failures });
    if (failures >= 3) pause(s.id, 'failures');
    emitBotEvent(s.botId, { type: 'schedule-run', scheduleId: s.id, status: 'error', text: msg.slice(0, 300) });
    logWarn('schedule', `${s.id} 失败（第 ${failures} 次）：${msg}`);
    return { ok: false, text: msg, failures };
  } finally {
    running.delete(id);
  }
}

async function tick() {
  const at = Date.now();
  for (const s of listSchedules()) {
    if (!s.enabled || s.pausedReason || !s.nextRunAt || s.nextRunAt > at) continue;
    if (running.has(s.id)) continue;
    try {
      await runSchedule(s.id);
    } catch (e) {
      logWarn('schedule', `tick ${s.id}: ${e?.message || e}`);
    }
  }
}

/** 把到期的主动消息发出去（免打扰/上限都在 outbox 里判断） */
export async function flushOutbox() {
  return flush({ deliver: deliverToChannel });
}

export function startScheduler() {
  if (timer) return;
  const boot = async () => {
    // 启动时把「早就过期」的规则顺延，避免一开机补跑一堆
    for (const s of listSchedules()) {
      if (!s.enabled) continue;
      if (!s.nextRunAt || s.nextRunAt <= Date.now()) {
        updateSchedule(s.id, { nextRunAt: computeNextRun(s) || Date.now() + 60_000 });
      }
    }
    timer = setInterval(() => {
      tick().catch((e) => logWarn('schedule', `tick failed: ${e?.message || e}`));
    }, TICK_MS);
    timer.unref?.();
    outboxTimer = setInterval(() => {
      flushOutbox().catch((e) => logWarn('outbox', `flush failed: ${e?.message || e}`));
    }, TICK_MS);
    outboxTimer.unref?.();
    log('schedule', `scheduler started (${listSchedules().filter((s) => s.enabled && !s.pausedReason).length} 条规则)`);
  };
  boot().catch((e) => logWarn('schedule', `boot failed: ${e?.message || e}`));
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  if (outboxTimer) clearInterval(outboxTimer);
  timer = null;
  outboxTimer = null;
}

export { inQuietHours, quietEndsAt };

