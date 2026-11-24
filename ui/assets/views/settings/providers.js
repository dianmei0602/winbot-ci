/** 「模型接口与 API Key」区块（拆自原 openSettingsImpl）。归属：连接域 providers。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';
import { loadBots } from '../bots.js';
import { field, inputEl, selectEl } from '../../components/form.js';

/** @param {{ data:any, refresh:()=>Promise<void> }} ctx */
export function renderProviders({ data, refresh }) {
  const provBox = el('div', {});
  provBox.append(el('div', { class: 'section-title' }, '模型接口与 API Key'));
  provBox.append(el('div', { class: 'tip' }, 'Key 只存在这台电脑的 data/config.json，只传给这个机器人的子进程；请求直达厂商，不经过我们。'));

  for (const p of data.config.providers) {
    if (p.locked) {
      // 内置接口（用本机 DSH 登录态）：不能改不能删，只显示状态
      provBox.append(
        el('div', { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px' },
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
    provBox.append(
      el('div', { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' },
          el('strong', {}, p.name), el('span', { class: 'chip' }, p.api),
        ),
        field('API Key', key, p.hasKey ? '已保存；留空表示不改' : ''),
        field('Base URL', baseURL),
        field('模型（逗号分隔）', models),
        el('div', { class: 'panel-actions' },
          el('button', {
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
                await refresh();
                await loadBots();
              } catch (e) { toast(e.message, true); }
            },
          }, '保存'),
          el('button', {
            class: 'ghost-btn danger',
            onclick: async () => {
              if (!confirm(`删除接口「${p.name}」？`)) return;
              await api(`/api/settings/provider/${p.id}`, { method: 'DELETE' });
              await refresh();
            },
          }, '删除'),
        ),
      ),
    );
  }

  const addSel = selectEl(data.presets.map((p) => ({ value: p.id, label: p.name })), data.presets[0]?.id);
  provBox.append(
    el('div', { class: 'panel-actions' },
      addSel,
      el('button', {
        class: 'ghost-btn',
        onclick: async () => {
          const preset = data.presets.find((x) => x.id === addSel.value);
          await api('/api/settings/provider', {
            method: 'POST',
            body: { id: preset.id, name: preset.name, api: preset.api, baseURL: preset.baseURL, models: preset.models },
          });
          await refresh();
        },
      }, '＋ 添加这个接口'),
    ),
  );
  return provBox;
}
