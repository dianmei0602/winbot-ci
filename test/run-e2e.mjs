// 一条命令跑完整验证：起 mock 模型 → 起 winbot → 主链路 → 审批拒绝/批准。
// 用法: node test/run-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE = process.execPath;
const ROOT = 'E:/AI_work/winbot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function start(label, args, outFile) {
  const out = fs.openSync(outFile, 'w');
  const child = spawn(NODE, args, { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true });
  children.push(child);
  console.log(`[e2e] started ${label} pid=${child.pid}`);
  return child;
}
async function waitHttp(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  return false;
}
function killAll() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

const data = path.join(ROOT, 'data');
fs.mkdirSync(data, { recursive: true });
start('mock-llm', ['test/mock-llm.mjs'], path.join(data, 'e2e-mock.log'));
start('winbot', ['src/main.js'], path.join(data, 'e2e-server.log'));
process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(1);
});

try {
  if (!(await waitHttp('http://127.0.0.1:5199/v1/models'))) throw new Error('mock 模型没起来');
  if (!(await waitHttp('http://127.0.0.1:5178/health'))) throw new Error('winbot 没起来');
  console.log('[e2e] both up\n');

  const run = (file, args = []) =>
    new Promise((resolve, reject) => {
      const p = spawn(NODE, [file, ...(args || [])], { cwd: ROOT, stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exit ${code}`))));
    });

  // 整轮都固定在本地 mock 上，最后再还原（不然 smoke 跑完会切回真实模型，审批用例就触发不了）
  const token = fs.readFileSync(path.join(data, 'ui-token'), 'utf8').trim();
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:5178${p}`, {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${p}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const bots = await api('GET', '/api/bots');
  const target = bots.find((b) => b.name === '小七') || bots[0];
  if (!target) throw new Error('没有机器人可测');
  const original = { providerId: target.providerId, model: target.model };
  console.log(`[e2e] 机器人 ${target.id} 原模型 ${original.providerId}/${original.model}，测试期间切到 mock`);
  await api('PATCH', `/api/bots/${target.id}`, { providerId: 'mock', model: 'mock-model' });

  try {
    await run('test/smoke.mjs');
    console.log('\n===== 审批：拒绝 =====');
    await run('test/probe-app-approval.mjs', [target.id, 'deny']);
    console.log('\n===== 审批：批准 =====');
    await run('test/probe-app-approval.mjs', [target.id, 'allow']);
    console.log('\n[e2e] PASS');
  } finally {
    if (original.providerId) {
      await api('PATCH', `/api/bots/${target.id}`, original);
      console.log(`[e2e] 已还原模型：${original.providerId}/${original.model}`);
    }
  }
} catch (e) {
  console.error('\n[e2e] FAIL:', e.message);
  console.error('--- server log tail ---');
  try {
    console.error(fs.readFileSync(path.join(data, 'e2e-server.log'), 'utf8').split('\n').slice(-25).join('\n'));
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  await sleep(300);
  killAll();
}
