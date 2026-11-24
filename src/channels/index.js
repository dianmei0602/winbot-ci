// 渠道管理：启动/停止各平台适配器，报告状态。
import { loadConfig } from '../config.js';
import { log, logWarn, sleep } from '../util.js';
import { TelegramChannel } from './telegram.js';
import { SlackChannel } from './slack.js';
import { DiscordChannel } from './discord.js';
import { FeishuChannel, WeChatChannel } from './placeholder.js';

const adapters = () => ({
  telegram: (state.telegram ||= new TelegramChannel()),
  slack: (state.slack ||= new SlackChannel()),
  discord: (state.discord ||= new DiscordChannel()),
  feishu: (state.feishu ||= new FeishuChannel()),
  wechat: (state.wechat ||= new WeChatChannel()),
});

const state = {};

export function channelStatus() {
  const cfg = loadConfig();
  const out = {};
  for (const [name, a] of Object.entries(adapters())) {
    const c = cfg.channels[name] || {};
    out[name] = {
      configured: a.configured?.() ?? false,
      enabled: !!c.enabled,
      running: !!a.running,
      owner: c.owner || null,
      lastError: a.lastError || c.lastError || null,
    };
  }
  return out;
}

export async function startChannels() {
  for (const [name, a] of Object.entries(adapters())) {
    if (!a.configured?.()) continue;
    try {
      await a.start();
      log('channels', `${name} started`);
    } catch (e) {
      a.lastError = e?.message || String(e);
      logWarn('channels', `${name} failed: ${a.lastError}`);
    }
  }
}

export async function restartChannels() {
  for (const a of Object.values(adapters())) {
    try {
      await a.stop();
    } catch {
      /* ignore */
    }
  }
  await sleep(200);
  await startChannels();
}

export async function startOne(name) {
  const a = adapters()[name];
  if (!a) return false;
  if (!a.configured?.()) {
    a.lastError = '还没填好凭证或没启用';
    return false;
  }
  try {
    await a.stop();
  } catch {
    /* ignore */
  }
  await a.start();
  return true;
}

export async function stopChannels() {
  for (const a of Object.values(adapters())) {
    try {
      await a.stop();
    } catch {
      /* ignore */
    }
  }
}

/** 定时任务/主动消息用：往某个渠道的指定会话发一条 */
export async function deliverToChannel(channel, target, text) {
  const a = adapters()[channel];
  if (!a) throw new Error(`没有渠道 ${channel}`);
  if (typeof a.deliver !== 'function') throw new Error(`${channel} 不支持主动发送`);
  if (!a.configured?.()) throw new Error(`${channel} 还没连上`);
  return a.deliver(target, text);
}
