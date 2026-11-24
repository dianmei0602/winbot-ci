// Electron 外壳：一个真正的桌面窗口 + 托盘，后端还是原来的 Node 服务（子进程）。
// 打包后数据放 %APPDATA%\winbot；开发时直接用项目里的 data。
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { ipcMain } from 'electron';
import { takePendingInstall } from '../src/update.js';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const PORT = Number(process.env.WINBOT_PORT || 5178);
const IS_WIN = process.platform === 'win32';

let backend = null; // 子进程
let win = null;
let tray = null;
let quitting = false;
let restarting = false;

// ---------- 数据目录 ----------

/** 打包后数据放 userData；第一次启动时把旧的 data/ 搬过来（别让用户丢机器人） */
function dataDir() {
  if (!app.isPackaged) return path.join(APP_ROOT, 'data');
  return path.join(app.getPath('userData'), 'data');
}

function migrateLegacyData(target) {
  try {
    if (fs.existsSync(path.join(target, 'config.json'))) return false;
    const legacy = path.join(APP_ROOT, 'data');
    if (!fs.existsSync(path.join(legacy, 'config.json'))) return false;
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(legacy, target, { recursive: true });
    logLine(`migrated legacy data from ${legacy}`);
    return true;
  } catch (e) {
    logLine(`migrate 失败：${e.message}`);
    return false;
  }
}

function logFile() {
  return path.join(dataDir(), 'desktop.log');
}

function logLine(msg) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

// ---------- 后端 ----------

function backendEnv() {
  const env = { ...process.env, WINBOT_PORT: String(PORT), WINBOT_DATA: dataDir() };
  // 让子进程以 Node 身份跑，而不是再开一个 Electron 窗口
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function backendEntry() {
  // 打包后 asar 里的路径；Electron 的 Node 能直接读 asar
  return path.join(APP_ROOT, 'src', 'main.js');
}

function startBackend() {
  if (backend) return;
  const entry = backendEntry();
  logLine(`starting backend: ${process.execPath} ${entry}`);
  // 打包后 APP_ROOT 是 app.asar（一个文件），不能当 cwd；用可写的数据目录
  const workDir = app.isPackaged ? app.getPath('userData') : APP_ROOT;
  backend = spawn(process.execPath, [entry], {
    cwd: workDir,
    env: backendEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backend.stdout.on('data', (d) => logLine(`[backend] ${String(d).trimEnd()}`));
  backend.stderr.on('data', (d) => logLine(`[backend:err] ${String(d).trimEnd()}`));
  backend.on('error', (err) => {
    logLine(`backend spawn error: ${err?.message || err}`);
  });
  backend.on('exit', (code, signal) => {
    logLine(`backend exited code=${code} signal=${signal}`);
    backend = null;
    if (!quitting && !restarting) {
      // 崩了自动拉起来一次，再崩就提示
      setTimeout(() => {
        if (!quitting) startBackend();
      }, 1500);
    }
  });
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backend) return resolve();
    const pid = backend.pid;
    restarting = true;
    const done = () => setTimeout(resolve, 300);
    if (IS_WIN) {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
        restarting = false;
        done();
      });
    } else {
      backend.kill('SIGTERM');
      restarting = false;
      done();
    }
  });
}

