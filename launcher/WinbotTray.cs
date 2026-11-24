// winbot 托盘启动器（C# 5 / .NET Framework 4，用系统自带 csc.exe 编译，不依赖 Electron）
// 职责：常驻托盘、拉起/看护 Node 服务、打开控制台、切换开机自启、退出时收干净。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunValue = "winbot";

    static NotifyIcon tray;
    static ContextMenuStrip menu;
    static ToolStripMenuItem openItem, copyItem, restartItem, autostartItem, logItem, quitItem;
    static Process node;
    static bool ownNode;                 // 这个 Node 进程是不是托盘拉起来的（退出时只杀自己拉起的）
    static bool quitting;
    static int restarts;
    static DateTime restartWindow = DateTime.MinValue;
    static string appRoot, dataDir, logPath, nodeExe, baseUrl;
    static int port = 5178;
    static Mutex single;

    [STAThread]
    static void Main(string[] args)
    {
        appRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        dataDir = Path.Combine(appRoot, "data");
        Directory.CreateDirectory(dataDir);

        // 命令行开关：开机自启的开关和「停止」都可以脚本化，托盘菜单也调同样的逻辑
        if (args.Length > 0)
        {
            string cmd = args[0].ToLowerInvariant();
            if (cmd == "--install-autostart") { SetAutostart(true); return; }
            if (cmd == "--remove-autostart") { SetAutostart(false); return; }
            if (cmd == "--stop") { StopEverything(); return; }
        }

        bool created;
        single = new Mutex(true, "winbot-tray-single-instance", out created);
        if (!created)
        {
            MessageBox.Show("winbot 已经在运行了，看右下角托盘。", "winbot", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        logPath = Path.Combine(dataDir, "tray.log");
        port = ReadPort();
        nodeExe = FindNode();
        Log("启动托盘，目录 " + appRoot + "，端口 " + port + "，node " + (nodeExe ?? "(没找到)"));
        try { File.WriteAllText(Path.Combine(dataDir, "tray.pid"), Process.GetCurrentProcess().Id.ToString()); } catch { }

        BuildTray();
        StartServer();

        var watchdog = new System.Windows.Forms.Timer();
        watchdog.Interval = 8000;
        watchdog.Tick += delegate { Watchdog(); };
        watchdog.Start();

        Application.Run();
    }

    /// <summary>脚本/菜单共用：按 pid 文件把托盘和它拉起的服务一起停掉。</summary>
    static void StopEverything()
    {
        string nodePidFile = Path.Combine(dataDir, "node.pid");
        if (File.Exists(nodePidFile))
        {
            try
            {
                int pid;
                if (int.TryParse(File.ReadAllText(nodePidFile).Trim(), out pid))
                {
                    var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    Process.Start(psi).WaitForExit(5000);
                }
            }
            catch { }
            try { File.Delete(nodePidFile); } catch { }
        }
        string trayPidFile = Path.Combine(dataDir, "tray.pid");
        if (File.Exists(trayPidFile))
        {
            try
            {
                int pid;
                if (int.TryParse(File.ReadAllText(trayPidFile).Trim(), out pid) && pid != Process.GetCurrentProcess().Id)
                {
                    var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /F");
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    Process.Start(psi).WaitForExit(5000);
                }
            }
            catch { }
            try { File.Delete(trayPidFile); } catch { }
        }
    }

    // ---------- 托盘 ----------

    static void BuildTray()
    {
        menu = new ContextMenuStrip();
        openItem = new ToolStripMenuItem("打开控制台", null, delegate { OpenConsole(); });
        openItem.Font = new Font(openItem.Font, FontStyle.Bold);
        copyItem = new ToolStripMenuItem("复制访问地址", null, delegate { CopyUrl(); });
        restartItem = new ToolStripMenuItem("重启服务", null, delegate { RestartServer(); });
        autostartItem = new ToolStripMenuItem("随 Windows 启动", null, delegate { ToggleAutostart(); });
        autostartItem.CheckOnClick = false;
        logItem = new ToolStripMenuItem("查看日志", null, delegate { OpenLog(); });
        quitItem = new ToolStripMenuItem("退出", null, delegate { Quit(); });
        menu.Items.Add(openItem);
        menu.Items.Add(copyItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(restartItem);
        menu.Items.Add(autostartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(logItem);
        menu.Items.Add(quitItem);
        menu.Opening += delegate { autostartItem.Checked = IsAutostart(); };

        tray = new NotifyIcon();
        tray.Text = "winbot";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.Icon = LoadIcon();
        tray.DoubleClick += delegate { OpenConsole(); };
        tray.BalloonTipTitle = "winbot";
    }

    static Icon LoadIcon()
    {
        try
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("winbot.ico");
            if (s != null) return new Icon(s);
        }
        catch { }
        return SystemIcons.Application;
    }

    static void Bubble(string text, ToolTipIcon icon)
    {
        try
        {
            tray.BalloonTipText = text;
            tray.BalloonTipIcon = icon;
            tray.ShowBalloonTip(3000);
        }
        catch { }
    }

    // ---------- 服务生命周期 ----------

    static string HealthUrl() { return "http://127.0.0.1:" + port + "/health"; }

    static string ConsoleUrl()
    {
        string token = "";
        try
        {
            string f = Path.Combine(dataDir, "ui-token");
            if (File.Exists(f)) token = File.ReadAllText(f).Trim();
        }
        catch { }
        baseUrl = "http://127.0.0.1:" + port + "/" + (token.Length > 0 ? "?token=" + token : "");
        return baseUrl;
    }

    static bool Healthy()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(HealthUrl());
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using (var resp = (HttpWebResponse)req.GetResponse())
            {
                return resp.StatusCode == HttpStatusCode.OK;
            }
        }
        catch { return false; }
    }

    static void StartServer()
    {
        if (Healthy())
        {
            // 已经有一个在跑（比如用 start.cmd 起的）：接管显示，但退出时不动它
            ownNode = false;
            SetStatus("已连接现有服务");
            return;
        }
        if (nodeExe == null)
        {
            Bubble("没找到 node.exe，请先装 Node.js 24.9 以上版本，或把路径写进 data\\node-path.txt", ToolTipIcon.Error);
            SetStatus("缺少 Node");
            return;
        }
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "\"" + Path.Combine(appRoot, "src", "main.js") + "\"";
            psi.WorkingDirectory = appRoot;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            // Node 输出的是 UTF-8，不显式指定会按系统代码页解码，日志里就成乱码
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["WINBOT_PORT"] = port.ToString();
            node = new Process();
            node.StartInfo = psi;
            node.EnableRaisingEvents = true;
            node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
            node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
            node.Exited += delegate { OnNodeExit(); };
            node.Start();
            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
            ownNode = true;
            try { File.WriteAllText(Path.Combine(dataDir, "node.pid"), node.Id.ToString()); } catch { }
            SetStatus("正在启动…");
            for (int i = 0; i < 60 && !Healthy(); i++) Thread.Sleep(500);
            if (Healthy()) { SetStatus("运行中 · " + port); Bubble("winbot 已启动，点托盘图标打开。", ToolTipIcon.Info); }
            else { SetStatus("启动没成功"); Bubble("服务没起来，右键 → 查看日志。", ToolTipIcon.Error); }
        }
        catch (Exception ex)
        {
            Log("启动失败: " + ex.Message);
            Bubble("启动失败：" + ex.Message, ToolTipIcon.Error);
            SetStatus("启动失败");
        }
    }

    static void OnNodeExit()
    {
        if (quitting) return;
        ownNode = false;
        SetStatus("服务停了");
        // 崩溃自愈：10 分钟内最多重启 3 次
        if ((DateTime.Now - restartWindow).TotalMinutes > 10) { restartWindow = DateTime.Now; restarts = 0; }
        if (restarts >= 3)
        {
            Bubble("服务反复退出，已停止自动重启，请看日志。", ToolTipIcon.Error);
            return;
        }
        restarts++;
        ThreadPool.QueueUserWorkItem(delegate
        {
            Thread.Sleep(2000);
            if (!quitting) StartServer();
        });
    }

    static void RestartServer()
    {
        KillOwnNode();
        Thread.Sleep(800);
        StartServer();
    }

    static void KillOwnNode()
    {
        try
        {
            if (ownNode && node != null && !node.HasExited)
            {
                var psi = new ProcessStartInfo("taskkill", "/PID " + node.Id + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi).WaitForExit(5000);
            }
        }
        catch (Exception ex) { Log("停止失败: " + ex.Message); }
        ownNode = false;
    }

    static void Watchdog()
    {
        if (quitting) return;
        if (!Healthy() && ownNode && (node == null || node.HasExited)) StartServer();
        SetStatus(Healthy() ? "运行中 · " + port : "服务未响应");
    }

    static void SetStatus(string text)
    {
        try
        {
            // 托盘提示最多 63 个字符（含 winbot 前缀）
            string t = "winbot · " + text;
            tray.Text = t.Length > 60 ? t.Substring(0, 60) : t;
        }
        catch { }
    }

    // ---------- 菜单动作 ----------

    static void OpenConsole()
    {
        try { Process.Start(ConsoleUrl()); }
        catch (Exception ex) { Bubble("打不开浏览器：" + ex.Message, ToolTipIcon.Error); }
    }

    static void CopyUrl()
    {
        try { Clipboard.SetText(ConsoleUrl()); Bubble("地址已复制", ToolTipIcon.Info); }
        catch { }
    }

    static void OpenLog()
    {
        try
        {
            if (File.Exists(logPath)) Process.Start("notepad.exe", logPath);
            else Bubble("还没有日志", ToolTipIcon.Info);
        }
        catch { }
    }

    static bool IsAutostart()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey, false))
            {
                if (k == null) return false;
                object v = k.GetValue(RunValue);
                return v != null;
            }
        }
        catch { return false; }
    }

    /// <summary>写/删注册表 Run 项；菜单和 --install-autostart 共用。</summary>
    static void SetAutostart(bool on)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (on) k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
            else k.DeleteValue(RunValue, false);
        }
    }

    static void ToggleAutostart()
    {
        try
        {
            bool now = IsAutostart();
            SetAutostart(!now);
            Bubble(now ? "已取消开机自启" : "已设为开机自启", ToolTipIcon.Info);
        }
        catch (Exception ex) { Bubble("改开机自启失败：" + ex.Message, ToolTipIcon.Error); }
    }

    static void Quit()
    {
        quitting = true;
        KillOwnNode();
        try { File.Delete(Path.Combine(dataDir, "tray.pid")); } catch { }
        try { tray.Visible = false; tray.Dispose(); } catch { }
        Application.Exit();
    }

    // ---------- 配置 ----------

    static int ReadPort()
    {
        try
        {
            string env = Environment.GetEnvironmentVariable("WINBOT_PORT");
            if (!string.IsNullOrEmpty(env)) return int.Parse(env);
            string cfg = Path.Combine(dataDir, "config.json");
            if (File.Exists(cfg))
            {
                string text = File.ReadAllText(cfg);
                int i = text.IndexOf("\"port\"", StringComparison.Ordinal);
                if (i >= 0)
                {
                    int colon = text.IndexOf(':', i);
                    if (colon > 0)
                    {
                        string rest = text.Substring(colon + 1).TrimStart();
                        int end = 0;
                        while (end < rest.Length && char.IsDigit(rest[end])) end++;
                        if (end > 0) return int.Parse(rest.Substring(0, end));
                    }
                }
            }
        }
        catch { }
        return 5178;
    }

    static string FindNode()
    {
        try
        {
            string hint = Path.Combine(dataDir, "node-path.txt");
            if (File.Exists(hint))
            {
                string p = File.ReadAllText(hint).Trim();
                if (p.Length > 0 && File.Exists(p)) return p;
            }
        }
        catch { }
        // 先看 PATH
        try
        {
            var psi = new ProcessStartInfo("where.exe", "node.exe");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            var pr = Process.Start(psi);
            string outp = pr.StandardOutput.ReadToEnd();
            pr.WaitForExit(3000);
            foreach (string line in outp.Split('\n'))
            {
                string t = line.Trim();
                if (t.Length > 0 && File.Exists(t) && IsNode24(t)) return t;
            }
        }
        catch { }
        // 再找本机已知的 24.x
        string[] candidates = new string[] {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\..\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
            Environment.GetEnvironmentVariable("USERPROFILE") + @"\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
            Environment.GetEnvironmentVariable("USERPROFILE") + @"\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
            @"C:\Program Files\nodejs\node.exe"
        };
        foreach (string c in candidates)
        {
            try { if (c != null && File.Exists(c) && IsNode24(c)) return c; } catch { }
        }
        return null;
    }

    static bool IsNode24(string path)
    {
        try
        {
            var psi = new ProcessStartInfo(path, "-v");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            var pr = Process.Start(psi);
            string v = pr.StandardOutput.ReadToEnd().Trim();
            pr.WaitForExit(3000);
            // v 形如 v24.22.3
            if (v.StartsWith("v"))
            {
                string[] parts = v.Substring(1).Split('.');
                int major;
                if (parts.Length > 0 && int.TryParse(parts[0], out major)) return major >= 24;
            }
        }
        catch { }
        return false;
    }

    static void Log(string line)
    {
        try
        {
            string entry = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine;
            lock (typeof(Program))
            {
                // 简单滚动：超过 4MB 就换一份
                if (File.Exists(logPath) && new FileInfo(logPath).Length > 4 * 1024 * 1024)
                {
                    string old = logPath + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(logPath, old);
                }
                File.AppendAllText(logPath, entry, Encoding.UTF8);
            }
        }
        catch { }
    }
}
