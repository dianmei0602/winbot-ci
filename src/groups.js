// 群聊：一个群拉几个机器人，消息共享；@谁谁答，没 @ 时上一个回答的接着答。
import {
  addMessage,
  addUsage,
  createConversation,
  deleteGroup,
  getGroup,
  getGroupSession,
  groupConversation,
  insertGroup,
  listGroups,
  setConversationSpeaker,
  setGroupSession,
  touchConversation,
  updateGroup,
} from './db.js';
import { getBot, listBots } from './bots.js';
import { sendToBot, emitBotEvent } from './dsh.js';
import { takeGenerated } from './media.js';
import { routeGroupMessage } from './router.js';
import { newId, log, logWarn, truncate } from './util.js';

export function createGroup({ name, botIds, router }) {
  const ids = [...new Set((botIds || []).filter((id) => getBot(id)))];
  if (!ids.length) throw new Error('群至少要有一个机器人');
  const label = String(name || '').trim() || ids.map((id) => getBot(id).name).join('、');
  const id = newId('grp');
  insertGroup({ id, name: label, botIds: ids });
  if (router === 'model') updateGroup(id, { router: 'model' });
  const conv = createConversation({ botId: ids[0], title: `群 · ${label}`, channel: 'group', externalId: id, groupId: id });
  log('groups', `created ${id} (${label}) conv=${conv.id}`);
  return { group: getGroup(id), conversation: conv };
}

/** 群的共享会话：丢了就按成员重建一条（清理脚本/误删之后也能自愈） */
export function ensureGroupConversation(groupId) {
  const g = getGroup(groupId);
  if (!g) return null;
  const existing = groupConversation(groupId);
  if (existing) return existing;
  const members = membersOf(g);
  if (!members.length) return null;
  const conv = createConversation({
    botId: members[0].id,
    title: `群 · ${g.name}`,
    channel: 'group',
    externalId: g.id,
    groupId: g.id,
  });
  log('groups', `rebuilt conversation for ${g.id}: ${conv.id}`);
  return conv;
}

export function groupView(g) {
  const members = (g.botIds || []).map((id) => getBot(id)).filter(Boolean);
  const conv = groupConversation(g.id);
  return {
    ...g,
    conversationId: conv?.id || null,
    members: members.map((b) => ({ id: b.id, name: b.name, avatar: b.avatar })),
    lastSpeakerId: conv?.botId || null,
    updatedAt: conv?.updatedAt || g.updatedAt,
  };
}

export function listGroupViews() {
  return listGroups().map(groupView);
}

export function removeGroup(id) {
  const conv = groupConversation(id);
  deleteGroup(id);
  return conv?.id || null;
}

/** 「@小八 帮我查一下」里把机器人认出来 */
export function resolveMention(text, members) {
  for (const b of members) {
    for (const token of [`@${b.name}`, `@${b.id}`]) {
      if (text.includes(token)) return { bot: b, token };
    }
  }
  return null;
}

function membersOf(group) {
  return (group.botIds || []).map((id) => getBot(id)).filter(Boolean);
}

/**
 * 往群里发一条用户消息，挑一个机器人回答。
 * 规则：@了就轮到它；没 @ 就上一个回答的接着说；都没就第一个成员。
 */
