/**
 * 对话主视图（拆自原 app.js）：选机器人/会话、SSE 订阅、消息渲染、审批回答、一轮结束。
 * 事件总线订阅在 events.js 里集中注册（bus.on），本文件只负责视图状态与渲染。
 */
import { qs, el } from '../core/dom.js';
import { api, token, toast } from '../core/api.js';
import { state } from '../core/store.js';
import { closeDrawer } from '../core/shell.js';
import { go } from '../core/router.js';
import { messageBubble, streamingBubble } from '../components/message.js';
import { approvalCard } from '../components/cards.js';
import { renderToolGroups } from '../components/tool-steps.js';
import { updateUsagePill, renderAttachments, setComposerState } from '../components/composer.js';
import { loadBots, renderBots, renderChatSub, paintModelSelectFor } from './bots.js';
import { renderGroups } from './groups.js';

/** 选中一个机器人并打开它的最近会话 */
export async function selectBot(botId) {
  closeDrawer();
  state.liveText = '';
  state.liveBotId = null;
  state.currentBotId = botId;
  state.currentGroupId = null;
  state.pane = null;
  qs('#panel').hidden = true;
  qs('#app').classList.remove('with-panel');
  renderBots();
  renderGroups();
  qs('#btn-new-conv').hidden = false;
  qs('#btn-bot-panel').hidden = false;
  const bot = state.bots.find((b) => b.id === botId);
  qs('#empty-state').hidden = !!bot;
  qs('#chat').hidden = !bot;
  if (!bot) return;
  qs('#chat-avatar').className = `avatar ${bot.avatar || 'blue'}`;
  qs('#chat-avatar').textContent = (bot.name || '?').slice(0, 1);
  qs('#chat-name').textContent = bot.name;
  renderChatSub(bot);
  const box = qs('#input');
  if (box) box.placeholder = window.innerWidth <= 700 ? `给 ${bot.name} 发消息…` : `描述你想让它做什么，/ 调用指令，@ 选文件`;
  await paintModelSelectFor(bot);
  await openLatestConversation(botId);
}

export async function openLatestConversation(botId) {
  const convs = await api(`/api/bots/${botId}/conversations`);
  if (convs.length) {
    await openConversation(convs[0].id);
  } else {
    const { conversation } = await api(`/api/bots/${botId}/conversations`, { method: 'POST', body: {} });
    await openConversation(conversation.id);
  }
}

export async function openConversation(convId) {
  state.conversationId = convId;
  state.approvals.clear();
  state.attachments = [];
  renderAttachments();
  const data = await api(`/api/conversations/${convId}`);
  state.conversation = data.conversation;
  state.messages = data.messages;
  state.tools = data.tools || [];
  state.progress = [];
  state.busy = false;
  updateUsagePill(data.usage);
  renderMessages();
  subscribeEvents(convId);
  qs('#input')?.focus();
}

export function subscribeEvents(convId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const es = new EventSource(`/api/conversations/${convId}/events?token=${encodeURIComponent(token)}`);
  state.sse = es;
  es.onmessage = (e) => {
    // 事件总线：所有 SSE 事件统一 emit，由 events.js 的订阅者分发处理
    import('../core/events.js').then(({ emit }) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type !== 'hello') emit(ev.type, ev);
    });
  };
  es.onerror = () => {
    // EventSource 自己会重连；这里不打扰用户
  };
}

/** 工具组折叠切换 */
function toggleTool(key) {
  if (state.ui.openTools.has(key)) state.ui.openTools.delete(key);
  else state.ui.openTools.add(key);
  renderMessages();
}

/** 消息区全量渲染（保留 rAF 合帧的流式优化；增量 diff 见 Phase 4 后续优化） */
export function renderMessages() {
  const box = qs('#messages');
  if (!box) return;
  box.replaceChildren();
  const bot = state.bots.find((b) => b.id === state.currentBotId);
  for (const m of state.messages) {
    if (m.role === 'approval') {
      box.append(approvalCard(m, answerApproval));
      continue;
    }
    if (m.role === 'tool') {
      box.append(el('div', { class: 'tool-line' }, m.content));
      continue;
    }
    if (m.role === 'note') {
      box.append(el('div', { class: 'msg-note' }, m.content));
      continue;
    }
    box.append(messageBubble(m, bot, state.currentBotId || state.conversation?.botId));
  }

  // 中途说的话（assistant-step）：按正常气泡显示
  let pi = 0;
  while (pi < state.progress.length) {
    const p = state.progress[pi];
    if (p.kind === 'say' && p.text) {
      const speaker = state.bots.find((b) => b.id === p.botId) || state.bots.find((b) => b.id === state.currentBotId);
      box.append(streamingBubble(p.text, speaker));
    }
    pi += 1;
  }

  // 历史工具（刷新后还在）：转成 progress 同构数据，复用折叠组
  const historyTools = (state.tools || []).map((t) => ({
    kind: 'tool',
    botId: t.botId || state.currentBotId,
    name: t.name,
    args: t.args,
    done: !!t.endedAt,
    isError: !!t.isError,
    reason: t.reason,
    result: t.result,
    ms: t.ms || 0,
  }));
  for (const node of renderToolGroups(historyTools, state.bots, false, toggleTool)) box.append(node);

  // 工具步骤折叠组
  for (const node of renderToolGroups(state.progress, state.bots, state.busy, toggleTool)) box.append(node);

  // 正在逐字输出的那一段
  if (state.liveText) {
    const speaker = state.bots.find((b) => b.id === state.liveBotId) || state.bots.find((b) => b.id === state.currentBotId);
    box.append(streamingBubble(state.liveText, speaker));
  }
  if (state.busy && !state.liveText) box.append(el('div', { class: 'typing' }, '…'));
  box.scrollTop = box.scrollHeight;
}

export function renderProgress() {
  renderMessages();
}

/** 逐字输出时合帧，不每来一个包就整屏重画 */
let liveFrame = 0;
export function scheduleLiveRender() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    renderProgress();
  });
}

/** 一轮结束：拉服务端落好的最终消息回来 */
let endTimer = null;
export function endOfTurn() {
  state.busy = false;
  state.liveText = '';
  state.liveBotId = null;
  setComposerState();
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(async () => {
    endTimer = null;
    try {
      await reloadMessages();
    } catch {
      /* 拉失败就保持现状 */
    }
  }, 400);
}

export async function reloadMessages() {
  if (!state.conversationId) return;
  const data = await api(`/api/conversations/${state.conversationId}`);
  state.messages = data.messages;
  state.progress = [];
  renderMessages();
}

export async function answerApproval(id, allow, opts = {}) {
  try {
    const r = await api(`/api/approvals/${id}`, { method: 'POST', body: { allow, remember: opts.remember === true } });
    if (r.warning) toast(r.warning, true);
    await reloadMessages();
  } catch (e) {
    toast(e.message, true);
  }
}
