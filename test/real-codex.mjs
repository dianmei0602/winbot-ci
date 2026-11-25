// Codex 内核的真模型冒烟：用本机 DSH 登录态直连 DeepSeek /v1/responses。
// 前置：装好 Codex（桌面版/CLI 都行）+ DSH 登录过 DeepSeek。
// 跑法：node test/real-codex.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 项目模块之前改数据目录，否则 util.js 的 DATA_DIR 已经定死
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winbot-codex-real-'));
process.env.WINBOT_DATA = tmp;

fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({
    version: 1,
    server: { port: 5178, host: '127.0.0.1' },
    defaultProviderId: 'deepseek-account',
    providers: [],
    security: { defaultPermission: 'workspace-write' },
  }),
);

const botId = 'bot-codex-real';
const bdir = path.join(tmp, 'bots', botId);
fs.mkdirSync(path.join(bdir, 'workspace'), { recursive: true });
fs.writeFileSync(
  path.join(bdir, 'bot.json'),
  JSON.stringify({
    id: botId,
    name: 'Codex 冒烟',
    engine: 'codex',
    providerId: 'deepseek-account',
    model: 'deepseek-flash',
    permission: 'workspace-write',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
);
fs.writeFileSync(path.join(bdir, 'persona.md'), '你是测试机器人。用户让你只回数字时，就只回那个数字。');
fs.writeFileSync(path.join(bdir, 'memory.md'), '# 记忆\n');

const { CodexRuntime, resolveCodexBin } = await import('../src/codex.js');
const { getBot } = await import('../src/bots.js');
const { createConversation } = await import('../src/db.js');

if (!resolveCodexBin()) {
  console.log('跳过：这台机器没装 Codex（设 WINBOT_CODEX_BIN 可指定路径）');
  process.exit(0);
}

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

const bot = getBot(botId);
const events = [];
const rt = new CodexRuntime(bot, { emit: (_id, ev) => events.push(ev) });
const conv = createConversation({ botId, title: 'codex e2e' });

try {
  console.log('=== 1. 第一轮（新线程） ===');
  const r1 = await rt.runTurn({ conversationId: conv.id, text: '只回答一个数字：7。不要解释，不要调用任何工具。' });
  ok('有回复', !!String(r1.text || '').trim(), JSON.stringify(String(r1.text).slice(0, 60)));
  ok('回复里有 7', /7/.test(r1.text || ''));
  ok('拿到线程 id', !!r1.sessionId, r1.sessionId);
  ok('用量有输入 token', (r1.usage?.inputTokens || 0) > 0, JSON.stringify(r1.usage));
  ok('事件里有 assistant-step', events.some((e) => e.type === 'assistant-step'));

  console.log('=== 2. 续同一线程 ===');
  const r2 = await rt.runTurn({
    conversationId: conv.id,
    sessionId: r1.sessionId,
    text: '我刚才让你回答什么数字？只回那个数字，不要解释。',
  });
  ok('第二轮有回复', !!String(r2.text || '').trim(), JSON.stringify(String(r2.text).slice(0, 60)));
  ok('线程 id 不变（resume 生效）', r2.sessionId === r1.sessionId);
  ok('记得上一轮（回 7）', /7/.test(r2.text || ''));

  console.log('=== 3. 沙箱真的生效（只读下不能写） ===');
  // 观察模式那条路径：只对紧接着的这一轮换成 read-only
  await rt.setPermission('read-only');
  const r3 = await rt.runTurn({
    conversationId: conv.id,
    sessionId: r2.sessionId,
    text: '在工作区写一个 probe-readonly.txt，内容写 ok。写不了就只回「写不了」。',
  });
  const wrote = fs.existsSync(path.join(bdir, 'workspace', 'probe-readonly.txt'));
  ok('只读模式没写成文件', !wrote, wrote ? '文件居然被创建了' : '');
  ok('第三轮有回复', !!String(r3.text || '').trim());
} finally {
  await rt.stop();
  // codex 的沙箱服务偶尔还占着临时目录里的文件，删不掉不算测试失败
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 留着让系统清理 */
  }
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
