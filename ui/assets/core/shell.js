/**
 * 应用外壳（拆自原 app.js）：通用面板容器、抽屉、面板拖拽调宽。
 * ------------------------------------------------------------
 * openPanel 保留为「通用容器」，但由路由驱动：
 *   router.onChange(route => shell.renderPanel(route)) 在 app.js 里接线。
 * 宽面板不再是靠标题字符串 'ComfyUI' 判断，而是路由 tab='media' 判断。
 */
import { qs } from './dom.js';
import { state } from './store.js';

/** 关闭窄屏侧栏抽屉 */
export function closeDrawer() {
  if (window.innerWidth > 700) return;
  qs('#app')?.classList.remove('drawer-open');
  const scrim = qs('#drawer-scrim');
  if (scrim) scrim.hidden = true;
}

/**
 * 通用面板容器：设置标题、宽度、调用 render 填充内容后显示。
 * @param {string} title 面板标题
 * @param {(body:HTMLElement)=>void} render
 * @param {{ wide?:boolean, pane?:string }} [opts]
 */
export function openPanel(title, render, opts = {}) {
  const panel = qs('#panel');
  state.pane = opts.pane ?? title;
  // wide 由显式参数或 media 路由决定，不再比对标题字符串
  const wide = opts.wide ?? (state.ui.route?.domain === 'connect' && state.ui.route?.tab === 'media');
  panel.classList.toggle('wide', !!wide);
  qs('#panel-title').textContent = title;
  const body = qs('#panel-body');
  body.replaceChildren();
  render(body);
  panel.hidden = false;
  qs('#app').classList.add('with-panel');
  return body;
}

/** 关闭右侧面板 */
export function closePanel() {
  qs('#panel').hidden = true;
  qs('#app').classList.remove('with-panel');
  state.pane = null;
}

/** 面板是否打开 */
export const isPanelOpen = () => !!state.pane;

/** 右侧面板拖拽调宽（逻辑原样迁移） */
export function setupPaneResizer() {
  const handle = qs('#pane-resizer');
  if (!handle) return;
  const root = document.documentElement;
  // 上限给对话至少留 420px（左侧栏固定 232px），下限 320px
  const maxW = () => Math.max(320, Math.min(1200, window.innerWidth - 232 - 420));
  const clamp = (w) => Math.max(320, Math.min(w, maxW()));
  const apply = (w) => root.style.setProperty('--panel-w', `${Math.round(w)}px`);
  let dragging = false;

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

  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--panel-w');
    localStorage.removeItem('winbot.panelW');
  });
}
