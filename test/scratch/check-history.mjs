// 确认最近一次视频任务里真的用了 AddGuide 和 AudioConcat。
const B = 'http://127.0.0.1:8188';
const h = await (await fetch(`${B}/history?max_items=8`)).json();
const rows = [];
for (const [id, e] of Object.entries(h)) {
  const types = Object.values(e.prompt?.[2] || {}).map((n) => n.class_type);
  const out = JSON.stringify(e.outputs || {});
  const file = (out.match(/"filename":"([^"]+)"/) || [])[1];
  if (!file) continue;
  rows.push({
    id: id.slice(0, 8),
    guide: types.includes('MiniMaxH3AddGuide'),
    concat: types.includes('AudioConcat'),
    segs: types.filter((t) => t === 'MiniMaxH3ImageToVideo').length,
    file,
  });
}
rows.sort((a, b) => (a.id < b.id ? 1 : -1));
console.log('最近的视频任务：');
for (const r of rows.slice(0, 5)) console.log(` ${r.id} guide=${r.guide} audioConcat=${r.concat} segments=${r.segs} -> ${r.file}`);
