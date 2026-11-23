// winbot 控制台前端：纯原生 ES 模块，无构建步骤。
const token = new URLSearchParams(location.search).get('token') || '' || document.cookie.match(/(?:^|;\s*)winbot=([^;]+)/)?.[1] || '';
if (token) document.cookie = `winbot=${token}; path=/; SameSite=Strict`;
const qs = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const state = {
  bots: [],
  groups: [],
  currentBotId: null,
  currentGroupId: null,
  conversationId: null,
  conversation: null,
  messages: [],
  approvals: new Map(),
  pane: null, // 'bot' | 'settings' | 'convs' | null
  sse: null,
  busy: false,
  progress: [],
  openTools: new Set(),
  attachments: [], // 还没发出去的附件 {path,name,size,kind,url}
  usage: null,
  liveText: '', // 模型正在输出的文字（逐字）
  liveBotId: null,
  comfyUrl: 'http://127.0.0.1:8188',
  connectorPresets: [],
  botFilter: '',
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

async function apiRaw(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = JSON.parse(await res.text())?.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

function toast(msg, isErr = false) {
  const t = el('div', { class: `toast${isErr ? ' err' : ''}` }, msg);
  qs('#toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 极简 markdown：代码块、行内代码、粗体、链接、标题、列表。够用且不引依赖。 */
function md(src) {
  let s = esc(src || '');
  const blocks = [];
  s = s.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  s = s.replace(/^[-*] (.*)$/gm, '· $1');
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return s;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};

const fmtTokens = (n) => {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** 工作区里一个文件的访问地址（图片直接 <img>） */
function botFileUrl(botId, rel) {
  return `/api/bots/${encodeURIComponent(botId)}/file?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`;
}

function updateUsagePill(usage) {
  state.usage = usage || null;
  const pill = qs('#usage-pill');
  if (!pill) return;
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) {
    pill.textContent = '—';
    pill.title = '这段对话还没产生用量';
    return;
  }
  const prompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0);
  pill.textContent = `↑${fmtTokens(prompt)} ↓${fmtTokens(usage.outputTokens)}`;
  pill.title = `这段对话累计：上下文 ${prompt} tokens（其中缓存命中 ${usage.cacheReadTokens || 0}）、输出 ${usage.outputTokens} tokens、共 ${usage.turns || 0} 次模型调用`;
}

// ---------- 附件 ----------

/**
 * 上传一个文件到当前机器人的工作区 assets/。
 * 图片直接作为图片给模型看，其它文件落盘后由模型自己用读文件工具打开。
 */
async function uploadOne(file) {
  if (!state.currentBotId) throw new Error('先选一个机器人');
  if (file.size > 30 * 1024 * 1024) throw new Error(`${file.name} 超过 30 MB`);
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`读不了 ${file.name}`));
    reader.readAsDataURL(file);
  });
  const r = await api(`/api/bots/${state.currentBotId}/upload`, {
    method: 'POST',
    body: { name: file.name || 'file.bin', data },
  });
  return { ...r, url: r.kind === 'image' ? botFileUrl(state.currentBotId, r.path) : null };
}

async function addFiles(fileList) {
  const files = [...(fileList || [])].slice(0, 8);
  if (!files.length) return;
  qs('#btn-attach')?.classList.add('busy');
  try {
    for (const f of files) {
      try {
        state.attachments.push(await uploadOne(f));
      } catch (e) {
        toast(e.message, true);
      }
    }
    renderAttachments();
  } finally {
    qs('#btn-attach')?.classList.remove('busy');
  }
}

function renderAttachments() {
  const box = qs('#attachments');
  box.replaceChildren();
  box.hidden = state.attachments.length === 0;
  state.attachments.forEach((att, i) => {
    box.append(
      el(
        'div',
        { class: 'att-chip' },
        att.url ? el('img', { src: att.url, alt: att.name }) : el('span', { class: 'avatar blue' }, '📄'),
        el(
          'span',
          { class: 'meta' },
          el('span', { class: 'name', title: att.path }, att.name),
          el('span', { class: 'size' }, `${fmtBytes(att.size)} · ${att.kind === 'image' ? '图片' : '文件'}`),
        ),
        el(
          'button',
          {
            class: 'x',
            title: '移除',
            onclick: () => {
              state.attachments.splice(i, 1);
              renderAttachments();
            },
          },
          '×',
        ),
      ),
    );
  });
}

// ---------- 群聊 ----------

async function loadGroups() {
  state.groups = await api('/api/groups');
  renderGroups();
}

function renderGroups() {
  const box = qs('#group-list');
  box.replaceChildren();
  for (const g of state.groups) {
    box.append(
      el(
        'button',
        {
          class: `bot-item${g.id === state.currentGroupId ? ' on' : ''}`,
          title: g.members.map((m) => m.name).join('、'),
          onclick: () => selectGroup(g.id),
        },
        el('div', { class: 'avatar group-avatar' }, '群'),
        el('span', { class: 'name' }, g.name),
      ),
    );
  }
  if (!state.groups.length) box.append(el('div', { class: 'side-meta' }, '还没有群'));
}

async function selectGroup(groupId) {
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

function subscribeGroupEvents(groupId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const es = new EventSource(`/api/groups/${groupId}/events?token=${encodeURIComponent(token)}`);
  state.sse = es;
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
}

function openNewGroup() {
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

// ---------- 右侧面板拖拽调宽 ----------

function setupPaneResizer() {
  const handle = qs('#pane-resizer');
  const root = document.documentElement;
  // 上限给对话至少留 420px（左侧栏固定 232px），下限 320px
  const maxW = () => Math.max(320, Math.min(1200, window.innerWidth - 232 - 420));
  const clamp = (w) => Math.max(320, Math.min(w, maxW()));
  const apply = (w) => root.style.setProperty('--panel-w', `${Math.round(w)}px`);
  let dragging = false;

  // 记住上次拖的宽度
  const saved = Number(localStorage.getItem('winbot.panelW')) || 0;
  if (saved) apply(saved);

  handle.addEventListener('pointerdown', (e) => {
    if (window.innerWidth <= 820) return;
    dragging = true;
    handle.classList.add('active');
    document.body.classList.add('resizing-pane');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有真实指针，忽略 */
    }
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 面板贴右边，宽度 = 视口宽 - 指针位置
    apply(clamp(window.innerWidth - e.clientX));
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.classList.remove('resizing-pane');
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const w = parseInt(root.style.getPropertyValue('--panel-w'), 10) || 0;
    if (w) localStorage.setItem('winbot.panelW', String(w));
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);

  // 双击回到默认宽度
  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--panel-w');
    localStorage.removeItem('winbot.panelW');
  });
}

// ---------- ComfyUI 侧边面板 ----------

/** 右边直接嵌 ComfyUI：生图/生视频时能看着它跑 */
function openComfyPanel({ auto = false } = {}) {
  const url = state.comfyUrl || 'http://127.0.0.1:8188';
  // 立刻画出来，别等状态请求（ComfyUI 忙着生成时接口会慢，等它就看不到「正在跑」了）
  openPanel('ComfyUI', (b) => {
    b.append(
      el(
        'div',
        { class: 'panel-actions' },
        el('button', { class: 'ghost-btn', onclick: () => openComfyPanel(), title: '重新加载' }, '刷新'),
        el('a', { class: 'ghost-btn', href: url, target: '_blank', rel: 'noreferrer' }, '在新窗口打开'),
      ),
      el('div', { class: 'tip' }, auto ? '正在这里跑，进度直接看它的队列。' : '这是本机的 ComfyUI 界面，和生成用的是同一个。'),
      el('iframe', { class: 'comfy-frame', src: url, title: 'ComfyUI' }),
    );
  });
  // 顺手确认一下地址；ComfyUI 没跑时给个说明，别只留个空白框
  api('/api/comfy/status')
    .then((st) => {
      if (st?.url) state.comfyUrl = st.url;
      if (st && !st.up) {
        const body = qs('#panel-body');
        if (body && !body.querySelector('.comfy-down')) {
          body.prepend(
            el('div', { class: 'tip comfy-down' }, `ComfyUI 没在跑（${st.url}）。先在命令行把它启动起来，这个框里就会显示它的界面。`),
          );
        }
      }
    })
    .catch(() => {});
}

// ---------- 机器人列表 ----------

function relTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (diff < 7 * 86_400_000) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function botSnippet(b) {
  const last = b.last;
  if (!last || !String(last.text || '').trim()) return b.summary || '还没聊过';
  const one = String(last.text).replace(/\s+/g, ' ').trim();
  return (last.role === 'user' ? '你：' : '') + one.slice(0, 42);
}

