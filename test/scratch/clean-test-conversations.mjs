// 清掉测试留下的会话（按标题特征），保留真实的演示内容。
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:5178';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const api = async (method, p) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

// 保留这些（真实演示）
const keep = ['写个 hello.txt 放到 outputs 里，内容随便', '帮我把这周的工作记一下：周三要交报表，周五评审', '这两张附件里分别是什么'];

const bots = await api('GET', '/api/bots');
let removed = 0;
for (const bot of bots) {
  const convs = await api('GET', `/api/bots/${bot.id}/conversations`);
  for (const c of convs) {
    const title = String(c.title || '');
    if (keep.some((k) => title.startsWith(k))) continue;
    if (c.channel === 'group') continue; // 群会话别删，删了群就没法说话了
    await api('DELETE', `/api/conversations/${c.id}`);
    removed += 1;
    console.log('删:', title.slice(0, 40));
  }
}
console.log('共删除', removed, '个测试会话');

