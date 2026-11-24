/**
 * 输入区组件（拆自原 app.js 的发送/附件/用量相关函数）。
 * 依赖 chat 视图的 renderMessages 与 reloadMessages —— 通过 configure() 注入，
 * 避免 components → views 的反向依赖（消除循环依赖）。
 */
import { qs, el, fmtBytes, fmtTokens } from '../core/dom.js';
import { api, botFileUrl, toast } from '../core/api.js';
import { state } from '../core/store.js';

let _renderMessages = () => {};
let _reloadMessages = async () => {};

/** 由 app 入口注入 chat 视图的渲染函数 */
export function configureComposer({ renderMessages, reloadMessages }) {
  if (renderMessages) _renderMessages = renderMessages;
  if (reloadMessages) _reloadMessages = reloadMessages;
}

export function updateUsagePill(usage) {
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

/** 上传一个文件到当前机器人的工作区 assets/ */
export async function uploadOne(file) {
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

export async function addFiles(fileList) {
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

export function renderAttachments() {
  const box = qs('#attachments');
  if (!box) return;
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
            'aria-label': `移除附件 ${att.name}`,
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

export function setComposerState() {
  const send = qs('#btn-send');
  if (send) send.disabled = state.busy;
  const stop = qs('#btn-stop');
  if (stop) stop.hidden = !state.busy;
  const attach = qs('#btn-attach');
  if (attach) attach.disabled = state.busy;
  const hint = qs('#composer-hint');
  if (hint) hint.textContent = state.busy ? '正在处理…（可以看上面的工具步骤）' : '';
}

export function autoGrow() {
  const t = qs('#input');
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

export async function send() {
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
  _renderMessages();
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
    _renderMessages();
  }
}