function renderBots() {
  const list = qs('#bot-list');
  if (!list) return;
  list.replaceChildren();
  const q = String(state.botFilter || '').trim().toLowerCase();
  const bots = q
    ? state.bots.filter((b) => `${b.name} ${b.summary || ''}`.toLowerCase().includes(q))
    : state.bots;
  for (const b of bots) {
    const dotCls = b.status?.busy ? 'dot busy' : b.status?.state === 'running' ? 'dot run' : 'dot';
    const item = el(
      'button',
      {
        class: `bot-item${b.id === state.currentBotId ? ' on' : ''}`,
        title: `${b.name}\n${b.summary || ''}`,
        onclick: () => selectBot(b.id),
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

async function loadBots() {
  state.bots = await api('/api/bots');
  renderBots();
}

// ---------- 会话 ----------

function closeDrawer() {
  if (window.innerWidth > 700) return;
  qs('#app').classList.remove('drawer-open');
  const scrim = qs('#drawer-scrim');
  if (scrim) scrim.hidden = true;
}

async function selectBot(botId) {
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
  if (box) box.placeholder = window.innerWidth <= 700 ? `给 ${bot.name} 发消息…` : `给 ${bot.name} 发消息…（Enter 发送，Shift+Enter 换行）`;
  paintModelSelectFor(bot);
  await openLatestConversation(botId);
}

function paintModelSelect(bot) {
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
  if (!choices.length) {
    sel.append(el('option', { value: '', selected: true }, bot.model || '未选模型'));
  }
  const want = `${bot.providerId || ''}::${bot.model || ''}`;
  try {
    sel.value = want;
  } catch {
    /* ignore */
  }
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  sel.title = `当前：${bot.model || '未选模型'}（切换会重启这个机器人）`;
}

async function paintModelSelectFor(bot) {
  if (!state.settings?.modelChoices?.length) {
    try {
      state.settings = await api('/api/settings');
    } catch {
      /* ignore */
    }
  }
  paintModelSelect(bot);
}

function renderChatSub(bot) {
  const perm = { readonly: '只读', 'workspace-write': '工作区', 'danger-full-access': '完全权限' }[bot.permission] || bot.permission;
  const st = bot.status?.state === 'running' ? (bot.status.busy ? '正在干活' : '在线') : '未启动';
  qs('#chat-sub').textContent = `${perm} · ${bot.model || '未选模型'} · ${st}`;
  // 窄屏会隐藏「机器人设置」按钮，给标题栏一个长按/点击也能进设置的入口
  qs('#chat-avatar').title = '点这里打开机器人设置';
}

async function openLatestConversation(botId) {
  const convs = await api(`/api/bots/${botId}/conversations`);
  if (convs.length) {
    await openConversation(convs[0].id);
  } else {
    const { conversation } = await api(`/api/bots/${botId}/conversations`, { method: 'POST', body: {} });
    await openConversation(conversation.id);
  }
}

async function openConversation(convId) {
  state.conversationId = convId;
  state.approvals.clear();
  state.attachments = [];
  renderAttachments();
  const data = await api(`/api/conversations/${convId}`);
  state.conversation = data.conversation;
  state.messages = data.messages;
  state.progress = [];
  state.busy = false;
  updateUsagePill(data.usage);
  renderMessages();
  subscribeEvents(convId);
  qs('#input')?.focus();
}

function subscribeEvents(convId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const es = new EventSource(`/api/conversations/${convId}/events?token=${encodeURIComponent(token)}`);
  state.sse = es;
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    onEvent(ev);
  };
  es.onerror = () => {
    // EventSource 自己会重连；这里不打扰用户
  };
}

function onEvent(ev) {
  if (ev.type === 'hello') return;
  if (ev.type === 'tool-call') {
    state.progress.push({ kind: 'tool', botId: ev.botId || state.liveBotId, callId: ev.callId, name: ev.name, args: ev.args, done: false, startedAt: Date.now() });
    renderProgress();
    return;
  }
  if (ev.type === 'tool-result') {
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
    return;
  }
  if (ev.type === 'assistant-step') {
    if (ev.text || ev.reasoning) {
      // 这一段定稿了：把逐字缓冲收进进度（用服务端的完整文本），避免少字/重字
      state.progress.push({ kind: 'say', botId: ev.botId || state.liveBotId, text: ev.text, reasoning: ev.reasoning });
      if (ev.text) {
        state.liveText = '';
      }
      renderProgress();
    }
    return;
  }
  if (ev.type === 'media-start') {
    // 生图/生视频开跑：把右边切到 ComfyUI，让用户看着它跑
    if (state.pane !== 'ComfyUI') {
      openComfyPanel({ auto: true }).catch(() => {});
      toast(ev.kind === 'video' ? '在右边看视频生成' : '在右边看它画');
    }
    return;
  }
  if (ev.type === 'delta') {
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
    return;
  }
  if (ev.type === 'turn-status') {
    state.busy = ev.status === 'running';
    setComposerState();
    if (ev.status === 'idle') endOfTurn();
    return;
  }
  if (ev.type === 'status') {
    // 刷新左侧状态点与标题栏
    loadBots().then(() => {
      renderBots();
      const b = state.bots.find((x) => x.id === state.currentBotId);
      if (b) renderChatSub(b);
    });
    if (ev.busy === false) endOfTurn();
    return;
  }
  if (ev.type === 'approval') {
    state.approvals.set(ev.approval.id, ev.approval);
    // 审批卡直接落进消息流
    state.messages.push({
      id: `appr-${ev.approval.id}`,
      role: 'approval',
      content: `${ev.approval.tool}${ev.approval.detail ? `：${ev.approval.detail}` : ''}`,
      meta: { approvalId: ev.approval.id, tool: ev.approval.tool, detail: ev.approval.detail, status: 'pending' },
      createdAt: Date.now(),
    });
    renderMessages();
    return;
  }
  if (ev.type === 'usage') {
    updateUsagePill(ev.usage);
    return;
  }
  if (ev.type === 'schedule-run') {
    if (ev.status === 'error') toast(`定时任务出错：${ev.text || ''}`, true);
    else if (ev.status === 'ok' && ev.text) toast(`⏰ ${ev.text.slice(0, 80)}`);
    if (state.pane === '定时任务') openSchedules();
    return;
  }
  if (ev.type === 'approval-resolved') {
    for (const m of state.messages) {
      if (m.meta?.approvalId === ev.approvalId) m.meta.status = ev.status;
    }
    renderMessages();
    return;
  }
}

function setComposerState() {
  qs('#btn-send').disabled = state.busy;
  const stop = qs('#btn-stop');
  if (stop) stop.hidden = !state.busy;
  const attach = qs('#btn-attach');
  if (attach) attach.disabled = state.busy;
  qs('#composer-hint').textContent = state.busy ? '正在处理…（可以看上面的工具步骤）' : '';
}

// 逐字输出时别每来一个包就整屏重画：合并到下一帧
let liveFrame = 0;
function scheduleLiveRender() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    renderProgress();
  });
}

// 一轮结束：清掉流式片段，把服务端落好的最终消息拉回来，
// 否则界面上只剩一段灰字缩略，看着像备注而不是对话
let endTimer = null;
function endOfTurn() {
  state.busy = false;
  state.liveText = '';
  state.liveBotId = null;
  setComposerState();
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(async () => {
    endTimer = null;
    // 保留进度：这一轮结束后仍能看到「用了 N 个工具」的折叠行，下一条消息再清
    try {
      await reloadMessages();
    } catch {
      /* 拉失败就保持现状 */
    }
  }, 400);
}

async function reloadMessages() {
  if (!state.conversationId) return;
  const data = await api(`/api/conversations/${state.conversationId}`);
  state.messages = data.messages;
  state.progress = [];
  renderMessages();
}

// ---------- 渲染消息 ----------

