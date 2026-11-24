// 工具级权限：被禁用的工具在执行前拦下。
// 诊断：加载时写标记文件，便于确认插件到底有没有被 DSH 加载。
import fs from 'node:fs';
import path from 'node:path';

export const name = 'winbot-toolguard';

export const inject = ['tools'];

export function apply(ctx) {
  const raw = String(process.env.WINBOT_DENY_TOOLS || '');
  const deny = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const home = String(process.env.WINBOT_WORKSPACE || process.env.APPDATA || '.');
    const marker = path.join(home, 'toolguard-loaded.txt');
    fs.writeFileSync(marker, `${new Date().toISOString()} deny=${deny.join('|') || '(empty)'}\n`, { flag: 'a' });
  } catch {
    /* ignore */
  }
  if (!deny.length) return;

  const denial = (execution) => {
    const toolName = String(execution?.name || '');
    if (!deny.includes(toolName)) return undefined;
    return { reason: `工具「${toolName}」已被这个机器人禁用（设置 → 禁用这些工具）` };
  };

  // 两条路都试：执行期 guard + pre-execute 监听（后者是全局事件）
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
