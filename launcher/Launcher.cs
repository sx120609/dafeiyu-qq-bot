// Tray launcher for the local Dafeiyu deployment. Built with the .NET Framework compiler
// that ships with Windows (C# 5): see launcher/build.ps1. Every WSL command runs without a
// console window, so nothing appears on screen and nothing can be closed by accident.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Dafeiyu
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool autostart = Array.IndexOf(args, "--autostart") >= 0;
            bool created;
            using (var mutex = new Mutex(true, @"Local\DafeiyuLauncher", out created))
            {
                if (!created)
                {
                    // Already in the tray: a second double-click just opens the console.
                    if (!autostart) new Backend().OpenConsole();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext(autostart));
            }
        }
    }

    sealed class Backend
    {
        public const string Distro = "Ubuntu";
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "Dafeiyu";
        public readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        string linuxRoot;

        public string Wsl { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe"); } }
        string RuntimeFile(string name) { return Path.Combine(Root, ".runtime", name); }

        public Dictionary<string, object> BridgeConfig()
        {
            return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(RuntimeFile("bridge.json")));
        }
        public string BaseUrl
        {
            get
            {
                object port;
                try { if (BridgeConfig().TryGetValue("port", out port)) return "http://127.0.0.1:" + port; } catch { }
                return "http://127.0.0.1:18191";
            }
        }
        string ConsoleToken { get { return (string)BridgeConfig()["consoleToken"]; } }

        public static string Run(string file, string arguments, int timeout)
        {
            var info = new ProcessStartInfo(file, arguments);
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            using (var process = Process.Start(info))
            {
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(timeout)) { try { process.Kill(); } catch { } throw new TimeoutException(file + " timed out"); }
                if (process.ExitCode != 0) throw new InvalidOperationException((error.Result + output.Result).Trim());
                return output.Result;
            }
        }
        string WslRun(string arguments, int timeout) { return Run(Wsl, "-d " + Distro + " " + arguments, timeout); }

        string LinuxRoot
        {
            get
            {
                if (linuxRoot == null) linuxRoot = WslRun("-- wslpath -u \"" + Root.Replace('\\', '/') + "\"", 30000).Trim();
                return linuxRoot;
            }
        }

        // WSL shuts the distro down once no Windows process is attached, so one windowless
        // wsl.exe stays attached for as long as the bot should run.
        void EnsureKeepalive()
        {
            var file = RuntimeFile("wsl-keepalive.json");
            try
            {
                var record = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                var process = Process.GetProcessById(Convert.ToInt32(record["pid"]));
                if (process.ProcessName.Equals("wsl", StringComparison.OrdinalIgnoreCase)) return;
            }
            catch { }
            var info = new ProcessStartInfo(Wsl, "-d " + Distro + " --exec /bin/bash " + LinuxRoot + "/scripts/keepalive.sh");
            info.UseShellExecute = false; info.CreateNoWindow = true;
            var started = Process.Start(info);
            File.WriteAllText(file, "{\"pid\":" + started.Id + "}", new UTF8Encoding(false));
        }
        void StopKeepalive()
        {
            try
            {
                var record = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(RuntimeFile("wsl-keepalive.json")));
                var process = Process.GetProcessById(Convert.ToInt32(record["pid"]));
                if (process.ProcessName.Equals("wsl", StringComparison.OrdinalIgnoreCase)) process.Kill();
            }
            catch { }
        }

        public void Start()
        {
            EnsureKeepalive();
            WslRun("-u root -- systemctl start docker", 120000);
            WslRun("-u root -- docker start qq-ai", 120000);
            WslRun("-- systemctl --user start dafeiyu-bot.service", 120000);
            for (int i = 0; i < 90; i++)
            {
                try { Request("GET", "/healthz", null, false); return; } catch { Thread.Sleep(1000); }
            }
            throw new TimeoutException("控制台服务没有在 90 秒内就绪");
        }
        public void Stop()
        {
            try { WslRun("-- systemctl --user stop dafeiyu-bot.service dafeiyu-codex.service", 60000); } catch { }
            try { WslRun("-u root -- docker stop qq-ai", 60000); } catch { }
            StopKeepalive();
        }

        public Dictionary<string, object> Request(string method, string route, string body, bool authorized)
        {
            var request = (HttpWebRequest)WebRequest.Create(BaseUrl + route);
            request.Method = method; request.Proxy = null; request.Timeout = 60000;
            if (authorized)
            {
                request.Headers["Authorization"] = "Bearer " + ConsoleToken;
                request.Headers["Origin"] = BaseUrl;
            }
            if (body != null)
            {
                var bytes = Encoding.UTF8.GetBytes(body);
                request.ContentType = "application/json"; request.ContentLength = bytes.Length;
                using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                if (response == null) throw;
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var value = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object message;
                    throw new InvalidOperationException(value != null && value.TryGetValue("error", out message) ? Convert.ToString(message) : error.Message);
                }
            }
        }
        public string RuntimeAction(string action)
        {
            var result = Request("POST", "/console/api/runtime/action", "{\"action\":\"" + action + "\"}", true);
            object message;
            return result.TryGetValue("message", out message) ? Convert.ToString(message) : "已完成";
        }

        // Before a password exists the console is opened with the private token for first-time setup.
        public void OpenConsole()
        {
            string url = BaseUrl + "/console/";
            try
            {
                var auth = Request("GET", "/console/api/auth", null, false);
                if (!(bool)auth["passwordSet"]) url += "#" + ConsoleToken;
            }
            catch { }
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }

        public string LaunchCommand { get { return "\"" + Application.ExecutablePath + "\" --autostart"; } }
        public bool AutostartEnabled
        {
            get
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                    return key != null && string.Equals(key.GetValue(RunValue) as string, LaunchCommand, StringComparison.OrdinalIgnoreCase);
            }
            set
            {
                using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (value) key.SetValue(RunValue, LaunchCommand);
                    else if (key.GetValue(RunValue) != null) key.DeleteValue(RunValue);
                }
            }
        }
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly Backend backend = new Backend();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ToolStripMenuItem status = new ToolStripMenuItem("正在启动…") { Enabled = false };
        readonly ToolStripMenuItem toggle = new ToolStripMenuItem("暂停回复") { Enabled = false };
        readonly ToolStripMenuItem autostartItem = new ToolStripMenuItem("开机自启");
        readonly SynchronizationContext ui;
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 15000 };
        bool running, connected, ready, busy, kickedNotified;

        public TrayContext(bool autostart)
        {
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            tray.Text = "大肥鱼 · 正在启动";
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("打开控制台", null, delegate { Background(() => backend.OpenConsole(), null); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            toggle.Click += delegate { Act(running ? "bot-pause" : "bot-resume"); };
            var restartBot = new ToolStripMenuItem("重启机器人", null, delegate { Act("bot-restart"); });
            var restartNapcat = new ToolStripMenuItem("重启 NapCat", null, delegate { Act("napcat-restart"); });
            autostartItem.Click += delegate
            {
                try { backend.AutostartEnabled = !autostartItem.Checked; autostartItem.Checked = backend.AutostartEnabled; }
                catch (Exception error) { Notify("开机自启设置失败：" + error.Message, ToolTipIcon.Error); }
            };
            var stopAll = new ToolStripMenuItem("停止大肥鱼并退出", null, delegate { StopAndExit(); });
            var quit = new ToolStripMenuItem("退出托盘（机器人继续运行）", null, delegate { Quit(); });
            menu.Items.AddRange(new ToolStripItem[] { status, open, new ToolStripSeparator(), toggle, restartBot, restartNapcat,
                new ToolStripSeparator(), autostartItem, new ToolStripSeparator(), stopAll, quit });
            menu.Opening += delegate { autostartItem.Checked = SafeAutostart(); };
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { Background(() => backend.OpenConsole(), null); };
            tray.Visible = true;
            poll.Tick += delegate { Refresh(); };

            Background(() => backend.Start(), error =>
            {
                if (error != null) { SetStatus("启动失败", "大肥鱼 · 启动失败"); Notify("启动失败：" + error.Message, ToolTipIcon.Error); return; }
                ready = true; poll.Start(); Refresh();
                if (autostart) Notify("大肥鱼已在后台启动，双击托盘图标打开控制台。", ToolTipIcon.Info);
                else Background(() => backend.OpenConsole(), null);
            });
        }

        bool SafeAutostart() { try { return backend.AutostartEnabled; } catch { return false; } }

        void Background(Action work, Action<Exception> done)
        {
            Task.Run(() =>
            {
                Exception failure = null;
                try { work(); } catch (Exception error) { failure = error; }
                ui.Post(delegate { if (done != null) done(failure); else if (failure != null) Notify(failure.Message, ToolTipIcon.Error); }, null);
            });
        }

        void SetStatus(string text, string tooltip)
        {
            status.Text = text;
            tray.Text = tooltip.Length > 63 ? tooltip.Substring(0, 63) : tooltip;
        }

        void Refresh()
        {
            if (!ready) return;
            Dictionary<string, object> overview = null;
            Background(() => { overview = backend.Request("GET", "/console/api/overview", null, true); }, error =>
            {
                if (error != null) { SetStatus("控制台服务未响应", "大肥鱼 · 服务未响应"); toggle.Enabled = false; return; }
                var bot = overview["bot"] as Dictionary<string, object>;
                bool active = bot != null && Convert.ToString(bot["state"]) == "active";
                object value;
                connected = active && bot.TryGetValue("connected", out value) && value is bool && (bool)value;
                running = active && bot.TryGetValue("running", out value) && value is bool && (bool)value;
                // Tencent dropped the session: say so once, and keep it in the menu until messages arrive again.
                bool kicked = active && bot.TryGetValue("kickedAt", out value) && value != null;
                if (kicked && !kickedNotified) Notify("QQ 被腾讯踢下线了，机器人收不到也发不出消息。打开控制台的「QQ 登录」用机器人的手机 QQ 重新扫码。", ToolTipIcon.Warning);
                kickedNotified = kicked;
                string text = !active ? "机器人引擎离线" : kicked ? "QQ 被踢下线，请在控制台扫码" : !connected ? "未连接 QQ，请在控制台扫码" : running ? "正在回复" : "已暂停回复";
                SetStatus(text, "大肥鱼 · " + text);
                toggle.Text = running ? "暂停回复" : "开始回复";
                toggle.Enabled = connected && !busy;
            });
        }

        void Act(string action)
        {
            if (busy) return;
            busy = true; toggle.Enabled = false;
            string message = null;
            Background(() => { message = backend.RuntimeAction(action); }, error =>
            {
                busy = false;
                Notify(error != null ? error.Message : message, error != null ? ToolTipIcon.Error : ToolTipIcon.Info);
                Refresh();
            });
        }

        void Notify(string text, ToolTipIcon icon)
        {
            tray.BalloonTipTitle = "大肥鱼"; tray.BalloonTipText = text; tray.BalloonTipIcon = icon;
            tray.ShowBalloonTip(4000);
        }

        void StopAndExit()
        {
            if (MessageBox.Show("停止后机器人会下线，直到下次启动。确定停止吗？", "大肥鱼", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            ready = false; poll.Stop(); SetStatus("正在停止…", "大肥鱼 · 正在停止");
            Background(() => backend.Stop(), delegate { Quit(); });
        }

        void Quit()
        {
            poll.Stop(); tray.Visible = false; tray.Dispose();
            ExitThread();
        }
    }
}
