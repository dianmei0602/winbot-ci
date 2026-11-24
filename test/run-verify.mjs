#!/usr/bin/env node
// 回归入口：一条命令跑完收口门槛。
//
//   node test/run-verify.mjs            # 快检：不调模型、不开浏览器
//   node test/run-verify.mjs --model    # 再加需要真模型的（要后端在跑）
//   node test/run-verify.mjs --ui       # 再加 UI/CDP（要安装版在跑）
//   node test/run-verify.mjs --all      # 以上全部
//   node test/run-verify.mjs --slow     # 再加生成类（图/视频/3D，很慢）
//
// 退出码 0 = 全绿。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = new Set(process.argv.slice(2));
const want = (flag) => args.has(flag) || args.has('--all');

const SUITES = {
  fast: [
    ['telegram 群聊判定', 'test/telegram-group.mjs'],
    ['频道 @ 收敛（Slack/Discord）', 'test/channel-mention.mjs'],
    ['打包依赖自检', 'test/check-pack.mjs'],
    ['文档一致性', 'test/docs-check.mjs'],
    ['Codex 内核离线自检', 'test/codex-engine.mjs'],
    ['语法自检', 'test/syntax-check.mjs'],
  ],
  model: [
    ['P0 规则', 'test/p0-rules.mjs'],
    ['P0 失败处理', 'test/p0-failure.mjs'],
    ['记忆即时生效', 'test/p0-memory-fresh.mjs'],
    ['每日预算 + 交付文件', 'test/p1-budget-present.mjs'],
    ['群聊 + 互派', 'test/p3-groups.mjs'],
    ['聊天搜索', 'test/p3-search.mjs'],
    ['流式输出', 'test/stream-check.mjs'],
    ['停止这一轮', 'test/stop-turn.mjs'],
    ['审批记住一小时', 'test/approval-remember.mjs'],
    ['相对路径汇报', 'test/relative-path.mjs'],
    ['群聊路由', 'test/router.mjs'],
    ['群聊路由实测', 'test/group-router-app.mjs'],
    ['团队包 + 应用连接', 'test/team-connectors.mjs'],
    ['更新检查', 'test/update-check.mjs'],
    ['登录态 Cookie', 'test/session-cookie.mjs'],
    ['安装队列', 'test/update-queue.mjs'],
    ['文件接口边界', 'test/file-edge.mjs'],
    ['Codex 内核实跑（DeepSeek Responses）', 'test/real-codex.mjs'],
  ],
  headless: [
    ['更新检查', 'test/update-check.mjs'],
    ['安装队列', 'test/update-queue.mjs'],
    ['团队包 + 应用连接', 'test/team-connectors.mjs'],
  ],  ui: [
    ['安装版窗口可发消息', 'test/electron-check.mjs'],
    ['ComfyUI 面板', 'test/comfy-panel-installed.mjs'],
    ['面板拖拽调宽', 'test/ui-resize.mjs'],
    ['停止按钮', 'test/ui-stop-installed.mjs'],
    ['手机端页面', 'test/mobile-check.mjs'],
  ],
  slow: [
    ['生图', 'test/zimage-app.mjs'],
    ['生视频', 'test/video-app.mjs'],
    ['生 3D', 'test/model3d-app.mjs'],
  ],
};

const selected = [...SUITES.fast];
if (want('--model')) selected.push(...SUITES.model);
if (want('--headless')) selected.push(...SUITES.headless);
if (want('--ui')) selected.push(...SUITES.ui);
if (want('--slow')) selected.push(...SUITES.slow);

const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 15 * 60_000);

function runOne(name, rel) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [rel], {
      cwd: root,
      env: { ...process.env, WINBOT_VERIFY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      out += '\n[verify] 超时，强制结束';
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, rel, code, ms: Date.now() - started, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ name, rel, code: -1, ms: Date.now() - started, out: String(e) });
    });
  });
}

console.log(`回归：${selected.length} 项${args.size ? `（${[...args].join(' ')}）` : '（快检）'}\n`);
const results = [];
for (const [name, rel] of selected) {
  if (!fs.existsSync(path.join(root, rel))) {
    results.push({ name, rel, code: -2, ms: 0, out: '脚本不存在' });
    console.log(`✗ ${name}（脚本不存在：${rel}）`);
    continue;
  }
  process.stdout.write(`… ${name}`);
  const r = await runOne(name, rel);
  results.push(r);
  const ok = r.code === 0;
  const tail = (r.out.match(/✗[^\n]*/g) || []).slice(0, 3).join(' | ');
  console.log(`\r${ok ? '✓' : '✗'} ${name}（${Math.round(r.ms / 1000)}s）${ok ? '            ' : ''}${tail ? `\n    ${tail}` : ''}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) {
    console.log(`\n--- ${f.name}（${f.rel}，exit ${f.code}）---`);
    console.log(f.out.trim().split('\n').slice(-12).join('\n'));
  }
  process.exit(1);
}










