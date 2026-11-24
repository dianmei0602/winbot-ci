/** ComfyUI 侧边面板（拆自原 app.js openComfyPanel）。路由 #/connect/media。 */
import { qs, el } from '../core/dom.js';
import { api } from '../core/api.js';
import { state } from '../core/store.js';
import { openPanel } from '../core/shell.js';

/** 右边直接嵌 ComfyUI：生图/生视频时能看着它跑 */
export function openComfyPanel({ auto = false } = {}) {
  const url = state.comfyUrl || 'http://127.0.0.1:8188';
  // 立刻画出来，别等状态请求（ComfyUI 忙着生成时接口会慢）
  openPanel(
    'ComfyUI',
    (b) => {
      b.append(
        el('div', { class: 'panel-actions' },
          el('button', { class: 'ghost-btn', onclick: () => openComfyPanel(), title: '重新加载' }, '刷新'),
          el('a', { class: 'ghost-btn', href: url, target: '_blank', rel: 'noreferrer' }, '在新窗口打开'),
        ),
        el('div', { class: 'tip' }, auto ? '正在这里跑，进度直接看它的队列。' : '这是本机的 ComfyUI 界面，和生成用的是同一个。'),
        el('iframe', { class: 'comfy-frame', src: url, title: 'ComfyUI' }),
      );
    },
    { wide: true, pane: 'media' },
  );
  // 顺手确认一下地址；没跑起来给个说明，别只留空白框
  api('/api/comfy/status')
    .then((st) => {
      if (st?.url) state.comfyUrl = st.url;
      if (st && !st.up) {
        const body = qs('#panel-body');
        if (body && !body.querySelector('.comfy-down')) {
          body.prepend(el('div', { class: 'tip comfy-down' }, `ComfyUI 没在跑（${st.url}）。先在命令行把它启动起来，这个框里就会显示它的界面。`));
        }
      }
    })
    .catch(() => {});
}