function health(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitHealthy(maxMs = 60_000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (await health()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function tokenPath() {
  return path.join(dataDir(), 'ui-token');
}

function readToken() {
  try {
    return fs.readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    return '';
  }
}

function consoleUrl() {
  const t = readToken();
  return `http://127.0.0.1:${PORT}/${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}

// ---------- 窗口与托盘 ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    title: 'winbot',
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
    },
  });
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    // 关窗口不退服务，缩到托盘
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 链接一律用系统浏览器打开，别在应用里跑
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  loadUi();
}

async function loadUi() {
  const ok = await waitHealthy();
  if (!ok) {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="background:#0f1115;color:#e8ecf4;font:14px 'Segoe UI';padding:40px">
         <h2>服务没起来</h2>
         <p>请查看日志：<code>${logFile()}</code></p>
         <p>常见原因：端口 ${PORT} 被占用，或 Node 运行环境异常。</p>
         <button onclick="location.reload()" style="margin-top:12px;padding:8px 14px">重试</button></body>`,
      )}`,
    );
    return;
  }
  await win.loadURL(consoleUrl());
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

async function backendJson(method, path, body) {
  const t = readToken();
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

async function checkUpdatesFromTray() {
  try {
    const r = await backendJson('GET', '/api/update/check');
    if (!r.found) {
      await dialog.showMessageBox({ type: 'info', title: '检查更新', message: '没有找到 release', detail: r.message || '', buttons: ['好'] });
      return;
    }
    if (!r.newer) {
      await dialog.showMessageBox({ type: 'info', title: '检查更新', message: `已是最新版本 ${r.current}`, buttons: ['好'] });
      return;
    }
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: '有新版本',
      message: `发现新版本 ${r.latest}（当前 ${r.current}）`,
      detail: r.asset ? `安装包：${r.asset.name}` : '这个 release 没有 Windows 安装包',
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0 || !r.asset) return;
    await dialog.showMessageBox({ type: 'info', title: '下载中', message: '正在下载安装包，完成后会自动打开安装程序' });
    const d = await backendJson('POST', '/api/update/download', { url: r.asset.url, name: r.asset.name });
    await backendJson('POST', '/api/update/install', { path: d.path });
  } catch (err) {
    await dialog.showMessageBox({ type: 'error', title: '检查更新失败', message: String(err?.message || err) });
  }
}

function takePendingInstallLocal() {
  try {
    const file = path.join(dataDir(), 'update-pending.json');
    if (!fs.existsSync(file)) return null;
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    if (!job?.file || !fs.existsSync(job.file)) return null;
    return job;
  } catch {
    return null;
  }
}

const UPDATE_CHANNEL = { owner: 'dianmei0602', repo: 'winbot-ci' };
let updaterReady = false;
let lastUpdateInfo = null;

function setupUpdater() {
  if (updaterReady) return;
  if (!app.isPackaged) return; // 开发模式没有 app-update.yml
  updaterReady = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL({ provider: 'github', ...UPDATE_CHANNEL, private: false });
  autoUpdater.on('download-progress', (p) => {
    try {
      win?.webContents.send('update:progress', { percent: Math.round(p.percent || 0), transferred: p.transferred, total: p.total });
    } catch {
      /* ignore */
    }
  });
  autoUpdater.on('error', (e) => log('update', 'updater error: ' + (e?.message || e)));
}

ipcMain.handle('update:check', async () => {
  setupUpdater();
  if (!updaterReady) return { ok: false, error: '当前是开发模式，更新只在安装版里可用' };
  try {
    const r = await autoUpdater.checkForUpdates();
    lastUpdateInfo = r?.updateInfo || null;
    const current = app.getVersion();
    const latest = lastUpdateInfo?.version || '';
    return {
      ok: true,
      found: !!latest,
      current,
      latest,
      newer: !!latest && latest !== current,
      notes: lastUpdateInfo?.releaseNotes || '',
      asset: { name: lastUpdateInfo?.files?.[0]?.url || '', size: lastUpdateInfo?.files?.[0]?.size || 0 },
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('update:download', async () => {
  setupUpdater();
  if (!updaterReady) return { ok: false, error: '开发模式' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

async function stopBackendForInstall() {
  try {
    await stopBackend();
  } catch {
    /* ignore */
  }
  // 给子进程一点时间退干净（DSH 机器人进程 / 后端 node）
  await new Promise((r) => setTimeout(r, 1200));
}

function findDownloadedInstaller() {
  const pending = path.join(process.env.LOCALAPPDATA || '', 'winbot-updater', 'pending');
  if (!fs.existsSync(pending)) return null;
  const files = fs
    .readdirSync(pending)
    .filter((f) => /^winbot-Setup-.*\.exe$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(pending, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? path.join(pending, files[0].f) : null;
}

ipcMain.handle('update:install', async () => {
  setupUpdater();
  if (!updaterReady) return { ok: false, error: '开发模式' };
  const installer = findDownloadedInstaller();
  if (!installer) return { ok: false, error: '没找到已下载的安装包（先点下载）' };
  const marker = path.join(dataDir(), 'update-result.json');
  const appExe = process.execPath;
  const bat = path.join(dataDir(), 'update-run.bat');
  const lines = [
    '@echo off',
    'timeout /t 3 /nobreak >nul',
    `"${installer}" /S`,
    'set RC=%ERRORLEVEL%',
    `echo {"exitCode":%RC%,"file":"${installer.replace(/\\/g, '\\\\')}","at":"%DATE% %TIME%"} > "${marker}"`,
    `start "" "${appExe}"`,
    'del "%~f0"',
    '',
  ].join('\r\n');
  try {
    fs.writeFileSync(bat, lines, 'utf8');
    // explorer.exe 拉起：进程挂在资源管理器下，不随 winbot 退出被带走
    spawn('explorer.exe', [bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    return { ok: false, error: '写安装脚本失败：' + (e?.message || e) };
  }
  quitting = true;
  await stopBackendForInstall();
  setImmediate(() => app.quit());
  return { ok: true, queued: true, installer, marker };
});

function watchPendingInstall() {
  setInterval(() => {
    if (quitting) return;
    const job = takePendingInstallLocal();
    if (!job) return;
    quitting = true;
    // 关键：detached 子进程会随父进程一起被带走（实测），所以交给「计划任务」跑。
    // 计划任务在 Task Scheduler 服务下执行，父进程退出后仍在；装完写回执，安装本身要 2-4 分钟。
    const args = job.silent ? ['/S'] : [];
    const psFile = job.file.replace(/'/g, "''");
    const psArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const marker = path.join(dataDir(), 'update-result.json').replace(/'/g, "''");
    const taskName = 'winbot-selfupdate';
    const scriptPath = path.join(dataDir(), 'update-run.ps1');
    const ps1 = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$deadline = (Get-Date).AddSeconds(60)`,
      `while ((Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 400 }`,
      `Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue`,
      'Start-Sleep -Milliseconds 800',
      `$p = Start-Process -FilePath '${psFile}' -ArgumentList ${psArgs || '@()'} -PassThru -Wait`,
      `@{ exitCode = $p.ExitCode; file = '${psFile}'; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding UTF8 '${marker}'`,
      `schtasks.exe /Delete /F /TN ${taskName} | Out-Null`,
      '',
    ].join('\r\n');
    try {
      fs.writeFileSync(scriptPath, '\ufeff' + ps1, 'utf8');
      const tr = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
      execFileSync('schtasks.exe', ['/Create', '/F', '/TN', taskName, '/TR', tr, '/SC', 'ONCE', '/ST', '23:59', '/RL', 'LIMITED'], { windowsHide: true });
      execFileSync('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true });
    } catch (e) {
      // 计划任务失败就退回直接启动（可能失败，但至少试一次）
      try {
        spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => app.quit(), 3000);
  }, 2500).unref?.();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message || '').slice(0, 400)));
      else resolve(stdout);
    });
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const BACKUP_EXCLUDES = ['--exclude=*.log', '--exclude=updates', '--exclude=edge-*', '--exclude=restore-pending.zip'];