function renderMessages() {
  const box = qs('#messages');
  box.replaceChildren();
  const bot = state.bots.find((b) => b.id === state.currentBotId);
  for (const m of state.messages) {
    if (m.role === 'approval') {
      box.append(approvalCard(m, bot));
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
      bubbleChildren.push(fileCards(m.meta.files, m.meta.speakerBotId || state.currentBotId || state.conversation?.botId));
    }
    box.append(
      el(
        'div',
        { class: cls },
        el('div', { class: 'avatar ' + (isUser ? 'purple' : speakerAvatar) }, isUser ? '你' : speakerName.slice(0, 1)),
        el('div', {}, el('div', { class: 'who' }, `${who} · ${fmtTime(m.createdAt)}`), ...bubbleChildren),
      ),
    );
  }
  // 工具步骤默认折叠成一行「小七 用了 3 个工具」，点开看细节
  let pi = 0;
  while (pi < state.progress.length) {
    const p = state.progress[pi];
    if (p.kind === 'tool') {
      let pj = pi;
      while (pj < state.progress.length && state.progress[pj].kind === 'tool' && state.progress[pj].botId === p.botId) pj += 1;
      const items = state.progress.slice(pi, pj);
      const owner = state.bots.find((b) => b.id === p.botId);
      const key = `tools:${p.botId || '?'}:${pi}`;
      const open = state.openTools.has(key);
      const running = pj === state.progress.length && state.busy;
      const failed = items.filter((x) => x.isError).length;
      const allDone = items.every((x) => x.done);
      const head = el(
        'button',
        {
          class: 'tool-summary',
          onclick: () => {
            if (state.openTools.has(key)) state.openTools.delete(key);
            else state.openTools.add(key);
            renderMessages();
          },
        },
        owner ? el('span', { class: `tool-who ${owner.avatar || 'blue'}` }, owner.name) : null,
        el('span', { class: 'tool-sum' }, `用了 ${items.length} 个工具`),
        running ? el('span', { class: 'tool-live' }, '正在跑…') : null,
        failed ? el('span', { class: 'tool-fail' }, `${failed} 个失败`) : allDone ? el('span', { class: 'tool-ok' }, '完成') : null,
        allDone ? el('span', { class: 'tool-total' }, `${(items.reduce((n, x) => n + (x.ms || 0), 0) / 1000).toFixed(1)}s`) : null,
        el('span', { class: 'caret' }, open ? '▾' : '▸'),
      );
      const detail = el(
        'div',
        { class: 'tool-detail' },
        ...items.map((x) =>
          el(
            'div',
            { class: `tool-line${x.isError ? ' failed' : x.done ? ' ok' : ''}` },
            el('span', { class: 'tool-mark' }, x.isError ? '✗' : x.done ? '✓' : '·'),
            el('span', { class: 'tool-name' }, x.name),
            el('span', { class: 'tool-args' }, String(x.args || '').slice(0, 200)),
            x.ms ? el('span', { class: 'tool-ms' }, `${(x.ms / 1000).toFixed(1)}s`) : null,
            x.isError ? el('span', { class: 'tool-reason' }, x.reason || x.result || '失败（没有更多信息）') : null,
          ),
        ),
      );
      detail.hidden = !open;
      box.append(el('div', { class: 'tool-group' }, head, detail));
      pi = pj;
      continue;
    }
    if (p.kind === 'say' && p.text) {
      // 中途说的那句话，按正常气泡显示，和最终消息同一套样式
      const speaker = state.bots.find((b) => b.id === p.botId) || state.bots.find((b) => b.id === state.currentBotId);
      box.append(
        el(
          'div',
          { class: 'msg bot streaming' },
          el('div', { class: `avatar ${speaker?.avatar || 'blue'}` }, (speaker?.name || '?').slice(0, 1)),
          el(
            'div',
            {},
            el('div', { class: 'who' }, `${speaker?.name || '机器人'} · 正在说`),
            el('div', { class: 'bubble', html: md(p.text) }),
          ),
        ),
      );
    }
    pi += 1;
  }
  // 正在逐字输出的那一段：跟正式气泡同样式，末尾一个光标
  if (state.liveText) {
    const speaker = state.bots.find((b) => b.id === state.liveBotId) || state.bots.find((b) => b.id === state.currentBotId);
    box.append(
      el(
        'div',
        { class: 'msg bot streaming' },
        el('div', { class: `avatar ${speaker?.avatar || 'blue'}` }, (speaker?.name || '?').slice(0, 1)),
        el(
          'div',
          {},
          el('div', { class: 'who' }, `${speaker?.name || '机器人'} · 正在说`),
          (() => {
            // 逐字气泡和正式消息用同一套 markdown 渲染，否则标签会当文本显示
            const bubble = el('div', { class: 'bubble' });
            bubble.innerHTML = md(state.liveText);
            bubble.append(el('span', { class: 'caret' }, '▍'));
            return bubble;
          })(),
        ),
      ),
    );
  }
  if (state.busy && !state.liveText) box.append(el('div', { class: 'typing' }, '…'));
  box.scrollTop = box.scrollHeight;
}

function renderProgress() {
  renderMessages();
}

/** 机器人用 present 交付的文件：给成可点开的卡片 */
function fileCards(files, botId) {
  const row = el('div', { class: 'file-cards' });
  for (const f of files) {
    const rel = typeof f === 'string' ? f : f.path;
    const desc = typeof f === 'string' ? '' : f.description || '';
    const name = String(rel).split('/').pop();
    const url = botFileUrl(botId, rel);
    const ext = String(rel).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    // 图片直接显示，视频给播放器，其它还是文件卡片
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      row.append(
        el(
          'a',
          { class: 'media-card', href: url, target: '_blank', rel: 'noreferrer', title: desc || rel },
          el('img', { src: url, alt: desc || name, loading: 'lazy' }),
          desc ? el('span', { class: 'media-desc' }, desc) : null,
        ),
      );
      continue;
    }
    if (['glb', 'gltf', 'obj', 'ply', 'stl'].includes(ext)) {
      row.append(
        el(
          'a',
          { class: 'file-card model-card', href: url, target: '_blank', rel: 'noreferrer', title: desc || rel, download: name },
          el('span', { class: 'fc-icon' }, '🧊'),
          el(
            'span',
            { class: 'fc-body' },
            el('span', { class: 'fc-name' }, name),
            el('span', { class: 'fc-desc' }, desc ? `${desc} · 3D 模型` : '3D 模型（glb）'),
          ),
        ),
      );
      continue;
    }
    if (['mp4', 'webm'].includes(ext)) {
      row.append(
        el(
          'div',
          { class: 'media-card video' },
          el('video', { src: url, controls: 'controls', preload: 'metadata', playsinline: '' }),
          desc ? el('span', { class: 'media-desc' }, desc) : null,
        ),
      );
      continue;
    }
    row.append(
      el(
        'a',
        {
          class: 'file-card',
          href: url,
          target: '_blank',
          rel: 'noreferrer',
          title: desc || rel,
          download: name,
        },
        el('span', { class: 'fc-icon' }, '📄'),
        el(
          'span',
          { class: 'fc-body' },
          el('span', { class: 'fc-name' }, name),
          desc ? el('span', { class: 'fc-desc' }, desc) : null,
        ),
      ),
    );
  }
  return row;
}

/** 消息里的附件：图片直接显示，其它文件显示成带名字的小标签 */
function attachmentRow(atts) {  const row = el('div', { class: 'attach-row' });
  for (const rel of atts) {
    const name = String(rel).split('/').pop();
    const isImg = /\.(png|jpe?g|webp|gif)$/i.test(name);
    if (isImg) {
      row.append(el('img', { src: botFileUrl(state.currentBotId, rel), alt: name, title: rel }));
    } else {
      row.append(el('span', { class: 'file-pill', title: rel }, `📄 ${name}`));
    }
  }
  return row;
}

function approvalCard(m, bot) {
  const appr = state.approvals.get(m.meta.approvalId) || m.meta;
  const status = m.meta.status || appr.status || 'pending';
  const card = el(
    'div',
    { class: 'approval-card' },
    el('div', { class: 't' }, `需要你点头：${m.meta.tool || '操作'}`),
    m.meta.detail ? el('div', { class: 'd' }, m.meta.detail) : null,
    status === 'pending'
      ? el(
          'div',
          { class: 'row' },
          el('button', { class: 'primary', onclick: () => answerApproval(m.meta.approvalId, true) }, '允许这一次'),
          el('button', { class: 'ghost-btn', onclick: () => answerApproval(m.meta.approvalId, true, { remember: true }), title: '这一小时内同类操作不再问你' }, '允许，1 小时内同类'),
          el('button', { class: 'ghost-btn', onclick: () => answerApproval(m.meta.approvalId, false) }, '拒绝'),
        )
      : el('div', { class: 'status' }, { allowed: '已允许', rejected: '已拒绝', cancelled: '已作废' }[status] || status),
  );
  return card;
}

