/**
 * 消息气泡组件（拆自原 app.js renderMessages 的单条消息渲染）。
 * 纯函数：给定消息 + 当前机器人 + botId，返回 DOM，不读全局 state（除必要的 botFileUrl 兜底）。
 */
import { el, md, fmtTime, fmtTokens } from '../core/dom.js';
import { fileCards, attachmentRow } from './cards.js';

/**
 * 渲染一条普通消息（user / bot / error）。
 * @param {object} m 消息
 * @param {object|undefined} bot 当前机器人
 * @param {string|undefined} fallbackBotId 交付文件归属兜底
 */
export function messageBubble(m, bot, fallbackBotId) {
  const isUser = m.role === 'user';
  const cls = `msg ${isUser ? 'user' : m.role === 'error' ? 'error' : 'bot'}`;
  // 群聊里每条回复可能来自不同机器人，名字和头像用消息自带的
  const speakerName = m.meta?.speakerName || bot?.name || '机器人';
  const speakerAvatar = m.meta?.speakerAvatar || bot?.avatar || 'blue';
  const who = isUser ? '你' : m.role === 'error' ? '错误' : speakerName;
  const atts = Array.isArray(m.meta?.attachments) ? m.meta.attachments : [];
  const bubbleChildren = [];
  if (atts.length) bubbleChildren.push(attachmentRow(atts));
  if (m.content) bubbleChildren.push(el('div', { class: 'bubble', html: md(m.content) }));
  if (m.meta?.usage) {
    const u = m.meta.usage;
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    bubbleChildren.push(el('div', { class: 'usage' }, `↑${fmtTokens(prompt)} ↓${fmtTokens(u.outputTokens)} tokens`));
  }
  if (Array.isArray(m.meta?.files) && m.meta.files.length) {
    bubbleChildren.push(fileCards(m.meta.files, m.meta.speakerBotId || fallbackBotId));
  }
  return el(
    'div',
    { class: cls },
    el('div', { class: `avatar ${isUser ? 'purple' : speakerAvatar}` }, isUser ? '你' : speakerName.slice(0, 1)),
    el('div', {}, el('div', { class: 'who' }, `${who} · ${fmtTime(m.createdAt)}`), ...bubbleChildren),
  );
}

/** 正在逐字输出的那一段：跟正式气泡同样式，末尾一个光标 */
export function streamingBubble(text, speaker) {
  const bubble = el('div', { class: 'bubble' });
  bubble.innerHTML = md(text);
  bubble.append(el('span', { class: 'caret', 'aria-hidden': 'true' }, '▍'));
  return el(
    'div',
    { class: 'msg bot streaming' },
    el('div', { class: `avatar ${speaker?.avatar || 'blue'}` }, (speaker?.name || '?').slice(0, 1)),
    el('div', {}, el('div', { class: 'who' }, `${speaker?.name || '机器人'} · 正在说`), bubble),
  );
}
