/**
 * 机器人视图（拆自原 app.js）：列表渲染、新建、详情/设置面板、技能、模型选择、导出。
 * 函数间及跨视图的调用通过 ESM import；函数声明有 hoisting，模块顶层不调用，循环 import 安全。
 */
import { qs, el, relTime } from '../core/dom.js';
import { api, apiRaw, toast } from '../core/api.js';
import { state } from '../core/store.js';
import { openPanel, closePanel, closeDrawer } from '../core/shell.js';
import { field, inputEl, selectEl } from '../components/form.js';
import { go } from '../core/router.js';
import { selectBot } from './chat.js';
import { openConversations } from './conversations.js';
import { openSkillsSection as openSkillsSectionImpl } from './skills.js';

export function botSnippet(b) {
  const last = b.last;
  if (!last || !String(last.text || '').trim()) return b.summary || '还没聊过';
  const one = String(last.text).replace(/\s+/g, ' ').trim();
  return (last.role === 'user' ? '你：' : '') + one.slice(0, 42);
}

export function renderBots() {
  const list = qs('#bot-list');
  if (!list) return;
  list.replaceChildren();
  const q = String(state.botFilter || '').trim().toLowerCase();
  const bots = q ? state.bots.filter((b) => `${b.name} ${b.summary || ''}`.toLowerCase().includes(q)) : state.bots;
  for (const b of bots) {
    const dotCls = b.status?.busy ? 'dot busy' : b.status?.state === 'running' ? 'dot run' : 'dot';
    const item = el(
      'button',
      {
        class: `bot-item${b.id === state.currentBotId ? ' on' : ''}`,
        title: `${b.name}\n${b.summary || ''}`,
        'aria-label': `打开机器人 ${b.name}`,
        onclick: () => {
          go(`chat/${b.id}`);
          selectBot(b.id);
        },
      },
      el('div', { class: `avatar ${b.avatar || 'blue'}` }, (b.name || '?').slice(0, 1)),
      el(
        'div',
        { class: 'bot-lines' },
        el(
          'div',
          { class: 'bot-line' },
          el('span', { class: 'name' }, b.name),
          el('span', { class: 'time' }, relTime(b.last?.at)),
          el('span', { class: dotCls }),
        ),
        el('div', { class: 'bot-snippet' }, botSnippet(b)),
      ),
    );
    list.append(item);
  }
  if (!state.bots.length) {
    list.append(el('div', { class: 'side-meta' }, '还没有机器人'));
  } else if (!bots.length) {
    list.append(el('div', { class: 'side-meta' }, '没有匹配的机器人'));
  }
}

export async function loadBots() {
  state.bots = await api('/api/bots');
  renderBots();
}

export function renderChatSub(bot) {
  const perm = { readonly: '只读', 'workspace-write': '工作区', 'danger-full-access': '完全权限' }[bot.permission] || bot.permission;
  const st = bot.status?.state === 'running' ? (bot.status.busy ? '正在干活' : '在线') : '未启动';
  qs('#chat-sub').textContent = `${perm} · ${bot.model || '未选模型'} · ${st}`;
  const chip = qs('#perm-chip');
  if (chip) chip.textContent = perm;
  // 窄屏会隐藏「机器人设置」按钮，给标题栏一个长按/点击也能进设置的入口
  qs('#chat-avatar').title = '点这里打开机器人设置';
}

