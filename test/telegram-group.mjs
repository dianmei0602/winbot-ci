// 验证 Telegram 群聊的两个关键点：只接「@机器人 / 回复它 / 命令」，且群里共享一条会话。
import { shouldHandleTelegramMessage } from '../src/channels/telegram.js';
import { conversationFor } from '../src/channels/core.js';
import { deleteConversation, openDb } from '../src/db.js';

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
openDb();
const BOT = 'bot-test-group';

console.log('=== 私聊 ===');
{
  const r = shouldHandleTelegramMessage({ chat: { id: 1, type: 'private' }, text: '你好' }, 'winbot_bot');
  ok('私聊照常接', r.handle === true);
  ok('私聊不带 groupId', r.groupId === null);
}

console.log('=== 群聊：没 @ 就不接 ===');
{
  const r = shouldHandleTelegramMessage({ chat: { id: -1001, type: 'supergroup' }, text: '今天天气不错' }, 'winbot_bot');
  ok('没 @ 不接', r.handle === false);
  ok('带出群 id', r.groupId === '-1001');
}

console.log('=== 群聊：@ 机器人 ===');
{
  const r = shouldHandleTelegramMessage({ chat: { id: -1001, type: 'group' }, text: '@winbot_bot 帮我看下这个' }, 'winbot_bot');
  ok('@ 了就接', r.handle === true);
  ok('@ 被去掉', r.text === '帮我看下这个', JSON.stringify(r.text));
}

console.log('=== 群聊：回复机器人的消息 ===');
{
  const r = shouldHandleTelegramMessage(
    { chat: { id: -1001, type: 'supergroup' }, text: '继续说', reply_to_message: { from: { username: 'winbot_bot' } } },
    'winbot_bot',
  );
  ok('回复它也接', r.handle === true, JSON.stringify(r.text));
}

console.log('=== 群聊：命令 /help@bot ===');
{
  const r = shouldHandleTelegramMessage({ chat: { id: -1001, type: 'group' }, text: '/help@winbot_bot' }, 'winbot_bot');
  ok('命令带 @ 也接', r.handle === true);
  ok('命令被还原成 /help', r.text === '/help', JSON.stringify(r.text));
}

console.log('=== 群会话：同群共享、不同群分开 ===');
{
  const a1 = conversationFor({ channel: 'telegram', senderId: 'u1', botId: BOT, groupId: '-1001' });
  const a2 = conversationFor({ channel: 'telegram', senderId: 'u2', botId: BOT, groupId: '-1001' });
  const b1 = conversationFor({ channel: 'telegram', senderId: 'u1', botId: BOT, groupId: '-2002' });
  const p1 = conversationFor({ channel: 'telegram', senderId: 'u1', botId: BOT });
  ok('同一个群、不同人 -> 同一条会话', a1.id === a2.id, `${a1.id} / ${a2.id}`);
  ok('不同群 -> 不同会话', a1.id !== b1.id);
  ok('私聊另开一条', p1.id !== a1.id);
  for (const c of [a1, b1, p1]) deleteConversation(c.id);
}
