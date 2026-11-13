# -*- coding: utf-8 -*-
"""
桌面启动程序构建脚本 (_studio/tools/build_desktop_app.py)
职责：
1. 调用 Windows 内置 .NET C# 编译器 (csc.exe)，结合项目图标 (ui/icon.ico) 编译纯桌面软件模式的 Maersy.exe：
   - 检测本机运行环境，缺少 Python、Node.js 或 npm 工具时自动准备；
   - 后台静默启动 Python 服务 _studio/server.py（完全无黑色命令行窗口）；
   - 通过 Chromium (Edge/Chrome) --app=http://localhost:8001/admin 模式以无地址栏独立软件窗口启动；
   - 实时监测独立窗口句柄 (HWND) 生命周期，关窗后等待后台写入结束，再通过本机接口退出；
   - 重复双击时直接唤醒并置顶已打开的独立窗口，防止重复多开。
2. 生成可移植启动器，只有 --install-desktop 显式复制到桌面：
   - 项目根目录：Maersy.exe
   - 系统桌面：Desktop/Maersy.exe
用法：python _studio/tools/build_desktop_app.py
"""

import os
import sys
import shutil
import tempfile
import subprocess

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
STUDIO_DIR = os.path.dirname(TOOLS_DIR)
PROJECT_ROOT = os.path.dirname(STUDIO_DIR)

ICON_PATH = os.path.join(PROJECT_ROOT, "ui", "icon.ico")
ROOT_EXE_PATH = os.path.join(PROJECT_ROOT, "Maersy.exe")
DESKTOP_DIR = os.path.join(os.path.expanduser("~"), "Desktop")
DESKTOP_EXE_PATH = os.path.join(DESKTOP_DIR, "Maersy.exe")


def ensure_transparent_icon(icon_path):
    """
    规范化打包高质量多尺寸图标 (ICO)：
    保留高保真 Squircle 白底圆角矩形卡片与纯黑 MAERS 标志，
    四个圆角外侧平滑透明抗锯齿，
    包含 256x256 / 128x128 / 64x64 / 48x48 / 32x32 / 16x16 全规格层级。
    """
    from PIL import Image

    im = Image.open(icon_path).convert("RGBA")
    # 若尺寸不为 256x256，采用高质量 Lanczos 滤波器平滑缩放至 256x256
    if im.size != (256, 256):
        resample_mode = getattr(Image, "Resampling", Image).LANCZOS
        im = im.resize((256, 256), resample_mode)

    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    im.save(icon_path, format="ICO", sizes=sizes)