export function paintModelSelect(bot) {
  const sel = qs('#chat-model');
  if (!sel) return;
  const choices = state.settings?.modelChoices || [];
  const groups = new Map();
  for (const c of choices) {
    const g = c.providerName || c.providerId || '模型';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  sel.replaceChildren();
  for (const [g, items] of groups) {
    const og = el('optgroup', { label: g });
    for (const c of items) {
      og.append(el('option', { value: `${c.providerId}::${c.model}`, selected: c.providerId === bot.providerId && c.model === (bot.model || '') }, c.model));
    }
    sel.append(og);
  }
  if (!choices.length) sel.append(el('option', { value: '', selected: true }, bot.model || '未选模型'));
  const want = `${bot.providerId || ''}::${bot.model || ''}`;
  try {
    sel.value = want;
  } catch {
    /* ignore */
  }
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  sel.title = `当前：${bot.model || '未选模型'}（切换会重启这个机器人）`;
}

export async function paintModelSelectFor(bot) {
  if (!state.settings?.modelChoices?.length) {
    try {
      state.settings = await api('/api/settings');
    } catch {
      /* ignore */
    }
  }
  paintModelSelect(bot);
}

/** 新建机器人弹窗 */
export function openNewBot() {
  const modal = qs('#modal');
  const card = qs('#modal-card');
  const name = inputEl('', { placeholder: '比如：小七、工作助手、读书搭子' });
  const persona = el('textarea', { placeholder: '它是什么样的人？说话风格、擅长什么、不该做什么…（可以留空，用默认）' });
  const color = selectEl(
    ['blue', 'green', 'yellow', 'red', 'purple', 'orange'].map((c) => ({ value: c, label: c })),
    ['blue', 'green', 'purple', 'orange', 'red', 'yellow'][state.bots.length % 6],
  );
  card.replaceChildren(
    el('h3', {}, '新建机器人'),
    field('名字', name),
    field('头像颜色', color),
    field('人设', persona, '之后在「机器人设置」里随时能改'),
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
              const { bot } = await api('/api/bots', {
                method: 'POST',
                body: { name: name.value.trim() || '新机器人', avatar: color.value, persona: persona.value.trim() || undefined },
              });
              modal.hidden = true;
              await loadBots();
              await selectBot(bot.id);
              toast(`「${bot.name}」建好了`);
            } catch (e) {
              toast(e.message, true);
            }
          },
        },
        '创建',
      ),
    ),
  );
  modal.hidden = false;
  setTimeout(() => name.focus(), 30);
}

