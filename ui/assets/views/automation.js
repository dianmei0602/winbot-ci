/** 自动化视图（拆自原 app.js openSchedules / statusLabel）。路由 #/automation。 */
import { el, fmtTime, fmtTokens } from '../core/dom.js';
import { api, toast } from '../core/api.js';
import { state } from '../core/store.js';
import { openPanel } from '../core/shell.js';
import { field, inputEl, selectEl } from '../components/form.js';

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function statusLabel(s) {
  return { ok: '有结果', quiet: '安静（没值得说的）', observe: '观察完成', error: '出错' }[s] || s;
}

export async function openSchedules() {
  const schedules = await api('/api/schedules');
  const bots = state.bots;

  openPanel(
    '定时任务',
    (body) => {
      body.append(
        el('div', { class: 'tip', style: 'margin-bottom:12px' }, '到点让机器人自己干活，结果回到它自己的会话；没有新东西要说时它会安静不打扰你。'),
      );

      const list = el('div', { class: 'sched-list' });
      if (!schedules.length) list.append(el('div', { class: 'side-meta' }, '还没有定时任务'));
      for (const s of schedules) {
        const when = el('span', { class: 'sched-when' }, `${s.when}${s.enabled ? '' : ' · 已暂停'}`);
        const budget = s.monthBudgetTokens
          ? `本月 ${fmtTokens(s.monthTokens)}/${fmtTokens(s.monthBudgetTokens)}`
          : s.monthTokens
            ? `本月 ${fmtTokens(s.monthTokens)} tokens`
            : '';
        list.append(
          el(
            'div',
            { class: 'sched-card' + (s.pausedReason ? ' paused' : '') },
            el(
              'div',
              { class: 'sched-head' },
              el('strong', {}, s.title || '未命名'),
              el('span', { class: 'chips' },
                el('span', { class: 'chip' + (s.mode === 'observe' ? ' on' : '') }, s.mode === 'observe' ? '观察' : '执行'),
                el('span', { class: 'chip' }, s.botName),
              ),
            ),
            el('div', { class: 'sched-prompt' }, s.prompt),
            el('div', { class: 'sched-meta' },
              when,
              budget ? el('span', {}, budget) : null,
              s.lastStatus ? el('span', {}, `上次：${statusLabel(s.lastStatus)} · ${fmtTime(s.lastRunAt)}`) : null,
            ),
            s.pausedReason ? el('div', { class: 'sched-paused' }, s.pausedLabel || '已暂停') : null,
            s.lastWouldSay ? el('div', { class: 'sched-would' }, `本来会说：${s.lastWouldSay.slice(0, 120)}`) : null,
            el(
              'div',
              { class: 'panel-actions' },
              el('button', {
                class: 'ghost-btn',
                onclick: async () => {
                  toast('正在跑…');
                  const r = await api(`/api/schedules/${s.id}/run`, { method: 'POST', body: {} });
                  toast(
                    r.ok
                      ? r.observe ? '观察完成，去会话里看「本来会说什么」'
                        : r.quiet ? '这次没什么要说（安静）'
                        : r.queued ? '跑完了，已排队等合适时间推送'
                        : '跑完了，去会话里看'
                      : `失败：${r.text}`,
                    !r.ok,
                  );
                  await openSchedules();
                },
              }, '立即运行'),
              s.pausedReason
                ? el('button', {
                    class: 'ghost-btn',
                    onclick: async () => { await api(`/api/schedules/${s.id}/resume`, { method: 'POST', body: {} }); await openSchedules(); },
                  }, '恢复')
                : el('button', {
                    class: 'ghost-btn',
                    onclick: async () => { await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }); await openSchedules(); },
                  }, s.enabled ? '暂停' : '启用'),
              el('button', {
                class: 'ghost-btn danger',
                onclick: async () => { if (!confirm(`删掉「${s.title}」？`)) return; await api(`/api/schedules/${s.id}`, { method: 'DELETE' }); await openSchedules(); },
              }, '删除'),
            ),
          ),
        );
      }
      body.append(list);

      // 新建
      const title = inputEl('', { placeholder: '比如：早上看天气' });
      const prompt = el('textarea', { style: 'min-height:90px', placeholder: '到点让它做什么？写清楚要查什么、怎么判断值不值得说。比如：查今天北京天气，如果下雨就告诉我带伞。' });
      const botSel = selectEl(bots.map((b) => ({ value: b.id, label: b.name })), state.currentBotId || bots[0]?.id);
      const kind = selectEl(
        [ { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }, { value: 'interval', label: '每隔一段时间' } ],
        'daily',
      );
      const at = inputEl('08:00', { type: 'time' });
      const every = inputEl('60', { type: 'number', min: '5', placeholder: '分钟' });
      const dayChips = el('div', { class: 'chips' });
      const picked = new Set([new Date().getDay()]);
      for (let d = 0; d < 7; d += 1) {
        const chip = el('button', {
          class: 'chip' + (picked.has(d) ? ' on' : ''),
          onclick: () => { if (picked.has(d)) picked.delete(d); else picked.add(d); chip.classList.toggle('on'); },
        }, WEEK_NAMES[d]);
        dayChips.append(chip);
      }
      const weeklyBox = field('哪几天', dayChips);
      const intervalBox = field('间隔（分钟）', every);
      weeklyBox.hidden = true;
      intervalBox.hidden = true;
      kind.addEventListener('change', () => {
        weeklyBox.hidden = kind.value !== 'weekly';
        intervalBox.hidden = kind.value !== 'interval';
      });

      const mode = selectEl(
        [ { value: 'act', label: '执行（真的去做）' }, { value: 'observe', label: '观察（只读，记下本来会说什么）' } ],
        'act',
      );
      const runBudget = inputEl('', { type: 'number', min: '0', placeholder: '0 = 不限' });
      const monthBudget = inputEl('', { type: 'number', min: '0', placeholder: '0 = 不限' });
      const quietToggle = el('input', { type: 'checkbox', checked: 'checked' });

      body.append(
        el('div', { class: 'section-title' }, '新建'),
        field('名字', title),
        field('让哪个机器人做', botSel),
        field('做什么', prompt),
        el('div', { class: 'row-2' }, field('重复方式', kind), field('时间', at)),
        weeklyBox,
        intervalBox,
        field('怎么跑', mode, '观察模式下这个会话被切到只读，结果只留在会话里，不推送'),
        el('div', { class: 'row-2' },
          field('单次预算（tokens）', runBudget, '超过就自动暂停'),
          field('每月预算（tokens）', monthBudget, '0 = 不限'),
        ),
        el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);width:auto;white-space:nowrap;margin-bottom:12px' }, quietToggle, '遵守免打扰时段'),
        el('div', { class: 'panel-actions' },
          el('button', {
            class: 'primary',
            onclick: async () => {
              try {
                await api('/api/schedules', {
                  method: 'POST',
                  body: {
                    botId: botSel.value,
                    title: title.value.trim(),
                    prompt: prompt.value.trim(),
                    kind: kind.value,
                    at: at.value || '08:00',
                    days: [...picked],
                    everyMinutes: Number(every.value) || 60,
                    channel: 'app',
                    mode: mode.value,
                    runBudgetTokens: Number(runBudget.value) || 0,
                    monthBudgetTokens: Number(monthBudget.value) || 0,
                    quietEnabled: quietToggle.checked,
                  },
                });
                toast('建好了');
                await openSchedules();
              } catch (e) {
                toast(e.message, true);
              }
            },
          }, '创建'),
        ),
      );
    },
    { pane: 'automation' },
  );
}
