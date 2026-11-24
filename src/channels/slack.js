// Slack：Socket Mode（App Token 开连接，Bot Token 收发消息），不需要公网地址。
import { loadConfig } from '../config.js';
import { log, logWarn, sleep, truncate } from '../util.js';
import { MiniWebSocket } from './ws.js';
import { handleApprovalReply, handleIncoming } from './core.js';
import { shouldHandleChannelMessage } from './mention.js';

const SLACK_API = 'https://slack.com/api';
const MAX_LEN = 3800;

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

export class SlackChannel {
  constructor() {
    this.name = 'slack';
    this.running = false;
    this.ws = null;
    this.heartbeat = null;
  }

  configured() {
    const c = loadConfig().channels.slack || {};
    return !!c.enabled && !!c.appToken && !!c.botToken;
  }

  async post(method, body) {
    const c = loadConfig().channels.slack || {};
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${c.botToken}`,
      },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.error || `Slack ${method} 失败`);
    return json;
  }

  /** 定时任务主动发消息：target 是 channel id */
  async deliver(target, text) {
    for (const chunk of splitText(text)) await this.post('chat.postMessage', { channel: target, text: chunk });
  }

  async start() {
    if (!this.configured()) return false;
    this.running = true;
    // 记下自己的 user id：频道里只有被 @ 到才接
    try {
      const me = await this.post('auth.test', {});
      this.botUserId = me.user_id || '';
      log('slack', `bot=${me.user || this.botUserId}`);
    } catch (e) {
      logWarn('slack', `auth.test failed: ${e?.message || e}`);
    }
    this.connect().catch((e) => logWarn('slack', `connect failed: ${e?.message || e}`));
    log('slack', 'socket mode starting');
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

  async connect() {
    let backoff = 1000;
    while (this.running) {
      try {
        const c = loadConfig().channels.slack || {};
        const res = await fetch(`${SLACK_API}/apps.connections.open`, {
          method: 'POST',
          headers: { authorization: `Bearer ${c.appToken}` },
        });
        const json = await res.json().catch(() => ({}));
        if (!json.ok || !json.url) throw new Error(json.error || '拿不到 Socket Mode 地址');
        await this.openSocket(json.url);
        backoff = 1000;
      } catch (e) {
        if (!this.running) break;
        logWarn('slack', `connection failed: ${e?.message || e}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  openSocket(url) {
    return new Promise((resolve) => {
      const ws = new MiniWebSocket(url);
      this.ws = ws;
      let ready = false;
      const settle = () => {
        if (!ready) {
          ready = true;
          resolve();
        }
      };
      ws.on('open', () => log('slack', 'websocket connected'));
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        this.onMessage(msg).catch((e) => logWarn('slack', `handle failed: ${e?.message || e}`));
      });
      ws.on('error', (e) => {
        logWarn('slack', `ws error: ${e?.message || e}`);
        settle();
      });
      ws.on('close', () => {
        clearInterval(this.heartbeat);
        log('slack', 'websocket closed');
        settle();
      });
      // hello 之后开始心跳
      this.heartbeat = setInterval(() => {
        if (ws.closed) return;
        try {
          if (this.lastEnvelopeId) ws.send(JSON.stringify({ type: 'ping', id: Date.now() }));
        } catch {
          /* ignore */
        }
      }, 30_000);
      this.heartbeat.unref?.();
      setTimeout(settle, 20_000).unref?.();
    });
  }

  async onMessage(msg) {
    if (msg.type === 'hello') return;
    if (msg.type === 'disconnect') {
      logWarn('slack', `server asked reconnect: ${msg.reason}`);
      this.ws?.close();
      return;
    }
    if (msg.type !== 'events_api' || !msg.envelope_id) return;
    this.lastEnvelopeId = msg.envelope_id;
    // 立刻 ack，避免 Slack 重投
    this.ws?.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    const ev = msg.payload?.event || {};
    if (ev.type !== 'message' || ev.bot_id || ev.subtype) return;
    const text = String(ev.text || '').trim();
    if (!text) return;
    // 频道里只在被 @ 或发命令时接；私聊（im）照常
    const gate = shouldHandleChannelMessage({
      platform: 'slack',
      text,
      selfId: this.botUserId,
      isDM: ev.channel_type === 'im',
    });
    if (!gate.handle) return;
    const channelId = ev.channel;
    const senderId = ev.user || 'unknown';
    const reply = async (t) => {
      for (const chunk of splitText(t)) await this.post('chat.postMessage', { channel: channelId, text: chunk });
    };
    try {
      if (await handleApprovalReply(this.name, senderId, gate.text, reply)) return;
      await handleIncoming({ channel: this.name, senderId, senderName: senderId, text: gate.text, reply });
    } catch (e) {
      logWarn('slack', `handle failed: ${e?.message || e}`);
      try {
        await reply(truncate(`出错了：${e?.message || e}`, 1500));
      } catch {
        /* ignore */
      }
    }
  }
}

