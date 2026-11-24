// 工具级权限：被机器人禁用的工具在执行前被 guard 拦下（比 restrict 更可靠，作用域无关）。
export const name = 'winbot-toolguard';

export const inject = ['tools'];

export function apply(ctx) {
  const raw = String(process.env.WINBOT_DENY_TOOLS || '');
  const deny = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!deny.length) return;
  try {
    ctx.tools.guard((execution) => {
      const toolName = String(execution?.name || '');
      if (!deny.includes(toolName)) return undefined;
      return { reason: `工具「${toolName}」已被这个机器人禁用（设置 → 禁用这些工具）` };
    });
  } catch {
    /* guard 注册失败不影响会话 */
  }
}
