/** 「关于我」区块（拆自原 app.js openAboutSection）。归属：系统域。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';

export async function openAboutSection(box, onChanged) {
  const data = await api('/api/about');
  const list = el('div', { class: 'about-list' });
  for (const line of data.lines) {
    list.append(
      el(
        'div',
        { class: 'about-line' },
        el('span', { class: 'about-text' }, line.text),
        line.sensitive ? el('span', { class: 'chip' }, '敏感') : null,
        el('button', {
          class: 'x',
          title: '删掉这条',
          'aria-label': `删除：${line.text}`,
          onclick: async () => { await api(`/api/about/${line.id}`, { method: 'DELETE' }); await openAboutSection(box, onChanged); },
        }, '×'),
      ),
    );
  }
  if (!data.lines.length) list.append(el('div', { class: 'side-meta' }, '还没记任何关于你的事'));
  const input = el('input', { placeholder: '比如：我在杭州做产品，习惯下午开会', 'aria-label': '新增关于我的信息' });
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  box.replaceChildren(
    el('div', { class: 'section-title' }, `关于我 · ${data.chars}/${data.maxChars} 字`),
    el('div', { class: 'tip' }, '所有机器人都能看到这些。机器人自己也会用 remember 记；电话、邮箱、住址它必须先问你。'),
    list,
    el('div', { class: 'panel-actions' }, input, el('button', { class: 'primary', onclick: add }, '添加')),
  );
}
