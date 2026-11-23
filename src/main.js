// winbot 入口：起本地控制台 + 渠道适配器，等用户来聊天。
import { ensureDirs, log, logWarn, logError, DATA_DIR } from './util.js';
import { loadConfig, modelChoices, builtinProviders } from './config.js';
import { openDb, expireApprovals, closeDb, danglingUserConversations, addMessage } from './db.js';
import { listBots } from './bots.js';
import { startServer } from './server.js';
import { startChannels, stopChannels, channelStatus } from './channels/index.js';
import { stopAll } from './dsh.js';
import { startScheduler, stopScheduler } from './schedules.js';

const SHUTDOWN_TIMEOUT_MS = 8000;

async function main() {
  ensureDirs();
  openDb();
  // 本机 DSH 登录过 DeepSeek 的话，账号接口自动出现在可选列表里，用户不用再填一次 Key
  const builtins = builtinProviders();
  if (builtins.length) log('main', `内置接口可用：${builtins.map((p) => `${p.name}（${p.models.join(', ')}）`).join('；')}`);
  const cfg = loadConfig();
  log('main', `data dir: ${DATA_DIR}`);
  log('main', `bots: ${listBots().length}, providers: ${cfg.providers.length + builtins.length}, models ready: ${modelChoices().length}`);

  // 上次没处理完的审批，启动时作废，避免界面挂着假待办
  expireApprovals('应用重启，审批作废');
  // 上次发出去但没等到回复的消息：在原会话里说一声，别让它沉默
  const dangling = danglingUserConversations();
  for (const c of dangling) {
    addMessage({
      conversationId: c.id,
      role: 'note',
      content: '上次这条消息没处理完（应用退出或崩溃了），麻烦重发一次。',
      meta: { recovered: true },
    });
  }
  if (dangling.length) log('main', `补了 ${dangling.length} 条未完成的提示`);

  let url;
  try {
    ({ url } = await startServer());
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      log('main', '端口被占用：可能已经有一个 winbot 在跑。先关掉它，或设置 WINBOT_PORT 换一个端口。');
      process.exit(1);
    }
    throw e;
  }
  await startChannels();
  startScheduler();

  const ch = channelStatus();
  const up = Object.entries(ch)
    .filter(([, v]) => v.running)
    .map(([k]) => k);
  log('main', up.length ? `channels up: ${up.join(', ')}` : '没有已连接的聊天渠道（可以在控制台的「渠道」里接）');
  log('main', '');
  log('main', `  打开控制台：${url}`);
  log('main', '');

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log('main', `shutting down (${signal})…`);
    const timer = setTimeout(() => {
      logWarn('main', 'shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
    try {
      stopScheduler();
      await stopChannels();
      await stopAll();
      expireApprovals('应用退出，审批作废');
      closeDb();
    } catch (e) {
      logError('main', `shutdown error: ${e?.message || e}`);
    }
    clearTimeout(timer);
    log('main', 'bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logError('main', `unhandled rejection: ${e?.stack || e}`));
  process.on('uncaughtException', (e) => logError('main', `uncaught: ${e?.stack || e}`));
}

main().catch((e) => {
  logError('main', e?.stack || String(e));
  process.exit(1);
});