async function answerApproval(id, allow, opts = {}) {
  try {
    const r = await api(`/api/approvals/${id}`, { method: 'POST', body: { allow, remember: opts.remember === true } });
    if (r.warning) toast(r.warning, true);
    await reloadMessages();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 发送 ----------

async function send() {
  const input = qs('#input');
  const text = input.value.trim();
  const atts = state.attachments.slice();
  if ((!text && !atts.length) || !state.conversationId) return;
  if (state.busy) {
    toast('还在处理上一条消息', true);
    return;
  }
  input.value = '';
  autoGrow();
  state.attachments = [];
  renderAttachments();
  state.busy = true;
  state.progress = [];
  setComposerState();
  state.messages.push({
    id: `tmp-${Date.now()}`,
    role: 'user',
    content: text,
    meta: atts.length ? { attachments: atts.map((a) => a.path) } : {},
    createdAt: Date.now(),
  });
  renderMessages();
  try {
    if (state.currentGroupId) {
      // 群里不走会话接口：由宿主按 @ / 上一个发言人挑人
      if (atts.length) toast('群聊暂时只发文字，附件请单独发给某个机器人', true);
      await api(`/api/groups/${state.currentGroupId}/send`, { method: 'POST', body: { text } });
    } else {
      await api(`/api/conversations/${state.conversationId}/send`, {
        method: 'POST',
        body: { text, ...(atts.length ? { attachments: atts.map((a) => a.path) } : {}) },
      });
    }
  } catch (e) {
    state.busy = false;
    setComposerState();
    toast(e.message, true);
    state.messages.push({ id: `err-${Date.now()}`, role: 'error', content: e.message, meta: {}, createdAt: Date.now() });
    renderMessages();
  }
}

function autoGrow() {
  const t = qs('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

// ---------- 右侧面板 ----------

function openPanel(title, render) {
  const panel = qs('#panel');
  state.pane = title;
  // ComfyUI 面板要更宽一些（它的界面很密）
  panel.classList.toggle('wide', title === 'ComfyUI');
  qs('#panel-title').textContent = title;
  const body = qs('#panel-body');
  body.replaceChildren();
  render(body);
  panel.hidden = false;
  qs('#app').classList.add('with-panel');
  return body;
}

function closePanel() {
  qs('#panel').hidden = true;
  qs('#app').classList.remove('with-panel');
  state.pane = null;
}

function field(label, input, tip) {
  return el('div', { class: 'field' }, el('label', {}, label), input, tip ? el('div', { class: 'tip' }, tip) : null);
}

function inputEl(value, attrs = {}) {
  return el('input', { value: value ?? '', ...attrs });
}

function selectEl(options, value, attrs = {}) {
  const s = el('select', attrs);
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    s.append(opt);
  }
  return s;
}

async function openBotPanel() {
  const botId = state.currentBotId;
  if (!botId) return;
  const data = await api(`/api/bots/${botId}`);
  const settings = await api('/api/settings');
  const bot = data.bot;
  const models = settings.modelChoices;
  const provs = settings.config.providers;

  openPanel('机器人设置', (body) => {
    const name = inputEl(bot.name);
    const summary = inputEl(bot.summary);
    const avatar = selectEl(
      ['blue', 'green', 'yellow', 'red', 'purple', 'orange'].map((c) => ({ value: c, label: c })),
      bot.avatar,
    );
    const provSelect = selectEl(
      provs.map((p) => ({
        value: p.id,
        label: `${p.name}${p.ready ? '' : p.locked ? '（先在 DSH 登录）' : '（没有 Key）'}`,
      })),
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
    const perm = selectEl(
      Object.entries(data.permissions).map(([k, v]) => ({ value: k, label: `${v.label} — ${v.desc}` })),
      bot.permission,
    );
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
      el('div', { class: 'row-2' }, field('模型接口', provSelect), field('模型', modelSelect)),
      field('权限', perm, '「工作区」下，写到工作区以外会停下来问你'),
      field('电脑操作', desktop, '打开后它能截屏、看窗口、点鼠标、敲键盘；默认每次都要你同意'),
      field(
        '每天最多用多少 token',
        dailyBudget,
        `今天已经用了 ${data.usageToday?.totalTokens || 0} tokens；0 = 不限，超了它会拒绝干活`,
      ),
      field(
        '记忆',
        el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);width:auto;white-space:nowrap' }, memoryToggle, '把长期记忆带进每次对话'),
      ),
      field('人设（每次发消息前拼给模型）', persona, '改这里就是改性格；也可以让它自己改'),
      field('长期记忆（可手改）', memory, '也可以让它把重要的事写进工作区 MEMORY.md'),
      el('div', { id: 'bot-skills-box' }, el('div', { class: 'side-meta' }, '技能加载中…')),
      el('div', { class: 'section-title' }, '工作区'),
      el('pre', { class: 'mono' }, data.workspace),
      el(
        'div',
        { class: 'panel-actions' },
        el('button', { class: 'primary', onclick: save }, '保存'),
        el('button', { class: 'ghost-btn', onclick: () => openConversations() }, '历史会话'),
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
            },
          },
          '删除机器人',
        ),
      ),
    );
    // 技能列表单独异步加载，别把整个面板卡住
    openSkillsSection(bot.id, qs('#bot-skills-box')).catch(() => {});
  });
}

async function downloadConversation(convId, label) {
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

async function openConversations() {
  const botId = state.currentBotId;
  if (!botId) return;
  const convs = await api(`/api/bots/${botId}/conversations`);
  openPanel('历史会话', (body) => {
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
              onclick: async () => {
                await openConversation(c.id);
                renderBots();
              },
            },
            el('span', { class: 't' }, c.title || '（未命名）'),
            el('span', { class: 'm' }, `${c.channel === 'app' ? '电脑' : c.channel} · ${fmtTime(c.updatedAt)}`),
          ),
          el(
            'button',
            {
              class: 'icon-btn tiny',
              title: '导出为 Markdown',
              onclick: (e) => {
                e.stopPropagation();
                downloadConversation(c.id, c.title || '会话');
              },
            },
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
  });
}

// ---------- 技能 ----------

async function openSkillsSection(botId, box) {
  const data = await api(`/api/bots/${botId}/skills`);
  const list = el('div', { class: 'skill-list' });
  for (const s of data.skills) {
    list.append(
      el(
        'div',
        { class: 'skill-card' },
        el('div', { class: 'skill-head' }, el('strong', {}, s.name), el('span', { class: 'chip' }, `${(s.bytes / 1024).toFixed(1)} KB`)),
        s.description ? el('div', { class: 'skill-desc' }, s.description) : null,
        el(
          'div',
          { class: 'panel-actions' },
          el(
            'button',
            {
              class: 'ghost-btn danger',
              onclick: async () => {
                if (!confirm(`删掉技能「${s.name}」？`)) return;
                await api(`/api/bots/${botId}/skills/${encodeURIComponent(s.slug)}`, { method: 'DELETE' });
                toast('已删除（机器人已重启）');
                await openSkillsSection(botId, box);
              },
            },
            '删除',
          ),
        ),
      ),
    );
  }
  if (!data.skills.length) list.append(el('div', { class: 'side-meta' }, '还没有技能。技能就是一段 SKILL.md，告诉它遇到这类活儿按什么步骤做。'));

  const text = el('textarea', {
    style: 'min-height:110px;font-family:Consolas,monospace;font-size:12px',
    placeholder: '把 SKILL.md 全文粘进来，例如：\n---\nname: daily-report\ndescription: 生成日报\n---\n\n# 日报\n1. 读 outputs/ 下今天的文件…',
  });
  const zipInput = el('input', { type: 'file', accept: '.zip', style: 'display:none' });

  const install = async () => {
    try {
      await api(`/api/bots/${botId}/skills`, { method: 'POST', body: { text: text.value } });
      text.value = '';
      toast('装好了（机器人已重启，下一条消息生效）');
      await openSkillsSection(botId, box);
    } catch (e) {
      toast(e.message, true);
    }
  };

  zipInput.addEventListener('change', async () => {
    const f = zipInput.files?.[0];
    if (!f) return;
    try {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error('读不了这个文件'));
        r.readAsDataURL(f);
      });
      const r = await api(`/api/bots/${botId}/skills`, { method: 'POST', body: { zip: b64 } });
      toast(`装好了「${r.slug}」，${r.files} 个文件`);
      await openSkillsSection(botId, box);
    } catch (e) {
      toast(e.message, true);
    }
    zipInput.value = '';
  });

  box.replaceChildren(
    el('div', { class: 'section-title' }, '技能'),
    el('div', { class: 'tip' }, '每个技能是一个 SKILL.md（可带脚本）。装好后这个机器人能自己调用，也可以在对话里说「用 xxx 技能」。改动立即生效，机器人会用新技能重启。'),
    list,
    el('div', { class: 'section-title' }, '装一个技能'),
    text,
    el(
      'div',
      { class: 'panel-actions' },
      el('button', { class: 'primary', onclick: install }, '安装这段 SKILL.md'),
      el('button', { class: 'ghost-btn', onclick: () => zipInput.click() }, '导入 ZIP'),
      zipInput,
    ),
    el('div', { class: 'tip' }, `技能目录：${data.dir}`),
  );
}

// ---------- 搜索 ----------

async function openSearch(initial = '') {
  openPanel('搜索聊天记录', (body) => {
    const input = inputEl(initial, { placeholder: '搜消息内容…（回车搜索）' });
    const scope = selectEl(
      [{ value: '', label: '所有机器人' }, ...state.bots.map((b) => ({ value: b.id, label: b.name }))],
      '',
    );
    const results = el('div', { class: 'search-results' });
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
                  const el2 = [...qs('#messages').children].find((n) => n.textContent.includes(snippet.slice(0, 24)));
                  el2?.scrollIntoView({ block: 'center' });
                }, 250);
              },
            },
            el('div', { class: 'search-meta' }, `${who} · ${m.title || '未命名会话'} · ${fmtTime(m.createdAt)}`),
            el('div', { class: 'search-text' }, snippet),
          ),
        );
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
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
  });
}

// ---------- 定时任务 ----------

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

