/**
 * 极简事件总线（原 app.js onEvent 的 if-else 分发 → 订阅分发）。
 * 零依赖。加新事件只需 bus.on(type, handler)，不再改中心函数。
 */
const handlers = new Map();

/** 订阅某类事件，返回取消订阅函数 */
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

/** 分发事件到所有订阅者（同步、按订阅顺序） */
export function emit(type, payload) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bus] handler for "${type}" threw:`, err);
    }
  }
}

/** 清除某类事件的所有订阅（视图 destroy 时用） */
export function off(type) {
  handlers.delete(type);
}

export const bus = { on, emit, off };
export default bus;