/** 机器人详情/设置面板（路由 #/bots 的内容） */
export async function openBotPanel() {
  const botId = state.currentBotId;
  if (!botId) return;
  const data = await api(`/api/bots/${botId}`);
  const settings = await api('/api/settings');
  const bot = data.bot;
  const models = settings.modelChoices;
  const provs = settings.config.providers;

  openPanel(
    '机器人设置',
    (body) => {
      const name = inputEl(bot.name);
      const summary = inputEl(bot.summary);
      const avatar = selectEl(['blue', 'green', 'yellow', 'red', 'purple', 'orange'].map((c) => ({ value: c, label: c })), bot.avatar);
      const provSelect = selectEl(
        provs.map((p) => ({ value: p.id, label: `${p.name}${p.ready ? '' : p.locked ? '（先在 DSH 登录）' : '（没有 Key）'}` })),
        bot.providerId,
        { id: 'provSelect' },
      );
      const modelOptions = () => {
        const pid = provSelect.value;
        const p = provs.find((x) => x.id === pid);
        return (p?.models || []).map((m) => ({ value: typeof m === 'string' ? m : m.id, label: typeof m === 'string' ? m : m.id }));
      };
      let modelSelect = selectEl(modelOptions(), bot.model, { id: 'modelSelect' });
      provSelect.addEventListener('change', () => {
        const next = selectEl(modelOptions(), modelOptions()[0]?.value);
        modelSelect.replaceWith(next);
        modelSelect = next;
      });
      const desktop = selectEl(
        [
          { value: 'off', label: '关（不让它碰桌面）' },
          { value: 'ask', label: '每次问我（读屏不用，动键鼠要点头）' },
          { value: 'auto', label: '自动执行（我信任它）' },
        ],
        bot.desktopUse || 'off',
      );
      const perm = selectEl(Object.entries(data.permissions).map(([k, v]) => ({ value: k, label: `${v.label} — ${v.desc}` })), bot.permission);
      // 智能体内核：DSH（默认）或 Codex。Codex 没装时后端会给 available=false 和原因
      const engineList = settings.engines || [{ id: 'dsh', label: 'DSH（默认）', desc: '', available: true }];
      const engineSel = selectEl(
        engineList.map((e) => ({ value: e.id, label: `${e.label}${e.available === false ? '（不可用）' : ''}` })),
        bot.engine || 'dsh',
      );
      const engineTip = el('div', { class: 'tip' });
      const syncEngineTip = () => {
        const e = engineList.find((x) => x.id === engineSel.value);
        engineTip.textContent = e ? `${e.desc || ''}${e.available === false && e.hint ? ` ${e.hint}` : ''}` : '';
      };
      engineSel.addEventListener('change', syncEngineTip);
      syncEngineTip();
      const dailyBudget = inputEl(bot.dailyBudgetTokens || '', { type: 'number', min: '0', placeholder: '0 = 不限' });
      const memoryToggle = el('input', { type: 'checkbox', checked: bot.memoryEnabled ? 'checked' : null });
      const persona = el('textarea', {}, { value: data.persona });
      persona.value = data.persona;
      const memory = el('textarea', { style: 'min-height:110px' });
      memory.value = data.memory;

      const save = async () => {
        try {
          await api(`/api/bots/${bot.id}`, {
            method: 'PATCH',
            body: {
              name: name.value.trim() || bot.name,
              summary: summary.value,
              avatar: avatar.value,
              engine: engineSel.value,
              providerId: provSelect.value,
              model: modelSelect.value,
              permission: perm.value,
              desktopUse: desktop.value,
              dailyBudgetTokens: Number(dailyBudget.value) || 0,
              memoryEnabled: memoryToggle.checked,
              persona: persona.value,
              memory: memory.value,
            },
          });
          toast('已保存（机器人已重启，下次发消息用新配置）');
          await loadBots();
          const b = state.bots.find((x) => x.id === bot.id);
          if (b) renderChatSub(b);
          renderBots();
        } catch (e) {
          toast(e.message, true);
        }
      };

      body.append(
        field('名字', name),
        field('一句话', summary),
        field('头像颜色', avatar),
        el('div', { class: 'row-2' }, field('智能体内核', engineSel), el('div', { class: 'field' }, el('label', {}, '说明'), engineTip)),
        el('div', { class: 'row-2' }, field('模型接口', provSelect), field('模型', modelSelect)),
        field('权限', perm, '「工作区」下，写到工作区以外会停下来问你'),
        field('电脑操作', desktop, '打开后它能截屏、看窗口、点鼠标、敲键盘；默认每次都要你同意'),
        field('每天最多用多少 token', dailyBudget, `今天已经用了 ${data.usageToday?.totalTokens || 0} tokens；0 = 不限，超了它会拒绝干活`),
        field('记忆', el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);width:auto;white-space:nowrap' }, memoryToggle, '把长期记忆带进每次对话')),
        field('人设（每次发消息前拼给模型）', persona, '改这里就是改性格；也可以让它自己改'),
        field('长期记忆（可手改）', memory, '也可以让它把重要的事写进工作区 MEMORY.md'),
        el('div', { id: 'bot-skills-box' }, el('div', { class: 'side-meta' }, '技能加载中…')),
        el('div', { class: 'section-title' }, '工作区'),
        el('pre', { class: 'mono' }, data.workspace),
        el(
          'div',
          { class: 'panel-actions' },
          el('button', { class: 'primary', onclick: save }, '保存'),
          el('button', { class: 'ghost-btn', onclick: () => go('chat/history') }, '历史会话'),
          el(
            'button',
            {
              class: 'ghost-btn danger',
              onclick: async () => {
                if (!confirm(`删除「${bot.name}」？工作区文件可以不保留。`)) return;
                const keep = confirm('要保留它的工作区文件吗？（取消 = 一起删掉）');
                await api(`/api/bots/${bot.id}?keep=${keep ? 1 : 0}`, { method: 'DELETE' });
                toast('已删除');
                state.currentBotId = null;
                await loadBots();
                qs('#chat').hidden = true;
                qs('#empty-state').hidden = false;
                closePanel();
                go('chat');
              },
            },
            '删除机器人',
          ),
        ),
      );
      openSkillsSectionImpl(bot.id, qs('#bot-skills-box')).catch(() => {});
    },
    { pane: 'bot' },
  );
}

export async function downloadConversation(convId, label) {
  try {
    const res = await apiRaw(`/api/conversations/${convId}/export`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `${label || 'winbot'}-${convId.slice(-6)}.md` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 Markdown');
  } catch (e) {
    toast(`导出失败：${e.message}`, true);
  }
}
