/** 系统域设置区块（拆自原 openSettingsImpl）：网络 / 更新 / 团队包 / 主动消息 / 关于本机。 */
import { el } from '../../core/dom.js';
import { api, toast } from '../../core/api.js';
import { state } from '../../core/store.js';
import { field, inputEl } from '../../components/form.js';

/** 手机 / 局域网 */
function renderNetwork(net) {
  const phoneBox = el('div', {});
  const lan = !!net?.lan;
  const toggle = el('input', { type: 'checkbox', id: 'lan-toggle' });
  toggle.checked = lan;
  toggle.addEventListener('change', async () => {
    try {
      await api('/api/net', { method: 'POST', body: { lan: toggle.checked } });
      toast(toggle.checked ? '已允许局域网访问，重启 winbot 后生效' : '已关闭局域网访问，重启后生效');
    } catch (e) { toast(e.message, true); }
  });
  const links = el('div', { class: 'skill-list' });
  for (const u of net?.urls || []) {
    links.append(
      el('div', { class: 'skill-card' },
        el('div', { class: 'skill-head' }, el('strong', {}, u.label)),
        el('div', { class: 'skill-desc', style: 'word-break:break-all' }, u.url),
        el('div', { class: 'panel-actions' },
          el('button', { class: 'ghost-btn', onclick: () => navigator.clipboard.writeText(u.url).then(() => toast('链接已复制')) }, '复制链接'),
        ),
      ),
    );
  }
  const qrBox = el('div', { class: 'qr-box' }, el('div', { class: 'side-meta' }, '二维码加载中…'));
  const first = net?.urls?.[0]?.url || '';
  if (first) {
    api(`/api/qr?text=${encodeURIComponent(first)}`)
      .then((r) => {
        qrBox.replaceChildren(el('div', { html: r.svg }));
        const svg = qrBox.querySelector('svg');
        if (svg) {
          svg.style.width = '180px'; svg.style.height = '180px';
          svg.style.background = '#fff'; svg.style.padding = '8px'; svg.style.borderRadius = '12px';
        }
      })
      .catch(() => qrBox.replaceChildren(el('div', { class: 'side-meta' }, '二维码生成失败')));
  }
  phoneBox.append(
    el('div', { class: 'section-title' }, '手机 / 局域网'),
    el('div', { class: 'tip' }, '打开后，同一个 WiFi 下的手机就能用浏览器打开这个控制台。访问链接里带着本机令牌，别发给别人。'),
    el('label', { class: 'row-inline' }, toggle, el('span', {}, '允许局域网访问（重启 winbot 生效）')),
    qrBox,
    links,
  );
  return phoneBox;
}

/** 自动更新 */
function renderUpdateNative(native) {
  const box = el('div', {});
  const out = el('div', { class: 'tip' }, '点「检查更新」查看新版本');
  let info = null;
  const actions = el('div', { class: 'panel-actions' });

  const checkBtn = el('button', {
    class: 'ghost-btn',
    onclick: async () => {
      out.textContent = '正在检查…';
      const r = await native.check();
      if (!r.ok) {
        out.textContent = `检查失败：${r.error || '未知'}`;
        return;
      }
      info = r;
      if (!r.newer) {
        out.textContent = `已是最新（${r.current}）`;
        return;
      }
      out.replaceChildren(
        el('div', {}, `发现新版本 ${r.latest}（当前 ${r.current}）`),
        r.notes ? el('div', { class: 'tip', style: 'white-space:pre-wrap;max-height:120px;overflow:auto' }, String(r.notes).slice(0, 400)) : null,
      );
      const dl = el('button', {
        class: 'primary',
        onclick: async () => {
          dl.disabled = true;
          dl.textContent = '下载中… 0%';
          const off = native.onProgress(({ percent }) => {
            dl.textContent = `下载中… ${percent}%`;
          });
          const d = await native.download();
          off();
          if (!d.ok) {
            dl.disabled = false;
            dl.textContent = '下载失败，重试';
            toast(d.error || '下载失败', true);
            return;
          }
          dl.textContent = '已下载，点这里安装并重启';
          dl.disabled = false;
          dl.onclick = async () => {
            dl.disabled = true;
            dl.textContent = '正在安装…';
            await native.install();
          };
        },
      }, '下载更新');
      actions.replaceChildren(dl);
    },
  }, '检查更新');

  actions.replaceChildren(checkBtn);
  box.append(
    el('div', { class: 'section-title' }, '更新'),
    el('div', { class: 'tip' }, '走 Electron 自带更新器（electron-updater）：检查、下载、退出、安装、重启一体化。渠道是公开镜像仓 winbot-ci。'),
    out,
    actions,
  );
  return box;
}

