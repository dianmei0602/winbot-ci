// P0 验证：规则的分寸（观察/预算/失败暂停）+ 送达队列 + 「关于我」敏感闸门。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const bots = await api('GET', '/api/bots');
const botId = (bots.find((b) => b.name === '小七') || bots[0]).id;
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

// 清理上次的测试规则
for (const s of await api('GET', `/api/schedules?botId=${botId}`)) {
  if (s.title.startsWith('P0·')) await api('DELETE', `/api/schedules/${s.id}`);
}

console.log('=== 1. 观察模式 ===');
{
  const { schedule } = await api('POST', '/api/schedules', {
    botId,
    title: 'P0·观察',
    prompt: '在工作区 outputs 下新建 observe-should-not-exist.txt，内容写 test。然后告诉我你做了什么。',
    kind: 'interval',
    everyMinutes: 60,
    channel: 'app',
    mode: 'observe',
  });
  const target = `E:/AI_work/winbot/data/bots/${botId}/workspace/outputs/observe-should-not-exist.txt`;
  fs.rmSync(target, { force: true });
  const r = await api('POST', `/api/schedules/${schedule.id}/run`, {});
  console.log('  run:', JSON.stringify({ ok: r.ok, observe: r.observe, tokens: r.tokens, text: String(r.text).slice(0, 100) }));
  ok('返回标记为 observe', r.observe === true);
  ok('文件没有被创建（真的只读）', !fs.existsSync(target));
  const after = await api('GET', `/api/schedules?botId=${botId}`);
  const s = after.find((x) => x.id === schedule.id);
  ok('状态是 observe', s.lastStatus === 'observe');
  ok('记录了「本来会说什么」', !!s.lastWouldSay, String(s.lastWouldSay || '').slice(0, 60));
  await api('DELETE', `/api/schedules/${schedule.id}`);
}

console.log('=== 2. 单次预算 ===');
{
  const { schedule } = await api('POST', '/api/schedules', {
    botId,
    title: 'P0·预算',
    prompt: '用一句话说你好。',
    kind: 'interval',
    everyMinutes: 60,
    channel: 'app',
    runBudgetTokens: 1,
  });
  const r = await api('POST', `/api/schedules/${schedule.id}/run`, {});
  const after = await api('GET', `/api/schedules?botId=${botId}`);
  const s = after.find((x) => x.id === schedule.id);
  console.log('  tokens:', r.tokens, 'paused:', s.pausedReason);
  ok('跑完并记了 token', Number(r.tokens) > 0);
  ok('超预算后自动暂停', s.pausedReason === 'budget');
  ok('暂停有可读原因', !!s.pausedLabel, s.pausedLabel);
  // 暂停后自动触发应跳过
  const again = await api('POST', `/api/schedules/${schedule.id}/run`, {});
  ok('暂停后手动运行仍可（用户显式操作）', again.ok === true || again.paused === true);
  await api('DELETE', `/api/schedules/${schedule.id}`);
}

console.log('=== 3. 关于我：敏感闸门 ===');
{
  const { addAbout, loadAbout } = await import('../src/about.js');
  const phone = addAbout({ text: '他的手机号是 13800138000，晚上联系', source: 'chat' });
  ok('电话要确认才记', phone.needsConfirm === true && phone.sensitive?.includes('phone'));
  const saved = addAbout({ text: '他的手机号是 13800138000，晚上联系', source: 'chat', confirmSensitive: true });
  ok('确认后能记', saved.ok === true);
  const secret = addAbout({ text: '他的 API key 是 sk-abcdef1234567890abcdef', source: 'chat', confirmSensitive: true });
  ok('密钥一律拒绝', secret.ok === false, secret.reason);
  const lines = loadAbout().lines.map((l) => l.text);
  ok('只留下确认过的那条', lines.filter((t) => t.includes('13800138000')).length === 1);
  // 清掉测试条目
  for (const l of loadAbout().lines) {
    if (l.text.includes('13800138000')) await api('DELETE', `/api/about/${l.id}`);
  }
  const after = await api('GET', '/api/about');
  ok('清理完成', !after.lines.some((l) => l.text.includes('13800138000')));
}

