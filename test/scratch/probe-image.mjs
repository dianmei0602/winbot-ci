// 验证 DSH SDK 的图片输入：把一张 PNG 作为 image 内容块发进去，看模型能不能读出来。
import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const botId = 'bot-32fc0226d24f';
const root = 'E:/AI_work/winbot';
const home = path.join(root, 'data', 'dsh', botId);
const ws = path.join(root, 'data', 'bots', botId, 'workspace');
const patch = path.join(home, 'winbot.patch.yml');
const img = 'E:/AI_work/winbot/data/vision-test.png';

const data = fs.readFileSync(img).toString('base64');
console.log('image bytes:', data.length);

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
harness.client.onRequest(async () => ({ outcome: 'rejected' }));

try {
  await harness.start();
  const session = harness.session();
  const result = await session.run(
    [
      { type: 'text', text: '这张图里写的编号和 code 是什么？只回答这两项，用「编号 / code」的格式。' },
      { type: 'image', data, mimeType: 'image/png', name: 'vision-test.png' },
    ],
    {
      onNotification: (n) => {
        if (n.method !== 'session.event') return;
        const ev = n.params.event;
        if (ev.type === 'user/message') {
          const blocks = (ev.data.content || []).map((b) => b.type);
          console.log('user/message blocks:', blocks.join(','));
        }
        if (ev.type === 'turn/end') console.log('turn/end:', JSON.stringify(ev.data.reason));
        if (ev.type === 'assistant/message') {
          const t = (ev.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (t) console.log('assistant:', t.slice(0, 300));
        }
      },
    },
  );
  console.log('finalResponse:', result.finalResponse);
} catch (e) {
  console.error('FAILED:', e?.message || e);
} finally {
  await harness.close();
}
