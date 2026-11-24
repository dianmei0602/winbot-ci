// 验证：团队包导入 + 应用连接模板。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync(process.env.WINBOT_TOKEN_FILE || 'E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${p} ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : null;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const TEAM = `# 测试团队

\`\`\`winbot-team
{
  "name": "测试小队",
  "bots": [
    { "name": "测试主编", "summary": "写稿、改稿、排版", "avatar": "green", "persona": "你是编辑，说话简洁。" },
    { "name": "测试工程", "summary": "写代码、跑脚本、查资料", "avatar": "blue", "persona": "你是工程师。" }
  ],
  "group": { "name": "测试小队", "members": ["测试主编", "测试工程"], "router": "model" }
}
\`\`\`
`;

// 先清掉上次可能残留的测试对象
for (const b0 of (await api('GET', '/api/bots')).filter((x) => x.name.startsWith('测试'))) {
  await api('DELETE', `/api/bots/${b0.id}?keep=0`);
}
for (const g0 of (await api('GET', '/api/groups')).filter((x) => x.name.startsWith('测试'))) {
  await api('DELETE', `/api/groups/${g0.id}`);
}
for (const m0 of (await api('GET', '/api/mcp')).items.filter((x) => x.name === 'filesystem')) {
  await api('DELETE', `/api/mcp/${m0.id}`);
}

console.log('=== 团队包导入 ===');
const before = (await api('GET', '/api/bots')).map((b) => b.name);
const r = await api('POST', '/api/teams/import', { text: TEAM });
console.log('  结果:', JSON.stringify(r).slice(0, 200));
ok('新建了 2 个机器人', r.created.length === 2, r.created.join(','));
const bots = await api('GET', '/api/bots');
ok('机器人真的存在', bots.some((b) => b.name === '测试主编') && bots.some((b) => b.name === '测试工程'));
const groups = await api('GET', '/api/groups');
const g = groups.find((x) => x.name === '测试小队');
ok('群建好了', !!g, g ? g.members.map((m) => m.name).join('、') : '');
ok('群路由是 model', g?.router === 'model', g?.router);

console.log('=== 重复导入 = 更新而不是重建 ===');
const r2 = await api('POST', '/api/teams/import', { text: TEAM });
ok('第二次没有新建', r2.created.length === 0, `updated=${r2.updated.length}`);
const dup = (await api('GET', '/api/bots')).filter((b) => b.name === '测试主编');
ok('没有重名机器人', dup.length === 1, `${dup.length} 个`);

console.log('=== 应用连接模板 ===');
const presets = (await api('GET', '/api/connectors/presets')).presets;
ok('有模板列表', presets.length >= 5, `${presets.length} 个`);
const fsPreset = presets.find((p) => p.id === 'filesystem');
ok('filesystem 模板不需要账号', fsPreset && (fsPreset.env || []).length === 0);
const inst = await api('POST', '/api/connectors/install', { presetId: 'filesystem', env: {} });
ok('接入成功', inst.ok === true, inst.item?.name);
const mcps = (await api('GET', '/api/mcp')).items;
ok('连接器列表里有它', mcps.some((m) => m.name === 'filesystem'));
const needKey = presets.find((p) => p.id === 'github');
if (needKey) {
  let failed = false;
  try {
    await api('POST', '/api/connectors/install', { presetId: 'github', env: {} });
  } catch {
    failed = true;
  }
  ok('缺 Token 时明确拒绝', failed);
}

// 清理
for (const b of (await api('GET', '/api/bots')).filter((x) => x.name.startsWith('测试'))) {
  await api('DELETE', `/api/bots/${b.id}?keep=0`);
}
if (g) await api('DELETE', `/api/groups/${g.id}`);
for (const m of (await api('GET', '/api/mcp')).items.filter((x) => x.name === 'filesystem')) {
  await api('DELETE', `/api/mcp/${m.id}`);
}
console.log('清理完成');
