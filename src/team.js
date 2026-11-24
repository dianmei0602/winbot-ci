// 团队包：一段 Markdown（或 JSON）一次建好几个机器人 + 一个群。
//
// 支持两种写法：
//   1. 围栏代码块 ```winbot-team { ...json... } ```
//   2. 整个文本就是 JSON
//
// 结构：
// {
//   "name": "写作小组",
//   "bots": [
//     { "name": "小七", "summary": "总编", "avatar": "green", "persona": "…" },
//     { "name": "小八", "summary": "查资料", "avatar": "blue", "persona": "…" }
//   ],
//   "group": { "name": "写作小组", "members": ["小七", "小八"], "router": "rules" }
// }
import { createBot, listBots, updateBot } from './bots.js';
import { createGroup } from './groups.js';

const AVATARS = ['blue', 'green', 'yellow', 'red', 'purple', 'orange'];

export function parseTeamPackage(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('内容为空');
  let json = raw;
  const fenced = raw.match(/```(?:winbot-team|json)\s*\n([\s\S]*?)```/i);
  if (fenced) json = fenced[1];
  else {
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i >= 0 && j > i) json = raw.slice(i, j + 1);
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`团队包不是合法 JSON：${e.message}`);
  }
  const bots = Array.isArray(data?.bots) ? data.bots : [];
  if (!bots.length) throw new Error('团队包里没有 bots');
  for (const b of bots) {
    if (!String(b?.name || '').trim()) throw new Error('每个机器人都要有 name');
  }
  return {
    name: String(data.name || '').trim(),
    bots: bots.map((b, i) => ({
      name: String(b.name).trim(),
      summary: String(b.summary || '').trim(),
      avatar: AVATARS.includes(b.avatar) ? b.avatar : AVATARS[i % AVATARS.length],
      persona: String(b.persona || '').trim(),
    })),
    group: data.group && Array.isArray(data.group.members)
      ? { name: String(data.group.name || data.name || '团队').trim(), members: data.group.members.map(String), router: data.group.router === 'model' ? 'model' : 'rules' }
      : null,
  };
}

/** 导入：同名机器人复用（更新简介/人设），没有的才新建；最后按名字建群 */
export function importTeam(text) {
  const pkg = parseTeamPackage(text);
  const existing = listBots();
  const created = [];
  const updated = [];
  const ids = [];
  for (const b of pkg.bots) {
    const found = existing.find((x) => x.name === b.name);
    if (found) {
      updateBot(found.id, { summary: b.summary || found.summary, persona: b.persona || undefined, avatar: b.avatar || found.avatar });
      updated.push(b.name);
      ids.push({ name: b.name, id: found.id });
    } else {
      const bot = createBot({ name: b.name, summary: b.summary, avatar: b.avatar });
      if (b.persona) updateBot(bot.id, { persona: b.persona });
      created.push(b.name);
      ids.push({ name: b.name, id: bot.id });
    }
  }
  let group = null;
  if (pkg.group) {
    const members = pkg.group.members
      .map((n) => ids.find((x) => x.name === n)?.id)
      .filter(Boolean);
    if (members.length >= 1) {
      group = createGroup({ name: pkg.group.name, botIds: members, router: pkg.group.router });
    }
  }
  return { name: pkg.name, created, updated, groupId: group?.group?.id || null, groupName: group?.group?.name || null };
}

