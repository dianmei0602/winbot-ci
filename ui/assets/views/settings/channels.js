/** 「聊天渠道」区块（拆自原 openSettingsImpl）。归属：连接域 channels。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';
import { state } from '../../core/store.js';
import { field, inputEl, selectEl } from '../../components/form.js';

const CHANNEL_DEFS = [
  { name: 'telegram', title: 'Telegram', fields: [['token', 'Bot Token', '从 @BotFather 拿']] },
  { name: 'slack', title: 'Slack', fields: [['appToken', 'App Token (xapp-)', '开 Socket Mode'], ['botToken', 'Bot Token (xoxb-)', '']] },
  { name: 'discord', title: 'Discord', fields: [['token', 'Bot Token', 'Developer Portal 里拿']] },
];

/** @param {{ data:any, refresh:()=>Promise<void> }} ctx */
export function renderChannels({ data, refresh }) {
  const chBox = el('div', {});
  chBox.append(el('div', { class: 'section-title' }, '聊天渠道'));

  for (const d of CHANNEL_DEFS) {
    const c = data.config.channels[d.name] || {};
    const st = data.channels[d.name] || {};
    const enabled = el('input', { type: 'checkbox', checked: c.enabled ? 'checked' : null });
    const inputs = {};
    for (const [k, label, tip] of d.fields) {
      inputs[k] = inputEl('', { placeholder: c[k] ? '••••••（已保存）' : '', type: 'password' });
    }
    const owner = inputEl(c.owner || '', { placeholder: '你的用户 ID（第一次发消息会自动记下）' });
    const defBot = selectEl(
      [{ value: '', label: '（第一个机器人）' }, ...state.bots.map((b) => ({ value: b.id, label: b.name }))],
      c.defaultBotId || '',
    );
    chBox.append(
      el('div', { class: 'field', style: 'border:1px solid var(--line);border-radius:12px;padding:10px' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' },
          el('strong', {}, d.title),
          el('span', { class: 'chip' + (st.running ? ' on' : '') }, st.running ? '运行中' : st.configured ? '已配置未连接' : '未配置'),
        ),
        el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);margin-bottom:8px;width:auto;white-space:nowrap' }, enabled, '启用'),
        ...d.fields.map(([k, label, tip]) => field(label, inputs[k], tip)),
        field('主人（用户 ID）', owner, '只有这个人能用；第一次发消息会自动记下'),
        field('默认机器人', defBot),
        st.lastError ? el('div', { class: 'tip' }, `状态：${st.lastError}`) : null,
        el('div', { class: 'panel-actions' },
          el('button', {
            class: 'primary',
            onclick: async () => {
              try {
                const body = { enabled: enabled.checked, owner: owner.value.trim(), defaultBotId: defBot.value || null };
                for (const [k] of d.fields) if (inputs[k].value.trim()) body[k] = inputs[k].value.trim();
                const r = await api(`/api/settings/channels/${d.name}`, { method: 'PATCH', body });
                toast(r.started ? `${d.title} 已启动` : `${d.title} 已保存`);
                await refresh();
              } catch (e) { toast(e.message, true); }
            },
          }, '保存并连接'),
        ),
      ),
    );
  }

  chBox.append(
    field('飞书 / 微信', el('div', { class: 'tip' }, '飞书要企业自建应用（App ID/Secret + 事件订阅 + 卡片权限），微信个人号没有官方机器人接口（需 iLink 扫码或客户端自动化）。这两个的接入面已留在 src/channels，下一期接。')),
  );
  return chBox;
}
