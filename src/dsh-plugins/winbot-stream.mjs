// 把模型输出的 token 增量实时推回宿主（界面）。
//
// DSH 的 SDK 通道只传「整段消息」，但进程内有 `llm/stream` waterfall：
// 每个插件都能拿到 AsyncIterable<StreamChunk>。这里 tee 一份，攒一点就 POST 给宿主，
// 宿主经 SSE 推给界面 —— 于是字是一个一个出来的，不是等整段。
import fs from 'node:fs';
import path from 'node:path';

export const name = 'winbot-stream';
// 接 llm 服务的事件必须先声明依赖（DSH 里监听 llm/stream 的插件都这么做）
export const inject = ['llm'];

const HOST = process.env.WINBOT_HOST || 'http://127.0.0.1:5178';
const TOKEN = process.env.WINBOT_UI_TOKEN || '';
const BOT_ID = process.env.WINBOT_BOT_ID || '';
const DEBUG = process.env.WINBOT_STREAM_DEBUG === '1';
const DEBUG_FILE = path.join(process.env.WINBOT_WORKSPACE || process.cwd(), 'stream-debug.log');

const FLUSH_MS = 90;
const FLUSH_CHARS = 160;

let buffer = '';
let inflight = false;
let timer = null;

function debug(msg) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

async function flush() {
  if (DEBUG) debug(`flush try inflight=${inflight} buf=${buffer.length}`);
  if (inflight || !buffer) return;
  const text = buffer;
  buffer = '';
  inflight = true;
  try {
    const res = await fetch(`${HOST}/api/stream/delta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ botId: BOT_ID, text }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) debug(`delta HTTP ${res.status}`);
    else debug(`delta ok ${text.length}`);
  } catch (e) {
    debug(`delta failed: ${e?.message || e}`);
  } finally {
    inflight = false;
    if (buffer && !timer) schedule();
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
  timer.unref?.();
}

function push(text) {
  buffer += text;
  if (buffer.length >= FLUSH_CHARS) void flush();
  else schedule();
}

export function apply(ctx) {
  debug('apply called');
  ctx.on('llm/stream', (options, next) => {
    debug(`hooked session=${options?.sessionId || '?'}`);
    const inner = next();
    return (async function* teed() {
      try {
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') push(chunk.text);
          yield chunk;
        }
      } finally {
        // 收尾：把剩下的推掉，别丢最后几个字
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await flush().catch(() => {});
      }
    })();
  });
}
