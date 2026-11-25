// 机器人这一轮生成的文件：先记在这里，回合结束挂到消息 meta.files 上，
// 界面就能直接显示图片/视频（不用靠模型记得调用 present）。

const pending = new Map(); // botId -> [{path, description, kind}]

export function addGenerated(botId, files) {
  if (!botId || !Array.isArray(files) || !files.length) return;
  const cur = pending.get(botId) || [];
  for (const f of files) {
    if (!f?.path) continue;
    if (!cur.some((x) => x.path === f.path)) cur.push(f);
  }
  pending.set(botId, cur);
}

export function takeGenerated(botId) {
  const cur = pending.get(botId) || [];
  pending.delete(botId);
  return cur;
}
