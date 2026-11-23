// 全局配置：模型接口（含 API Key）、渠道令牌、服务设置。
// 只存在本机 data/config.json，不出设备；文件权限尽量收紧。
import fs from 'node:fs';
import { CONFIG_FILE, ensureDirs, readJson, writeJson, newId } from './util.js';
import { DSH_ACCOUNT_PROVIDER_ID, hasDshDeepSeekAccount, isDshAccountProvider, readDshDeepSeekToken } from './dsh-account.js';
import { DSH_ACCOUNT_MODELS } from './dsh-models.js';

/** 内置接口预设：只给 baseURL 和默认模型，Key 由用户填。value 是 llm-pi-ai 的 api 协议。 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（API Key）',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    help: 'platform.deepseek.com 申请 API Key',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    help: 'platform.openai.com 申请 API Key',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    help: 'console.anthropic.com 申请 API Key',
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-128k'],
    help: 'platform.moonshot.cn 申请 API Key',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    api: 'openai-completions',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5-air'],
    help: 'bigmodel.cn 申请 API Key',
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope',
    api: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus'],
    help: 'dashscope 控制台申请 API Key',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat'],
    help: 'openrouter.ai 一把 Key 走多家模型',
  },
  {
    id: 'ollama',
    name: '本地 Ollama / vLLM',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:8b', 'llama3.1:8b'],
    help: '本机模型，Key 可留空',
  },
];

const DEFAULT_CONFIG = {
  version: 1,
  server: { port: 5178, host: '127.0.0.1' },
  defaultProviderId: null,
  providers: [],
  // 连接器（MCP）：本地命令或远程 HTTP 服务，接上后工具会以 mcp__<名字>__<工具> 出现
  mcp: [],
  // 本机 ComfyUI：生图生视频走它
  comfy: { url: 'http://127.0.0.1:8188', checkpoint: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', enabled: true },
  update: { repo: 'dianmei0602/winbot', token: '' },
  channels: {
    telegram: { enabled: false, token: '', allow: [], defaultBotId: null },
    slack: { enabled: false, appToken: '', botToken: '', allow: [], defaultBotId: null },
    discord: { enabled: false, token: '', allow: [], defaultBotId: null },
    feishu: { enabled: false, appId: '', appSecret: '', allow: [], defaultBotId: null },
    wechat: { enabled: false, mode: 'off', token: '', allow: [], defaultBotId: null },
  },
  security: {
    // 新机器人默认权限；ask-outside 即「工作区外写入先问我」
    defaultPermission: 'workspace-write',
    // 哪些渠道来源可以审批（默认主人自己）
    approvalFromChannels: true,
    // 免打扰时段：这段时间里主动消息只排队，不发出去
    quietHours: { enabled: true, from: '22:00', to: '08:00' },
    // 每个渠道每天最多主动发几条（0 或省略 = 不限）
    proactiveDailyCap: { telegram: 5, slack: 5, discord: 5, feishu: 5, wechat: 3 },
  },
};

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  ensureDirs();
  const raw = readJson(CONFIG_FILE, null);
  const cfg = raw ? { ...structuredClone(DEFAULT_CONFIG), ...raw } : structuredClone(DEFAULT_CONFIG);
  cfg.channels = { ...structuredClone(DEFAULT_CONFIG.channels), ...(raw?.channels || {}) };
  for (const [k, v] of Object.entries(DEFAULT_CONFIG.channels)) {
    cfg.channels[k] = { ...v, ...(cfg.channels[k] || {}) };
  }
  cfg.security = { ...DEFAULT_CONFIG.security, ...(raw?.security || {}) };
  cfg.providers = Array.isArray(raw?.providers) ? raw.providers : [];
  cfg.mcp = Array.isArray(raw?.mcp) ? raw.mcp : [];
  cfg.comfy = { ...(cfg.comfy || {}), ...(raw?.comfy || {}) };
  cache = cfg;
  if (!raw) saveConfig(cfg);
  return cache;
}

export function saveConfig(cfg = cache) {
  cache = cfg;
  writeJson(CONFIG_FILE, cfg);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* Windows 上不一定支持，忽略 */
  }
  return cfg;
}

export function providerById(id) {
  const builtin = builtinProviders().find((p) => p.id === id);
  if (builtin) return builtin;
  return loadConfig().providers.find((p) => p.id === id) || null;
}

export function providerPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

/**
 * DSH 自带的账号接口：不需要我们的 llm-pi-ai 配置，令牌由 DSH 的账号服务在请求时注入。
 * 只有本机 DSH 登录过 DeepSeek 才可用。
 */
export function builtinProviders() {
  const out = [];
  if (hasDshDeepSeekAccount()) {
    out.push({
      id: DSH_ACCOUNT_PROVIDER_ID,
      name: 'DeepSeek（本机 DSH 登录态）',
      api: 'anthropic-messages',
      baseURL: 'https://api.deepseek.com',
      models: DSH_ACCOUNT_MODELS.map((m) => m.id),
      modelDetails: DSH_ACCOUNT_MODELS,
      builtin: true,
      authFromDsh: true,
      noKey: true,
      help: '不用填 Key，令牌由 DSH 账号服务在请求时注入',
    });
  }
  return out;
}

