// 渠道无关的核心：谁能用这个机器人、这条消息落到哪个会话、斜杠命令、
// 结果怎么发回去。各平台适配器（telegram/slack/discord）只负责收发。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { ensureWorkspace, getBot, listBots } from '../bots.js';
import { addMessage, addUsage, createConversation, findConversation, getConversation, listMessages, touchConversation } from '../db.js';
import { sendToBot, botStatus } from '../dsh.js';
import { truncate, log, safeFileName } from '../util.js';

/** 这个渠道里谁能用机器人：渠道 owner 或白名单，都没配时第一个来的人成为 owner */
export function isAuthorized(channel, senderId) {
  const cfg = loadConfig();
  const c = cfg.channels[channel] || {};
  if (c.allowAnyone) return true;
  const owner = String(c.owner || '').trim();
  if (owner) return String(senderId) === owner;
  const allow = (c.allow || []).map(String);
  return allow.includes(String(senderId));
}

/** 记录渠道 owner（第一次有人用这个渠道时调用） */
export function claimOwner(channel, senderId) {
  const cfg = loadConfig();
  const c = (cfg.channels[channel] ||= {});
  if (!c.owner) {
    c.owner = String(senderId);
    import('../config.js').then((m) => m.saveConfig(cfg));
    return true;
  }
  return false;
}

/** 渠道里现在用哪个机器人：显式指定 > 渠道默认 > 第一个 */
export function pickBot(channel, overrideId) {
  const cfg = loadConfig();
  const id = overrideId || cfg.channels[channel]?.defaultBotId;
  const bot = id ? getBot(id) : null;
  if (bot) return bot;
  return listBots()[0] || null;
}

export function setChannelBot(channel, botId) {
  const cfg = loadConfig();
  (cfg.channels[channel] ||= {}).defaultBotId = botId;
  import('../config.js').then((m) => m.saveConfig(cfg));
}

/**
 * 渠道会话：
 * - 私聊：一个「渠道 + 人 + 机器人」一条
 * - 群聊：一个「渠道 + 群 + 机器人」一条（群里所有人共享上下文，换机器人另开）
 */
export function conversationFor({ channel, senderId, botId, groupId }) {
  const scope = groupId ? `g:${groupId}` : senderId;
  const externalId = `${scope}::${botId}`;
  let conv = findConversation({ channel, externalId });
  if (!conv) conv = createConversation({ botId, channel, externalId });
  return conv;
}

export function resetConversation(convId) {
  touchConversation(convId, { sessionId: null });
}

// 群里未授权时的提示节流（chatId -> 上次提示时间）
const groupNags = new Map();

const HELP = [
  '直接发消息就行。可用命令：',
  '/new 开一段新对话（旧的还在）',
  '/bot 看有哪些机器人；/bot 名字 换一个',
  '/help 看这份说明',
].join('\n');

/** 渠道发来的图片/文件先落到这个机器人的工作区 assets/，返回相对路径 */
function saveIncomingMedia(botId, media = []) {
  if (!media.length) return [];
  const ws = ensureWorkspace(botId);
  const dir = path.join(ws, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const item of media.slice(0, 8)) {
    const buf = item?.buf;
    if (!Buffer.isBuffer(buf) || !buf.length) continue;
    if (buf.length > 30 * 1024 * 1024) continue;
    const name = safeFileName(item.name || 'file.bin');
    const rel = path.join('assets', `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${name}`).replace(/\\/g, '/');
    try {
      fs.writeFileSync(path.join(ws, rel), buf);
      out.push(rel);
    } catch {
      /* 写不进去就跳过 */
    }
  }
  return out;
}

/**
 * 处理一条渠道入站消息。
 * ctx: { channel, senderId, senderName, text, media?: [{buf,name}], reply(text), sendApproval?(approval) }
 * 返回 { ok, text }
 */
