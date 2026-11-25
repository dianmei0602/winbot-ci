/**
 * winbot 控制台入口 —— 只做启动、事件绑定、路由接线、全局快捷键。
 * 业务逻辑已拆到 core/ components/ views/；本文件保持精简（目标 ≤200 行）。
 */
import { qs, el } from './core/dom.js';
import { state } from './core/store.js';
import { api, toast } from './core/api.js';
import { go, onChange, startRouter, back, resolve } from './core/router.js';
import { closePanel, setupPaneResizer } from './core/shell.js';
import { configureComposer, send, autoGrow, addFiles, setComposerState } from './components/composer.js';
import { loadBots, renderBots, paintModelSelect, openNewBot, renderChatSub } from './views/bots.js';
import { loadGroups, renderGroups, selectGroup, openNewGroup } from './views/groups.js';
import { selectBot, openConversation, renderMessages, reloadMessages } from './views/chat.js';
import { openSchedules } from './views/automation.js';
import { openSearch } from './views/search.js';
import { openConversations } from './views/conversations.js';
import { openComfyPanel } from './views/comfy.js';
import { openSettings } from './views/settings/index.js';
import { registerEventHandlers } from './views/events.js';
import { initSidebarExtras } from './views/recent.js';

// 把 chat 的渲染函数注入 composer，避免 components → views 的反向依赖
configureComposer({ renderMessages, reloadMessages });

// 主题：默认跟随系统偏好，可手动切换并记住
const THEME_KEY = 'winbot.theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  const btn = qs('#btn-theme');
  if (btn) btn.setAttribute('aria-label', theme === 'light' ? '切换到深色主题' : '切换到浅色主题');
}
function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem(THEME_KEY) || ''; } catch { /* ignore */ }
  // 默认深色（设计基线），用户手动切到浅色会存在 localStorage 里
  if (!t) t = 'dark';
  applyTheme(t);
}
initTheme();
initSidebarExtras();

// ---------- 路由接线：每个视图由 hash 驱动 ----------
onChange((route) => {
  state.ui.route = route;
  const { domain, tab } = route;
  // 所有面板类视图由路由打开；对话主区（#/chat）关闭面板
  if (domain === 'chat') {
    if (tab === 'history') openConversations().catch((e) => toast(e.message, true));
    else if (tab === 'search') openSearch().catch((e) => toast(e.message, true));
    else closePanel();
    return;
  }
  if (domain === 'bots') { openBotPanel().catch((e) => toast(e.message, true)); return; }
  if (domain === 'automation') { openSchedules().catch((e) => toast(e.message, true)); return; }
  if (domain === 'connect') { openSettings('connect', tab).catch((e) => toast(e.message, true)); return; }
  if (domain === 'system') { openSettings('system', tab).catch((e) => toast(e.message, true)); return; }
});

