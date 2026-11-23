// 探针：用安装版自己的 electron 以 node 身份跑一次「启动机器人 + 发一条消息」，
// 把 DSH 启动过程中吞掉的错误打出来。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = process.argv[2] || path.resolve(here, '..');
process.env.WINBOT_DATA = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'winbot-probe-'));

const { pathToFileURL } = await import('node:url');
const load = (rel) => import(pathToFileURL(path.join(appRoot, rel)).href);
const { createBot, listBots } = await load('src/bots.js');
const { sendToBot, botStatus } = await load('src/dsh.js');
const { openDb, createConversation } = await load('src/db.js');

openDb();
const name = `探针-${Date.now() % 100000}`;
const bot = createBot({ name, avatar: 'blue', summary: 'probe', providerId: 'deepseek-account', model: 'deepseek-flash' });
console.log('bot:', bot.id, 'data:', process.env.WINBOT_DATA);

const conv = createConversation({ botId: bot.id, title: 'probe', channel: 'app' });

try {
  const r = await sendToBot({ botId: bot.id, conversationId: conv.id, sessionId: null, text: '只回答两个字：可以', channel: 'app' });
  console.log('OK:', JSON.stringify(r).slice(0, 300));
} catch (e) {
  console.log('FAIL:', e?.stack || e);
  console.log('status:', JSON.stringify(botStatus(bot.id)));
}
console.log('bots now:', listBots().map((b) => b.name).join(','));
process.exit(0);

