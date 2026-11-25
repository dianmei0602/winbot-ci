/**
 * 侧栏「最近对话」+ 空状态建议卡 + 回到底部（DeepSeek 布局补件）
 */
import { el, qs, fmtTime } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/store.js';
import { openConversation } from './chat.js';

let lastKey = '';

function titleOf(c) {
  const t = String(c.title || '').trim();
  if (t) return t;
  const p = String(c.preview || c.lastMessage || '').trim();
  return p ? p.slice(0, 28) : '新对话';
}

export async function renderRecent() {
  const box = qs('#recent-list');
  const botId = state.currentBotId;
  if (!box || !botId) return;
  let list = [];
  try {
    const r = await api(`/api/bots/${botId}/conversations`);
    list = Array.isArray(r) ? r : r.conversations || [];
  } catch {
    return;
  }
  const key = `${botId}:${list.slice(0, 12).map((c) => c.id + c.updatedAt).join(',')}`;
  if (key === lastKey) return;
  lastKey = key;
  box.replaceChildren(
    ...list.slice(0, 12).map((c) =>
      el(
        'div',
        {
          class: `recent-item${c.id === state.conversationId ? ' active' : ''}`,
          role: 'listitem',
          title: titleOf(c),
          onclick: () => openConversation(c.id),
        },
        el('span', { class: 'ri-title' }, titleOf(c)),
        el('span', { class: 'ri-time' }, fmtTime(c.updatedAt || c.createdAt)),
        el(
          'button',
          {
            class: 'recent-del',
            title: '删除这条对话',
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm('删除这条对话？删了就找不回来。')) return;
              try {
                await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
                lastKey = '';
                await renderRecent();
                if (c.id === state.conversationId && state.currentBotId) {
                  const r = await api(`/api/bots/${state.currentBotId}/conversations`, { method: 'POST', body: {} });
                  await openConversation(r.conversation.id);
                }
              } catch (err) {
                alert(err.message);
              }
            },
          },
          '✕',
        ),
      ),
    ),
  );
  if (!list.length) box.append(el('div', { class: 'side-meta', style: 'padding:6px 12px' }, '还没有对话'));
}

/** 空状态建议卡：点了填进输入框 */
export function wireEmptyCards() {
  for (const card of document.querySelectorAll('#empty-cards .empty-card')) {
    card.addEventListener('click', () => {
      const input = qs('#input');
      if (!input) return;
      input.value = card.dataset.prompt || card.textContent || '';
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/** 滚动：贴底 + 回到底部按钮 */
export function wireScroll() {
  const box = qs('#messages');
  const btn = qs('#btn-to-bottom');
  if (!box || !btn) return;
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.addEventListener('scroll', () => {
    btn.hidden = nearBottom();
  });
  btn.addEventListener('click', () => {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    btn.hidden = true;
  });
  const stick = () => {
    if (nearBottom()) box.scrollTop = box.scrollHeight;
    else btn.hidden = false;
  };
  const mo = new MutationObserver(stick);
  mo.observe(box, { childList: true, subtree: true, characterData: true });
  const name = qs('#chat-name');
  if (name) {
    new MutationObserver(() => renderRecent()).observe(name, { childList: true, characterData: true });
  }
  renderRecent();
  // 机器人/会话切换没有统一事件，轮询兜底（有 lastKey 去重，开销极小）
  setInterval(() => renderRecent().catch(() => {}), 4000);
}

export function initSidebarExtras() {
  const openBotSettings = async () => {
    const { openBotPanel } = await import('./bots.js');
    await openBotPanel();
  };
  qs('#chip-workspace')?.addEventListener('click', openBotSettings);
  qs('#chip-permission')?.addEventListener('click', openBotSettings);
  wireEmptyCards();
  wireScroll();
  qs('#btn-new-conv-side')?.addEventListener('click', async () => {
    if (!state.currentBotId) return;
    const { conversation } = await api(`/api/bots/${state.currentBotId}/conversations`, { method: 'POST', body: {} });
    await openConversation(conversation.id);
    await renderRecent();
  });
}

