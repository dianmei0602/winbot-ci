/** 历史会话面板（拆自原 app.js openConversations）。路由 #/chat/history 的内容。 */
import { el, fmtTime } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/store.js';
import { openPanel } from '../core/shell.js';
import { field } from '../components/form.js';
import { openConversation } from './chat.js';
import { downloadConversation } from './bots.js';

export async function openConversations() {
  const botId = state.currentBotId;
  if (!botId) return;
  const convs = await api(`/api/bots/${botId}/conversations`);
  openPanel(
    '历史会话',
    (body) => {
      const list = el('div', { class: 'conv-list' });
      for (const c of convs) {
        list.append(
          el(
            'div',
            { class: `conv-row${c.id === state.conversationId ? ' on' : ''}` },
            el(
              'button',
              {
                class: 'conv-main',
                'aria-label': `打开会话 ${c.title || '未命名'}`,
                onclick: async () => {
                  await openConversation(c.id);
                  const { renderBots } = await import('./bots.js');
                  renderBots();
                },
              },
              el('span', { class: 't' }, c.title || '（未命名）'),
              el('span', { class: 'm' }, `${c.channel === 'app' ? '电脑' : c.channel} · ${fmtTime(c.updatedAt)}`),
            ),
            el(
              'button',
              { class: 'icon-btn tiny', title: '导出为 Markdown', 'aria-label': '导出为 Markdown', onclick: (e) => { e.stopPropagation(); downloadConversation(c.id, c.title || '会话'); } },
              '⤓',
            ),
          ),
        );
      }
      if (!convs.length) list.append(el('div', { class: 'side-meta' }, '还没有会话'));
      body.append(
        list,
        el(
          'div',
          { class: 'panel-actions' },
          el(
            'button',
            {
              class: 'primary',
              onclick: async () => {
                const { conversation } = await api(`/api/bots/${botId}/conversations`, { method: 'POST', body: {} });
                await openConversation(conversation.id);
              },
            },
            '＋ 新对话',
          ),
        ),
      );
    },
    { pane: 'convs' },
  );
}
