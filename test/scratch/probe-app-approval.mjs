// 通过 winbot 控制台 API 验证审批链路：发消息 → SSE 收到 approval → POST 批准 → 文件落地。
// 用法: node test/probe-app-approval.mjs <botId> [allow|deny]
import fs from 'node:fs';

const botId = process.argv[2] || 'bot-32fc0226d24f';
const allow = (process.argv[3] || 'allow') !== 'deny';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const outside = 'E:/AI_work/winbot/outside-test.txt';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

fs.rmSync(outside, { force: true });
// 每轮新会话，避免历史干扰
const { conversation } = await call('POST', `/api/bots/${botId}/conversations`, {});
console.log('conversation:', conversation.id);

// 先订阅 SSE
const events = [];
const es = await fetch(`${BASE}/api/conversations/${conversation.id}/events?token=${encodeURIComponent(token)}`);
const reader = es.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const pump = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        console.log('SSE', ev.type, ev.approval ? `${ev.approval.tool} ${ev.approval.id}` : ev.name || '');
      } catch {
        /* ignore */
      }
    }
  }
})();

await call('POST', `/api/conversations/${conversation.id}/send`, { text: 'OUTSIDE 把这个写到工作区外面' });
console.log('sent');

// 等审批事件
const deadline = Date.now() + 120_000;
let approval = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  approval = events.find((e) => e.type === 'approval')?.approval;
  if (approval) break;
}
if (!approval) {
  console.log('FAIL: 没等到审批事件');
  process.exitCode = 1;
} else {
  console.log('approval:', JSON.stringify(approval));
  const r = await call('POST', `/api/approvals/${approval.id}`, { allow });
  console.log('approval result:', JSON.stringify(r));
}

// 等最终回复
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const data = await call('GET', `/api/conversations/${conversation.id}`);
  const assistant = data.messages.filter((m) => m.role === 'assistant').at(-1);
  if (assistant) {
    console.log('assistant:', assistant.content);
    break;
  }
}
const data = await call('GET', `/api/conversations/${conversation.id}`);
console.log('messages:', data.messages.map((m) => `[${m.role}] ${m.content.slice(0, 80)}`).join('\n  '));
console.log('outside file exists =', fs.existsSync(outside));
es.body.cancel?.().catch(() => {});
process.exit(0);