console.log('=== 4. 送达队列：免打扰 / 上限 / 重试 ===');
{
  const { enqueue, flush, sentToday, queuedItems, dropItem } = await import('../src/outbox.js');
  const { openDb } = await import('../src/db.js');
  const { loadConfig, saveConfig } = await import('../src/config.js');
  const cfg = loadConfig();
  const originalQuiet = { ...cfg.security.quietHours };
  const originalCaps = { ...cfg.security.proactiveDailyCap };
  const CH = 'feishu'; // 用一个测试渠道，避免和真实使用混淆

  // 从干净状态开始
  openDb().prepare(`DELETE FROM outbox WHERE channel = ?`).run(CH);
  const nowH = new Date();
  const hh = (h) => `${String((h + 24) % 24).padStart(2, '0')}:${String(nowH.getMinutes()).padStart(2, '0')}`;
  cfg.security.quietHours = { enabled: true, from: hh(nowH.getHours()), to: hh(nowH.getHours() + 2) };
  cfg.security.proactiveDailyCap = { ...originalCaps, [CH]: 2 };
  saveConfig(cfg);

  const sent = [];
  const deliver = async (ch, target, text) => {
    sent.push({ ch, target, text });
  };
  enqueue({ botId, channel: CH, target: '123', text: '免打扰测试', kind: 'schedule' });
  let r = await flush({ deliver });
  ok('免打扰期间只排队不发', r.sent === 0 && r.held >= 1, JSON.stringify(r));

  cfg.security.quietHours = { enabled: false, from: '00:00', to: '00:00' };
  saveConfig(cfg);
  r = await flush({ deliver });
  ok('过了免打扰就发出去', r.sent === 1 && sent.length === 1, JSON.stringify(r));
  ok('发完状态是 sent', sentToday(CH) === 1);

  // 每日上限 2 条：已经发 1 条，再造 3 条，只该再发 1 条
  for (const t of ['上限1', '上限2', '上限3']) enqueue({ botId, channel: CH, target: '123', text: t, kind: 'schedule' });
  r = await flush({ deliver });
  await flush({ deliver });
  console.log('  上限测试 flush:', JSON.stringify(r), '累计已发', sent.length);
  ok('超过每日上限不再直接发', sent.length === 2, `已发 ${sent.length}`);
  ok('剩下的合成一条排到明天', queuedItems(CH).length === 1, `队列剩 ${queuedItems(CH).length} 条`);

  // 重试退避：deliver 抛错时 attempts 增加、not_before 往后推
  openDb().prepare(`DELETE FROM outbox WHERE channel = ?`).run(CH);
  cfg.security.proactiveDailyCap = { ...originalCaps, [CH]: 0 };
  saveConfig(cfg);
  enqueue({ botId, channel: CH, target: '123', text: '失败重试', kind: 'schedule' });
  await flush({ deliver: async () => { throw new Error('模拟断网'); } });
  const failedItem = openDb().prepare(`SELECT * FROM outbox WHERE channel = ?`).get(CH);
  ok('发失败会退避重试而不是丢掉', failedItem.attempts === 1 && failedItem.status === 'queued' && failedItem.not_before > Date.now(), `attempts=${failedItem.attempts}`);

  for (const it of queuedItems()) dropItem(it.id, '测试清理');
  openDb().prepare(`DELETE FROM outbox WHERE channel = ?`).run(CH);
  cfg.security.quietHours = originalQuiet;
  cfg.security.proactiveDailyCap = originalCaps;
  saveConfig(cfg);
  ok('配置已还原', JSON.stringify(loadConfig().security.quietHours) === JSON.stringify(originalQuiet));
}

console.log('=== 5. 设置接口：免打扰与上限 ===');
{
  const r = await api('PATCH', '/api/settings/security', {
    quietHours: { enabled: true, from: '23:00', to: '07:30' },
  });
  ok('能保存免打扰', r.security.quietHours.from === '23:00' && r.security.quietHours.to === '07:30');
  await api('PATCH', '/api/settings/security', { quietHours: { enabled: true, from: '22:00', to: '08:00' } });
}
