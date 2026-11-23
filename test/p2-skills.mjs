// 技能：粘贴安装、列、删、ZIP 导入，并验证 DSH 真的把技能给到模型。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (method, p, body) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);

const bots = await api('GET', '/api/bots');
const botId = (bots.find((b) => b.name === '小七') || bots[0]).id;

// 清理旧测试技能
for (const s of (await api('GET', `/api/bots/${botId}/skills`)).skills) {
  if (s.slug.startsWith('demo-')) await api('DELETE', `/api/bots/${botId}/skills/${s.slug}`);
}

console.log('=== 1. 粘贴安装 ===');
const md = `---
name: demo-weekly-note
description: 把一周的零散记录整理成一份周报草稿
whenToUse: 用户说「写周报」「整理这周的记录」时
---

# 周报

1. 读工作区 notes/ 下最近 7 天的文件。
2. 按「做了什么 / 结果 / 下周计划」三段归纳。
3. 写到 outputs/weekly-YYYY-MM-DD.md，只写有证据的事。
`;
const installed = await api('POST', `/api/bots/${botId}/skills`, { text: md });
ok('安装成功', installed.ok === true, installed.slug);
const list1 = (await api('GET', `/api/bots/${botId}/skills`)).skills;
ok('列表里有它', list1.some((s) => s.slug === 'demo-weekly-note'));
const one = list1.find((s) => s.slug === 'demo-weekly-note');
ok('解析出 description', one?.description.includes('周报'), one?.description);
ok('SKILL.md 落在机器人目录', fs.existsSync(`E:/AI_work/winbot/data/bots/${botId}/skills/demo-weekly-note/SKILL.md`));

console.log('=== 2. 模型能看到这个技能 ===');
{
  const { conversation } = await api('POST', `/api/bots/${botId}/conversations`, {});
  await api('POST', `/api/conversations/${conversation.id}/send`, {
    text: '你现在有哪些技能可用？只列技能名，不要做别的。',
  });
  const deadline = Date.now() + 180_000;
  let reply = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const data = await api('GET', `/api/conversations/${conversation.id}`);
    const a = data.messages.filter((m) => m.role === 'assistant').at(-1);
    if (a) {
      reply = a.content;
      break;
    }
  }
  ok('回复里提到新技能', reply.includes('demo-weekly-note') || reply.includes('周报'), reply.slice(0, 120));
  await api('DELETE', `/api/conversations/${conversation.id}`);
}

console.log('=== 3. ZIP 导入 ===');
{
  const tmp = 'E:/AI_work/winbot/data/skill-zip-test';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'demo-zip-skill', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'demo-zip-skill', 'SKILL.md'),
    '---\nname: demo-zip-skill\ndescription: 从 ZIP 装的技能\n---\n\n# 演示\n\n跑 scripts/run.js。\n',
  );
  fs.writeFileSync(path.join(tmp, 'demo-zip-skill', 'scripts', 'run.js'), 'console.log("hi");\n');
  const zip = 'E:/AI_work/winbot/data/skill-zip-test.zip';
  fs.rmSync(zip, { force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp.replace(/\//g, '\\')}\\demo-zip-skill' -DestinationPath '${zip.replace(/\//g, '\\')}' -Force`]);
  const b64 = fs.readFileSync(zip).toString('base64');
  const r = await api('POST', `/api/bots/${botId}/skills`, { zip: b64 });
  ok('ZIP 导入成功', r.ok === true && r.slug === 'demo-zip-skill', `${r.slug} / ${r.files} 个文件`);
  const dir = `E:/AI_work/winbot/data/bots/${botId}/skills/demo-zip-skill`;
  ok('SKILL.md 解出来了', fs.existsSync(`${dir}/SKILL.md`));
  ok('脚本也解出来了', fs.existsSync(`${dir}/scripts/run.js`));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
}

console.log('=== 4. 删除 ===');
{
  const r = await api('DELETE', `/api/bots/${botId}/skills/demo-weekly-note`);
  ok('删除成功', r.ok === true);
  ok('目录没了', !fs.existsSync(`E:/AI_work/winbot/data/bots/${botId}/skills/demo-weekly-note`));
  await api('DELETE', `/api/bots/${botId}/skills/demo-zip-skill`);
  const left = (await api('GET', `/api/bots/${botId}/skills`)).skills;
  ok('列表清空', left.length === 0, `剩 ${left.length} 个`);
}
