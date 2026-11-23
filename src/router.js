// 群聊里「谁该接这句话」：
//   规则：按机器人名字/简介/人设和消息的关键词重合度打分（不打模型，零成本）
//  模型：让一个小模型从成员里挑一个（失败就退回规则）
import { loadConfig, providerById, defaultProvider, providerReady } from './config.js';
import { readDshDeepSeekToken } from './dsh-account.js';
import { log } from './util.js';

const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '在', '和', '就', '也', '都', '这', '那', '吗', '呢', '吧', '一下', '一个', '帮我', '看看', '什么', '怎么', '可以', '这个', '那个']);

/** 把一段话切成可用于匹配的词（中文按 2 字滑窗，英文按单词） */
function keywords(text) {
  const raw = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of raw.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length > 1 && !STOP.has(w)) out.add(w);
      continue;
    }
    // 中文：2-4 字 n-gram
    for (let n = 2; n <= Math.min(4, w.length); n += 1) {
      for (let i = 0; i + n <= w.length; i += 1) {
        const g = w.slice(i, i + n);
        if (!STOP.has(g)) out.add(g);
      }
    }
  }
  return [...out];
}

/** 规则路由：谁的关键词命中多就归谁 */
export function routeByRules({ text, members, lastSpeakerId }) {
  const words = keywords(text);
  if (!members.length) return { bot: null, reason: 'no-members' };
  if (members.length === 1) return { bot: members[0], reason: 'only-member' };
  let best = null;
  let bestScore = 0;
  for (const m of members) {
    const hay = `${m.summary || ''} ${m.persona || ''}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length >= 3 ? 2 : 1;
    // 名字被直接叫到，权重高
    if (m.name && text.includes(m.name)) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (best && bestScore > 0) return { bot: best, reason: `rules:${bestScore}` };
  const last = members.find((m) => m.id === lastSpeakerId);
  return { bot: last || members[0], reason: last ? 'rules:last-speaker' : 'rules:first-member' };
}

function pickProvider() {
  const cfg = loadConfig();
  const preferred = defaultProvider();
  const candidates = [preferred, ...(cfg.providers || [])].filter(Boolean);
  for (const p of candidates) {
    if (!providerReady(p)) continue;
    if (p.id === 'deepseek-account') return p;
    if (p.apiKey && (p.baseURL || p.baseUrl)) return p;
  }
  return null;
}

function chatUrl(p) {
  const base = String(p.baseURL || p.baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

async function callModel(p, messages, { model, maxTokens = 40, timeoutMs = 8000 } = {}) {
  const url = chatUrl(p);
  if (!url) throw new Error('provider 没有 baseUrl');
  const headers = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  else if (p.id === 'deepseek-account') {
    const tok = readDshDeepSeekToken();
    if (!tok) throw new Error('没有本机 DSH 登录态');
    headers['x-dsh-auth-token'] = tok;
  } else throw new Error(`provider ${p.id} 没有可用凭据`);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content || '');
}

/** 模型路由：让它选一个成员；任何失败都退回规则 */
export async function routeByModel({ text, members, lastSpeakerId }) {
  const fallback = routeByRules({ text, members, lastSpeakerId });
  if (members.length <= 1) return fallback;
  const p = pickProvider();
  if (!p) return { ...fallback, reason: `${fallback.reason} (no provider)` };
  const model = (p.models || [])[0];
  if (!model) return fallback;
  const roster = members.map((m, i) => `${i + 1}. ${m.name} — ${m.summary || '（没有简介）'}`).join('\n');
  try {
    const reply = await callModel(p, [
      {
        role: 'system',
        content:
          `你是群聊的路由器。群成员：\n${roster}\n\n` +
          '根据用户这句话的主题，选出最该回应的成员。只输出 JSON：{"index": 序号, "reason": "一句话"}。不要输出别的。',
      },
      { role: 'user', content: String(text || '').slice(0, 500) },
    ], { model, maxTokens: 60 });
    const m = reply.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const idx = Number(parsed?.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= members.length) {
      return { bot: members[idx - 1], reason: `model:${String(parsed?.reason || '').slice(0, 40)}` };
    }
    return { ...fallback, reason: `${fallback.reason} (bad model reply)` };
  } catch (e) {
    log('router', `model route failed: ${e?.message || e}`);
    return { ...fallback, reason: `${fallback.reason} (model failed)` };
  }
}

export async function routeGroupMessage({ text, members, lastSpeakerId, mode = 'rules' }) {
  if (mode === 'model') return routeByModel({ text, members, lastSpeakerId });
  return routeByRules({ text, members, lastSpeakerId });
}


