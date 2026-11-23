// winbot 的 Windows 电脑操作：
//   desktop_screenshot / desktop_windows  只读，不需要审批
//   desktop_action                        点击/输入/按键/切窗口，默认每次都要用户在界面里点同意
// 实现方式是调用系统的 PowerShell + Win32（不发任何数据出去）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'winbot-desktop';
export const inject = ['tools'];

const HOST = process.env.WINBOT_HOST || 'http://127.0.0.1:5178';
const TOKEN = process.env.WINBOT_UI_TOKEN || '';
const BOT_ID = process.env.WINBOT_BOT_ID || '';
const WORKSPACE = process.env.WINBOT_WORKSPACE || '';
const AUTO = process.env.WINBOT_DESKTOP_AUTO === '1';

const textOut = (text) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_a, v) => [{ type: 'text', text: v.text }],
});

function ps(script, timeoutMs = 30_000) {
  // 先切 UTF-8，否则中文窗口标题会按系统代码页解码成乱码
  const full = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + script;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').toString().slice(0, 800)));
        else resolve(stdout.toString());
      },
    );
  });
}

/** 问宿主能不能做这件事（宿主在界面里弹出卡片等用户点） */
async function askHost(tool, detail) {
  if (AUTO) return { allow: true, auto: true };
  const res = await fetch(`${HOST}/api/desktop/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, tool, detail }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`审批请求失败：HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'desktop_screenshot',
      description:
        'Capture the current screen to a PNG file inside the workspace and return its path. ' +
        'Use it when you need to see what is on the user\'s screen. Reading the screen needs no approval.',
      parameters: {
        label: { type: 'string', description: 'Optional short label used in the file name.' },
      },
      output: textOut('ok'),
      async execute(args) {
        const dir = path.join(WORKSPACE, 'tmp', 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = String(args.label || 'screen').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 24);
        const file = path.join(dir, `${stamp}-${safe}.png`);
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
          '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
          '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
          String.raw`$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
          '$g.Dispose(); $bmp.Dispose()',
          `Write-Output "${file}"`,
        ].join('; ');
        await ps(script);
        const rel = path.relative(WORKSPACE, file).replace(/\\/g, '/');
        return { text: `截好了：${rel}（${Math.round(process.uptime())}s 内）。要看内容就用读图工具打开它。` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'desktop_windows',
      description: 'List visible top-level windows (title and process) on the user\'s desktop. Read-only.',
      parameters: {},
      output: textOut('ok'),
      async execute() {
        const script = [
          'Get-Process | Where-Object { $_.MainWindowTitle -ne "" }',
          '| Select-Object -First 40 Id, ProcessName, MainWindowTitle',
          '| ConvertTo-Json -Compress',
        ].join(' ');
        const raw = await ps(script);
        let list = [];
        try {
          list = JSON.parse(raw || '[]');
          if (!Array.isArray(list)) list = [list];
        } catch {
          return { text: `读窗口失败：${raw.slice(0, 200)}` };
        }
        if (!list.length) return { text: '当前没有带标题的窗口。' };
        return {
          text: ['当前窗口：', ...list.map((w) => `- [${w.Id}] ${w.ProcessName}：${w.MainWindowTitle}`)].join('\n'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'desktop_action',
      description:
        'Act on the user\'s desktop: move/click the mouse, type text, press keys, or focus a window. ' +
        'Every call asks the user for approval first unless they turned that off. ' +
        'Prefer one small step at a time and check the screen again after each action.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['click', 'type', 'key', 'focus'],
          description: 'click = 点一下（用 x/y）；type = 输入文字；key = 按键；focus = 按窗口标题切到前台。',
        },
        x: { type: 'integer', description: 'click：屏幕坐标 X。' },
        y: { type: 'integer', description: 'click：屏幕坐标 Y。' },
        text: { type: 'string', description: 'type：要输入的文字；focus：窗口标题的一部分。' },
        keys: { type: 'string', description: 'key：按键，如 ENTER、TAB、^S、%{F4}（SendKeys 语法）。' },
        detail: { type: 'string', description: '给用户看的一句话说明这次要做什么。' },
      },
      output: textOut('ok'),
      async execute(args) {
        const what = describe(args);
        const verdict = await askHost('电脑操作', what);
        if (!verdict.allow) return { text: '用户没有同意这次操作，已停下。' };
        const script = buildScript(args);
        const raw = await ps(script, 30_000);
        return { text: `已执行：${what}${raw.trim() ? `\n${raw.trim().slice(0, 300)}` : ''}` };
      },
    }),
  );
}

function describe(a) {
  if (a.action === 'click') return `点一下屏幕 (${a.x}, ${a.y})`;
  if (a.action === 'type') return `输入文字「${String(a.text || '').slice(0, 60)}」`;
  if (a.action === 'key') return `按键 ${a.keys}`;
  if (a.action === 'focus') return `切到窗口「${String(a.text || '').slice(0, 40)}」`;
  return a.action;
}

function buildScript(a) {
  if (a.action === 'click') {
    const x = Math.round(Number(a.x) || 0);
    const y = Math.round(Number(a.y) || 0);
    return [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class W { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
      '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e); }',
      '"@',
      `[W]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 150`,
      '[W]::mouse_event(0x0002, 0, 0, 0, 0); [W]::mouse_event(0x0004, 0, 0, 0, 0)',
    ].join('\n');
  }
  if (a.action === 'type') {
    const text = String(a.text || '').replace(/'/g, "''");
    return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text}')`;
  }
  if (a.action === 'key') {
    const keys = String(a.keys || '').replace(/'/g, "''");
    return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  }
  if (a.action === 'focus') {
    const title = String(a.text || '').replace(/'/g, "''");
    return [
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class F { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }',
      '"@',
      `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1`,
      'if ($p) { [F]::SetForegroundWindow($p.MainWindowHandle) } else { Write-Output "没找到这个窗口" }',
    ].join('\n');
  }
  throw new Error(`不认识的动作：${a.action}`);
}