async function openSchedules() {
  const schedules = await api('/api/schedules');
  const bots = state.bots;

  openPanel('定时任务', (body) => {
    body.append(
      el(
        'div',
        { class: 'tip', style: 'margin-bottom:12px' },
        '到点让机器人自己干活，结果回到它自己的会话；没有新东西要说时它会安静不打扰你。',
      ),
    );

    const list = el('div', { class: 'sched-list' });
    if (!schedules.length) list.append(el('div', { class: 'side-meta' }, '还没有定时任务'));
    for (const s of schedules) {
      const when = el('span', { class: 'sched-when' }, `${s.when}${s.enabled ? '' : ' · 已暂停'}`);
      const budget = s.monthBudgetTokens
        ? `本月 ${fmtTokens(s.monthTokens)}/${fmtTokens(s.monthBudgetTokens)}`
        : s.monthTokens
          ? `本月 ${fmtTokens(s.monthTokens)} tokens`
          : '';
      list.append(
        el(
          'div',
          { class: 'sched-card' + (s.pausedReason ? ' paused' : '') },
          el(
            'div',
            { class: 'sched-head' },
            el('strong', {}, s.title || '未命名'),
            el('span', { class: 'chips' },
              el('span', { class: 'chip' + (s.mode === 'observe' ? ' on' : '') }, s.mode === 'observe' ? '观察' : '执行'),
              el('span', { class: 'chip' }, s.botName),
            ),
          ),
          el('div', { class: 'sched-prompt' }, s.prompt),
          el(
            'div',
            { class: 'sched-meta' },
            when,
            budget ? el('span', {}, budget) : null,
            s.lastStatus ? el('span', {}, `上次：${statusLabel(s.lastStatus)} · ${fmtTime(s.lastRunAt)}`) : null,
          ),
          s.pausedReason ? el('div', { class: 'sched-paused' }, s.pausedLabel || '已暂停') : null,
          s.lastWouldSay ? el('div', { class: 'sched-would' }, `本来会说：${s.lastWouldSay.slice(0, 120)}`) : null,
          el(
            'div',
            { class: 'panel-actions' },
            el(
              'button',
              {
                class: 'ghost-btn',
                onclick: async () => {
                  toast('正在跑…');
                  const r = await api(`/api/schedules/${s.id}/run`, { method: 'POST', body: {} });
                  toast(
                    r.ok
                      ? r.observe
                        ? '观察完成，去会话里看「本来会说什么」'
                        : r.quiet
                          ? '这次没什么要说（安静）'
                          : r.queued
                            ? '跑完了，已排队等合适时间推送'
                            : '跑完了，去会话里看'
                      : `失败：${r.text}`,
                    !r.ok,
                  );
                  await openSchedules();
                },
              },
              '立即运行',
            ),
            s.pausedReason
              ? el(
                  'button',
                  {
                    class: 'ghost-btn',
                    onclick: async () => {
                      await api(`/api/schedules/${s.id}/resume`, { method: 'POST', body: {} });
                      await openSchedules();
                    },
                  },
                  '恢复',
                )
              : el(
                  'button',
                  {
                    class: 'ghost-btn',
                    onclick: async () => {
                      await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
                      await openSchedules();
                    },
                  },
                  s.enabled ? '暂停' : '启用',
                ),
            el(
              'button',
              {
                class: 'ghost-btn danger',
                onclick: async () => {
                  if (!confirm(`删掉「${s.title}」？`)) return;
                  await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
                  await openSchedules();
                },
              },
              '删除',
            ),
          ),
        ),
      );
    }
    body.append(list);

    // 新建
    const title = inputEl('', { placeholder: '比如：早上看天气' });
    const prompt = el('textarea', { style: 'min-height:90px', placeholder: '到点让它做什么？写清楚要查什么、怎么判断值不值得说。比如：查今天北京天气，如果下雨就告诉我带伞。' });
    const botSel = selectEl(bots.map((b) => ({ value: b.id, label: b.name })), state.currentBotId || bots[0]?.id);
    const kind = selectEl(
      [
        { value: 'daily', label: '每天' },
        { value: 'weekly', label: '每周' },
        { value: 'interval', label: '每隔一段时间' },
      ],
      'daily',
    );
    const at = inputEl('08:00', { type: 'time' });
    const every = inputEl('60', { type: 'number', min: '5', placeholder: '分钟' });
    const dayChips = el('div', { class: 'chips' });
    const picked = new Set([new Date().getDay()]);
    for (let d = 0; d < 7; d += 1) {
      const chip = el(
        'button',
        {
          class: 'chip' + (picked.has(d) ? ' on' : ''),
          onclick: () => {
            if (picked.has(d)) picked.delete(d);
            else picked.add(d);
            chip.classList.toggle('on');
          },
        },
        WEEK_NAMES[d],
      );
      dayChips.append(chip);
    }
    const weeklyBox = field('哪几天', dayChips);
    const intervalBox = field('间隔（分钟）', every);
    weeklyBox.hidden = true;
    intervalBox.hidden = true;
    kind.addEventListener('change', () => {
      weeklyBox.hidden = kind.value !== 'weekly';
      intervalBox.hidden = kind.value !== 'interval';
    });

    const mode = selectEl(
      [
        { value: 'act', label: '执行（真的去做）' },
        { value: 'observe', label: '观察（只读，记下本来会说什么）' },
      ],
      'act',
    );
    const runBudget = inputEl('', { type: 'number', min: '0', placeholder: '0 = 不限' });
    const monthBudget = inputEl('', { type: 'number', min: '0', placeholder: '0 = 不限' });
    const quietToggle = el('input', { type: 'checkbox', checked: 'checked' });

    body.append(
      el('div', { class: 'section-title' }, '新建'),
      field('名字', title),
      field('让哪个机器人做', botSel),
      field('做什么', prompt),
      el('div', { class: 'row-2' }, field('重复方式', kind), field('时间', at)),
      weeklyBox,
      intervalBox,
      field('怎么跑', mode, '观察模式下这个会话被切到只读，结果只留在会话里，不推送'),
      el(
        'div',
        { class: 'row-2' },
        field('单次预算（tokens）', runBudget, '超过就自动暂停'),
        field('每月预算（tokens）', monthBudget, '0 = 不限'),
      ),
      el(
        'label',
        { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);width:auto;white-space:nowrap;margin-bottom:12px' },
        quietToggle,
        '遵守免打扰时段',
      ),
      el(
        'div',
        { class: 'panel-actions' },
        el(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              try {
                await api('/api/schedules', {
                  method: 'POST',
                  body: {
                    botId: botSel.value,
                    title: title.value.trim(),
                    prompt: prompt.value.trim(),
                    kind: kind.value,
                    at: at.value || '08:00',
                    days: [...picked],
                    everyMinutes: Number(every.value) || 60,
                    channel: 'app',
                    mode: mode.value,
                    runBudgetTokens: Number(runBudget.value) || 0,
                    monthBudgetTokens: Number(monthBudget.value) || 0,
                    quietEnabled: quietToggle.checked,
                  },
                });
                toast('建好了');
                await openSchedules();
              } catch (e) {
                toast(e.message, true);
              }
            },
          },
          '创建',
        ),
      ),
    );
  });
}

function statusLabel(s) {
  return { ok: '有结果', quiet: '安静（没值得说的）', observe: '观察完成', error: '出错' }[s] || s;
}

// ---------- 设置页 ----------

async function openAboutSection(box, onChanged) {
  const data = await api('/api/about');
  const list = el('div', { class: 'about-list' });
  for (const line of data.lines) {
    list.append(
      el(
        'div',
        { class: 'about-line' },
        el('span', { class: 'about-text' }, line.text),
        line.sensitive ? el('span', { class: 'chip' }, '敏感') : null,
        el(
          'button',
          {
            class: 'x',
            title: '删掉这条',
            onclick: async () => {
              await api(`/api/about/${line.id}`, { method: 'DELETE' });
              await openAboutSection(box, onChanged);
            },
          },
          '×',
        ),
      ),
    );
  }
  if (!data.lines.length) list.append(el('div', { class: 'side-meta' }, '还没记任何关于你的事'));
  const input = el('input', { placeholder: '比如：我在杭州做产品，习惯下午开会' });
  const add = async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('/api/about', { method: 'POST', body: { text } });
      input.value = '';
      await openAboutSection(box, onChanged);
      onChanged?.();
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  box.replaceChildren(
    el('div', { class: 'section-title' }, `关于我 · ${data.chars}/${data.maxChars} 字`),
    el('div', { class: 'tip' }, '所有机器人都能看到这些。机器人自己也会用 remember 记；电话、邮箱、住址它必须先问你。'),
    list,
    el('div', { class: 'panel-actions' }, input, el('button', { class: 'primary', onclick: add }, '添加')),
  );
}

function openSettings() {
  return openSettingsImpl();
}

