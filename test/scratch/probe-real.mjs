// 用真实 DeepSeek 账号接口跑一轮，把错误完整打出来。
import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const botId = process.argv[2] || 'bot-32fc0226d24f';
const root = 'E:/AI_work/winbot';
const home = path.join(root, 'data', 'dsh', botId);
const ws = path.join(root, 'data', 'bots', botId, 'workspace');
const patch = path.join(home, 'winbot.patch.yml');
console.log('patch:', fs.existsSync(patch));

const harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome: home,
  patches: [patch],
  cwd: ws,
  env: { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write' },
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  approvalRequests: true,
  onUserQuestion: async () => ({ cancelled: true }),
  initializeTimeoutMs: 30_000,
});

harness.client.start();
harness.client.onRequest(async (method) => {
  console.log('>>> approval request', method);
  return { outcome: 'rejected' };
});

try {
  await harness.start();
  console.log('started');
  const session = harness.session();
  const result = await session.run('用一句话介绍你自己', {
    onNotification: (n) => {
      if (n.method === 'session.event') {
        const ev = n.params.event;
        if (['turn/end', 'assistant/message', 'tool/call', 'tool/result', 'assistant/attempt'].includes(ev.type)) {
          console.log('EV', ev.type, JSON.stringify(ev.data).slice(0, 800));
        }
      } else if (n.method !== 'session.status') {
        console.log('NOTIFY', n.method, JSON.stringify(n.params).slice(0, 400));
      }
    },
  });
  console.log('=== finalResponse ===');
  console.log(result.finalResponse);
  console.log('finishReason:', result.finishReason);
} catch (e) {
  console.error('FAILED:', e?.message || e);
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
} finally {
  await harness.close();
}
