/**
 * 网络层（拆自原 app.js）：token 读取、带鉴权的 fetch、文件访问地址。
 * toast 也从这里导出——它是最基础的反馈原语，被所有层复用，放这里避免循环依赖。
 */
import { el, qs } from './dom.js';

// 令牌：URL 参数优先，其次 cookie
export const token =
  new URLSearchParams(location.search).get('token') ||
  '' ||
  document.cookie.match(/(?:^|;\s*)winbot=([^;]+)/)?.[1] ||
  '';
if (token) document.cookie = `winbot=${token}; path=/; SameSite=Strict`;

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

export async function apiRaw(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = JSON.parse(await res.text())?.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res;
}

/** 工作区里一个文件的访问地址（图片直接 <img>） */
export function botFileUrl(botId, rel) {
  return `/api/bots/${encodeURIComponent(botId)}/file?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`;
}

/** 吐司提示：基础反馈原语 */
export function toast(msg, isErr = false) {
  const t = el('div', { class: `toast${isErr ? ' err' : ''}`, role: isErr ? 'alert' : 'status' }, msg);
  qs('#toasts')?.append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}
