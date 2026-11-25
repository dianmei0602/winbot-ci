// Telegram：长轮询（不需要公网地址）。填 Bot Token 即可。
import { loadConfig } from '../config.js';
import { getState, setState } from '../db.js';
import { log, logWarn, sleep } from '../util.js';
import { handleApprovalReply, handleIncoming } from './core.js';

const API = 'https://api.telegram.org';
const MAX_LEN = 3900;

/**
 * 群里要不要接这条消息：只在被 @ 或回复机器人时接；私聊全接。
 * 顺便把 @机器人 从文本里去掉，并把群 id 带出去（群共享一条会话）。
 */
export function shouldHandleTelegramMessage(msg, username) {
  const chat = msg?.chat || {};
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const raw = String(msg?.text ?? msg?.caption ?? '');
  if (!isGroup) return { handle: true, text: raw, groupId: null, isGroup: false };

  const uname = String(username || '');
  const mentioned = uname ? new RegExp(`@${uname}\\b`, 'i').test(raw) : false;
  const repliedToBot = !!(
    uname &&
    msg?.reply_to_message?.from?.username &&
    String(msg.reply_to_message.from.username).toLowerCase() === uname.toLowerCase()
  );
  const isCommand = /^\//.test(raw.trim());
  if (!mentioned && !repliedToBot && !isCommand) return { handle: false, text: '', groupId: String(chat.id), isGroup: true };

  let text = raw;
  if (uname) text = text.replace(new RegExp(`@${uname}\\b`, 'ig'), ' ');
  // /help@yourbot -> /help
  text = text.replace(/(^\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/g, '$1').replace(/[ \t]+/g, ' ').trim();
  return { handle: true, text, groupId: String(chat.id), isGroup: true };
}

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

export class TelegramChannel {
  constructor() {
    this.name = 'telegram';
    this.running = false;
    this.token = '';
  }

  configured() {
    const c = loadConfig().channels.telegram || {};
    return !!c.enabled && !!c.token;
  }

  async start() {
    const c = loadConfig().channels.telegram || {};
    if (!c.enabled || !c.token) return false;
    this.token = c.token;
    this.running = true;
    try {
      const me = await this.api('getMe', {});
      this.username = me?.username || '';
      log('telegram', `bot=@${this.username}`);
    } catch (e) {
      logWarn('telegram', `getMe failed: ${e?.message || e}`);
    }
    this.loop().catch((e) => logWarn('telegram', `loop died: ${e?.message || e}`));
    log('telegram', 'long polling started');
    return true;
  }

  async stop() {
    this.running = false;
  }

  async api(method, body, timeoutMs = 60_000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ac.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.description || `Telegram ${method} 失败（HTTP ${res.status}）`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(chatId, text) {
    for (const chunk of splitText(text)) {
      await this.api('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
    }
  }

  /** 定时任务主动发消息：target 是 chat id */
  async deliver(target, text) {
    await this.send(target, text);
  }

  /** 下载一张图片/一个文件到内存（Telegram 给的是 file_id → 临时下载地址） */
  async download(fileId, maxBytes = 25 * 1024 * 1024) {
    const file = await this.api('getFile', { file_id: fileId });
    if (!file?.file_path) return null;
    const res = await fetch(`${API}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`下载文件失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= maxBytes ? buf : null;
  }

  async loop() {
    let backoff = 1000;
    while (this.running) {
      const offset = getState('telegram:offset', 0);
      try {
        const updates = await this.api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 70_000);
        backoff = 1000;
        for (const u of updates || []) {
          setState('telegram:offset', u.update_id + 1);
          const msg = u.message;
          if (!msg) continue;
          const chatId = msg.chat?.id;
          const from = msg.from || {};
          if (from.is_bot) continue;
          const gate = shouldHandleTelegramMessage(msg, this.username);
          if (!gate.handle) continue;
          const text = gate.text;
          // 图片（取最大那张）和文件都下载下来交给机器人
          const media = [];
          try {
            if (Array.isArray(msg.photo) && msg.photo.length) {
              const largest = msg.photo[msg.photo.length - 1];
              const buf = await this.download(largest.file_id);
              if (buf) media.push({ buf, name: `photo-${msg.message_id}.jpg` });
            } else if (msg.document) {
              const buf = await this.download(msg.document.file_id);
              if (buf) media.push({ buf, name: msg.document.file_name || `file-${msg.message_id}` });
            } else if (msg.voice || msg.audio) {
              const f = msg.voice || msg.audio;
              const buf = await this.download(f.file_id);
              if (buf) media.push({ buf, name: `${msg.voice ? 'voice' : 'audio'}-${msg.message_id}.ogg` });
            }
          } catch (e) {
            logWarn('telegram', `download failed: ${e?.message || e}`);
          }
          if (!text.trim() && !media.length) continue;
          const senderId = String(from.id);
          const reply = async (t) => {
            try {
              await this.send(chatId, t);
            } catch (e) {
              logWarn('telegram', `send failed: ${e?.message || e}`);
            }
          };
          try {
            if (await handleApprovalReply(this.name, senderId, text, reply)) continue;
            await handleIncoming({
              channel: this.name,
              senderId,
              senderName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
              text,
              media,
              groupId: gate.groupId,
              reply,
            });
          } catch (e) {
            logWarn('telegram', `handle failed: ${e?.message || e}`);
            await reply(`出错了：${e?.message || e}`);
          }
        }
      } catch (e) {
        if (!this.running) break;
        logWarn('telegram', `poll failed: ${e?.message || e}`);
        await sleep(Math.min(backoff, 30_000));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    log('telegram', 'stopped');
  }
}



