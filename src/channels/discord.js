// Discord：Gateway over WebSocket（不需要公网地址）。填 Bot Token 即可。
// 只处理单聊与频道里的消息；忽略机器人自己和别的机器人。
import { loadConfig } from '../config.js';
import { log, logWarn, sleep, truncate } from '../util.js';
import { MiniWebSocket } from './ws.js';
import { handleApprovalReply, handleIncoming } from './core.js';
import { shouldHandleChannelMessage } from './mention.js';

const API = 'https://discord.com/api/v10';
const MAX_LEN = 1900;
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

function splitText(text, max = MAX_LEN) {
  const out = [];
  let s = String(text ?? '');
  while (s.length > max) {
    let cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s.trim()) out.push(s);
  return out;
}

export class DiscordChannel {
  constructor() {
    this.name = 'discord';
    this.running = false;
    this.ws = null;
    this.seq = null;
    this.heartbeat = null;
    this.sessionId = null;
    this.resumeUrl = null;
  }

  configured() {
    const c = loadConfig().channels.discord || {};
    return !!c.enabled && !!c.token;
  }

  token() {
    return loadConfig().channels.discord?.token || '';
  }

  async api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token()}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `Discord ${method} ${path} 失败（${res.status}）`);
    return json;
  }

  /** 定时任务主动发消息：target 是 channel id */
  async deliver(target, text) {
    for (const chunk of splitText(text)) await this.api('POST', `/channels/${target}/messages`, { content: chunk });
  }

  async start() {
    if (!this.configured()) return false;
    this.running = true;
    this.connect().catch((e) => logWarn('discord', `connect failed: ${e?.message || e}`));
    log('discord', 'gateway connecting');
    return true;
  }

  async stop() {
    this.running = false;
    clearInterval(this.heartbeat);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  async gatewayUrl() {
    try {
      const g = await this.api('GET', '/gateway/bot');
      return g?.url ? `${g.url}/?v=10&encoding=json` : 'wss://gateway.discord.gg/?v=10&encoding=json';
    } catch (e) {
      logWarn('discord', `gateway/bot failed: ${e?.message || e}`);
      return 'wss://gateway.discord.gg/?v=10&encoding=json';
    }
  }

  async connect() {
    let backoff = 1000;
    while (this.running) {
      const url = this.resumeUrl || (await this.gatewayUrl());
      this.resumeUrl = null;
      try {
        await this.runSocket(url);
        backoff = 1000;
      } catch (e) {
        if (!this.running) break;
        logWarn('discord', `socket ended: ${e?.message || e}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  runSocket(url) {
    return new Promise((resolve) => {
      const ws = new MiniWebSocket(url);
      this.ws = ws;
      let done = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearInterval(this.heartbeat);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(reason);
      };
      ws.on('open', () => log('discord', 'websocket connected'));
      ws.on('error', (e) => {
        logWarn('discord', `ws error: ${e?.message || e}`);
        finish(e);
      });
      ws.on('close', () => finish(new Error('closed')));
      ws.on('message', (raw) => {
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.s !== null && m.s !== undefined) this.seq = m.s;
        switch (m.op) {
          case 10: {
            const interval = m.d?.heartbeat_interval || 41250;
            this.heartbeat = setInterval(() => {
              try {
                ws.send(JSON.stringify({ op: 1, d: this.seq }));
              } catch {
                /* ignore */
              }
            }, interval);
            this.heartbeat.unref?.();
            if (this.sessionId && this.seq !== null) {
              ws.send(JSON.stringify({ op: 6, d: { token: this.token(), session_id: this.sessionId, seq: this.seq } }));
            } else {
              ws.send(
                JSON.stringify({
                  op: 2,
                  d: { token: this.token(), intents: INTENTS, properties: { os: 'windows', browser: 'winbot', device: 'winbot' } },
                }),
              );
            }
            break;
          }
          case 11:
            break;
          case 1:
            try {
              ws.send(JSON.stringify({ op: 1, d: this.seq }));
            } catch {
              /* ignore */
            }
            break;
          case 7:
            finish(new Error('reconnect requested'));
            break;
          case 9:
            this.sessionId = null;
            this.seq = null;
            finish(new Error('invalid session'));
            break;
          case 0:
            this.onDispatch(m.t, m.d).catch((e) => logWarn('discord', `dispatch failed: ${e?.message || e}`));
            break;
          default:
            break;
        }
      });
    });
  }

  async onDispatch(type, data) {
    if (type === 'READY') {
      this.sessionId = data?.session_id || null;
      this.botId = data?.user?.id || '';
      log('discord', `ready as ${data?.user?.username || '?'} (${this.botId})`);
      return;
    }
    if (type === 'RESUMED') {
      log('discord', 'resumed');
      return;
    }
    if (type !== 'MESSAGE_CREATE') return;
    if (!data || data.author?.bot || data.webhook_id) return;
    const text = String(data.content || '').trim();
    if (!text) return;
    const senderId = String(data.author?.id || '');
    // 服务器频道里只在被 @ 或发命令时接；私聊照常
    const gate = shouldHandleChannelMessage({
      platform: 'discord',
      text,
      selfId: this.botId,
      isDM: !data.guild_id,
    });
    if (!gate.handle) return;
    const channelId = data.channel_id;
    const reply = async (t) => {
      for (const chunk of splitText(t)) await this.api('POST', `/channels/${channelId}/messages`, { content: chunk });
    };
    try {
      if (await handleApprovalReply(this.name, senderId, gate.text, reply)) return;
      await handleIncoming({
        channel: this.name,
        senderId,
        senderName: data.author?.username || senderId,
        text: gate.text,
        reply,
      });
    } catch (e) {
      logWarn('discord', `handle failed: ${e?.message || e}`);
      try {
        await reply(truncate(`出错了：${e?.message || e}`, 1500));
      } catch {
        /* ignore */
      }
    }
  }
}


