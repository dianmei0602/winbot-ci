/** 「连接器（MCP）+ 应用连接（一键）」区块（拆自原 openSettingsImpl）。归属：连接域 mcp。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';
import { state } from '../../core/store.js';
import { field, inputEl, selectEl } from '../../components/form.js';

/** @param {{ mcpItems:any[], refresh:()=>Promise<void> }} ctx */
export function renderMcp({ mcpItems, refresh }) {
  const mcpBox = el('div', {});

  const list = el('div', { class: 'skill-list' });
  for (const m of mcpItems) {
    list.append(
      el('div', { class: 'skill-card' },
        el('div', { class: 'skill-head' },
          el('strong', {}, m.title || m.name),
          el('span', { class: 'chip' }, m.transport === 'stdio' ? '本地命令' : 'HTTP'),
        ),
        el('div', { class: 'skill-desc' }, m.transport === 'stdio' ? `${m.command} ${(m.args || []).join(' ')}` : m.url),
        el('div', { class: 'panel-actions' },
          el('button', {
            class: 'ghost-btn',
            onclick: async () => { await api(`/api/mcp/${m.id}`, { method: 'PATCH', body: { enabled: m.enabled === false } }); await refresh(); },
          }, m.enabled === false ? '启用' : '停用'),
          el('button', {
            class: 'ghost-btn danger',
            onclick: async () => { if (!confirm(`删掉连接器「${m.title || m.name}」？`)) return; await api(`/api/mcp/${m.id}`, { method: 'DELETE' }); await refresh(); },
          }, '删除'),
        ),
      ),
    );
  }
  if (!mcpItems.length) list.append(el('div', { class: 'side-meta' }, '还没有连接器'));

  const mName = inputEl('', { placeholder: 'github（工具会叫 mcp__github__xxx）' });
  const mTitle = inputEl('', { placeholder: 'GitHub（给人看的名字）' });
  const mTransport = selectEl(
    [ { value: 'stdio', label: '本地命令（stdio）' }, { value: 'streamable-http', label: '远程服务（HTTP）' } ],
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
          name: mName.value.trim(), title: mTitle.value.trim(), transport: mTransport.value,
          command: mCmd.value.trim(), args: mArgs.value.trim().split(/\s+/).filter(Boolean), env, url: mUrl.value.trim(),
        },
      });
      toast('连接器已添加（机器人已重启，下条消息生效）');
      await refresh();
    } catch (e) { toast(e.message, true); }
  };

  // 应用连接模板
  const presetList = el('div', { class: 'skill-list' });
  const presets = state.connectorPresets || [];
  for (const p of presets) {
    presetList.append(
      el('div', { class: 'skill-card' },
        el('div', { class: 'skill-head' }, el('strong', {}, p.title), el('span', { class: 'chip' }, p.name)),
        el('div', { class: 'skill-desc' }, p.description),
        el('div', { class: 'panel-actions' },
          el('button', {
            class: 'ghost-btn',
            onclick: async () => {
              const env = {};
              let cancelled = false;
              for (const e of p.env || []) {
                const v = window.prompt(`${p.title}：${e.label || e.key}${e.required ? '（必填）' : '（可留空）'}`);
                if (v === null) { cancelled = true; break; }
                if (v.trim()) env[e.key] = v.trim();
                else if (e.required) { toast(`缺少 ${e.key}`, true); cancelled = true; break; }
              }
              if (cancelled) return;
              try {
                await api('/api/connectors/install', { method: 'POST', body: { presetId: p.id, env } });
                toast(`已添加「${p.title}」，机器人已重启`);
                await refresh();
              } catch (e) { toast(e.message, true); }
            },
          }, '接入'),
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
  return mcpBox;
}