// ---------- 事件绑定 ----------
function bindEvents() {
  qs('#btn-new-bot')?.addEventListener('click', async () => {
    if (state.currentBotId) {
      try {
        const { conversation } = await api(`/api/bots/${state.currentBotId}/conversations`, { method: 'POST', body: {} });
        await openConversation(conversation.id);
        renderBots();
      } catch (e) { toast(e.message, true); }
    } else {
      openNewBot();
    }
  });
  qs('#btn-new-bot-2')?.addEventListener('click', openNewBot);
  qs('#btn-first-bot')?.addEventListener('click', openNewBot);
  qs('#btn-new-group')?.addEventListener('click', openNewGroup);
  qs('#btn-settings')?.addEventListener('click', () => go('system/about'));
  qs('#btn-theme')?.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });

  // 5 域主导航
  for (const btn of document.querySelectorAll('[data-domain]')) {
    btn.addEventListener('click', () => {
      const domain = btn.dataset.domain;
      go(domain === 'chat' ? 'chat' : domain);
    });
  }

  qs('#btn-comfy-side')?.addEventListener('click', () => go('connect/media'));

  // 会话/机器人操作入口（合并重复入口后的唯一位置）
  qs('#btn-new-task')?.addEventListener('click', () => go('automation'));
  qs('#btn-search')?.addEventListener('click', () => go('chat/search'));
  qs('#btn-comfy')?.addEventListener('click', () => go('connect/media'));
  qs('#btn-bot-panel')?.addEventListener('click', () => go('bots'));
  qs('#chat-avatar')?.addEventListener('click', () => go('bots'));
  qs('#btn-open-convs')?.addEventListener('click', () => go('chat/history'));
  qs('#btn-new-conv')?.addEventListener('click', async () => {
    if (!state.currentBotId) return;
    const { conversation } = await api(`/api/bots/${state.currentBotId}/conversations`, { method: 'POST', body: {} });
    await openConversation(conversation.id);
  });

  // 侧栏抽屉 / 折叠 / 搜索
  qs('#btn-sidebar')?.addEventListener('click', () => {
    qs('#app').classList.toggle('drawer-open');
    const scrim = qs('#drawer-scrim');
    if (scrim) scrim.hidden = !qs('#app').classList.contains('drawer-open');
  });
  qs('#drawer-scrim')?.addEventListener('click', () => {
    qs('#app').classList.remove('drawer-open');
    qs('#drawer-scrim').hidden = true;
  });
  qs('#btn-sidebar-collapse')?.addEventListener('click', () => qs('#app').classList.toggle('sidebar-collapsed'));
  qs('#btn-bot-search')?.addEventListener('click', () => {
    const wrap = qs('#side-search-wrap');
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) qs('#bot-search')?.focus();
  });
  qs('#bot-search')?.addEventListener('input', (e) => { state.botFilter = e.target.value; renderBots(); });

  // 模型切换
  qs('#chat-model')?.addEventListener('change', async (e) => {
    const bot = state.bots.find((b) => b.id === state.currentBotId);
    if (!bot) return;
    const [providerId, model] = String(e.target.value || '').split('::');
    if (!model) return;
    if (!window.confirm(`切换模型会重启「${bot.name}」（这段对话会保留）。继续？`)) { paintModelSelect(bot); return; }
    try {
      await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: { providerId, model } });
      await loadBots();
      const fresh = state.bots.find((b) => b.id === bot.id);
      if (fresh) { renderChatSub(fresh); paintModelSelect(fresh); }
      toast(`已切到 ${model}，机器人正在重启`);
    } catch (err) { toast(err.message, true); }
  });

  // 输入 / 发送 / 停止
  qs('#btn-send')?.addEventListener('click', send);
  qs('#input')?.addEventListener('input', autoGrow);
  qs('#input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  qs('#btn-stop')?.addEventListener('click', async () => {
    state.busy = false; state.liveText = ''; state.liveBotId = null; state.progress = [];
    setComposerState(); renderMessages();
    try {
      if (state.currentGroupId) await api(`/api/groups/${state.currentGroupId}/stop`, { method: 'POST' });
      else await api(`/api/conversations/${state.conversationId}/stop`, { method: 'POST' });
      toast('已停止这一轮');
    } catch (e) { toast(e.message, true); }
  });

  // 附件：按钮、粘贴、拖放
  const filePicker = el('input', { type: 'file', multiple: 'multiple', style: 'display:none' });
  filePicker.addEventListener('change', async () => { await addFiles(filePicker.files); filePicker.value = ''; });
  document.body.append(filePicker);
  qs('#btn-attach')?.addEventListener('click', () => filePicker.click());
  qs('#input')?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault(); addFiles(files);
  });
  const composer = qs('.composer-card') || qs('.composer');
  composer?.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('dragover'); });
  composer?.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer?.addEventListener('drop', (e) => {
    e.preventDefault(); composer.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) addFiles(files);
  });

  // 面板关闭 / 模态 / 全局快捷键
  qs('#pane-scrim')?.addEventListener('click', () => go('chat'));
  qs('#btn-panel-close')?.addEventListener('click', () => go('chat'));
  qs('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('chat/search'); return; }
    if (e.key === 'Escape') {
      if (!qs('#modal').hidden) { qs('#modal').hidden = true; return; }
      if (state.pane) back();
    }
  });
}

/** 启动 */
async function boot() {
  registerEventHandlers();
  setupPaneResizer();
  bindEvents();
  startRouter();
  try {
    await loadBots();
    await loadGroups();
    const health = await api('/api/health');
    qs('#side-meta').textContent = `${state.bots.length} 个机器人 · ${health.channels && Object.values(health.channels).some((c) => c.running) ? '渠道在线' : '仅本机'}`;

    // 深链恢复：#/chat/:botId 直达指定机器人；#/chat/group/:id 直达群
    const r = resolve();
    if (r.domain === 'chat' && r.tab === 'group' && r.id) {
      await selectGroup(r.id);
    } else if (state.bots.length) {
      const target = r.domain === 'chat' && r.id ? state.bots.find((b) => b.id === r.id) : null;
      await selectBot(target?.id || state.bots[0].id);
    }
  } catch (e) {
    toast(`连不上后端：${e.message}`, true);
  }
}

boot();

// 暴露给自动化/调试用的极小钩子
window.__winbot = {
  state,
  go,
  setTheme: applyTheme,
  openSettings: () => go('connect/providers'),
};




