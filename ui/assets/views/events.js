/**
 * SSE 事件订阅集中注册（原 app.js onEvent 的 if-else → bus.on 分发）。
 * ------------------------------------------------------------
 * 12 类事件各建一个订阅者，加新事件不再改中心函数。
 * 由 app.js 在启动时调用 registerEventHandlers() 一次。
 */
import { el } from '../core/dom.js';
import { toast } from '../core/api.js';
import { state } from '../core/store.js';
import { on, emit } from '../core/events.js';
import { go } from '../core/router.js';
import { loadBots, renderBots, renderChatSub } from './bots.js';
import { renderMessages, renderProgress, scheduleLiveRender, endOfTurn, reloadMessages } from './chat.js';
import { updateUsagePill, setComposerState } from '../components/composer.js';

/** 生图/生视频开跑时跳到连接域 media 路由（替代硬开面板 + 标题字符串判断） */
function jumpToMedia(ev) {
  const r = state.ui.route;
  if (r?.domain === 'connect' && r?.tab === 'media') return;
  go('connect/media');
  toast(ev.kind === 'video' ? '在右边看视频生成' : '在右边看它画');
}

/** 注册所有事件订阅。返回 unsubscribe 函数（便于热重载/测试）。 */
export function registerEventHandlers() {
  const offs = [];
  const reg = (type, fn) => offs.push(on(type, fn));

  // 忽略 hello
  reg('hello', () => {});

  reg('tool-call', (ev) => {
    state.progress.push({ kind: 'tool', botId: ev.botId || state.liveBotId, callId: ev.callId, name: ev.name, args: ev.args, done: false, startedAt: Date.now() });
    renderProgress();
  });

  reg('tool-result', (ev) => {
    // 按 callId 找到对应的工具步骤，回填成功/失败
    const item = [...state.progress].reverse().find((x) => x.kind === 'tool' && ((ev.callId && x.callId === ev.callId) || (!ev.callId && !x.done)));
    if (item) {
      item.done = true;
      item.ms = item.startedAt ? Date.now() - item.startedAt : 0;
      item.isError = !!ev.isError;
      item.reason = ev.reason || '';
      item.result = ev.result || '';
    }
    renderProgress();
  });

  reg('assistant-step', (ev) => {
    if (ev.text || ev.reasoning) {
      // 这一段定稿了：把逐字缓冲收进进度（用服务端的完整文本），避免少字/重字
      state.progress.push({ kind: 'say', botId: ev.botId || state.liveBotId, text: ev.text, reasoning: ev.reasoning });
      if (ev.text) state.liveText = '';
      renderProgress();
    }
  });

  reg('media-start', jumpToMedia);

  reg('delta', (ev) => {
    if (!ev.text) return;
    if (state.liveBotId && ev.botId && ev.botId !== state.liveBotId) {
      // 群聊里换人了：上一段收尾
      if (state.liveText) state.progress.push({ kind: 'say', botId: state.liveBotId, text: state.liveText });
      state.liveText = '';
    }
    state.liveBotId = ev.botId || state.liveBotId;
    state.busy = true;
    state.liveText += ev.text;
    scheduleLiveRender();
  });

  reg('turn-status', (ev) => {
    state.busy = ev.status === 'running';
    setComposerState();
    if (ev.status === 'idle') endOfTurn();
  });

  reg('status', (ev) => {
    loadBots().then(() => {
      renderBots();
      const b = state.bots.find((x) => x.id === state.currentBotId);
      if (b) renderChatSub(b);
    });
    if (ev.busy === false) endOfTurn();
  });

  reg('approval', (ev) => {
    state.approvals.set(ev.approval.id, ev.approval);
    state.messages.push({
      id: `appr-${ev.approval.id}`,
      role: 'approval',
      content: `${ev.approval.tool}${ev.approval.detail ? `：${ev.approval.detail}` : ''}`,
      meta: { approvalId: ev.approval.id, tool: ev.approval.tool, detail: ev.approval.detail, status: 'pending' },
      createdAt: Date.now(),
    });
    renderMessages();
  });

  reg('usage', (ev) => updateUsagePill(ev.usage));

  reg('schedule-run', (ev) => {
    if (ev.status === 'error') toast(`定时任务出错：${ev.text || ''}`, true);
    else if (ev.status === 'ok' && ev.text) toast(`⏰ ${ev.text.slice(0, 80)}`);
    if (state.pane === 'automation') import('./automation.js').then((m) => m.openSchedules());
  });

  reg('approval-resolved', (ev) => {
    for (const m of state.messages) {
      if (m.meta?.approvalId === ev.approvalId) m.meta.status = ev.status;
    }
    renderMessages();
  });

  return () => offs.forEach((fn) => fn());
}