async function openSettingsImpl() {
  const data = await api('/api/settings');
  const mcpItems = (await api('/api/mcp')).items;
  const net = await api('/api/net').catch(() => null);
  try {
    state.connectorPresets = (await api('/api/connectors/presets')).presets;
  } catch {
    state.connectorPresets = [];
  }
  const comfy = await api('/api/comfy/status');
  openPanel('设置', (body) => {
    // 关于我
    const aboutBox = el('div', {});
    body.append(aboutBox);
    openAboutSection(aboutBox, () => {});

    // 模型接口
    const provBox = el('div', {});
    provBox.append(el('div', { class: 'section-title' }, '模型接口与 API Key'));
    provBox.append(
      el(
        'div',
        { class: 'tip' },
        'Key 只存在这台电脑的 data/config.json，只传给这个机器人的子进程；请求直达厂商，不经过我们。',
      ),
    );
    for (const p of data.config.providers) {
      if (p.locked) {
        // 内置接口（用本机 DSH 登录态）：不能改不能删，只显示状态
        provBox.append(
          el(
            'div',
            { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
            el(
              'div',
              { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px' },
              el('strong', {}, p.name),
              el('span', { class: 'chip on' }, p.ready ? '已连接' : '未登录'),
            ),
            el('div', { class: 'tip' }, '不用填 Key：直接用这台电脑上 DeepSeek Harness 已经登录的账号，令牌在请求时注入。'),
            el('div', { class: 'chips', style: 'margin-top:8px' }, ...(p.models || []).map((m) => el('span', { class: 'chip' }, m))),
          ),
        );
        continue;
      }
      const key = inputEl('', { placeholder: p.hasKey ? p.apiKey : 'sk-…', type: 'password' });
      const models = inputEl((p.models || []).map((m) => (typeof m === 'string' ? m : m.id)).join(', '));
      const baseURL = inputEl(p.baseURL);
      const row = el(
        'div',
        { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' },
          el('strong', {}, p.name),
          el('span', { class: 'chip' }, p.api),
        ),
        field('API Key', key, p.hasKey ? '已保存；留空表示不改' : ''),
        field('Base URL', baseURL),
        field('模型（逗号分隔）', models),
        el(
          'div',
          { class: 'panel-actions' },
          el(
            'button',
            {
              class: 'primary',
              onclick: async () => {
                try {
                  await api('/api/settings/provider', {
                    method: 'POST',
                    body: {
                      id: p.id,
                      baseURL: baseURL.value.trim(),
                      models: models.value.split(',').map((s) => s.trim()).filter(Boolean),
                      ...(key.value.trim() ? { apiKey: key.value.trim() } : {}),
                    },
                  });
                  toast('已保存');
                  await openSettings();
                  await loadBots();
                } catch (e) {
                  toast(e.message, true);
                }
              },
            },
            '保存',
          ),
          el(
            'button',
            {
              class: 'ghost-btn danger',
              onclick: async () => {
                if (!confirm(`删除接口「${p.name}」？`)) return;
                await api(`/api/settings/provider/${p.id}`, { method: 'DELETE' });
                await openSettings();
              },
            },
            '删除',
          ),
        ),
      );
      provBox.append(row);
    }
    const addSel = selectEl(
      data.presets.map((p) => ({ value: p.id, label: p.name })),
      data.presets[0]?.id,
    );
    provBox.append(
      el(
        'div',
        { class: 'panel-actions' },
        addSel,
        el(
          'button',
          {
            class: 'ghost-btn',
            onclick: async () => {
              const preset = data.presets.find((x) => x.id === addSel.value);
              await api('/api/settings/provider', {
                method: 'POST',
                body: {
                  id: preset.id,
                  name: preset.name,
                  api: preset.api,
                  baseURL: preset.baseURL,
                  models: preset.models,
                },
              });
              await openSettings();
            },
          },
          '＋ 添加这个接口',
        ),
      ),
    );

    // 渠道
    const chBox = el('div', {});
    chBox.append(el('div', { class: 'section-title' }, '聊天渠道'));
    const defs = [
      { name: 'telegram', title: 'Telegram', fields: [['token', 'Bot Token', '从 @BotFather 拿']] },
      { name: 'slack', title: 'Slack', fields: [['appToken', 'App Token (xapp-)', '开 Socket Mode'], ['botToken', 'Bot Token (xoxb-)', '']] },
      { name: 'discord', title: 'Discord', fields: [['token', 'Bot Token', 'Developer Portal 里拿']] },
    ];
    for (const d of defs) {
      const c = data.config.channels[d.name] || {};
      const st = data.channels[d.name] || {};
      const enabled = el('input', { type: 'checkbox', checked: c.enabled ? 'checked' : null });
      const inputs = {};
      for (const [k, label, tip] of d.fields) {
        inputs[k] = inputEl('', { placeholder: c[k] ? '••••••（已保存）' : '', type: 'password' });
      }
      const owner = inputEl(c.owner || '', { placeholder: '你的用户 ID（第一次发消息会自动记下）' });
      const defBot = selectEl(
        [{ value: '', label: '（第一个机器人）' }, ...state.bots.map((b) => ({ value: b.id, label: b.name }))],
        c.defaultBotId || '',
      );
      chBox.append(
        el(
          'div',
          { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' },
            el('strong', {}, d.title),
            el('span', { class: 'chip' + (st.running ? ' on' : '') }, st.running ? '运行中' : st.configured ? '已配置未连接' : '未配置'),
          ),
          el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);margin-bottom:8px;width:auto;white-space:nowrap' }, enabled, '启用'),
          ...d.fields.map(([k, label, tip]) => field(label, inputs[k], tip)),
          field('主人（用户 ID）', owner, '只有这个人能用；第一次发消息会自动记下'),
          field('默认机器人', defBot),
          st.lastError ? el('div', { class: 'tip' }, `状态：${st.lastError}`) : null,
          el(
            'div',
            { class: 'panel-actions' },
            el(
              'button',
              {
                class: 'primary',
                onclick: async () => {
                  try {
                    const body = { enabled: enabled.checked, owner: owner.value.trim(), defaultBotId: defBot.value || null };
                    for (const [k] of d.fields) if (inputs[k].value.trim()) body[k] = inputs[k].value.trim();
                    const r = await api(`/api/settings/channels/${d.name}`, { method: 'PATCH', body });
                    toast(r.started ? `${d.title} 已启动` : `${d.title} 已保存`);
                    await openSettings();
                  } catch (e) {
                    toast(e.message, true);
                  }
                },
              },
              '保存并连接',
            ),
          ),
        ),
      );
    }
    chBox.append(
      field(
        '飞书 / 微信',
        el(
          'div',
          { class: 'tip' },
          '飞书要企业自建应用（App ID/Secret + 事件订阅 + 卡片权限），微信个人号没有官方机器人接口（需 iLink 扫码或客户端自动化）。这两个的接入面已留在 src/channels，下一期接。',
        ),
      ),
    );

    // 连接器（MCP）
    const mcpBox = el('div', {});
    {
      const items = mcpItems;
      const list = el('div', { class: 'skill-list' });
      for (const m of items) {
        list.append(
          el(
            'div',
            { class: 'skill-card' },
            el(
              'div',
              { class: 'skill-head' },
              el('strong', {}, m.title || m.name),
              el('span', { class: 'chip' }, m.transport === 'stdio' ? '本地命令' : 'HTTP'),
            ),
            el('div', { class: 'skill-desc' }, m.transport === 'stdio' ? `${m.command} ${(m.args || []).join(' ')}` : m.url),
            el(
              'div',
              { class: 'panel-actions' },
              el(
                'button',
                {
                  class: 'ghost-btn',
                  onclick: async () => {
                    await api(`/api/mcp/${m.id}`, { method: 'PATCH', body: { enabled: m.enabled === false } });
                    await openSettings();
                  },
                },
                m.enabled === false ? '启用' : '停用',
              ),
              el(
                'button',
                {
                  class: 'ghost-btn danger',
                  onclick: async () => {
                    if (!confirm(`删掉连接器「${m.title || m.name}」？`)) return;
                    await api(`/api/mcp/${m.id}`, { method: 'DELETE' });
                    await openSettings();
                  },
                },
                '删除',
              ),
            ),
          ),
        );
      }
      if (!items.length) list.append(el('div', { class: 'side-meta' }, '还没有连接器'));

      const mName = inputEl('', { placeholder: 'github（工具会叫 mcp__github__xxx）' });
      const mTitle = inputEl('', { placeholder: 'GitHub（给人看的名字）' });
      const mTransport = selectEl(
        [
          { value: 'stdio', label: '本地命令（stdio）' },
          { value: 'streamable-http', label: '远程服务（HTTP）' },
        ],
        'stdio',
      );
      const mCmd = inputEl('', { placeholder: 'npx' });
      const mArgs = inputEl('', { placeholder: '-y @modelcontextprotocol/server-github' });
      const mEnv = el('textarea', { style: 'min-height:60px;font-family:Consolas,monospace', placeholder: 'GITHUB_TOKEN=xxx（一行一个）' });
      const mUrl = inputEl('', { placeholder: 'http://127.0.0.1:3000/mcp' });
      const stdioBox = el('div', {}, field('命令', mCmd), field('参数（空格分隔）', mArgs), field('环境变量', mEnv));
      const httpBox = el('div', { hidden: '' }, field('地址', mUrl));
      httpBox.hidden = true;
      mTransport.addEventListener('change', () => {
        stdioBox.hidden = mTransport.value !== 'stdio';
        httpBox.hidden = mTransport.value === 'stdio';
      });

      const addMcp = async () => {
        try {
          const env = {};
          for (const line of mEnv.value.split(/\r?\n/)) {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
            if (m) env[m[1]] = m[2];
          }
          await api('/api/mcp', {
            method: 'POST',
            body: {
              name: mName.value.trim(),
              title: mTitle.value.trim(),
              transport: mTransport.value,
              command: mCmd.value.trim(),
              args: mArgs.value.trim().split(/\s+/).filter(Boolean),
              env,
              url: mUrl.value.trim(),
            },
          });
          toast('连接器已添加（机器人已重启，下条消息生效）');
          await openSettings();
        } catch (e) {
          toast(e.message, true);
        }
      };

      // 应用连接模板（常见 MCP 服务器）
      const presetList = el('div', { class: 'skill-list' });
      const presets = state.connectorPresets || [];
      for (const p of presets) {
        presetList.append(
          el(
            'div',
            { class: 'skill-card' },
            el('div', { class: 'skill-head' }, el('strong', {}, p.title), el('span', { class: 'chip' }, p.name)),
            el('div', { class: 'skill-desc' }, p.description),
            el(
              'div',
              { class: 'panel-actions' },
              el(
                'button',
                {
                  class: 'ghost-btn',
                  onclick: async () => {
                    const env = {};
                    let cancelled = false;
                    for (const e of p.env || []) {
                      const v = window.prompt(`${p.title}：${e.label || e.key}${e.required ? '（必填）' : '（可留空）'}`);
                      if (v === null) {
                        cancelled = true;
                        break;
                      }
                      if (v.trim()) env[e.key] = v.trim();
                      else if (e.required) {
                        toast(`缺少 ${e.key}`, true);
                        cancelled = true;
                        break;
                      }
                    }
                    if (cancelled) return;
                    try {
                      await api('/api/connectors/install', { method: 'POST', body: { presetId: p.id, env } });
                      toast(`已添加「${p.title}」，机器人已重启`);
                      await openSettings();
                    } catch (e) {
                      toast(e.message, true);
                    }
                  },
                },
                '接入',
              ),
            ),
          ),
        );
      }
      if (!presets.length) presetList.append(el('div', { class: 'side-meta' }, '模板加载中…'));

      mcpBox.append(
        el('div', { class: 'section-title' }, '连接器（MCP）'),
        el('div', { class: 'tip' }, '接上 MCP 服务器后，它的工具会以 mcp__名字__工具 出现。本地命令会在这台电脑上执行，只加你信任的。'),
        list,
        el('div', { class: 'section-title' }, '应用连接（一键）'),
        el('div', { class: 'tip' }, '常见服务的现成模板。需要账号的会问你 Token，只存在本机。'),
        presetList,
        el('div', { class: 'section-title' }, '加一个'),
        el('div', { class: 'row-2' }, field('名字（英文）', mName), field('显示名', mTitle)),
        field('类型', mTransport),
        stdioBox,
        httpBox,
        el('div', { class: 'panel-actions' }, el('button', { class: 'primary', onclick: addMcp }, '添加连接器')),
      );
    }

    // 生图 / 生视频（本机 ComfyUI）
    const genBox = el('div', {});
    {
      const url = inputEl((comfy?.url || 'http://127.0.0.1:8188').replace(/\/+$/, ''), { placeholder: 'http://127.0.0.1:8188' });
      const ckpt = selectEl(
        (comfy?.checkpoints?.length ? comfy.checkpoints : ['Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors']).map((c) => ({ value: c, label: c })),
        comfy?.checkpoint || '',
      );
      const statusLine = el(
        'div',
        { class: 'tip' },
        comfy?.up
          ? `ComfyUI ${comfy.version || ''} 在线 · 生图${comfy.zimageReady ? '（Z-Image Turbo）' : `（SDXL ${comfy.checkpoints?.length || 0} 个模型）`} · 视频${comfy.videoReady ? '可用' : '缺模型'}`
          : `没连上 ComfyUI（${url.value}）。先在命令行把它跑起来，仪表盘就会出现在这里。`,
      );
      genBox.append(
        el('div', { class: 'section-title' }, '生图 / 生视频'),
        el('div', { class: 'tip' }, '接本机的 ComfyUI：图在本地生成，不花钱、不出门。视频用 MiniMax H3（需要先放好 20-25 GB 的权重）。'),
        statusLine,
        el('div', { class: 'row-2' }, field('ComfyUI 地址', url), field('生图默认模型', ckpt)),
        el(
          'div',
          { class: 'panel-actions' },
          el(
            'button',
            {
              class: 'ghost-btn',
              onclick: async () => {
                try {
                  const r = await api('/api/settings/comfy', { method: 'PATCH', body: { url: url.value.trim(), checkpoint: ckpt.value } });
                  toast(r.status?.up ? '连上了，机器人已重启' : '保存了，但现在还是连不上 ComfyUI', !r.status?.up);
                  await openSettings();
                } catch (e) {
                  toast(e.message, true);
                }
              },
            },
            '保存并检测',
          ),
        ),
      );
    }

    // 手机 / 局域网
    const phoneBox = el('div', {});
    {
      const info = net;
      const lan = !!info?.lan;
      const toggle = el('input', { type: 'checkbox', id: 'lan-toggle' });
      toggle.checked = lan;
      toggle.addEventListener('change', async () => {
        try {
          await api('/api/net', { method: 'POST', body: { lan: toggle.checked } });
          toast(toggle.checked ? '已允许局域网访问，重启 winbot 后生效' : '已关闭局域网访问，重启后生效');
        } catch (e) {
          toast(e.message, true);
        }
      });
      const links = el('div', { class: 'skill-list' });
      for (const u of info?.urls || []) {
        links.append(
          el(
            'div',
            { class: 'skill-card' },
            el('div', { class: 'skill-head' }, el('strong', {}, u.label)),
            el('div', { class: 'skill-desc', style: 'word-break:break-all' }, u.url),
            el(
              'div',
              { class: 'panel-actions' },
              el('button', { class: 'ghost-btn', onclick: () => navigator.clipboard.writeText(u.url).then(() => toast('链接已复制')) }, '复制链接'),
            ),
          ),
        );
      }
      const qrBox = el('div', { class: 'qr-box' }, el('div', { class: 'side-meta' }, '二维码加载中…'));
      const first = info?.urls?.[0]?.url || '';
      if (first) {
        api(`/api/qr?text=${encodeURIComponent(first)}`)
          .then((r) => {
            qrBox.replaceChildren(el('div', { html: r.svg }));
            const svg = qrBox.querySelector('svg');
            if (svg) {
              svg.style.width = '180px';
              svg.style.height = '180px';
              svg.style.background = '#fff';
              svg.style.padding = '8px';
              svg.style.borderRadius = '12px';
            }
          })
          .catch(() => qrBox.replaceChildren(el('div', { class: 'side-meta' }, '二维码生成失败')));
      }
      phoneBox.append(
        el('div', { class: 'section-title' }, '手机 / 局域网'),
        el('div', { class: 'tip' }, '打开后，同一个 WiFi 下的手机就能用浏览器打开这个控制台。访问链接里带着本机令牌，别发给别人。'),
        el('label', { class: 'row-inline' }, toggle, el('span', {}, '允许局域网访问（重启 winbot 生效）')),
        qrBox,
        links,
      );
    }

    // 自动更新
    const updateBox = el('div', {});
    {
      const u = state.update || {};
      const repo = inputEl(u.repo || 'dianmei0602/winbot', { placeholder: 'owner/repo' });
      const token = inputEl('', { type: 'password', placeholder: u.hasToken ? '已保存（留空不改）' : '私有仓需要 token' });
      const proxy = inputEl(u.proxy || '', { placeholder: '如 http://127.0.0.1:12450（直连 GitHub 超时才需要）' });
      const out = el('div', { class: 'tip' }, `当前版本 ${u.current || ''}`);
      const runCheck = async () => {
        if (!token.value && !u.hasToken) {
          toast('先填 GitHub Token：私有仓才能查 release', true);
          token.focus();
          token.classList.add('flash');
          setTimeout(() => token.classList.remove('flash'), 1200);
          return;
        }
        out.textContent = '正在查 GitHub…';
        try {
          await api('/api/update/settings', { method: 'POST', body: { repo: repo.value, proxy: proxy.value, ...(token.value ? { token: token.value } : {}) } });
          const r = await api(`/api/update/check?repo=${encodeURIComponent(repo.value)}`);
          state.update = r.settings || state.update;
          if (!r.found) {
            out.textContent = r.message || '没找到 release';
            if (r.needsToken) {
              token.focus();
              token.classList.add('flash');
              setTimeout(() => token.classList.remove('flash'), 1200);
            }
            return;
          }
          out.replaceChildren(
            el('div', {}, `最新 ${r.latest} · 当前 ${r.current} · ${r.newer ? '有更新' : '已是最新'}`),
            r.asset ? el('div', { class: 'tip' }, `安装包：${r.asset.name}（${Math.round((r.asset.size || 0) / 1048576)} MB）`) : el('div', { class: 'tip' }, '这个 release 没有 .exe'),
            r.notes ? el('div', { class: 'tip', style: 'white-space:pre-wrap;max-height:120px;overflow:auto' }, r.notes.slice(0, 400)) : null,
          );
          if (r.newer && r.asset) {
            const btn = el(
              'button',
              {
                class: 'primary',
                onclick: async () => {
                  btn.disabled = true;
                  btn.textContent = '下载中…';
                  try {
                    const d = await api('/api/update/download', { method: 'POST', body: { url: r.asset.url, name: r.asset.name } });
                    btn.textContent = `已下载 ${Math.round(d.size / 1048576)} MB，点这里安装`;
                    btn.disabled = false;
                    btn.onclick = async () => {
                      const done = await api('/api/update/install', { method: 'POST', body: { path: d.path } });
                      toast(done.installsOnQuit ? 'winbot 会先退出再安装，装好后重新打开' : '安装程序已启动');
                    };
                  } catch (e) {
                    btn.disabled = false;
                    btn.textContent = '下载失败，重试';
                    toast(e.message, true);
                  }
                },
              },
              '下载并安装',
            );
            out.append(el('div', { class: 'panel-actions' }, btn));
          }
        } catch (e) {
          out.textContent = `检查失败：${e.message}`;
        }
      };
      updateBox.append(
        el('div', { class: 'section-title' }, '更新'),
        el('div', { class: 'tip' }, '从 GitHub Releases 检查新版本。私有仓要填一个带 repo 权限的 token，只存在本机。'),
        el('div', { class: 'row-2' }, field('仓库', repo), field('Token（可留空）', token)),
        field('代理（可选）', proxy),
        out,
        el('div', { class: 'panel-actions' }, el('button', { class: 'ghost-btn', onclick: runCheck }, '检查更新')),
      );
    }

    // 团队包：一段 Markdown/JSON 一次建好几个机器人 + 一个群
    const teamBox = el('div', {});
    {
      const text = el('textarea', {
        style: 'min-height:140px;font-family:Consolas,monospace;font-size:12px',
        placeholder: '把团队包粘进来，例如：\n```winbot-team\n{"name":"写作小组","bots":[{"name":"小七","summary":"总编","persona":"…"}],"group":{"name":"写作小组","members":["小七"]}}\n```',
      });
      const importBtn = el(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            try {
              const r = await api('/api/teams/import', { method: 'POST', body: { text: text.value } });
              toast(`导入完成：新建 ${r.created.length} 个、更新 ${r.updated.length} 个${r.groupName ? `，建群「${r.groupName}」` : ''}`);
              text.value = '';
              await openSettings();
            } catch (e) {
              toast(e.message, true);
            }
          },
        },
        '导入团队',
      );
      const file = el('input', { type: 'file', accept: '.md,.json,.txt', style: 'display:none' });
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        text.value = await f.text();
        file.value = '';
      });
      teamBox.append(
        el('div', { class: 'section-title' }, '团队包'),
        el('div', { class: 'tip' }, '一段 JSON（或包在 ```winbot-team 代码块里）可以一次建好几个机器人并组群。同名机器人会更新简介/人设，不会重建。'),
        text,
        el('div', { class: 'panel-actions' }, importBtn, el('button', { class: 'ghost-btn', onclick: () => file.click() }, '从文件读'), file),
      );
    }

    // 主动消息的分寸
    const quietBox = el('div', {});
    const sec = data.config.security || {};
    const quiet = sec.quietHours || { enabled: true, from: '22:00', to: '08:00' };
    const caps = sec.proactiveDailyCap || {};
    const quietOn = el('input', { type: 'checkbox', checked: quiet.enabled ? 'checked' : null });
    const quietFrom = inputEl(quiet.from, { type: 'time' });
    const quietTo = inputEl(quiet.to, { type: 'time' });
    const capInputs = {};
    const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', feishu: '飞书', wechat: '微信' };
    const capRows = Object.entries(channelNames).map(([key, label]) => {
      capInputs[key] = inputEl(String(caps[key] ?? (key === 'wechat' ? 3 : 5)), { type: 'number', min: '0' });
      return el('div', { class: 'row-2' }, el('div', { class: 'field' }, el('label', {}, label), capInputs[key]), el('div'));
    });
    quietBox.append(
      el('div', { class: 'section-title' }, '主动消息'),
      el(
        'div',
        { class: 'tip' },
        '定时任务的结果在免打扰时段只排队、不推送；超过每日上限的会合成一条，第二天早上再发。应用内不受限制。',
      ),
      el(
        'label',
        { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);margin:10px 0;width:auto;white-space:nowrap' },
        quietOn,
        '启用免打扰',
      ),
      el('div', { class: 'row-2' }, field('从', quietFrom), field('到', quietTo)),
      el('div', { class: 'section-title' }, '每个渠道每天最多主动发几条（0 = 不限）'),
      ...capRows,
      el(
        'div',
        { class: 'panel-actions' },
        el(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              try {
                const nextCaps = {};
                for (const [k, inp] of Object.entries(capInputs)) nextCaps[k] = Number(inp.value) || 0;
                await api('/api/settings/security', {
                  method: 'PATCH',
                  body: {
                    quietHours: { enabled: quietOn.checked, from: quietFrom.value || '22:00', to: quietTo.value || '08:00' },
                    proactiveDailyCap: nextCaps,
                  },
                });
                toast('已保存');
              } catch (e) {
                toast(e.message, true);
              }
            },
          },
          '保存',
        ),
      ),
    );

    // 关于
    const about = el('div', {});
    about.append(el('div', { class: 'section-title' }, '关于这台机器'));
    about.append(
      el(
        'dl',
        { class: 'kv' },
        el('dt', {}, '数据目录'),
        el('dd', {}, data.dataDir),
        el('dt', {}, '智能体内核'),
        el('dd', {}, `DeepSeek Harness（SDK 子进程，每个机器人一个）`),
        el('dt', {}, '控制台'),
        el('dd', {}, location.origin),
        el('dt', {}, '权限模式'),
        el('dd', {}, Object.entries(data.permissionModes).map(([k, v]) => `${v.label}`).join(' / ')),
      ),
    );

    body.append(provBox, chBox, phoneBox, mcpBox, genBox, updateBox, teamBox, quietBox, about);
  });
}

