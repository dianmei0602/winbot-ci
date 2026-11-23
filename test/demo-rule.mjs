// 造一条演示用的定时规则（截图/展示用），可加 --delete 清理。
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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

if (process.argv.includes('--delete')) {
  for (const s of await api('GET', '/api/schedules')) {
    if (s.title === '早上看天气') {
      await api('DELETE', `/api/schedules/${s.id}`);
      console.log('deleted', s.id);
    }
  }
  process.exit(0);
}

const bots = await api('GET', '/api/bots');
const botId = (bots.find((b) => b.name === '小七') || bots[0]).id;
const { schedule } = await api('POST', '/api/schedules', {
  botId,
  title: '早上看天气',
  prompt: '查今天杭州天气，只有下雨或降温超过 5 度才提醒我，否则不用说话。',
  kind: 'daily',
  at: '08:00',
  mode: 'observe',
  runBudgetTokens: 20000,
  monthBudgetTokens: 300000,
  channel: 'app',
});
console.log('demo rule:', schedule.id, schedule.mode, schedule.monthBudgetTokens);
