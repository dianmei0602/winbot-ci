// 工具级权限：被机器人禁用的工具在该机器人会话里不可见（ctx.tools.restrict）。
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
    ctx.tools.restrict({ deny });
  } catch {
    /* 名字不认识时忽略，别把整个会话搞挂 */
  }
}
