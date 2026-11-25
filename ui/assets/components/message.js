/**
 * 消息气泡组件（拆自原 app.js renderMessages 的单条消息渲染）。
 * 纯函数：给定消息 + 当前机器人 + botId，返回 DOM，不读全局 state（除必要的 botFileUrl 兜底）。
 */
import { el, md, fmtTime, fmtTokens } from '../core/dom.js';
import { api, toast } from '../core/api.js';
import { state } from '../core/store.js';

/** 给渲染好的代码块加「复制」按钮（DeepSeek 同款交互） */
function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.code-copy')) continue;
    pre.style.position = 'relative';
    const btn = el('button', { class: 'code-copy', type: 'button', title: '复制代码' }, '复制');
    btn.onclick = async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code')?.textContent || pre.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1200);
      } catch {
        /* ignore */
      }
    };
    pre.append(btn);
  }
}

/** 助手消息下方的悬浮操作条：复制 / 朗读 */
function actionBar(text) {
  const copy = el('button', { class: 'msg-action', type: 'button', title: '复制' }, '复制');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制';
      setTimeout(() => (copy.textContent = '复制'), 1200);
    } catch {
      /* ignore */
    }
  };
  const speak = el('button', { class: 'msg-action', type: 'button', title: '朗读' }, '朗读');
  speak.onclick = () => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      speak.textContent = '朗读中';
      u.onend = () => (speak.textContent = '朗读');
    } catch {
      /* ignore */
    }
  };
  const regen = el('button', { class: 'msg-action', type: 'button', title: '重新生成' }, '重新生成');
  regen.onclick = async () => {
    const msgs = state.messages || [];
    const lastUser = [...msgs].reverse().find((x) => x.role === 'user');
    if (!lastUser || !state.conversationId) {
      toast('找不到可重发的用户消息', true);
      return;
    }
    regen.disabled = true;
    regen.textContent = '生成中…';
    try {
      await api(`/api/conversations/${state.conversationId}/send`, { method: 'POST', body: { text: lastUser.content } });
    } catch (e) {
      toast(e.message, true);
      regen.disabled = false;
      regen.textContent = '重新生成';
    }
  };
  return el('div', { class: 'msg-actions' }, copy, speak, regen);
}
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
  if (m.content) {
    const bubble = el('div', { class: 'bubble', html: md(m.content) });
    decorateCode(bubble);
    bubbleChildren.push(bubble);
  }
  if (m.meta?.usage) {
    const u = m.meta.usage;
    const prompt = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    bubbleChildren.push(el('div', { class: 'usage' }, `↑${fmtTokens(prompt)} ↓${fmtTokens(u.outputTokens)} tokens`));
  }
  if (Array.isArray(m.meta?.files) && m.meta.files.length) {
    bubbleChildren.push(fileCards(m.meta.files, m.meta.speakerBotId || fallbackBotId));
  }
  if (!isUser && m.role !== 'error' && m.content) bubbleChildren.push(actionBar(m.content));
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
