// 频道里「要不要接这条消息」的通用判断：
// 私聊全接；频道里只有被 @ 到、或者发的是命令才接。

const stripSpaces = (s) => s.replace(/[ \t]+/g, ' ').trim();

export function stripSlackMention(text, botUserId) {
  if (!botUserId) return String(text || '');
  return stripSpaces(String(text || '').replace(new RegExp(`<@${botUserId}>`, 'g'), ' '));
}

export function stripDiscordMention(text, botId) {
  if (!botId) return String(text || '');
  return stripSpaces(String(text || '').replace(new RegExp(`<@!?${botId}>`, 'g'), ' '));
}

/** 返回 { handle, text } —— text 是去掉 @ 之后的正文 */
export function shouldHandleChannelMessage({ platform, text, selfId, isDM }) {
  const raw = String(text || '').trim();
  if (isDM) return { handle: true, text: raw };
  // 频道里命令（/help 之类的）不用 @
  if (raw.startsWith('/')) return { handle: true, text: raw };
  if (!selfId) return { handle: false, text: '' };
  const mention = platform === 'discord' ? new RegExp(`<@!?${selfId}>`) : new RegExp(`<@${selfId}>`);
  if (!mention.test(raw)) return { handle: false, text: '' };
  const stripped = platform === 'discord' ? stripDiscordMention(raw, selfId) : stripSlackMention(raw, selfId);
  return { handle: true, text: stripped || raw };
}
