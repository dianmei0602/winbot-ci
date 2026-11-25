// 工具级权限：被禁用的工具在执行前拦下。
// 禁用列表来自 patch 里的 config.deny（每轮生成，比启动期环境变量可靠）。
export const name = 'winbot-toolguard';

export const inject = ['tools'];

export function apply(ctx, config) {
  const list = Array.isArray(config?.deny) ? config.deny : String(process.env.WINBOT_DENY_TOOLS || '').split(',');
  const deny = list.map((s) => String(s).trim()).filter(Boolean);
  if (!deny.length) return;

  const denial = (execution) => {
    const toolName = String(execution?.name || '');
    if (!deny.includes(toolName)) return undefined;
    return { reason: `工具「${toolName}」已被这个机器人禁用（设置 → 禁用这些工具）` };
  };

  try {
    ctx.tools.guard(denial);
  } catch {
    /* ignore */
  }
  try {
    if (typeof ctx.on === 'function') ctx.on('tools/pre-execute', denial);
  } catch {
    /* ignore */
  }
}