export async function handleIncoming(ctx) {
  const { channel, senderId, text, reply } = ctx;
  const trimmed = String(text || '').trim();
  if (!trimmed && !ctx.attachments?.length && !ctx.media?.length) return { ok: false, text: '' };

  // 斜杠命令先处理，不调用模型
  if (trimmed.startsWith('/')) {
    const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    if (cmd === 'help' || cmd === 'start') {
      await reply(HELP);
      return { ok: true, text: HELP };
    }
    if (cmd === 'bot') {
      const bots = listBots();
      if (!arg) {
        const cur = pickBot(channel);
        const list = bots.map((b) => `${b.id === cur?.id ? '▸ ' : '  '}${b.name}（${b.id}）`).join('\n');
        await reply(`现在的机器人：${cur?.name || '无'}\n${list}\n\n用 /bot 名字 换一个。`);
        return { ok: true, text: '' };
      }
      const found = bots.find((b) => b.id === arg || b.name === arg);
      if (!found) {
        await reply(`没有叫「${arg}」的机器人。发 /bot 看列表。`);
        return { ok: true, text: '' };
      }
      setChannelBot(channel, found.id);
      await reply(`好，接下来由「${found.name}」回复。`);
      return { ok: true, text: '' };
    }
    if (cmd === 'new') {
      const bot = pickBot(channel);
      if (!bot) {
        await reply('还没有机器人。先在控制台里建一个。');
        return { ok: true, text: '' };
      }
      const conv = conversationFor({ channel, senderId, botId: bot.id, groupId: ctx.groupId });
      resetConversation(conv.id);
      await reply(`好，和「${bot.name}」重新开始。`);
      return { ok: true, text: '' };
    }
    // 其他 /xxx 交给 DSH 当原生命令（/compact、/permission 等）
  }

  const bot = pickBot(channel);
  if (!bot) {
    await reply('还没有机器人。先在控制台 http://127.0.0.1:5178 里建一个。');
    return { ok: false, text: '' };
  }

  // 群里：发话的人被授权，或者这个群本身被授权（把群 id 加进 allow 名单即可）
  const authorized = isAuthorized(channel, senderId) || (ctx.groupId ? isAuthorized(channel, ctx.groupId) : false);
  if (!authorized) {
    if (claimOwner(channel, senderId)) {
      log('channel', `${channel}: ${senderId} (${ctx.senderName || ''}) 成为这个渠道的主人`);
    } else {
      if (ctx.groupId) {
        // 群里别刷屏：同一个群 10 分钟最多提醒一次
        const last = groupNags.get(ctx.groupId) || 0;
        if (Date.now() - last > 10 * 60_000) {
          groupNags.set(ctx.groupId, Date.now());
          await reply('这个群还没被允许用我。让主人在控制台的「聊天渠道」里把群 id 加进白名单就行。');
        }
        return { ok: false, text: '' };
      }
      await reply('这个机器人只听主人的。想让 owner 放行，请在控制台里加白名单。');
      return { ok: false, text: '' };
    }
  }

  // 渠道发来的图片/文件先落进这个机器人的工作区，再按普通附件处理
  const incoming = [...(ctx.attachments || []), ...saveIncomingMedia(bot.id, ctx.media)];
  const conv = conversationFor({ channel, senderId, botId: bot.id, groupId: ctx.groupId });
  addMessage({
    conversationId: conv.id,
    role: 'user',
    content: trimmed,
    meta: { channel, senderId, senderName: ctx.senderName || '', ...(incoming.length ? { attachments: incoming } : {}) },
  });

  const status = botStatus(bot.id);
  if (status.busy) {
    await reply('还在处理上一条消息，稍等一下。');
    return { ok: false, text: '' };
  }

  const conversation = getConversation(conv.id);
  const progress = [];
  try {
    const r = await sendToBot({
      botId: bot.id,
      conversationId: conv.id,
      sessionId: conversation.sessionId,
      text: trimmed,
      attachments: incoming,
      channel,
      onProgress: (p) => progress.push(p),
    });
    if (r.usage) addUsage({ conversationId: conv.id, botId: bot.id, ...r.usage });
    const answer = r.text?.trim() || '（这一轮没有产出文字）';
    addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: answer,
      meta: { channel, turns: progress.length, ...(r.usage ? { usage: r.usage } : {}), ...(r.presented?.length ? { files: r.presented } : {}) },
    });
    await reply(answer);
    return { ok: true, text: answer };
  } catch (e) {
    const msg = `出错了：${e?.message || e}`;
    addMessage({ conversationId: conv.id, role: 'error', content: msg, meta: { channel } });
    await reply(msg);
    return { ok: false, text: msg };
  }
}

/** 渠道里发审批卡（有卡片能力的渠道用），返回是否发出成功 */
export function approvalText(approval) {
  return [
    `⏸ 「${approval.tool}」需要你点个同意`,
    approval.detail ? `要做的：${truncate(approval.detail, 300)}` : '',
    '',
    `回「同意 ${approval.id}」或「拒绝 ${approval.id}」`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 渠道里回「同意 <id>」/「拒绝 <id>」 */
export async function handleApprovalReply(channel, senderId, text, reply) {
  const m = String(text || '')
    .trim()
    .match(/^(同意|拒绝|approve|deny|yes|no)\s+(\S+)$/i);
  if (!m) return false;
  if (!isAuthorized(channel, senderId)) {
    await reply('只有主人能批准。');
    return true;
  }
  const id = m[2].trim();
  const { getApproval } = await import('../db.js');
  const row = getApproval(id);
  if (!row) {
    await reply(`没找到审批 ${id}。`);
    return true;
  }
  if (row.status !== 'pending') {
    await reply(`这条审批已经处理过了（${row.status}）。`);
    return true;
  }
  const allow = /^(同意|approve|yes)$/i.test(m[1]);
  const { resolveBotApproval } = await import('../dsh.js');
  const ok = resolveBotApproval(row.botId, id, allow);
  await reply(ok ? (allow ? '好，这次允许了。' : '好，这次拒绝。') : '这条审批已经失效了（可能这一轮已结束）。');
  return true;
}





