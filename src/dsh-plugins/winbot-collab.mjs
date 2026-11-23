// 机器人互派：把一件具体的活交给另一个机器人，拿回它的结论。
// 目标机器人用自己的模型、权限和工作区；发起方负责核对后转述给用户。
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'winbot-collab';
export const inject = ['tools'];

const HOST = process.env.WINBOT_HOST || 'http://127.0.0.1:5178';
const TOKEN = process.env.WINBOT_UI_TOKEN || '';
const BOT_ID = process.env.WINBOT_BOT_ID || '';

const textOut = (text) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a, v) => [{ type: 'text', text: v.text }],
});

async function host(path, init = {}) {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}：${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'list_other_bots',
      description: 'List the other robots on this machine (name and one-line summary), so you know who can take a task.',
      parameters: {},
      output: textOut('ok'),
      async execute() {
        const bots = await host('/api/bots');
        const others = bots.filter((b) => b.id !== BOT_ID);
        if (!others.length) return { text: '这台电脑上只有你自己，没有别的机器人可以分工。' };
        return { text: ['可以分工的机器人：', ...others.map((b) => `- ${b.name}（id: ${b.id}）：${b.summary || '没有简介'}`)].join('\n') };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ask_another_bot',
      description:
        'Hand one concrete task to another robot and get its answer back. It works with its own model, permissions and workspace, ' +
        'and cannot see this conversation — so restate everything it needs. Then check its answer before telling the user. ' +
        'Use it when another robot is clearly better suited, or to split a job.',
      parameters: {
        bot: { type: 'string', required: true, description: '另一个机器人的名字或 id。' },
        task: {
          type: 'string',
          required: true,
          description: '完整、自包含的任务描述：背景、要做什么、输出成什么样。不要写「上面那个」。',
        },
      },
      output: textOut('ok'),
      async execute(args) {
        const r = await host('/api/handoff', {
          method: 'POST',
          body: JSON.stringify({ fromBotId: BOT_ID, toBot: args.bot, task: args.task }),
        });
        return {
          text: `「${r.botName}」的回复：\n\n${r.text || '（它没有产出文字）'}\n\n（它的工作记录在会话 ${r.conversationId}，你看不到内容，只有这段结论。）`,
        };
      },
    }),
  );
}
