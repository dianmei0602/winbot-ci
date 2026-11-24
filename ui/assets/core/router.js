// @ts-check
/**
 * 极简 hash 路由（零依赖）。替代原 app.js 用面板标题字符串当状态的做法。
 * ------------------------------------------------------------
 * 路由格式：#/<domain>[/<tab>][/<id>]
 *   #/chat                 对话（主区，关闭面板）
 *   #/chat/history         历史会话
 *   #/chat/search          搜索
 *   #/chat/:botId          指定机器人会话
 *   #/chat/group/:groupId  群聊
 *   #/bots                 机器人详情
 *   #/automation           自动化（定时任务）
 *   #/connect/:tab         连接（providers/channels/mcp/apps/media）
 *   #/system/:tab          系统（about/update/network/backup/diagnostics/team）
 */

/** @typedef {{ domain:string, tab:string|null, id:string|null, raw:string, hash:string }} Route */

const domains = new Set(['chat', 'bots', 'automation', 'connect', 'system']);

/** 解析 hash → Route 对象 */
export function resolve(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const domain = domains.has(parts[0]) ? parts[0] : 'chat';
  // chat/group/:id 特例
  if (domain === 'chat' && parts[1] === 'group') {
    return { domain, tab: 'group', id: parts[2] || null, raw, hash: `#/${raw}` };
  }
  return {
    domain,
    tab: parts[1] || null,
    id: parts[1] && domain === 'chat' ? parts[1] : parts[2] || null,
    raw,
    hash: `#/${raw || 'chat'}`,
  };
}

const changeFns = new Set();
let current = resolve();

/** 当前路由 */
export const currentRoute = () => current;

/** 跳转到某路由（可传 '#/connect/mcp' 或 'connect/mcp'） */
export function go(to) {
  const hash = to.startsWith('#') ? to : `#/${String(to).replace(/^\//, '')}`;
  if (location.hash === hash) {
    apply(hash); // 同一路由也强制刷新一次，方便「重新打开」
  } else {
    location.hash = hash;
  }
}

/** 订阅路由变化，返回取消订阅函数 */
export function onChange(fn) {
  changeFns.add(fn);
  return () => changeFns.delete(fn);
}

function apply(hash) {
  const prev = current;
  current = resolve(hash);
  for (const fn of [...changeFns]) {
    try {
      fn(current, prev);
    } catch (err) {
      console.error('[router] handler threw:', err);
    }
  }
}

/** 返回上一视图：面板态退回对话，否则回退历史 */
export function back() {
  if (current.domain !== 'chat') {
    go('#/chat');
    return true;
  }
  if (history.length > 1) {
    history.back();
    return true;
  }
  return false;
}

let started = false;
/** 启动路由：绑定 hashchange，并按首屏 hash 触发一次 */
export function startRouter() {
  if (started) return;
  started = true;
  window.addEventListener('hashchange', () => apply(location.hash));
  apply(location.hash || '#/chat');
}

export default { resolve, go, onChange, on: onChange, currentRoute, back, startRouter };
