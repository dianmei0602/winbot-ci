// P3 搜索验证：搜一条真实存在的消息，检查过滤与定位信息。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (method, p) => {
  const res = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
const bot = bots[0];

console.log('=== 先造一条好搜的消息 ===');
const { conversation } = await (async () => {
  const res = await fetch(`${BASE}/api/bots/${bot.id}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  return res.json();
})();
await fetch(`${BASE}/api/conversations/${conversation.id}/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ text: '记住这个暗号：蓝色风筝-9281' }),
});
await new Promise((r) => setTimeout(r, 8000));

console.log('=== 搜索 ===');
let hits = await api('GET', `/api/search?q=${encodeURIComponent('蓝色风筝-9281')}`);
ok('搜到消息', hits.length >= 1, `${hits.length} 条`);
ok('带会话与机器人信息', !!hits[0]?.conversationId && !!hits[0]?.botId, JSON.stringify({ c: hits[0]?.conversationId, b: hits[0]?.botId, t: hits[0]?.title }));
ok('内容包含关键词', String(hits[0]?.content).includes('蓝色风筝-9281'));

const filtered = await api('GET', `/api/search?q=${encodeURIComponent('蓝色风筝-9281')}&botId=${bot.id}`);
ok('按机器人过滤仍然能搜到', filtered.length >= 1);
const none = await api('GET', `/api/search?q=${encodeURIComponent('肯定不存在的词-zzz')}`);
ok('搜不到就返回空', none.length === 0);
const empty = await api('GET', '/api/search?q=');
ok('空关键词返回空', empty.length === 0);

// 清理
await fetch(`${BASE}/api/conversations/${conversation.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
console.log('测试会话已删除');
