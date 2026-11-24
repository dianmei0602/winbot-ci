/** 表单原语组件（拆自原 app.js 的 field / inputEl / selectEl）。纯函数，返回 DOM。 */
import { el } from '../core/dom.js';

export function field(label, input, tip) {
  return el('div', { class: 'field' }, el('label', {}, label), input, tip ? el('div', { class: 'tip' }, tip) : null);
}

export function inputEl(value, attrs = {}) {
  return el('input', { value: value ?? '', ...attrs });
}

export function selectEl(options, value, attrs = {}) {
  const s = el('select', attrs);
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    s.append(opt);
  }
  return s;
}