function renderUpdate() {
  // 安装版里优先用 Electron 内置更新器
  if (typeof window !== 'undefined' && window.winbotUpdate) return renderUpdateNative(window.winbotUpdate);
  const updateBox = el('div', {});
  const u = state.update || {};
  const repo = inputEl(u.repo || 'dianmei0602/winbot', { placeholder: 'owner/repo' });
  const token = inputEl('', { type: 'password', placeholder: u.hasToken ? '已保存（留空不改）' : '私有仓需要 token' });
  const proxy = inputEl(u.proxy || '', { placeholder: '如 http://127.0.0.1:12450（直连 GitHub 超时才需要）' });
  const out = el('div', { class: 'tip' }, `当前版本 ${u.current || ''}`);
  const runCheck = async () => {
    if (!token.value && !u.hasToken) {
      toast('先填 GitHub Token：私有仓才能查 release', true);
      token.focus(); token.classList.add('flash');
      setTimeout(() => token.classList.remove('flash'), 1200);
      return;
    }
    out.textContent = '正在查 GitHub…';
    try {
      await api('/api/update/settings', { method: 'POST', body: { repo: repo.value, proxy: proxy.value, ...(token.value ? { token: token.value } : {}) } });
      const r = await api(`/api/update/check?repo=${encodeURIComponent(repo.value)}`);
      state.update = r.settings || state.update;
      if (!r.found) {
        out.textContent = r.message || '没找到 release';
        if (r.needsToken) { token.focus(); token.classList.add('flash'); setTimeout(() => token.classList.remove('flash'), 1200); }
        return;
      }
      out.replaceChildren(
        el('div', {}, `最新 ${r.latest} · 当前 ${r.current} · ${r.newer ? '有更新' : '已是最新'}`),
        r.asset ? el('div', { class: 'tip' }, `安装包：${r.asset.name}（${Math.round((r.asset.size || 0) / 1048576)} MB）`) : el('div', { class: 'tip' }, '这个 release 没有 .exe'),
        r.notes ? el('div', { class: 'tip', style: 'white-space:pre-wrap;max-height:120px;overflow:auto' }, r.notes.slice(0, 400)) : null,
      );
      if (r.newer && r.asset) {
        const btn = el('button', {
          class: 'primary',
          onclick: async () => {
            btn.disabled = true; btn.textContent = '下载中…';
            try {
              const d = await api('/api/update/download', { method: 'POST', body: { url: r.asset.url, name: r.asset.name, assetId: r.asset.id } });
              btn.textContent = `已下载 ${Math.round(d.size / 1048576)} MB，点这里安装`;
              btn.disabled = false;
              btn.onclick = async () => {
                const done = await api('/api/update/install', { method: 'POST', body: { path: d.path } });
                toast(done.installsOnQuit ? 'winbot 会先退出再安装（约 2-4 分钟），装好后重新打开' : '安装程序已启动');
              };
            } catch (e) { btn.disabled = false; btn.textContent = '下载失败，重试'; toast(e.message, true); }
          },
        }, '下载并安装');
        out.append(el('div', { class: 'panel-actions' }, btn));
      }
    } catch (e) { out.textContent = `检查失败：${e.message}`; }
  };
  updateBox.append(
    el('div', { class: 'section-title' }, '更新'),
    el('div', { class: 'tip' }, '从 GitHub Releases 检查新版本。私有仓要填一个带 repo 权限的 token，只存在本机。'),
    el('div', { class: 'row-2' }, field('仓库', repo), field('Token（可留空）', token)),
    field('代理（可选）', proxy),
    out,
    el('div', { class: 'panel-actions' }, el('button', { class: 'ghost-btn', onclick: runCheck }, '检查更新')),
  );
  return updateBox;
}