async function exportBackup() {
  const dest = await dialog.showSaveDialog(win, {
    title: '导出 winbot 数据备份',
    defaultPath: path.join(app.getPath('documents'), `winbot-backup-${stamp()}.zip`),
    filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
  });
  if (dest.canceled || !dest.filePath) return;
  try {
    const dir = dataDir();
    await run('tar', ['-a', '-c', '-f', dest.filePath, '-C', dir, ...BACKUP_EXCLUDES, '.']);
    const size = Math.round(fs.statSync(dest.filePath).size / 1024 / 1024);
    await dialog.showMessageBox(win, { type: 'info', title: '备份完成', message: `已导出到：${dest.filePath}`, detail: `约 ${size} MB（含数据库、机器人工作区、配置和令牌；不含日志）` });
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'error', title: '备份失败', message: String(e?.message || e) });
  }
}

async function restoreBackup() {
  const pick = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 备份', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const zip = pick.filePaths[0];
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '从备份恢复',
    message: '会用备份里的内容替换当前数据（会话、机器人、配置、令牌）',
    detail: '当前数据会先改名留一份在旁边，恢复完 winbot 会重启。',
    buttons: ['恢复并重启', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (confirm.response !== 0) return;

  const dir = dataDir();
  const aside = `${dir}-before-restore-${stamp()}`;
  try {
    await stopBackend();
    fs.renameSync(dir, aside);
    fs.mkdirSync(dir, { recursive: true });
    await run('tar', ['-x', '-f', zip, '-C', dir]);
    startBackend();
    await loadUi();
    await dialog.showMessageBox(win, { type: 'info', title: '恢复完成', message: '数据已替换，winbot 已重启', detail: `旧数据备份在：${aside}` });
  } catch (e) {
    // 失败就回滚
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      if (fs.existsSync(aside)) fs.renameSync(aside, dir);
      startBackend();
      await loadUi();
    } catch {
      /* ignore */
    }
    await dialog.showMessageBox(win, { type: 'error', title: '恢复失败', message: String(e?.message || e), detail: '已尝试回滚到原数据。' });
  }
}

