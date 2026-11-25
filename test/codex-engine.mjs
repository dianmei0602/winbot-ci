// Codex 内核的离线自检：配置翻译、事件映射、沙箱对映、引擎分派。
// 不调真模型、不碰真实 data —— 全部在临时 WINBOT_DATA 里跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winbot-codex-'));
process.env.WINBOT_DATA = tmp;

// 最小 config.json：一个 mock 接口，Key 用假的（不发请求）
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({
    version: 1,
    server: { port: 5178, host: '127.0.0.1' },
    defaultProviderId: 'mock',
    providers: [
      {
        id: 'mock',
        name: '本地测试模型（mock）',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:5199/v1',
        apiKey: 'mock-key',
        models: ['mock-model'],
      },
    ],
    security: { defaultPermission: 'workspace-write' },
  }),
);

const botId = 'bot-codex-test';
const bdir = path.join(tmp, 'bots', botId);
fs.mkdirSync(path.join(bdir, 'workspace'), { recursive: true });
fs.writeFileSync(
  path.join(bdir, 'bot.json'),
  JSON.stringify({
    id: botId,
    name: 'Codex 测试',
    engine: 'codex',
    providerId: 'mock',
    model: 'mock-model',
    permission: 'workspace-write',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
);
fs.writeFileSync(path.join(bdir, 'persona.md'), '你是测试机器人，说话很短。');
fs.writeFileSync(path.join(bdir, 'memory.md'), '# 记忆\n');

const { CodexRuntime, resolveCodexBin } = await import('../src/codex.js');
const { getBot } = await import('../src/bots.js');
const { ensureRuntime } = await import('../src/dsh.js');

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let failed = 0;
const expect = (label, cond, extra = '') => {
  ok(label, cond, extra);
  if (!cond) failed++;
};

console.log('=== 1. 找 codex 可执行文件 ===');
{
  const bin = resolveCodexBin();
  // 没装 Codex 的机器上跳过，不算失败（CI/用户机器可能都没有）
  if (bin) ok('找到 codex', true, bin);
  else ok('没找到 codex（这台机器没装，跳过后续依赖项）', true);
}

console.log('=== 2. 沙箱对映（三档权限） ===');
{
  const bot = getBot(botId);
  const rt = new CodexRuntime(bot, { emit: () => {} });
  bot.permission = 'readonly';
  expect('readonly → read-only', rt.sandboxMode() === 'read-only', rt.sandboxMode());
  bot.permission = 'workspace-write';
  expect('workspace-write 同名', rt.sandboxMode() === 'workspace-write');
  bot.permission = 'danger-full-access';
  expect('danger-full-access 同名', rt.sandboxMode() === 'danger-full-access');
  bot.permission = 'workspace-write';
  // 定时任务的观察模式：nextPreset 优先，用完即撤
  rt.nextPreset = 'read-only';
  expect('观察模式覆盖为只读', rt.sandboxMode() === 'read-only');
  rt.nextPreset = null;
  expect('撤掉后回到机器人设置', rt.sandboxMode() === 'workspace-write');
}

console.log('=== 3. 配置翻译（独立 CODEX_HOME） ===');
{
  const rt = await ensureRuntime(botId);
  expect('engine=codex 时分派到 CodexRuntime', rt instanceof CodexRuntime, rt?.constructor?.name);
  if (resolveCodexBin()) {
    await rt.ensureStarted({ conversationId: null, channel: 'test' });
    const home = path.join(tmp, 'codex', botId);
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect('写成 wire_api = "responses"（chat 已不可用）', toml.includes('wire_api = "responses"'));
    expect('base_url 用机器人自己的接口', toml.includes('base_url = "http://127.0.0.1:5199/v1"'));
    expect('API Key 走 http_headers，不进命令行', toml.includes('"authorization" = "Bearer mock-key"'));
    expect('模型写进 config', toml.includes('model = "mock-model"'));
    expect('不许出现 user 配置里的 model_provider=custom', !toml.includes('custom'));
    const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    expect('人设进 AGENTS.md', agents.includes('你是测试机器人'));
    expect('AGENTS.md 带上身份说明', agents.includes('【身份】'));
    await rt.stop();
  } else {
    ok('跳过配置翻译检查（没装 Codex）', true);
  }
}

console.log('=== 4. 事件映射（JSONL → winbot 事件） ===');
{
  const bot = getBot(botId);
  const events = [];
  const rt = new CodexRuntime(bot, { emit: (id, ev) => events.push(ev) });
  rt.bot = bot;
  const ctx = {
    conversationId: 'conv-1',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    presented: [],
    toolNames: new Map(),
    finalText: '',
    threadId: null,
    failed: null,
    toolSeq: 0,
  };
  const feed = (obj) => rt.onLine(JSON.stringify(obj), ctx, null);

  feed({ type: 'thread.started', thread_id: 'thread-abc' });
  expect('thread.started → 记住线程 id', ctx.threadId === 'thread-abc');

  feed({ type: 'item.completed', item: { type: 'agent_message', text: '第一段' } });
  feed({ type: 'item.completed', item: { type: 'agent_message', text: '最终答复' } });
  expect('agent_message → assistant-step 事件', events.filter((e) => e.type === 'assistant-step').length === 2);
  expect('最终答复取最后一条', ctx.finalText === '最终答复');

  feed({ type: 'item.completed', item: { type: 'command_execution', command: 'dir', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } });
  const toolCall = events.find((e) => e.type === 'tool-call');
  const toolResult = events.find((e) => e.type === 'tool-result');
  expect('command_execution → tool-call（执行命令）', toolCall?.name === '执行命令', toolCall?.name);
  expect('command_execution → tool-result 不报错', toolResult && toolResult.isError === false);

  events.length = 0;
  feed({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'outputs/a.md', kind: 'add' }], status: 'failed' } });
  const failedResult = events.find((e) => e.type === 'tool-result');
  expect('失败的 file_change 标成 isError', failedResult?.isError === true);

  feed({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
  expect('usage 累加进 ctx', ctx.usage.inputTokens === 100 && ctx.usage.outputTokens === 7 && ctx.usage.cacheReadTokens === 40);

  feed({ type: 'turn.failed', error: { message: '模型拒绝了' } });
  expect('turn.failed → ctx.failed', ctx.failed === '模型拒绝了');

  // 「Model metadata not found」是警告不是失败
  ctx.failed = null;
  feed({ type: 'error', message: 'Model metadata for `mock-model` not found. Defaulting to fallback metadata' });
  expect('model metadata 警告不当失败', ctx.failed === null);

  // 非 JSON 行不能把整轮带崩
  expect('坏行被忽略', rt.onLine('not json at all', ctx, null) === undefined);
}

console.log('=== 5. 引擎字段与默认值 ===');
{
  const { createBot } = await import('../src/bots.js');
  const b = createBot({ name: '老机器人', engine: undefined });
  expect('没写 engine 默认 dsh', b.engine === 'dsh', b.engine);
  const b2 = createBot({ name: 'Codex机器人', engine: 'codex' });
  expect('写 codex 保留 codex', b2.engine === 'codex', b2.engine);
  const b3 = createBot({ name: '乱写引擎', engine: 'whatever' });
  expect('非法 engine 回落到 dsh', b3.engine === 'dsh');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
