// P0：连续失败 3 次自动暂停 + 恢复。
// 用一个「没有 API Key」的临时接口让每轮快速失败，不用真的等网络超时。
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
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

// 准备：一个没 Key 的接口 + 一个用它的机器人
const prov = (await api('POST', '/api/settings/provider', {
  id: 'p0broken',
  name: 'P0 故意坏的接口',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:9/v1',
  models: ['broken-model'],
})).provider;
const created = await api('POST', '/api/bots', {
  name: 'P0失败测试',
  avatar: 'red',
  providerId: 'p0broken',
  model: 'broken-model',
});
const botId = created.bot.id;
console.log('临时机器人:', botId, '接口:', prov?.id);

const { schedule } = await api('POST', '/api/schedules', {
  botId,
  title: 'P0·失败暂停',
  prompt: '说一句话',
  kind: 'interval',
  everyMinutes: 60,
  channel: 'app',
});
console.log('规则:', schedule.id);

let s = null;
for (let i = 1; i <= 3; i += 1) {
  const r = await api('POST', `/api/schedules/${schedule.id}/run`, {});
  s = (await api('GET', `/api/schedules?botId=${botId}`)).find((x) => x.id === schedule.id);
  console.log(`  第 ${i} 次: ok=${r.ok} failures=${s.failures} paused=${s.pausedReason || '-'} 原因=${String(r.text).slice(0, 60)}`);
}

ok('连续 3 次失败后自动暂停', s.pausedReason === 'failures');
ok('暂停原因可读', s.pausedLabel === '连续失败，已暂停', s.pausedLabel);
ok('失败次数记录正确', s.failures === 3, String(s.failures));

// 暂停后自动触发应被跳过
const skipped = await api('POST', `/api/schedules/${schedule.id}/run`, {});
ok('暂停后不再自动跑（手动也提示暂停）', skipped.paused === true || skipped.ok === false);

// 恢复
const resumed = await api('POST', `/api/schedules/${schedule.id}/resume`, {});
ok('恢复后清空暂停与失败计数', resumed.schedule.pausedReason === null && resumed.schedule.failures === 0);

// 清理
await api('DELETE', `/api/schedules/${schedule.id}`);
await api('DELETE', `/api/bots/${botId}?keep=0`);
await api('DELETE', '/api/settings/provider/p0broken');
ok('临时数据已清理', true);