function buildTray() {
  const iconPath = path.join(APP_ROOT, 'launcher', app.isPackaged ? 'icon-256.png' : 'icon-256.png');
  let image = null;
  try {
    image = require('electron').nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = null;
  } catch {
    image = null;
  }
  tray = new Tray(image ?? path.join(APP_ROOT, 'launcher', 'winbot.ico'));
  const menu = Menu.buildFromTemplate([
    { label: '打开 winbot', click: showWindow },
    { label: '复制访问地址', click: () => clipboard.writeText(consoleUrl()) },
    { label: '检查更新…', click: () => checkUpdatesFromTray() },
    { type: 'separator' },
    { label: '导出数据备份…', click: () => exportBackup() },
    { label: '从备份恢复…', click: () => restoreBackup() },
    { type: 'separator' },
    {
      label: '重启服务',
      click: async () => {
        await stopBackend();
        startBackend();
        await loadUi();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [] });
        tray.setContextMenu(buildMenu());
      },
    },
    { label: '查看日志', click: () => shell.openPath(logFile()).catch(() => {}) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('winbot');
  tray.setContextMenu(menu);
  tray.on('double-click', showWindow);
  return menu;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 winbot', click: showWindow },
    { label: '复制访问地址', click: () => clipboard.writeText(consoleUrl()) },
    { type: 'separator' },
    {
      label: '重启服务',
      click: async () => {
        await stopBackend();
        startBackend();
        await loadUi();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [] });
        tray.setContextMenu(buildMenu());
      },
    },
    { label: '查看日志', click: () => shell.openPath(logFile()).catch(() => {}) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => watchPendingInstall());
app.whenReady().then(async () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    migrateLegacyData(dataDir());
    logLine(`app ready, packaged=${app.isPackaged}, root=${APP_ROOT}, data=${dataDir()}`);
    startBackend();
    createWindow();
    buildTray();

    // 如果已经有别的进程占着端口（比如用 start.cmd 起的），直接用，不再起第二个
    if (await health()) logLine('existing backend detected, reusing');

    app.on('activate', showWindow);
  });

  app.on('before-quit', async (e) => {
    if (quitting && backend) {
      e.preventDefault();
      quitting = true;
      await stopBackend();
      app.exit(0);
    }
  });

  app.on('window-all-closed', (e) => {
    // 托盘常驻：窗口全关也不退出
    e.preventDefault?.();
  });
}



