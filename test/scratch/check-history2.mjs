// 打印最近几条视频任务用到的关键节点
const B = 'http://127.0.0.1:8188';
const h = await (await fetch(`${B}/history?max_items=8`)).json();
const rows = [];
for (const [id, e] of Object.entries(h)) {
  const nodes = Object.values(e.prompt?.[2] || {});
  const types = nodes.map((n) => n.class_type);
  const outs = e.outputs || {};
  let file = '';
  let frames = '';
  for (const o of Object.values(outs)) {
    for (const f of o.images || []) {
      file = f.filename;
      frames = f.metadata?.frame_count ?? '';
    }
  }
  if (!file) continue;
  rows.push({
    id: id.slice(0, 8),
    cw: types.includes('MiniMaxH3ContextWindows'),
    guide: types.includes('MiniMaxH3AddGuide'),
    concat: types.includes('AudioConcat'),
    segs: types.filter((t) => t === 'MiniMaxH3ImageToVideo').length,
    frames,
    file,
  });
}
console.log('最近的视频任务（cw=滑窗, guide=首尾帧锚定）:');
for (const r of rows.slice(0, 6)) {
  console.log(` ${r.id} cw=${r.cw} guide=${r.guide} concat=${r.concat} segs=${r.segs} frames=${r.frames} -> ${r.file}`);
}
