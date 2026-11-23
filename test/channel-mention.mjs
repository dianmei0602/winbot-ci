// Slack / Discord 的 @ 收敛单测（不需要网络）。
import { shouldHandleChannelMessage, stripDiscordMention, stripSlackMention } from '../src/channels/mention.js';

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

console.log('=== 私聊 ===');
{
  const r = shouldHandleChannelMessage({ platform: 'slack', text: '你好', selfId: 'U0BOT', isDM: true });
  check('私聊全接', r.handle === true, JSON.stringify(r.text));
}

console.log('=== Slack 频道 ===');
{
  const no = shouldHandleChannelMessage({ platform: 'slack', text: '今天发版吗', selfId: 'U0BOT', isDM: false });
  check('没 @ 不接', no.handle === false);

  const yes = shouldHandleChannelMessage({ platform: 'slack', text: '<@U0BOT> 看下这个报错', selfId: 'U0BOT', isDM: false });
  check('@ 了就接', yes.handle === true);
  check('@ 被去掉', yes.text === '看下这个报错', JSON.stringify(yes.text));

  const cmd = shouldHandleChannelMessage({ platform: 'slack', text: '/help', selfId: 'U0BOT', isDM: false });
  check('命令不用 @', cmd.handle === true, JSON.stringify(cmd.text));

  const unknown = shouldHandleChannelMessage({ platform: 'slack', text: '<@U0BOT> hi', selfId: '', isDM: false });
  check('不知道自己 id 时保守不接', unknown.handle === false);
}

console.log('=== Discord 频道 ===');
{
  const no = shouldHandleChannelMessage({ platform: 'discord', text: '随便聊聊', selfId: '123', isDM: false });
  check('没 @ 不接', no.handle === false);

  const yes = shouldHandleChannelMessage({ platform: 'discord', text: '<@123> 帮我查下', selfId: '123', isDM: false });
  check('<@id> 能认', yes.handle === true && yes.text === '帮我查下', JSON.stringify(yes.text));

  const nick = shouldHandleChannelMessage({ platform: 'discord', text: '<@!123> 在吗', selfId: '123', isDM: false });
  check('<@!id>（昵称形式）也能认', nick.handle === true && nick.text === '在吗', JSON.stringify(nick.text));
}

console.log('=== 去 @ 的纯函数 ===');
check('Slack 连续 @ 都清掉', stripSlackMention('<@U1> <@U1> 你好', 'U1') === '你好', JSON.stringify(stripSlackMention('<@U1> <@U1> 你好', 'U1')));
check('Discord 两种写法都清掉', stripDiscordMention('<@1> <@!1> hi', '1') === 'hi', JSON.stringify(stripDiscordMention('<@1> <@!1> hi', '1')));

process.exit(bad ? 1 : 0);
