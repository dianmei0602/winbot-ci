// 路由单测：规则路由（不联网）+ 模型路由（真实一次小调用，失败自动退回规则）。
import { routeByRules, routeByModel } from '../src/router.js';

const ok = (label, cond, extra = '') => console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad += 1;
  ok(label, cond, extra);
};

const members = [
  { id: 'a', name: '小七', summary: '写作、改稿、文档排版', persona: '我是编辑' },
  { id: 'b', name: '小八', summary: '查资料、跑脚本、写代码', persona: '我是工程师' },
];

console.log('=== 规则路由 ===');
{
  const r1 = routeByRules({ text: '帮我改一下这段稿子，排版也理一下', members, lastSpeakerId: 'b' });
  check('写作类消息给编辑', r1.bot.id === 'a', `${r1.bot.name} ${r1.reason}`);

  const r2 = routeByRules({ text: '跑个脚本把数据抓下来，代码报错了', members, lastSpeakerId: 'a' });
  check('技术类消息给工程师', r2.bot.id === 'b', `${r2.bot.name} ${r2.reason}`);

  const r3 = routeByRules({ text: '小八你看看这个', members, lastSpeakerId: 'a' });
  check('点名优先', r3.bot.id === 'b', `${r3.bot.name} ${r3.reason}`);

  const r4 = routeByRules({ text: '嗯', members, lastSpeakerId: 'b' });
  check('没关键词时给上一个发言者', r4.bot.id === 'b', `${r4.bot.name} ${r4.reason}`);

  const r5 = routeByRules({ text: '随便', members: [members[0]], lastSpeakerId: 'b' });
  check('只有一个成员就直接给它', r5.bot.id === 'a', r5.reason);
}

console.log('=== 模型路由（真实调用，失败回落） ===');
{
  const r = await routeByModel({ text: '这个 React 组件渲染有 bug，帮我看看', members, lastSpeakerId: 'a' });
  console.log('  结果:', r.bot.name, '|', r.reason);
  check('选出了成员', ['a', 'b'].includes(r.bot.id));
  check('技术问题倾向工程师（模型或规则）', r.bot.id === 'b', r.reason);
  check('模型失败也会回落（reason 带标记）', /model:/.test(r.reason) || /model failed|no provider|bad model/.test(r.reason), r.reason);
}

console.log('=== 混合路由 + 缓存（model 模式）===');
{
  const { routeGroupMessage } = await import('../src/router.js');
  // 明确命中：应直接用规则，不花模型调用
  const strong = await routeGroupMessage({ text: '小七帮我改稿子，排版也理一下', members, lastSpeakerId: 'b', mode: 'model' });
  check('强命中走规则（不调模型）', String(strong.reason).startsWith('rules:'), `${strong.bot.name} ${strong.reason}`);
  // 同一句再问一次：应命中缓存
  const again = await routeGroupMessage({ text: '小七帮我改稿子，排版也理一下', members, lastSpeakerId: 'b', mode: 'model' });
  check('第二次命中缓存', String(again.reason).includes('cached'), again.reason);
  check('缓存结果一致', again.bot.id === strong.bot.id);
}

process.exit(bad ? 1 : 0);

