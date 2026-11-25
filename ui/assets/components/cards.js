/**
 * 消息卡片组件（拆自原 app.js）：
 *   fileCards    —— 机器人 present 交付的文件/图片/视频/3D 卡
 *   attachmentRow —— 消息里的输入附件
 *   approvalCard —— 审批卡（含「1 小时内同类不再问」）
 * 组件是返回 DOM 的纯函数；审批动作通过 onAnswer 回调注入，不直接依赖 chat 视图。
 */
import { el } from '../core/dom.js';
import { botFileUrl } from '../core/api.js';
import { state } from '../core/store.js';

/** 机器人用 present 交付的文件：给成可点开的卡片 */
export function fileCards(files, botId) {
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
        { class: 'file-card', href: url, target: '_blank', rel: 'noreferrer', title: desc || rel, download: name },
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
export function attachmentRow(atts) {
  const row = el('div', { class: 'attach-row' });
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

const STATUS_TEXT = { allowed: '已允许', rejected: '已拒绝', cancelled: '已作废' };

/**
 * 审批卡：pending 时给三个动作按钮，已决时只显示状态。
 * @param {object} m 消息对象
 * @param {(id:string, allow:boolean, opts?:object)=>void} onAnswer 审批回调（由 chat 注入）
 */
export function approvalCard(m, onAnswer) {
  const appr = state.approvals.get(m.meta.approvalId) || m.meta;
  const status = m.meta.status || appr.status || 'pending';
  return el(
    'div',
    { class: 'approval-card', role: 'group', 'aria-label': `审批请求：${m.meta.tool || '操作'}` },
    el('div', { class: 't' }, `需要你点头：${m.meta.tool || '操作'}`),
    m.meta.detail ? el('div', { class: 'd' }, m.meta.detail) : null,
    status === 'pending'
      ? el(
          'div',
          { class: 'row' },
          el('button', { class: 'primary', onclick: () => onAnswer?.(m.meta.approvalId, true) }, '允许这一次'),
          el(
            'button',
            {
              class: 'ghost-btn',
              title: '这一小时内同类操作不再问你',
              onclick: () => onAnswer?.(m.meta.approvalId, true, { remember: true }),
            },
            '允许，1 小时内同类',
          ),
          el('button', { class: 'ghost-btn', onclick: () => onAnswer?.(m.meta.approvalId, false) }, '拒绝'),
        )
      : el('div', { class: 'status' }, STATUS_TEXT[status] || status),
  );
}
