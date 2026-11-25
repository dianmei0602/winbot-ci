/** 搜索视图（拆自原 app.js openSearch）。路由 #/chat/search，快捷键 Ctrl+K。 */
import { qs, el, fmtTime } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/store.js';
import { openPanel, closePanel } from '../core/shell.js';
import { field, inputEl, selectEl } from '../components/form.js';
import { openConversation, renderMessages } from './chat.js';
import { renderBots, renderChatSub } from './bots.js';

export async function openSearch(initial = '') {
  openPanel(
    '搜索聊天记录',
    (body) => {
      const input = inputEl(initial, { placeholder: '搜消息内容…（回车搜索）', 'aria-label': '搜索关键词' });
      const scope = selectEl(
        [{ value: '', label: '所有机器人' }, ...state.bots.map((b) => ({ value: b.id, label: b.name }))],
        '',
      );
      const results = el('div', { class: 'search-results', 'aria-live': 'polite' });
      const run = async () => {
        const q = input.value.trim();
        results.replaceChildren();
        if (!q) return;
        const items = await api(`/api/search?q=${encodeURIComponent(q)}${scope.value ? `&botId=${encodeURIComponent(scope.value)}` : ''}`);
        if (!items.length) {
          results.append(el('div', { class: 'side-meta' }, '没找到'));
          return;
        }
        for (const m of items) {
          const who = m.role === 'user' ? '你' : m.role === 'assistant' ? (state.bots.find((b) => b.id === m.botId)?.name || '机器人') : m.role;
          const text = String(m.content || '').replace(/\s+/g, ' ');
          const idx = text.toLowerCase().indexOf(q.toLowerCase());
          const snippet = idx >= 0 ? `${idx > 20 ? '…' : ''}${text.slice(Math.max(0, idx - 20), idx + 100)}` : text.slice(0, 120);
          results.append(
            el(
              'button',
              {
                class: 'search-row',
                onclick: async () => {
                  const bot = state.bots.find((b) => b.id === m.botId);
                  if (bot) {
                    state.currentBotId = bot.id;
                    state.currentGroupId = null;
                    renderBots();
                    qs('#empty-state').hidden = true;
                    qs('#chat').hidden = false;
                    qs('#chat-avatar').className = `avatar ${bot.avatar || 'blue'}`;
                    qs('#chat-avatar').textContent = (bot.name || '?').slice(0, 1);
                    qs('#chat-name').textContent = bot.name;
                    renderChatSub(bot);
                  }
                  await openConversation(m.conversationId);
                  closePanel();
                  // 滚到那条消息附近
                  setTimeout(() => {
                    const nodes = [...qs('#messages').children];
                    const target = nodes.find((n) => n.textContent.includes(snippet.slice(0, 24)));
                    target?.scrollIntoView({ block: 'center' });
                  }, 250);
                },
              },
              el('div', { class: 'search-meta' }, `${who} · ${m.title || '未命名会话'} · ${fmtTime(m.createdAt)}`),
              el('div', { class: 'search-text' }, snippet),
            ),
          );
        }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
      scope.addEventListener('change', () => input.value.trim() && run());
      body.append(
        el('div', { class: 'tip' }, '只搜本机保存的消息，不调用模型。'),
        field('关键词', input),
        field('范围', scope),
        el('div', { class: 'panel-actions' }, el('button', { class: 'primary', onclick: run }, '搜索')),
        results,
      );
      setTimeout(() => input.focus(), 50);
      if (initial) run();
    },
    { pane: 'search' },
  );
}
