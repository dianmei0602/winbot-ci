// winbot 的记忆工具插件：remember / forget / recall，写的是宿主那份共享的「关于我」。
// 通过 dsh.js 生成的补丁插进每个机器人的进程；逻辑全在 ../about.js，和界面用的是同一份数据。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { addAbout, listAbout, aboutChars, ABOUT_MAX_CHARS, removeAbout } from '../about.js';

export const name = 'winbot-memory';
export const inject = ['tools'];

const textOut = (text) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
});

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'remember',
      description:
        'Save a durable fact about the user to the shared "about me" memory that every robot can see. ' +
        'Use it for stable preferences, habits, background, ongoing projects — not for transient task details. ' +
        'Contacts and addresses need the user\'s confirmation first (retry with confirm_sensitive=true only after they agree). ' +
        'Never use it for passwords, keys, or tokens.',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: 'One short sentence, written in third person, e.g. "他偏好简洁的回答，不喜欢客套".',
        },
        confirm_sensitive: {
          type: 'boolean',
          description: 'Set true only after the user explicitly agreed to save contact details or an address.',
        },
      },
      output: textOut('ok'),
      execute(args) {
        const r = addAbout({ text: args.text, source: 'chat', confirmSensitive: args.confirm_sensitive === true });
        if (!r.ok) return { text: `没有保存：${r.reason || '未知原因'}` };
        const used = aboutChars();
        const suffix = r.duplicate ? '（这条之前已经记过了）' : '';
        return { text: `已记住${suffix}。关于我现在 ${used}/${ABOUT_MAX_CHARS} 字。` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'forget',
      description:
        'Remove remembered facts about the user from the shared "about me" memory. ' +
        'Match by a substring of the saved line, or by its id.',
      parameters: {
        query: { type: 'string', description: 'A substring of the fact to forget.' },
        id: { type: 'string', description: 'Exact id, when the user quoted one.' },
      },
      output: textOut('ok'),
      execute(args) {
        const n = removeAbout({ id: args.id, query: args.query });
        return { text: n > 0 ? `删掉了 ${n} 条。` : '没有匹配到要忘掉的内容。' };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'recall_about_me',
      description: 'Read everything currently remembered about the user in the shared "about me" memory.',
      parameters: {},
      output: textOut('ok'),
      execute() {
        const lines = listAbout();
        if (!lines.length) return { text: '关于我：还没有记录。' };
        return {
          text: ['关于我（共享记忆）：', ...lines.map((l) => `- ${l.text}`)].join('\n'),
        };
      },
    }),
  );
}
