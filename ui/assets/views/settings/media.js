/** 「生图 / 生视频」区块（拆自原 openSettingsImpl）。归属：连接域 media。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';
import { field, inputEl, selectEl } from '../../components/form.js';

/** @param {{ comfy:any, refresh:()=>Promise<void> }} ctx */
export function renderMedia({ comfy, refresh }) {
  const genBox = el('div', {});
  const url = inputEl((comfy?.url || 'http://127.0.0.1:8188').replace(/\/+$/, ''), { placeholder: 'http://127.0.0.1:8188' });
  const ckpt = selectEl(
    (comfy?.checkpoints?.length ? comfy.checkpoints : ['Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors']).map((c) => ({ value: c, label: c })),
    comfy?.checkpoint || '',
  );
  const statusLine = el('div', { class: 'tip' },
    comfy?.up
      ? `ComfyUI ${comfy.version || ''} 在线 · 生图${comfy.zimageReady ? '（Z-Image Turbo）' : `（SDXL ${comfy.checkpoints?.length || 0} 个模型）`} · 视频${comfy.videoReady ? '可用' : '缺模型'}`
      : `没连上 ComfyUI（${url.value}）。先在命令行把它跑起来，仪表盘就会出现在这里。`,
  );
  genBox.append(
    el('div', { class: 'section-title' }, '生图 / 生视频'),
    el('div', { class: 'tip' }, '接本机的 ComfyUI：图在本地生成，不花钱、不出门。视频用 MiniMax H3（需要先放好 20-25 GB 的权重）。'),
    statusLine,
    el('div', { class: 'row-2' }, field('ComfyUI 地址', url), field('生图默认模型', ckpt)),
    el('div', { class: 'panel-actions' },
      el('button', {
        class: 'ghost-btn',
        onclick: async () => {
          try {
            const r = await api('/api/settings/comfy', { method: 'PATCH', body: { url: url.value.trim(), checkpoint: ckpt.value } });
            toast(r.status?.up ? '连上了，机器人已重启' : '保存了，但现在还是连不上 ComfyUI', !r.status?.up);
            await refresh();
          } catch (e) { toast(e.message, true); }
        },
      }, '保存并检测'),
    ),
  );
  return genBox;
}
