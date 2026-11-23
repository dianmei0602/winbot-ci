// 验证「工作区外写入 → 审批」链路。
// 用法: node test/probe-approval.mjs <botId> [allow|deny]
import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const botId = process.argv[2] || 'bot-32fc0226d24f';
const decision = process.argv[3] === 'allow' ? 'allowed-once' : 'rejected';
const root = 'E:/AI_work/winbot';
const home = path.join(root, 'data', 'dsh', botId);
const ws = path.join(root, 'data', 'bots', botId, 'workspace');
const patch = path.join(home, 'winbot.patch.yml');
const outside = path.join(root, 'outside-test.txt');
fs.rmSync(outside, { force: true });

const harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome: home,
  patches: [patch],
  cwd: ws,
  env: { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: 'workspace-write', WINBOT_KEY_MOCK: 'mock-key' },
  provider: 'mock',
  model: 'mock-model',
  approvalRequests: true,
  onUserQuestion: async () => ({ cancelled: true }),
  initializeTimeoutMs: 30_000,
});

let sawApproval = false;
harness.client.start();
harness.client.onRequest(async (method, params) => {
  if (method !== 'approval/request') return {};
  sawApproval = true;
  console.log('>>> 收到审批请求:', JSON.stringify(params));
  console.log('>>> 决定:', decision);
  return { outcome: decision };
});

try {
  await harness.start();
  const session = harness.session();
  const result = await session.run('OUTSIDE 把这个写到工作区外面', {
    onNotification: (n) => {
      if (n.method !== 'session.event') return;
      const ev = n.params.event;
      if (ev.type === 'tool/result') {
        console.log('TOOL RESULT isError=', ev.data.message?.isError, JSON.stringify(ev.data.message?.content || []).slice(0, 400));
      }
      if (ev.type === 'assistant/message') {
        const t = (ev.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (t) console.log('ASSISTANT:', t.slice(0, 200));
      }
    },
  });
  console.log('=== 结果 ===');
  console.log('sawApproval =', sawApproval);
  console.log('finalResponse =', result.finalResponse);
  console.log('outside file exists =', fs.existsSync(outside));
} catch (e) {
  console.error('FAILED:', e?.message || e);
} finally {
  await harness.close();
}