def find_csc_compiler():
    """查找 Windows 内置 .NET Framework C# 编译器 (csc.exe)"""
    win_dir = os.environ.get("WINDIR", r"C:\Windows")
    candidates = [
        os.path.join(win_dir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        os.path.join(win_dir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def generate_launcher_cs_source(fallback_project_root, fallback_python_exe):
    """生成 C# 原生启动器源码，静默等待服务就绪及退出前的数据写入。"""
    escaped_root = fallback_project_root.replace("\\", "\\\\")
    escaped_py = fallback_python_exe.replace("\\", "\\\\")
    with open(os.path.join(TOOLS_DIR, "desktop_runtime.cs"), encoding="utf-8") as source:
        runtime_source = source.read()
    return f"""using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Reflection;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("MAERS Public Web")]
[assembly: AssemblyDescription("MAERS Public Web — 个人知识与创作中心桌面启动器")]
[assembly: AssemblyProduct("MAERS Public Web")]
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]

namespace MAERSLauncher
{{
    internal static class Program
    {{
        // 公开构建不写入本机路径；从程序所在目录定位项目并在运行时寻找 Python
        private const string FallbackProjectRoot = "{escaped_root}";
        private const string FallbackPythonExe = "{escaped_py}";
        private static int DefaultPort;
        private const string EntryPath = "/admin";
        private static readonly object LogLock = new object();

        // Win32 窗口管理 API：用于检测独立应用窗口打开/关闭状态及置顶唤醒
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("shell32.dll")]
        private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid,
            [Out, MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {{
            int GetCount(out uint cProps);
            int GetAt(uint iProp, out PROPERTYKEY pkey);
            int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        }}

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct PROPERTYKEY
        {{
            public Guid fmtid;
            public uint pid;
        }}

        [StructLayout(LayoutKind.Explicit)]
        private struct PROPVARIANT
        {{
            [FieldOffset(0)]
            public ushort vt;
            [FieldOffset(8)]
            public IntPtr pointerValue;
        }}

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PROPVARIANT pvar);

        private const int SW_RESTORE = 9;

        [STAThread]
        private static void Main()
        {{
            Process serverProc = null;
            Process browserProc = null;
            Mutex lifecycleOwner = null;
            bool ownsLifecycle = false;
            string serverToken = null;
            try
            {{
                string projectDir = ResolveProjectDirectory();
                if (projectDir == null) throw new Exception("未找到 MAERS 项目目录。");
                var runtime = new DesktopRuntime(projectDir);
                string python = runtime.PreparePython(FallbackPythonExe);
                DefaultPort = ReadServerPort(projectDir, python);
                string appUrl = "http://localhost:" + DefaultPort + EntryPath;

                // 同一端口只驻留一个窗口守护者；旧守护者退出后允许接管遗留服务。
                lifecycleOwner = new Mutex(false, @"Local\\MAERS_Studio_" + DefaultPort);
                try {{ ownsLifecycle = lifecycleOwner.WaitOne(0); }}
                catch (AbandonedMutexException) {{ ownsLifecycle = true; }}
                IntPtr existingWin = FindMaersAppWindow();
                if (!ownsLifecycle)
                {{
                    if (existingWin != IntPtr.Zero)
                    {{
                        ActivateWindow(existingWin);
                    }}
                    else if (IsMaersServerRunning(DefaultPort))
                    {{
                        using (Process reopened = OpenStandaloneWindow(appUrl)) {{ }}
                    }}
                    return;
                }}

                // 2. 若后台服务尚未在配置端口运行，则以无黑框静默方式启动 _studio/server.py
                if (!IsMaersServerRunning(DefaultPort))
                {{
                    try {{ runtime.PrepareTooling(); }}
                    catch (Exception ex)
                    {{
                        MessageBox.Show(
                            "本机私密管理或构建工具准备失败，可以先使用基础功能。\\n" + ex.Message,
                            "MAERS Public Web 环境准备",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                    }}

                    serverProc = StartSilentPythonServer(projectDir, python);
                }}
                if (!WaitUntilServerReady(DefaultPort, serverProc))
                {{
                    if (serverProc != null) StopServerProcess(serverProc, null);
                    return;
                }}
                serverToken = ReadServerToken();
                if (string.IsNullOrEmpty(serverToken)) throw new Exception("无法取得本地服务会话。");

                // 已有窗口也需要接管，不能仅唤醒后退出而留下无人管理的服务。
                if (existingWin != IntPtr.Zero) ActivateWindow(existingWin);
                else browserProc = OpenStandaloneWindow(appUrl);

                // 新启动与复用的服务遵守同一关窗退出规则。
                MonitorWindowAndStopServer(serverProc, existingWin, serverToken);
            }}
            catch (Exception ex)
            {{
                if (serverProc != null) StopServerProcess(serverProc, serverToken);
                MessageBox.Show(
                    "启动 MAERS Public Web 时发生异常：\\n" + ex.Message,
                    "MAERS Public Web 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }}
            finally
            {{
                if (browserProc != null) browserProc.Dispose();
                if (serverProc != null) serverProc.Dispose();
                if (ownsLifecycle) lifecycleOwner.ReleaseMutex();
                if (lifecycleOwner != null) lifecycleOwner.Dispose();
            }}
        }}

        private static void ActivateWindow(IntPtr window)
        {{
            if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }}

        // 后台无黑框静默启动 python _studio/server.py（由子进程直接写入 studio.log，避免父进程退出引发断管死锁）
        private static Process StartSilentPythonServer(string projectDir, string python)
        {{
            string studioDir = Path.Combine(projectDir, "_studio");
            string scriptPath = Path.Combine(studioDir, "server.py");
            string localDir = Path.Combine(studioDir, ".local");
            Directory.CreateDirectory(localDir);
            string logPath = Path.Combine(localDir, "studio.log");

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = python;
            psi.Arguments = "-B -u \\"" + scriptPath + "\\"";
            psi.WorkingDirectory = studioDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["MAERS_STUDIO_LOG"] = logPath;

            Process child = new Process();
            child.StartInfo = psi;
            child.Start();
            return child;
        }}

        // 用已确认的解释器读取当前端口配置。
        private static int ReadServerPort(string projectDir, string python)
        {{
            var info = new ProcessStartInfo(python);
            info.Arguments = "-B \\"" + Path.Combine(projectDir, "_studio", "config.py") + "\\" --port";
            info.WorkingDirectory = projectDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            using (var process = Process.Start(info))
            {{
                if (!process.WaitForExit(10000)) {{ process.Kill(); throw new Exception("读取端口配置超时。"); }}
                int port;
                if (process.ExitCode != 0 || !int.TryParse(process.StandardOutput.ReadToEnd().Trim(), out port) || port < 1 || port > 65535)
                    throw new Exception("后端端口配置无效。");
                return port;
            }}
        }}

        private static bool WaitUntilServerReady(int port, Process child)
        {{
            Stopwatch elapsed = Stopwatch.StartNew();
            while (true)
            {{
                Dictionary<string, object> status = ReadStudioStatus(port);
                if (status != null)
                {{
                    string state = Convert.ToString(status["state"]);
                    if (state == "ready" && !Convert.ToBoolean(status["draining"])) return true;
                    if (state == "error")
                    {{
                        MessageBox.Show(Convert.ToString(status["message"]) + "。详细记录位于 _studio/.local/studio.log。", "MAERS Public Web 启动失败");
                        return false;
                    }}
                }}
                if ((child != null && child.HasExited) || (child == null && status == null && elapsed.ElapsedMilliseconds > 10000))
                {{
                    MessageBox.Show("本地服务未能启动，请查看 _studio/.local/studio.log。", "MAERS Public Web 启动失败");
                    return false;
                }}
                Thread.Sleep(150);
            }}
        }}

        // 以 --app 模式启动无地址栏独立软件窗口（优先匹配系统默认浏览器以共享本地缓存与窗口尺寸记忆）
        private static Process OpenStandaloneWindow(string url)
        {{
            string browserExe = ResolveChromiumBrowser();
            if (!string.IsNullOrEmpty(browserExe))
            {{
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browserExe;
                psi.Arguments = "--app=" + url;
                psi.UseShellExecute = false;
                return Process.Start(psi);
            }}

            // 回退：使用系统默认浏览器打开
            ProcessStartInfo fallbackPsi = new ProcessStartInfo();
            fallbackPsi.FileName = url;
            fallbackPsi.UseShellExecute = true;
            return Process.Start(fallbackPsi);
        }}

        // 解析系统首选的 Chromium 内核浏览器 (Edge / Chrome)
        private static string ResolveChromiumBrowser()
        {{
            string progId = "";
            try
            {{
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice"))
                {{
                    if (key != null)
                    {{
                        object val = key.GetValue("ProgId");
                        if (val != null) progId = val.ToString();
                    }}
                }}
            }}
            catch {{ }}

            string chromePath = FindFirstExisting(new string[]
            {{
                @"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                @"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\\Chrome\\Application\\chrome.exe")
            }});

            string edgePath = FindFirstExisting(new string[]
            {{
                @"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                @"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\\Edge\\Application\\msedge.exe")
            }});

            if (progId.StartsWith("ChromeHTML", StringComparison.OrdinalIgnoreCase) && chromePath != null)
                return chromePath;
            if (progId.StartsWith("MSEdge", StringComparison.OrdinalIgnoreCase) && edgePath != null)
                return edgePath;

            return chromePath ?? edgePath;
        }}

        private static string FindFirstExisting(string[] paths)
        {{
            foreach (string p in paths)
            {{
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }}
            return null;
        }}

        // 监测独立窗口句柄：当窗口被用户关闭后，自动停止后台 Python 服务进程
        private static void MonitorWindowAndStopServer(Process serverProc, IntPtr existingWindow, string serverToken)
        {{
            bool closed = WaitForWindowClose(existingWindow, FindMaersAppWindow, IsWindow,
                delegate {{ return IsTrackedServerRunning(serverProc, serverToken); }}, Thread.Sleep);
            if (closed) StopServerProcess(serverProc, serverToken);
            else if (IsTrackedServerRunning(serverProc, serverToken))
            {{
                throw new Exception("未能识别 MAERS 独立窗口，请使用 Edge 或 Chrome 打开桌面入口。");
            }}
        }}

        // 窗口才是退出依据；Chrome / Edge 可复用其他浏览器窗口的进程。
        private static bool WaitForWindowClose(IntPtr trackedHwnd, Func<IntPtr> findWindow,
            Func<IntPtr, bool> isWindow, Func<bool> serverRunning, Action<int> pause)
        {{
            for (int attempt = 0; trackedHwnd == IntPtr.Zero && attempt < 100; attempt++)
            {{
                if (!serverRunning()) return false;
                trackedHwnd = findWindow();
                if (trackedHwnd == IntPtr.Zero) pause(150);
            }}
            if (trackedHwnd == IntPtr.Zero) return false;
            int absent = 0;
            while (serverRunning())
            {{
                if (isWindow(trackedHwnd)) absent = 0;
                else
                {{
                    IntPtr another = findWindow();
                    if (another != IntPtr.Zero) {{ trackedHwnd = another; absent = 0; }}
                    else if (++absent >= 3) return true;
                }}
                pause(400);
            }}
            return false;
        }}

        private static bool IsTrackedServerRunning(Process proc, string token)
        {{
            if (proc != null) return !proc.HasExited;
            return !string.IsNullOrEmpty(token) && string.Equals(ReadServerToken(), token, StringComparison.Ordinal);
        }}

        // 查找当前打开的本地 MAERS --app 独立桌面窗口句柄（严格排除普通多标签浏览器中的线上网页）
        private static IntPtr FindMaersAppWindow()
        {{
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {{
                if (!IsWindowVisible(hWnd)) return true;

                StringBuilder clsSb = new StringBuilder(128);
                GetClassName(hWnd, clsSb, clsSb.Capacity);
                string cls = clsSb.ToString();
                if (!cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;

                StringBuilder titleSb = new StringBuilder(256);
                GetWindowText(hWnd, titleSb, titleSb.Capacity);
                string title = titleSb.ToString();

                if (IsMaersStandaloneWindowTitle(title, HasChromiumStandaloneAppId(hWnd)))
                {{
                    found = hWnd;
                    return false;
                }}
                return true;
            }}, IntPtr.Zero);
            return found;
        }}

        // 读取窗口的 Windows Shell AppUserModelID，区分 Chromium --app 独立窗口 (_crx_) 与普通浏览器窗口
        private static bool HasChromiumStandaloneAppId(IntPtr hWnd)
        {{
            try
            {{
                Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
                IPropertyStore store;
                if (SHGetPropertyStoreForWindow(hWnd, ref iid, out store) != 0 || store == null) return false;
                PROPERTYKEY key = new PROPERTYKEY
                {{
                    fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
                    pid = 5
                }};
                PROPVARIANT pv;
                if (store.GetValue(ref key, out pv) != 0) return false;
                try
                {{
                    if (pv.vt != 31 || pv.pointerValue == IntPtr.Zero) return false;
                    string appId = Marshal.PtrToStringUni(pv.pointerValue) ?? "";
                    return appId.IndexOf("_crx_", StringComparison.OrdinalIgnoreCase) >= 0;
                }}
                finally
                {{
                    PropVariantClear(ref pv);
                }}
            }}
            catch
            {{
                return false;
            }}
        }}

        // 判定窗口标题是否属于当前端口的本地独立应用窗口，物理隔离线上 PWA、跨端口实例与普通浏览器标签页
        private static bool IsMaersStandaloneWindowTitle(string title, bool hasStandaloneAppId)
        {{
            if (string.IsNullOrEmpty(title)) return false;
            string normalized = title.Replace("\\u200B", "").Trim();
            string[] browserSuffixes = new string[]
            {{
                " - Google Chrome",
                " - Microsoft Edge",
                " - Brave",
                " - Vivaldi",
                " - Opera",
                " - Chromium",
                " - Cent Browser"
            }};
            foreach (string suffix in browserSuffixes)
            {{
                if (normalized.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return false;
            }}
            int port = DefaultPort > 0 ? DefaultPort : 8000;
            string expectedBadge = "[Local:" + port + "]";
            if (normalized.EndsWith(expectedBadge, StringComparison.OrdinalIgnoreCase))
            {{
                return hasStandaloneAppId ||
                    normalized.StartsWith("MAERS Admin", StringComparison.OrdinalIgnoreCase) ||
                    normalized.StartsWith("MAERS Public Web", StringComparison.OrdinalIgnoreCase) ||
                    normalized.StartsWith("404 ", StringComparison.OrdinalIgnoreCase);
            }}
            return false;
        }}

        // 退出前等待服务提交或回滚已接收的操作，禁止直接杀进程。
        private static void StopServerProcess(Process proc, string expectedToken)
        {{
            if (proc == null && string.IsNullOrEmpty(expectedToken)) return;
            for (int attempt = 0; attempt < 3; attempt++)
            {{
                try
                {{
                    if (proc != null && proc.HasExited) return;
                    string token = ReadServerToken();
                    if (string.IsNullOrEmpty(token))
                    {{
                        Thread.Sleep(150);
                        continue;
                    }}
                    if (expectedToken != null && token != expectedToken) return;
                    HttpWebRequest shutdown = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + DefaultPort + "/api/studio/shutdown");
                    shutdown.Method = "POST";
                    shutdown.ContentType = "application/json";
                    shutdown.Headers["Origin"] = "http://127.0.0.1:" + DefaultPort;
                    shutdown.Headers["X-MAERS-Token"] = token;
                    shutdown.Timeout = 3000;
                    shutdown.ReadWriteTimeout = 3000;
                    shutdown.KeepAlive = false;
                    shutdown.Proxy = null;
                    byte[] body = Encoding.UTF8.GetBytes("{{}}");
                    shutdown.ContentLength = body.Length;
                    using (Stream output = shutdown.GetRequestStream()) output.Write(body, 0, body.Length);
                    if (ReadJson(shutdown) == null)
                    {{
                        Thread.Sleep(150);
                        continue;
                    }}
                    if (proc != null) proc.WaitForExit();
                    else while (IsTrackedServerRunning(null, token)) Thread.Sleep(150);
                    return;
                }}
                catch (WebException) {{ Thread.Sleep(150); }}
                catch (InvalidOperationException) {{ return; }}
                catch (IOException) {{ Thread.Sleep(150); }}
            }}
        }}

        private static string ReadServerToken()
        {{
            HttpWebRequest session = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + DefaultPort + "/api/session");
            session.Headers["X-MAERS-Client"] = "studio";
            session.Timeout = 1500;
            session.ReadWriteTimeout = 1500;
            session.KeepAlive = false;
            session.Proxy = null;
            Dictionary<string, object> credentials = ReadJson(session);
            return credentials != null && credentials.ContainsKey("token") ? Convert.ToString(credentials["token"]) : null;
        }}

        private static Dictionary<string, object> ReadJson(HttpWebRequest request)
        {{
            try
            {{
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {{
                    if (response.Headers["X-MAERS-App"] != "MAERS-Public-Web") return null;
                    using (StreamReader input = new StreamReader(response.GetResponseStream()))
                        return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(input.ReadToEnd());
                }}
            }}
            catch (WebException) {{ return null; }}
        }}

        private static Dictionary<string, object> ReadStudioStatus(int port)
        {{
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/studio/status");
            request.Proxy = null;
            request.KeepAlive = false;
            request.Timeout = 1500;
            request.ReadWriteTimeout = 1500;
            return ReadJson(request);
        }}

        // 探测指定端口是否已运行 MAERS-Public-Web 服务
        private static bool IsMaersServerRunning(int port)
        {{
            return ReadStudioStatus(port) != null;
        }}

        // 解析有效的项目根目录（支持置于项目根目录、_studio 目录或桌面任意位置）
        private static string ResolveProjectDirectory()
        {{
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\', '/');
            if (IsValidProjectDir(baseDir)) return baseDir;

            try
            {{
                DirectoryInfo parent = Directory.GetParent(baseDir);
                if (parent != null && IsValidProjectDir(parent.FullName))
                {{
                    return parent.FullName;
                }}
            }}
            catch {{ }}

            if (IsValidProjectDir(FallbackProjectRoot)) return FallbackProjectRoot;
            return null;
        }}

        private static bool IsValidProjectDir(string dir)
        {{
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return false;
            return File.Exists(Path.Combine(Path.Combine(dir, "_studio"), "server.py"));
        }}
    }}
}}
{runtime_source}
"""


def _retire_dir_for(target_path):
    """返回与目标可执行文件同盘符的隐藏暂存目录，用于无痕移走运行中的旧映像。"""
    target_drive = os.path.splitdrive(os.path.abspath(target_path))[0].upper()
    local_dir = os.path.join(STUDIO_DIR, ".local")
    if os.path.splitdrive(os.path.abspath(local_dir))[0].upper() == target_drive:
        os.makedirs(local_dir, exist_ok=True)
        return local_dir
    temp_dir = tempfile.gettempdir()
    if os.path.splitdrive(os.path.abspath(temp_dir))[0].upper() == target_drive:
        return temp_dir
    return os.path.dirname(os.path.abspath(target_path))


def replace_executable_safely(source_exe, target_exe):
    """安全替换可执行文件；若目标正在运行被锁定，先同卷原子移入暂存目录再写入新版本。"""
    retire_dir = _retire_dir_for(target_exe)
    for name in os.listdir(retire_dir):
        if name.startswith(".maersy-retired-") and name.endswith(".exe"):
            try:
                os.remove(os.path.join(retire_dir, name))
            except OSError:
                pass
    try:
        shutil.copy2(source_exe, target_exe)
    except PermissionError:
        retired = os.path.join(retire_dir, f".maersy-retired-{os.getpid()}.exe")
        if os.path.exists(retired):
            os.remove(retired)
        os.replace(target_exe, retired)
        shutil.copy2(source_exe, target_exe)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if not os.path.isfile(ICON_PATH):
        raise FileNotFoundError(f"未找到项目图标文件: {ICON_PATH}")

    print(f"[1/3] 正在处理透明背景多尺寸图标: {ICON_PATH}")
    if '--skip-icon' not in sys.argv:
        ensure_transparent_icon(ICON_PATH)

    csc_path = find_csc_compiler()
    if not csc_path:
        raise RuntimeError("未找到 Windows 内置 .NET C# 编译器 (csc.exe)")

    cs_source = generate_launcher_cs_source('', '')
    temp_cs = os.path.join(tempfile.gettempdir(), f"MAERS_Public_Web_Launcher_{os.getpid()}.cs")
    temp_exe = os.path.join(tempfile.gettempdir(), f"MAERS_Public_Web_Launcher_{os.getpid()}.exe")

    print(f"[2/3] 正在编译原生桌面启动程序 (纯桌面软件模式): {ROOT_EXE_PATH}")
    try:
        # 写入 UTF-8 BOM 以确保 csc.exe 按 UTF-8 解析中文提示与元数据
        with open(temp_cs, "w", encoding="utf-8-sig") as f:
            f.write(cs_source)

        cmd = [
            csc_path,
            "/nologo",
            "/target:winexe",
            "/optimize+",
            f"/out:{temp_exe}",
            f"/win32icon:{ICON_PATH}",
            "/r:System.dll",
            "/r:System.Drawing.dll",
            "/r:System.Web.Extensions.dll",
            "/r:System.Windows.Forms.dll",
            temp_cs,
        ]
        subprocess.run(cmd, check=True)
        replace_executable_safely(temp_exe, ROOT_EXE_PATH)

        if os.path.isdir(DESKTOP_DIR) and '--install-desktop' in sys.argv:
            print(f"[3/3] 正在同步更新系统桌面启动程序: {DESKTOP_EXE_PATH}")
            replace_executable_safely(temp_exe, DESKTOP_EXE_PATH)
            try:
                import ctypes
                # SHCNE_ASSOCCHANGED (0x08000000) 通知 Windows 资源管理器立即刷新桌面图标缓存
                ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
                subprocess.run(["ie4uinit.exe", "-show"], check=False)
            except Exception:
                pass
    finally:
        for temp_path in (temp_cs, temp_exe):
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    print("✅ 构建完成！")


if __name__ == "__main__":
    main()

