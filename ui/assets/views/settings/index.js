/**
 * 设置编排器（替代原 app.js 的 openSettings / openSettingsImpl 大杂烩）。
 * ------------------------------------------------------------
 * 按路由的 domain + tab 分发到各子模块，一个面板只装一类内容，
 * 顶部给 tab 导航可在连接/系统各区块间切换。数据只加载一次并缓存。
 */
import { el } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { state } from '../../core/store.js';
import { openPanel } from '../../core/shell.js';
import { go, currentRoute } from '../../core/router.js';
import { renderProviders } from './providers.js';
import { renderChannels } from './channels.js';
import { renderMcp } from './mcp.js';
import { renderMedia } from './media.js';
import { renderSystem } from './system.js';
import { openAboutSection } from './about.js';

// 域 → 可用的 tab 列表（顶部导航）
const TABS = {
  connect: [
    { key: 'providers', label: '模型接口' },
    { key: 'channels', label: '聊天渠道' },
    { key: 'mcp', label: '连接器' },
    { key: 'media', label: '生图/生视频' },
  ],
  system: [
    { key: 'about', label: '关于本机' },
    { key: 'network', label: '手机/局域网' },
    { key: 'update', label: '更新' },
    { key: 'backup', label: '备份' },
    { key: 'team', label: '团队包' },
    { key: 'quiet', label: '主动消息' },
  ],
};

let cache = null;
let cacheAt = 0;

async function loadData(force = false) {
  if (!force && cache && Date.now() - cacheAt < 2000) return cache;
  const data = await api('/api/settings');
  const mcpItems = (await api('/api/mcp')).items;
  const net = await api('/api/net').catch(() => null);
  try {
    state.connectorPresets = (await api('/api/connectors/presets')).presets;
  } catch {
    state.connectorPresets = [];
  }
  const comfy = await api('/api/comfy/status');
  cache = { data, mcpItems, net, comfy };
  cacheAt = Date.now();
  return cache;
}

/** 顶部 tab 导航条 */
function tabBar(domain, activeTab) {
  return el('div', { class: 'chips', style: 'margin-bottom:14px', role: 'tablist', 'aria-label': `${domain === 'connect' ? '连接' : '系统'}设置分区` },
    ...TABS[domain].map((t) =>
      el('button', {
        class: 'chip' + (t.key === activeTab ? ' on' : ''),
        role: 'tab',
        'aria-selected': t.key === activeTab ? 'true' : 'false',
        onclick: () => go(`${domain}/${t.key}`),
      }, t.label),
    ),
  );
}

/**
 * 打开设置面板：由路由驱动。
 * @param {'connect'|'system'} domain
 * @param {string|null} tab
 */
export async function openSettings(domain = 'connect', tab = null) {
  const d = domain === 'system' ? 'system' : 'connect';
  const activeTab = tab || TABS[d][0].key;
  const ctx = await loadData();

  // 「关于我」在所有分区都能编辑，作为系统域 about 的一部分内联
  openPanel(
    `${d === 'connect' ? '连接' : '系统'} · ${TABS[d].find((t) => t.key === activeTab)?.label || activeTab}`,
    (body) => {
      body.append(tabBar(d, activeTab));
      const refresh = () => openSettings(d, activeTab);
      const shared = { ...ctx, tab: activeTab, refresh };

      if (d === 'connect') {
        if (activeTab === 'providers') body.append(renderProviders(shared));
        else if (activeTab === 'channels') body.append(renderChannels(shared));
        else if (activeTab === 'mcp') body.append(renderMcp(shared));
        else if (activeTab === 'media') body.append(renderMedia(shared));
        else body.append(renderProviders(shared));
        // 关于我：放在连接域第一块底部，保持旧版「一进设置就能编辑」的习惯
        if (activeTab === 'providers') {
          const aboutBox = el('div', { style: 'margin-top:18px' });
          body.append(aboutBox);
          openAboutSection(aboutBox, () => {}).catch(() => {});
        }
      } else {
        body.append(renderSystem(shared));
      }
    },
    { pane: d, wide: d === 'connect' && activeTab === 'media' },
  );
}

/** 强制刷新数据（保存后调用） */
export const refreshSettings = () => loadData(true);
