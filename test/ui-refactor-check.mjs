// 重构验证：真实浏览器加载，捕获运行时错误 + 断言 5 域导航/路由/面板/主题/消息。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.VERIFY_PORT || 9344) + Math.floor(Math.random() * 500);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const token = fs.readFileSync('E:/AI_work/winbot/data/ui-token', 'utf8').trim();
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:5178';
const url = `${BASE}/?token=${token}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=E:/AI_work/winbot/data/edge-verify-refactor-${PORT}`, '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
process.on('exit', () => { try { child.kill(); } catch {} });

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 端口没起来');
}

const ws = new WebSocket(await pageWs());
const waiters = new Map();
let seq = 0;
const consoleErrs = [];
const pageErrs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiters.has(m.id)) {
    const { resolve, reject } = waiters.get(m.id); waiters.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    consoleErrs.push(m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown')
    pageErrs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  seq += 1; const id = seq;
  waiters.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('WS timeout')), 10000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(2500);

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

try {
  const title = await evalJS('document.title');
  check('页面标题', /winbot/.test(title), title);

  const navCount = await evalJS('document.querySelectorAll(".side-nav-item[data-domain]").length');
  check('5 域导航项', navCount === 5, `实际 ${navCount}`);

  const navLabels = await evalJS('[...document.querySelectorAll(".side-nav-item[data-domain]")].map(b=>b.textContent.trim()).join(",")');
  check('导航语义正确', navLabels.includes('对话') && navLabels.includes('机器人') && navLabels.includes('自动化') && navLabels.includes('连接') && navLabels.includes('系统'), navLabels);

  const deadBtns = await evalJS('!!document.querySelector("#btn-market") || !!document.querySelector("#btn-more")');
  check('死按钮已删除', !deadBtns);

  const ariaCount = await evalJS('document.querySelectorAll("[aria-label]").length');
  check('无障碍标签覆盖', ariaCount >= 15, `${ariaCount} 个 aria-label`);

  const botCount = await evalJS('document.querySelectorAll("#bot-list .bot-item").length');
  check('机器人列表渲染', botCount > 0, `${botCount} 个`);

  const chatVisible = await evalJS('!document.querySelector("#chat").hidden');
  check('对话主区可见', chatVisible);

  // 路由：点击「连接」→ 面板打开 + hash + 标题
  await evalJS('document.querySelector("[data-domain=connect]").click()');
  await sleep(600);
  const hash1 = await evalJS('location.hash');
  const panelOpen = await evalJS('!document.querySelector("#panel").hidden');
  const panelTitle = await evalJS('document.querySelector("#panel-title").textContent');
  check('路由 #/connect 生效', hash1 === '#/connect', hash1);
  check('连接面板打开', panelOpen, panelTitle);
  check('面板只装一类内容', /连接/.test(panelTitle), panelTitle);

  // tab 切换：模型接口 → 连接器
  await evalJS('document.querySelector("[role=tab][aria-selected=false]")?.click()');
  await sleep(500);
  const hash2 = await evalJS('location.hash');
  check('tab 路由切换', hash2.startsWith('#/connect/'), hash2);

  // 深链刷新恢复
  await send('Page.navigate', { url: `${BASE}/?token=${token}#/system/about` });
  await sleep(1800);
  const panelTitle2 = await evalJS('document.querySelector("#panel-title").textContent');
  const hash3 = await evalJS('location.hash');
  check('深链 #/system/about 恢复', hash3 === '#/system/about' && /系统/.test(panelTitle2), `${hash3} / ${panelTitle2}`);

  // 回退到对话
  await evalJS('document.querySelector("[data-domain=chat]").click()');
  await sleep(400);
  const panelClosed = await evalJS('document.querySelector("#panel").hidden');
  check('回对话关闭面板', panelClosed);

  // 主题切换
  await evalJS('document.querySelector("#btn-theme").click()');
  await sleep(150);
  const theme = await evalJS('document.documentElement.getAttribute("data-theme")');
  check('主题切换', theme === 'light' || theme === 'dark', theme);

  // 发消息（模拟流式）
  await evalJS('document.querySelector("#input").value="你好，测试重构后的界面"; document.querySelector("#btn-send").click()');
  await sleep(300);
  const msgCount = await evalJS('document.querySelectorAll("#messages .msg.user").length');
  check('发消息追加气泡', msgCount > 0, `${msgCount} 条用户消息`);

  // 截图
  await evalJS('window.__winbot.setTheme("dark")');
  await sleep(150);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:/AI_work/winbot/data/ui-refactor-verify.png', Buffer.from(shot.data, 'base64'));
  console.log('\n截图已保存: data/ui-refactor-verify.png');

  console.log(`\n运行时 console 错误: ${consoleErrs.length}`);
  consoleErrs.slice(0, 8).forEach((e) => console.log('  [console]', e.slice(0, 300)));
  console.log(`运行时页面异常: ${pageErrs.length}`);
  pageErrs.slice(0, 8).forEach((e) => console.log('  [page]', e.slice(0, 300)));

  check('无运行时页面异常', pageErrs.length === 0, `${pageErrs.length} 个`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 项通过 ====`);
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join(', '));
} catch (e) {
  console.error('VERIFY ERROR:', e.message);
} finally {
  ws.close();
  child.kill();
}
