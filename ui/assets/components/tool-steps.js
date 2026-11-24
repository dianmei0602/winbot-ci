/**
 * 工具步骤组件（拆自原 app.js renderMessages 的工具组部分 + renderProgress）。
 * 折叠成一行「XX 用了 3 个工具」，点开看每个工具的成败/耗时/参数。
 * 数据由 view 传入，折叠状态由 openTools 集合维护（迁移期仍放 state.ui）。
 */
import { el } from '../core/dom.js';
import { state } from '../core/store.js';

/**
 * 从 progress 数组里连续同类 'tool' 项聚合成一组并渲染。
 * @param {object[]} progress
 * @param {object[]} bots
 * @param {boolean} busy
 * @param {(key:string)=>void} onToggle 点击折叠/展开的回调
 * @returns {HTMLElement[]}
 */
export function renderToolGroups(progress, bots, busy, onToggle) {
  const out = [];
  let pi = 0;
  while (pi < progress.length) {
    const p = progress[pi];
    if (p.kind === 'tool') {
      let pj = pi;
      while (pj < progress.length && progress[pj].kind === 'tool' && progress[pj].botId === p.botId) pj += 1;
      const items = progress.slice(pi, pj);
      const owner = bots.find((b) => b.id === p.botId);
      const key = `tools:${p.botId || '?'}:${pi}`;
      const open = state.ui.openTools.has(key);
      const running = pj === progress.length && busy;
      const failed = items.filter((x) => x.isError).length;
      const allDone = items.every((x) => x.done);
      const head = el(
        'button',
        {
          class: 'tool-summary',
          'aria-expanded': open ? 'true' : 'false',
          onclick: () => onToggle(key),
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
      out.push(el('div', { class: 'tool-group' }, head, detail));
      pi = pj;
      continue;
    }
    pi += 1;
  }
  return out;
}
