// @ts-check
/**
 * 分层状态（拆自原 app.js 的 40 字段全局对象）。
 * ------------------------------------------------------------
 * 内部按 session / data / runtime / ui 四个 slice 组织，组件可只订阅自己
 * 关心的 slice；对外仍暴露旧的扁平 `state.xxx` 访问方式——通过 Proxy 把
 * 每个字段映射到所属 slice，使迁移期 200+ 处引用零改动即可工作。
 *
 * 新代码推荐用 get()/set()/subscribe()，旧代码继续用 state.xxx 均可。
 */

/** @typedef {'session'|'data'|'runtime'|'ui'} SliceName */

const slices = {
  /** 当前会话上下文 */
  session: {
    currentBotId: null,
    currentGroupId: null,
    conversationId: null,
    currentConversationId: null,
    conversation: null,
    messages: [],
  },
  /** 从后端加载的清单数据 */
  data: {
    bots: [],
    groups: [],
    connectorPresets: [],
    settings: null,
    update: null,
  },
  /** 运行时瞬态（流式、工具步骤、审批、SSE、用量） */
  runtime: {
    approvals: new Map(),
    sse: null,
    busy: false,
    progress: [],
    liveText: '',
    liveBotId: null,
    usage: null,
  },
  /** 界面状态 */
  ui: {
    pane: null, // 'bot' | 'settings' | 'convs' | 'ComfyUI' | '定时任务' | null
    route: null, // 由 router 写入的当前路由
    attachments: [], // 还没发出去的附件 {path,name,size,kind,url}
    openTools: new Set(),
    botFilter: '',
    comfyUrl: 'http://127.0.0.1:8188',
  },
};

/** 字段 → slice 映射表（唯一事实来源） */
const fieldToSlice = {};
for (const [name, fields] of Object.entries(slices)) {
  for (const key of Object.keys(fields)) fieldToSlice[key] = name;
}

const listeners = new Set();

/** 取出整个分层状态（新代码用） */
export const get = () => slices;

/** 取单个 slice */
export const getSlice = (/** @type {SliceName} */ name) => slices[name];

/**
 * 更新一个 slice 的若干字段并通知订阅者（新代码用）。
 * @param {SliceName} slice
 * @param {Record<string, any>} patch
 */
export const set = (slice, patch) => {
  Object.assign(slices[slice], patch);
  listeners.forEach((fn) => fn(slice, slices));
};

/** 订阅状态变更，返回取消订阅函数 */
export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * 兼容层：扁平访问 state.xxx → 自动落到对应 slice。
 * 未知字段（旧代码里动态加的，如临时标记）兜底到 runtime，保证不丢。
 */
export const state = new Proxy(slices, {
  get(target, prop) {
    if (typeof prop !== 'string') return Reflect.get(target, prop);
    if (prop in target) return target[prop]; // state.session / state.data ...
    const slice = fieldToSlice[prop];
    if (slice) return target[slice][prop];
    return undefined;
  },
  set(target, prop, value) {
    if (typeof prop !== 'string') return Reflect.set(target, prop, value);
    if (prop in target) {
      target[prop] = value;
      return true;
    }
    const slice = fieldToSlice[prop] || 'runtime';
    target[slice][prop] = value;
    if (!fieldToSlice[prop]) fieldToSlice[prop] = slice; // 记住新字段
    return true;
  },
  has(target, prop) {
    if (prop in target) return true;
    return typeof prop === 'string' && prop in fieldToSlice;
  },
  ownKeys(target) {
    return [...Object.keys(target), ...Object.keys(fieldToSlice)];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop);
    if (typeof prop === 'string' && prop in fieldToSlice) {
      return { configurable: true, enumerable: true, writable: true, value: undefined };
    }
    return undefined;
  },
});

export default state;
