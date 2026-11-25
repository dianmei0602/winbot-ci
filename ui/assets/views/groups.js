/** 群聊视图（拆自原 app.js）：群列表、选群、群事件订阅、建群。 */
import { qs, el } from '../core/dom.js';
import { api, token, toast } from '../core/api.js';
import { state } from '../core/store.js';
import { emit } from '../core/events.js';
import { field, inputEl, selectEl } from '../components/form.js';
import { updateUsagePill, renderAttachments } from '../components/composer.js';
import { loadBots, renderBots } from './bots.js';
import { renderMessages } from './chat.js';

export async function loadGroups() {
  state.groups = await api('/api/groups');
  renderGroups();
}

export function renderGroups() {
  const box = qs('#group-list');
  if (!box) return;
  box.replaceChildren();
  for (const g of state.groups) {
    box.append(
      el(
        'button',
        {
          class: `bot-item${g.id === state.currentGroupId ? ' on' : ''}`,
          title: g.members.map((m) => m.name).join('、'),
          'aria-label': `打开群聊 ${g.name}`,
          onclick: () => selectGroup(g.id),
        },
        el('div', { class: 'avatar group-avatar' }, '群'),
        el('span', { class: 'name' }, g.name),
      ),
    );
  }
  if (!state.groups.length) box.append(el('div', { class: 'side-meta' }, '还没有群'));
}

export async function selectGroup(groupId) {
  state.liveText = '';
  state.liveBotId = null;
  state.currentGroupId = groupId;
  state.currentBotId = null;
  state.pane = null;
  qs('#panel').hidden = true;
  qs('#app').classList.remove('with-panel');
  renderBots();
  renderGroups();
  qs('#empty-state').hidden = true;
  qs('#chat').hidden = false;

  const data = await api(`/api/groups/${groupId}`);
  const g = data.group;
  state.currentConversationId = data.conversation?.id || null;
  state.conversationId = data.conversation?.id || null;
  state.conversation = data.conversation;
  state.messages = data.messages || [];
  state.progress = [];
  state.busy = false;
  state.attachments = [];
  state.approvals.clear();
  renderAttachments();
  updateUsagePill(data.usage);

  qs('#chat-avatar').className = 'avatar group-avatar';
  qs('#chat-avatar').textContent = '群';
  qs('#chat-name').textContent = g.name;
  qs('#chat-sub').textContent = `群聊 · ${g.members.map((m) => m.name).join('、')} · @名字 指定谁回答`;
  qs('#btn-new-conv').hidden = true;
  qs('#btn-bot-panel').hidden = true;
  renderMessages();
  subscribeGroupEvents(groupId);
  qs('#input')?.focus();
}

export function subscribeGroupEvents(groupId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const es = new EventSource(`/api/groups/${groupId}/events?token=${encodeURIComponent(token)}`);
  state.sse = es;
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type !== 'hello') emit(ev.type, ev);
    } catch {
      /* ignore */
    }
  };
}

export function openNewGroup() {
  const modal = qs('#modal');
  const card = qs('#modal-card');
  const name = inputEl('', { placeholder: '比如：写作小组、调研小队' });
  const picked = new Set(state.bots.slice(0, 2).map((b) => b.id));
  const routerSel = selectEl(
    [
      { value: 'rules', label: '规则路由（按关键词/上一个发言，零成本）' },
      { value: 'model', label: '模型路由（每句多一次小模型调用）' },
    ],
    'rules',
  );
  const chips = el('div', { class: 'chips' });
  for (const b of state.bots) {
    const chip = el(
      'button',
      {
        class: 'chip' + (picked.has(b.id) ? ' on' : ''),
        onclick: () => {
          if (picked.has(b.id)) picked.delete(b.id);
          else picked.add(b.id);
          chip.classList.toggle('on');
        },
      },
      `${b.name}`,
    );
    chips.append(chip);
  }
  card.replaceChildren(
    el('h3', {}, '建一个群'),
    field('群名（可留空）', name),
    field('拉谁进来（至少一个）', chips),
    field('没 @ 时谁回答', routerSel),
    el('div', { class: 'tip' }, '群里的消息是共享的：@谁谁回答；没 @ 时上一个回答的机器人接着说。每个机器人用自己的模型、工作区和记忆。'),
    el(
      'div',
      { class: 'foot' },
      el('button', { class: 'ghost-btn', onclick: () => (modal.hidden = true) }, '取消'),
      el(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            try {
              const { group } = await api('/api/groups', { method: 'POST', body: { name: name.value.trim(), botIds: [...picked], router: routerSel.value } });
              modal.hidden = true;
              await loadGroups();
              await selectGroup(group.id);
              toast(`群「${group.name}」建好了`);
            } catch (e) {
              toast(e.message, true);
            }
          },
        },
        '建群',
      ),
    ),
  );
  modal.hidden = false;
}