/** 所有可选接口：内置账号接口 + 用户自填的 */
export function allProviders() {
  return [...builtinProviders(), ...loadConfig().providers];
}

/** 每接口一条环境变量名，子进程里只放它自己的 Key，互不串味。 */
export function apiKeyEnvName(providerId) {
  return `WINBOT_KEY_${providerId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
}

/** 这个接口现在能不能用：有 Key、明确免 Key、或用本机 DSH 登录态 */
export function providerReady(p) {
  if (!p) return false;
  if (isDshAccountProvider(p)) return hasDshDeepSeekAccount();
  return !!(p.apiKey || p.noKey);
}

/** 可用的「接口+模型」组合，给界面下拉用。 */
export function modelChoices() {
  const out = [];
  for (const p of allProviders()) {
    if (!providerReady(p)) continue;
    for (const m of p.models || []) {
      out.push({ providerId: p.id, providerName: p.name, model: m, label: `${p.name} · ${m}`, builtin: !!p.builtin });
    }
  }
  return out;
}

/** 校验一个 provider 条目够不够用；返回错误文案或 null。 */
export function validateProvider(p) {
  if (!p || typeof p !== 'object') return '接口配置为空';
  if (!p.name) return '缺少名称';
  if (!p.baseURL) return '缺少 baseURL';
  if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(p.api)) {
    return `不支持的协议：${p.api}`;
  }
  if (!Array.isArray(p.models) || p.models.length === 0) return '至少填一个模型';
  return null;
}

export function defaultProvider() {
  const providers = allProviders();
  const cfg = loadConfig();
  const byId = cfg.defaultProviderId && providers.find((p) => p.id === cfg.defaultProviderId);
  if (byId && providerReady(byId)) return byId;
  return providers.find(providerReady) || providers[0] || null;
}

export function addProvider(preset) {
  const cfg = loadConfig();
  const base = preset || { id: newId('prov'), name: '新接口', api: 'openai-completions', baseURL: '', models: [] };
  const id = base.id && !cfg.providers.some((p) => p.id === base.id) ? base.id : newId('prov');
  const p = {
    id,
    name: base.name,
    api: base.api,
    baseURL: base.baseURL,
    apiKey: base.apiKey || '',
    noKey: !!base.noKey,
    authFromDsh: !!base.authFromDsh,
    models: base.models || [],
    extraHeaders: base.extraHeaders || {},
    createdAt: Date.now(),
  };
  cfg.providers.push(p);
  if (!cfg.defaultProviderId) cfg.defaultProviderId = p.id;
  saveConfig(cfg);
  return p;
}

/** 把本机 DSH 登录态同步成一个接口条目；没有登录态就什么都不做 */
export function syncDshAccountProvider() {
  const cfg = loadConfig();
  if (!hasDshDeepSeekAccount()) return null;
  let p = cfg.providers.find((x) => isDshAccountProvider(x));
  if (!p) {
    p = {
      id: DSH_ACCOUNT_PROVIDER_ID,
      name: 'DeepSeek（用本机 DSH 登录态）',
      api: 'anthropic-messages',
      baseURL: 'https://api.deepseek.com/anthropic',
      apiKey: '',
      noKey: false,
      authFromDsh: true,
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      extraHeaders: {},
      createdAt: Date.now(),
    };
    cfg.providers.unshift(p);
  } else {
    p.authFromDsh = true;
    p.api = 'anthropic-messages';
    p.baseURL = p.baseURL || 'https://api.deepseek.com/anthropic';
    if (!Array.isArray(p.models) || !p.models.length) p.models = ['deepseek-flash', 'deepseek-v4-pro'];
  }
  if (!cfg.defaultProviderId) cfg.defaultProviderId = p.id;
  saveConfig(cfg);
  return p;
}

/** 本机是否读得到 DeepSeek 账号登录态（界面提示用） */
export function dshAccountTokenAvailable() {
  return !!readDshDeepSeekToken();
}

export function updateProvider(id, patch) {
  const cfg = loadConfig();
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  saveConfig(cfg);
  return p;
}

export function removeProvider(id) {
  const cfg = loadConfig();
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.defaultProviderId === id) cfg.defaultProviderId = cfg.providers[0]?.id || null;
  saveConfig(cfg);
}

/** 界面用：Key 打码，绝不返回明文；内置接口单独标出来 */
export function publicConfig() {
  const cfg = loadConfig();
  return {
    ...cfg,
    providers: [...allProviders()].map((p) => ({
      ...p,
      apiKey: p.apiKey ? `••••••${String(p.apiKey).slice(-4)}` : '',
      hasKey: !!p.apiKey,
      ready: providerReady(p),
      ...(p.builtin ? { locked: true, models: p.models } : {}),
    })),
    channels: Object.fromEntries(
      Object.entries(cfg.channels).map(([k, v]) => [
        k,
        {
          ...v,
          token: v.token ? '••••••' : '',
          appToken: v.appToken ? '••••••' : '',
          botToken: v.botToken ? '••••••' : '',
          appSecret: v.appSecret ? '••••••' : '',
          hasToken: !!(v.token || v.botToken || v.appToken),
        },
      ]),
    ),
  };
}