/** 团队包 */
function renderTeam(refresh) {
  const teamBox = el('div', {});
  const text = el('textarea', {
    style: 'min-height:140px;font-family:Consolas,monospace;font-size:12px',
    placeholder: '把团队包粘进来，例如：\n```winbot-team\n{"name":"写作小组","bots":[{"name":"小七","summary":"总编","persona":"…"}],"group":{"name":"写作小组","members":["小七"]}}\n```',
  });
  const importBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        const r = await api('/api/teams/import', { method: 'POST', body: { text: text.value } });
        toast(`导入完成：新建 ${r.created.length} 个、更新 ${r.updated.length} 个${r.groupName ? `，建群「${r.groupName}」` : ''}`);
        text.value = '';
        await refresh();
      } catch (e) { toast(e.message, true); }
    },
  }, '导入团队');
  const file = el('input', { type: 'file', accept: '.md,.json,.txt', style: 'display:none' });
  file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; text.value = await f.text(); file.value = ''; });
  teamBox.append(
    el('div', { class: 'section-title' }, '团队包'),
    el('div', { class: 'tip' }, '一段 JSON（或包在 ```winbot-team 代码块里）可以一次建好几个机器人并组群。同名机器人会更新简介/人设，不会重建。'),
    text,
    el('div', { class: 'panel-actions' }, importBtn, el('button', { class: 'ghost-btn', onclick: () => file.click() }, '从文件读'), file),
  );
  return teamBox;
}

/** 主动消息的分寸 */
function renderQuiet(data) {
  const quietBox = el('div', {});
  const sec = data.config.security || {};
  const quiet = sec.quietHours || { enabled: true, from: '22:00', to: '08:00' };
  const caps = sec.proactiveDailyCap || {};
  const quietOn = el('input', { type: 'checkbox', checked: quiet.enabled ? 'checked' : null });
  const quietFrom = inputEl(quiet.from, { type: 'time' });
  const quietTo = inputEl(quiet.to, { type: 'time' });
  const capInputs = {};
  const channelNames = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', feishu: '飞书', wechat: '微信' };
  const capRows = Object.entries(channelNames).map(([key, label]) => {
    capInputs[key] = inputEl(String(caps[key] ?? (key === 'wechat' ? 3 : 5)), { type: 'number', min: '0' });
    return el('div', { class: 'row-2' }, el('div', { class: 'field' }, el('label', {}, label), capInputs[key]), el('div'));
  });
  quietBox.append(
    el('div', { class: 'section-title' }, '主动消息'),
    el('div', { class: 'tip' }, '定时任务的结果在免打扰时段只排队、不推送；超过每日上限的会合成一条，第二天早上再发。应用内不受限制。'),
    el('label', { style: 'display:inline-flex;gap:8px;align-items:center;color:var(--fg-2);margin:10px 0;width:auto;white-space:nowrap' }, quietOn, '启用免打扰'),
    el('div', { class: 'row-2' }, field('从', quietFrom), field('到', quietTo)),
    el('div', { class: 'section-title' }, '每个渠道每天最多主动发几条（0 = 不限）'),
    ...capRows,
    el('div', { class: 'panel-actions' },
      el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            const nextCaps = {};
            for (const [k, inp] of Object.entries(capInputs)) nextCaps[k] = Number(inp.value) || 0;
            await api('/api/settings/security', {
              method: 'PATCH',
              body: {
                quietHours: { enabled: quietOn.checked, from: quietFrom.value || '22:00', to: quietTo.value || '08:00' },
                proactiveDailyCap: nextCaps,
              },
            });
            toast('已保存');
          } catch (e) { toast(e.message, true); }
        },
      }, '保存'),
    ),
  );
  return quietBox;
}

/** 关于本机 */
function renderAboutMachine(data) {
  const about = el('div', {});
  about.append(el('div', { class: 'section-title' }, '关于这台机器'));
  about.append(
    el('dl', { class: 'kv' },
      el('dt', {}, '数据目录'), el('dd', {}, data.dataDir),
      el('dt', {}, '智能体内核'), el('dd', {}, 'DeepSeek Harness（SDK 子进程，每个机器人一个）'),
      el('dt', {}, '控制台'), el('dd', {}, location.origin),
      el('dt', {}, '权限模式'), el('dd', {}, Object.entries(data.permissionModes).map(([k, v]) => `${v.label}`).join(' / ')),
    ),
  );
  return about;
}

/** 按 tab 渲染对应区块；tab 为 null 时渲染全部（兼容旧调用） */
export function renderSystem({ data, net, tab, refresh }) {
  const box = el('div', {});
  const parts = {
    network: () => renderNetwork(net),
    update: () => renderUpdate(),
    backup: () => el('div', { class: 'tip' }, '备份恢复功能开发中，数据目录：' + data.dataDir),
    team: () => renderTeam(refresh),
    quiet: () => renderQuiet(data),
    about: () => renderAboutMachine(data),
  };
  if (tab && parts[tab]) {
    box.append(parts[tab]());
  } else {
    for (const fn of Object.values(parts)) box.append(fn());
  }
  return box;
}
