// 本机 DSH 登录态能用的 DeepSeek 模型（来自账号的 /models 列表）。
// 令牌由 DSH 的账号服务在请求时注入，这里只需要 id 和容量。
export const DSH_ACCOUNT_MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'] },
];