// ---------- 新建机器人 ----------

function openNewBot() {
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

// ---------- 事件绑定 ----------

qs('#btn-new-bot').addEventListener('click', openNewBot);
qs('#btn-new-group').addEventListener('click', openNewGroup);
qs('#btn-first-bot').addEventListener('click', openNewBot);
qs('#btn-settings').addEventListener('click', openSettings);
qs('#btn-schedules').addEventListener('click', openSchedules);
qs('#btn-sidebar')?.addEventListener('click', () => {
  qs('#app').classList.toggle('drawer-open');
  const scrim = qs('#drawer-scrim');
  if (scrim) scrim.hidden = !qs('#app').classList.contains('drawer-open');
});
qs('#drawer-scrim')?.addEventListener('click', () => {
  qs('#app').classList.remove('drawer-open');
  qs('#drawer-scrim').hidden = true;
});
qs('#bot-search')?.addEventListener('input', (e) => {
  state.botFilter = e.target.value;
  renderBots();
});
qs('#chat-model')?.addEventListener('change', async (e) => {
  const bot = state.bots.find((b) => b.id === state.currentBotId);
  if (!bot) return;
  const [providerId, model] = String(e.target.value || '').split('::');
  if (!model) return;
  if (!window.confirm(`切换模型会重启「${bot.name}」（这段对话会保留）。继续？`)) {
    paintModelSelect(bot);
    return;
  }
  try {
    await api(`/api/bots/${bot.id}`, { method: 'PATCH', body: { providerId, model } });
    await loadBots();
    const fresh = state.bots.find((b) => b.id === bot.id);
    if (fresh) {
      renderChatSub(fresh);
      paintModelSelect(fresh);
    }
    toast(`已切到 ${model}，机器人正在重启`);
  } catch (err) {
    toast(err.message, true);
  }
});
qs('#btn-new-task')?.addEventListener('click', () => openSchedules());
qs('#btn-plugins')?.addEventListener('click', async () => {
  await openSettings();
  setTimeout(() => {
    const heads = [...document.querySelectorAll('#panel-body .section-title')];
    const target = heads.find((h) => h.textContent.includes('连接器'));
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
});
qs('#btn-search').addEventListener('click', () => openSearch());
qs('#btn-comfy').addEventListener('click', () => openComfyPanel());
qs('#btn-stop').addEventListener('click', async () => {
  // 先本地复位：掐进程可能要一两秒，不能让按钮一直挂着
  state.busy = false;
  state.liveText = '';
  state.liveBotId = null;
  state.progress = [];
  setComposerState();
  renderMessages();
  try {
    if (state.currentGroupId) await api(`/api/groups/${state.currentGroupId}/stop`, { method: 'POST' });
    else await api(`/api/conversations/${state.conversationId}/stop`, { method: 'POST' });
    toast('已停止这一轮');
  } catch (e) {
    toast(e.message, true);
  }
});
setupPaneResizer();
qs('#pane-scrim').addEventListener('click', closePanel);
qs('#btn-panel-close').addEventListener('click', closePanel);
qs('#btn-bot-panel').addEventListener('click', openBotPanel);
qs('#chat-avatar').addEventListener('click', openBotPanel);
qs('#btn-open-convs').addEventListener('click', openConversations);
qs('#btn-send').addEventListener('click', send);
qs('#btn-new-conv')?.addEventListener('click', async () => {
  if (!state.currentBotId) return;
  const { conversation } = await api(`/api/bots/${state.currentBotId}/conversations`, { method: 'POST', body: {} });
  await openConversation(conversation.id);
});
qs('#input').addEventListener('input', autoGrow);
qs('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

// 附件：按钮、粘贴、拖放三种入口
const filePicker = el('input', { type: 'file', multiple: 'multiple', style: 'display:none' });
filePicker.addEventListener('change', async () => {
  await addFiles(filePicker.files);
  filePicker.value = '';
});
document.body.append(filePicker);
qs('#btn-attach').addEventListener('click', () => filePicker.click());
qs('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
const composer = qs('.composer');
composer.addEventListener('dragover', (e) => {
  e.preventDefault();
  composer.classList.add('dragover');
});
composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
composer.addEventListener('drop', (e) => {
  e.preventDefault();
  composer.classList.remove('dragover');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});
qs('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') e.target.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'Escape') {
    qs('#modal').hidden = true;
    if (state.pane) closePanel();
  }
});

async function boot() {
  try {
    await loadBots();
    await loadGroups();
    const health = await api('/api/health');
    qs('#side-meta').textContent = `${state.bots.length} 个机器人 · ${health.channels && Object.values(health.channels).some((c) => c.running) ? '渠道在线' : '仅本机'}`;
    if (state.bots.length) await selectBot(state.bots[0].id);
  } catch (e) {
    toast(`连不上后端：${e.message}`, true);
  }
}

boot();































