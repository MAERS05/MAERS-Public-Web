# -*- coding: utf-8 -*-
"""
桌面启动程序构建脚本 (_studio/tools/build_desktop_app.py)
职责：
1. 调用 Windows 内置 .NET C# 编译器 (csc.exe)，结合项目图标 (ui/icon.ico) 编译纯桌面软件模式的 Maersy.exe：
   - 后台静默启动 Python 服务 _studio/server.py（完全无黑色命令行窗口）；
   - 通过 Chromium (Edge/Chrome) --app=http://localhost:8001/admin 模式以无地址栏独立软件窗口启动；
   - 实时监测独立窗口句柄 (HWND) 生命周期，在系统内切换各子模块页面不中断，关闭软件窗口时自动停止后台 Python 服务；
   - 重复双击时直接唤醒并置顶已打开的独立窗口，防止重复多开。
2. 生成项目根目录启动器；仅 --install-desktop 显式同步桌面：
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
    """生成 C# 原生启动器源码（无黑框 + 独立软件窗口 + 关窗即停服务 + 防多开置顶唤醒）"""
    escaped_root = fallback_project_root.replace("\\", "\\\\")
    escaped_py = fallback_python_exe.replace("\\", "\\\\")
    return f"""using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Reflection;
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
        // 开源可移植构建不嵌入本机路径；从启动器所在目录发现项目，运行时查找 Python
        private const string FallbackProjectRoot = "{escaped_root}";
        private const string FallbackPythonExe = "{escaped_py}";
        private static int DefaultPort;
        private const string EntryPath = "/admin";

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

        private const int SW_RESTORE = 9;

        [STAThread]
        private static void Main()
        {{
            Process serverProc = null;
            try
            {{
                string projectDir = ResolveProjectDirectory();
                if (projectDir == null) throw new Exception("未找到 MAERS 项目目录。");
                DefaultPort = ReadServerPort(projectDir);
                string appUrl = "http://localhost:" + DefaultPort + EntryPath;

                // 1. 若独立窗口已打开且服务在线，直接还原并置顶唤醒，防止重复开启
                IntPtr existingWin = FindMaersAppWindow();
                if (existingWin != IntPtr.Zero && IsMaersServerRunning(DefaultPort))
                {{
                    if (IsIconic(existingWin)) ShowWindow(existingWin, SW_RESTORE);
                    SetForegroundWindow(existingWin);
                    return;
                }}

                // 2. 若后台服务尚未在配置端口运行，则以无黑框静默方式启动 _studio/server.py
                if (!IsMaersServerRunning(DefaultPort))
                {{
                    if (projectDir == null)
                    {{
                        MessageBox.Show(
                            "未找到 MAERS 后台服务脚本 (_studio/server.py)。\\n请将此程序置于项目目录或重新运行构建脚本。",
                            "MAERS Public Web 启动失败",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                        return;
                    }}

                    serverProc = StartSilentPythonServer(projectDir);
                    if (!WaitUntilServerReady(DefaultPort, 15000))
                    {{
                        StopServerProcess(serverProc);
                        MessageBox.Show(
                            "本地服务启动超时，请确认系统已安装 Python 且配置端口未被其他程序占用。",
                            "MAERS Public Web 启动失败",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                        return;
                    }}
                }}

                // 3. 通过 Chromium (Edge / Chrome) --app 模式打开无地址栏、无书签栏的独立桌面软件窗口
                Process browserProc = OpenStandaloneWindow(appUrl);

                // 4. 若本次启动拉起了后台服务，则监测独立软件窗口生命周期，关闭窗口时自动停止后台服务
                if (serverProc != null)
                {{
                    MonitorWindowAndStopServer(serverProc, browserProc);
                }}
            }}
            catch (Exception ex)
            {{
                StopServerProcess(serverProc);
                MessageBox.Show(
                    "启动 MAERS Public Web 时发生异常：\\n" + ex.Message,
                    "MAERS Public Web 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }}
        }}

        // 后台无黑框静默启动 python _studio/server.py
        private static Process StartSilentPythonServer(string projectDir)
        {{
            string studioDir = Path.Combine(projectDir, "_studio");
            string scriptPath = Path.Combine(studioDir, "server.py");
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ResolvePythonExecutable();
            psi.Arguments = "-B \\"" + scriptPath + "\\"";
            psi.WorkingDirectory = studioDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            return Process.Start(psi);
        }}

        // 定位 python.exe 路径
        private static string ResolvePythonExecutable()
        {{
            if (!string.IsNullOrEmpty(FallbackPythonExe) && File.Exists(FallbackPythonExe))
            {{
                return FallbackPythonExe;
            }}

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string[] candidates = new string[]
            {{
                Path.Combine(localAppData, "Programs", "Python", "Python313", "python.exe"),
                Path.Combine(localAppData, "Programs", "Python", "Python312", "python.exe"),
                Path.Combine(localAppData, "Programs", "Python", "Python311", "python.exe"),
                Path.Combine(localAppData, "Programs", "Python", "Python310", "python.exe"),
                Path.Combine(progFiles, "Python313", "python.exe"),
                Path.Combine(progFiles, "Python312", "python.exe"),
                Path.Combine(progFiles, "Python311", "python.exe"),
                @"C:\\Python312\\python.exe",
                @"C:\\Python311\\python.exe"
            }};
            foreach (string p in candidates)
            {{
                if (File.Exists(p)) return p;
            }}

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathEnv.Split(';'))
            {{
                string trimmed = dir.Trim();
                if (string.IsNullOrEmpty(trimmed) || trimmed.IndexOf("WindowsApps", StringComparison.OrdinalIgnoreCase) >= 0)
                    continue;
                try
                {{
                    string candidate = Path.Combine(trimmed, "python.exe");
                    if (File.Exists(candidate)) return candidate;
                }}
                catch {{ }}
            }}

            return "python";
        }}

        // 轮询等待本地服务就绪
        private static int ReadServerPort(string projectDir)
        {{
            var info = new ProcessStartInfo(ResolvePythonExecutable());
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

        private static bool WaitUntilServerReady(int port, int timeoutMs)
        {{
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {{
                if (IsMaersServerRunning(port)) return true;
                Thread.Sleep(100);
            }}
            return IsMaersServerRunning(port);
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
        private static void MonitorWindowAndStopServer(Process serverProc, Process browserProc)
        {{
            IntPtr trackedHwnd = IntPtr.Zero;
            Stopwatch waitOpen = Stopwatch.StartNew();

            // 阶段 1：等待独立窗口创建完成（最多等待 15 秒）
            while (waitOpen.ElapsedMilliseconds < 15000)
            {{
                if (serverProc.HasExited) return;
                trackedHwnd = FindMaersAppWindow();
                if (trackedHwnd != IntPtr.Zero) break;
                Thread.Sleep(150);
            }}

            // 若捕获到了顶层窗口句柄，持续监测该窗口或任意 MAERS Public Web / Admin 窗口是否仍处于打开状态
            if (trackedHwnd != IntPtr.Zero)
            {{
                while (!serverProc.HasExited)
                {{
                    if (IsWindow(trackedHwnd))
                    {{
                        Thread.Sleep(400);
                        continue;
                    }}
                    // 原窗口句柄销毁后，再检查是否还有其他 MAERS Public Web / Admin 窗口打开
                    IntPtr another = FindMaersAppWindow();
                    if (another != IntPtr.Zero)
                    {{
                        trackedHwnd = another;
                        Thread.Sleep(400);
                        continue;
                    }}
                    break;
                }}
            }}
            else if (browserProc != null)
            {{
                // 极端回退：若未捕获到窗口句柄则等待浏览器进程结束
                try {{ browserProc.WaitForExit(); }} catch {{ }}
            }}

            StopServerProcess(serverProc);
        }}

        // 查找当前打开的 MAERS Public Admin / MAERS Public Web 浏览器窗口句柄
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

                if (title.StartsWith("MAERS Public Admin", StringComparison.OrdinalIgnoreCase) ||
                    title.StartsWith("MAERS Public Web", StringComparison.OrdinalIgnoreCase))
                {{
                    found = hWnd;
                    return false;
                }}
                return true;
            }}, IntPtr.Zero);
            return found;
        }}

        // 安全终止后台 Python 服务进程
        private static void StopServerProcess(Process proc)
        {{
            if (proc == null) return;
            try
            {{
                if (!proc.HasExited)
                {{
                    proc.Kill();
                    proc.WaitForExit(2000);
                }}
            }}
            catch {{ }}
        }}

        // 探测指定端口是否已运行 MAERS-Public-Web 服务
        private static bool IsMaersServerRunning(int port)
        {{
            try
            {{
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/manifest.json");
                req.Method = "GET";
                req.Timeout = 400;
                req.ReadWriteTimeout = 400;
                req.Proxy = null;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {{
                    if (res.StatusCode != HttpStatusCode.OK) return false;
                    string appHeader = res.Headers["X-MAERS-App"];
                    if (appHeader == "MAERS-Public-Web") return true;
                    using (StreamReader sr = new StreamReader(res.GetResponseStream()))
                    {{
                        string content = sr.ReadToEnd();
                        return content != null && content.IndexOf("MAERS Public Web", StringComparison.OrdinalIgnoreCase) >= 0;
                    }}
                }}
            }}
            catch
            {{
                return false;
            }}
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
"""


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
            f"/out:{ROOT_EXE_PATH}",
            f"/win32icon:{ICON_PATH}",
            "/r:System.dll",
            "/r:System.Windows.Forms.dll",
            temp_cs,
        ]
        subprocess.run(cmd, check=True)
    finally:
        if os.path.exists(temp_cs):
            os.remove(temp_cs)

    if os.path.isdir(DESKTOP_DIR) and '--install-desktop' in sys.argv:
        print(f"[3/3] 正在同步更新系统桌面启动程序: {DESKTOP_EXE_PATH}")
        shutil.copy2(ROOT_EXE_PATH, DESKTOP_EXE_PATH)
        try:
            import ctypes
            # SHCNE_ASSOCCHANGED (0x08000000) 通知 Windows 资源管理器立即刷新桌面图标缓存
            ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
            subprocess.run(["ie4uinit.exe", "-show"], check=False)
        except Exception:
            pass

    print("✅ 构建完成！")


if __name__ == "__main__":
    main()