export async function sendToGroup({ groupId, text, onProgress }) {
  const group = getGroup(groupId);
  if (!group) throw new Error('没有这个群');
  const members = membersOf(group);
  if (!members.length) throw new Error('群里没有可用的机器人');
  const conv = ensureGroupConversation(groupId);
  if (!conv) throw new Error('群的会话丢了');
  const mention = resolveMention(text, members);
  // 没 @ 的时候：按群设置走路由（rules 默认 / model）
  let speaker = null;
  if (mention) speaker = mention.bot;
  else {
    const routed = await routeGroupMessage({ text, members, lastSpeakerId: conv.botId, mode: group.router || 'rules' });
    speaker = routed.bot || members[0];
    log('groups', `${group.id}: router(${group.router || 'rules'}) -> ${speaker.name} [${routed.reason}]`);
  }
  const clean = mention ? text.split(mention.token).join('').trim() : text;
  const body = clean || text;

  addMessage({
    conversationId: conv.id,
    role: 'user',
    content: text,
    meta: { channel: 'group', groupId, mentionBotId: mention?.bot.id || null },
  });

  const sessionId = getGroupSession(groupId, speaker.id);
  const started = Date.now();
  // 第一次在这个群发言时，把「你在群里、都有谁」交代清楚；之后靠历史就记得
  const groupContext = sessionId
    ? ''
    : `【你在一个群聊里】群名：${group.name}；成员：${members.map((m) => m.name).join('、')}。` +
      `你的回复群里所有人都看得到。需要别人接手时，可以用 ask_another_bot 把活交出去。\n\n`;
  const r = await sendToBot({
    botId: speaker.id,
    conversationId: conv.id,
    sessionId,
    text: `${groupContext}${body}`,
    channel: 'group',
    onProgress,
  });
  if (r.usage) addUsage({ conversationId: conv.id, botId: speaker.id, ...r.usage });
  if (r.sessionId) setGroupSession(groupId, speaker.id, r.sessionId);
  setConversationSpeaker(conv.id, speaker.id);
  touchConversation(conv.id, {});
  addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: r.text || '（这一轮没有产出文字）',
    meta: {
      channel: 'group',
      speakerBotId: speaker.id,
      speakerName: speaker.name,
      speakerAvatar: speaker.avatar,
      ...(r.usage ? { usage: r.usage } : {}),
      ...(() => {
        const all = [...(r.presented || []), ...takeGenerated(speaker.id)];
        const files = [...new Map(all.map((f) => [f.path, f])).values()];
        return files.length ? { files } : {};
      })(),
    },
  });
  emitBotEvent(speaker.id, { type: 'status', status: null });
  log('groups', `${group.id}: ${speaker.name} 答了 ${Date.now() - started}ms`);
  return { botId: speaker.id, botName: speaker.name, text: r.text || '', conversationId: conv.id };
}

// ---------- 机器人互派 ----------

/**
 * 把活交给另一个机器人：它用自己的模型/权限/预算，在一个独立会话里做完，
 * 结果回到这里给发起方，由发起方核对后转述给用户。
 */
export async function handoff({ fromBotId, toBot, task }) {
  const from = getBot(fromBotId) || null;
  // 允许用 id 或名字（名字可以只写一部分）
  const dest = getBot(String(toBot || '')) || listBots().find((b) => b.name === toBot) || listBots().find((b) => b.name.includes(String(toBot || '')));
  if (!dest) throw new Error(`没有叫「${toBot}」的机器人`);
  if (from && dest.id === from.id) throw new Error('不能把活交给自己');

  const conv = createConversation({
    botId: dest.id,
    title: `↪ ${dest.name}：${truncate(String(task || '').replace(/\s+/g, ' '), 24)}`,
    channel: 'handoff',
    externalId: from?.id || null,
  });
  addMessage({ conversationId: conv.id, role: 'user', content: task, meta: { channel: 'handoff', fromBotId: from?.id || null } });
  const brief = from ? `【来自「${from.name}」的委托，它看不到你的会话，请直接把结果写成可转述的完整回复】\n\n` : '';
  const r = await sendToBot({ botId: dest.id, conversationId: conv.id, sessionId: null, text: `${brief}${task}`, channel: 'handoff' });
  if (r.usage) addUsage({ conversationId: conv.id, botId: dest.id, ...r.usage });
  addMessage({
    conversationId: conv.id,
    role: 'assistant',
    content: r.text || '（没有产出）',
    meta: { channel: 'handoff', speakerName: dest.name, ...(r.usage ? { usage: r.usage } : {}) },
  });
  log('handoff', `${from?.id || '?'} -> ${dest.id} (${conv.id})`);
  return { botId: dest.id, botName: dest.name, text: r.text || '', conversationId: conv.id };
}







