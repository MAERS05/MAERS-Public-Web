// Maersy 桌面启动环境。复用已安装的运行时，只在缺少依赖时启动安装程序。
namespace MAERSLauncher
{
    using System;
    using System.Collections.Generic;
    using System.ComponentModel;
    using System.Diagnostics;
    using System.IO;
    using System.Threading;
    using System.Windows.Forms;

    internal sealed class DesktopRuntime
    {
        private readonly string projectDir;
        private readonly string logPath;

        internal DesktopRuntime(string projectDir)
        {
            this.projectDir = projectDir;
            logPath = Path.Combine(projectDir, "_studio", ".local", "setup.log");
        }

        internal string PreparePython(string fallback)
        {
            return EnsureRuntime(delegate { return FindRuntime(PythonCandidates(fallback), "Python ", new Version(3, 10)); },
                "Python.Python.3.13", "Python", " --scope user");
        }

        internal void PrepareTooling()
        {
            string node = EnsureRuntime(delegate { return FindRuntime(NodeCandidates(), "v", new Version(22, 12, 0)); },
                "OpenJS.NodeJS.22", "Node.js", "");
            string nodeDir = Path.GetDirectoryName(node);
            Environment.SetEnvironmentVariable("PATH", nodeDir + ";" + Environment.GetEnvironmentVariable("PATH"));

            string tooling = Path.Combine(projectDir, "_studio", "tooling");
            if (ToolingReady(tooling)) return;

            const string install = " ci --include=dev --no-audit --no-fund";
            string npm = Path.Combine(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
            if (File.Exists(npm))
                RunSetup(node, "\"" + npm + "\"" + install, tooling, "安装本机构建工具");
            else
                RunSetup(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d /c npm" + install,
                    tooling, "安装本机构建工具");
        }

        private static bool ToolingReady(string tooling)
        {
            string modules = Path.Combine(tooling, "node_modules");
            string installed = Path.Combine(modules, ".package-lock.json");
            string expected = Path.Combine(tooling, "package-lock.json");
            return File.Exists(expected) && File.Exists(installed) &&
                File.GetLastWriteTimeUtc(installed) >= File.GetLastWriteTimeUtc(expected) &&
                File.GetLastWriteTimeUtc(installed) >= File.GetLastWriteTimeUtc(Path.Combine(tooling, "package.json")) &&
                File.Exists(Path.Combine(modules, "acorn", "package.json"));
        }

        private string EnsureRuntime(Func<string> find, string package, string name, string scope)
        {
            string path = find();
            if (path != null) return path;

            // 不同端口的启动器也不能同时运行同一个系统安装程序。
            using (var setup = new Mutex(false, @"Local\MAERS_RuntimeSetup"))
            {
                try { setup.WaitOne(); }
                catch (AbandonedMutexException) { }
                try
                {
                    path = find();
                    if (path != null) return path;
                    string winget = FindWinGet();
                    if (winget == null)
                        throw new InvalidOperationException("自动安装 " + name + " 需要 WinGet。请从 Microsoft Store 安装或更新‘应用安装程序’后重试。");

                    RunSetup(winget, "install --id " + package + " --exact --source winget --silent" +
                        " --accept-package-agreements --accept-source-agreements --disable-interactivity" + scope,
                        projectDir, "安装 " + name);
                    path = find();
                    if (path == null)
                        throw new InvalidOperationException("安装完成后未找到可用的 " + name + "。请查看 " + logPath + "。");
                    return path;
                }
                finally { setup.ReleaseMutex(); }
            }
        }

        private static string FindWinGet()
        {
            string alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WindowsApps", "winget.exe");
            if (File.Exists(alias)) return alias;
            foreach (string path in PathCandidates("winget.exe"))
                if (File.Exists(path)) return path;
            return null;
        }

        private static IEnumerable<string> PythonCandidates(string fallback)
        {
            yield return fallback;
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            foreach (string version in new[] { "314", "313", "312", "311", "310" })
            {
                string directory = "Python" + version;
                yield return Path.Combine(local, "Programs", "Python", directory, "python.exe");
                yield return Path.Combine(programs, directory, "python.exe");
                yield return Path.Combine(@"C:\", directory, "python.exe");
            }
            foreach (string path in PathCandidates("python.exe"))
                if (path.IndexOf(@"\WindowsApps\", StringComparison.OrdinalIgnoreCase) < 0) yield return path;
        }

        private static IEnumerable<string> NodeCandidates()
        {
            foreach (string path in PathCandidates("node.exe")) yield return path;
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        }

        private static IEnumerable<string> PathCandidates(string filename)
        {
            // 安装后当前进程的 PATH 可能尚未刷新，直接读取用户和系统的新值。
            string paths = string.Join(";", new[] { Environment.GetEnvironmentVariable("PATH"),
                Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User),
                Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) });
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string entry in paths.Split(';'))
            {
                string dir = Environment.ExpandEnvironmentVariables(entry.Trim().Trim('"'));
                if (dir.IndexOfAny(Path.GetInvalidPathChars()) < 0 && Path.IsPathRooted(dir) && seen.Add(dir))
                    yield return Path.Combine(dir, filename);
            }
        }

        private static string FindRuntime(IEnumerable<string> candidates, string prefix, Version minimum)
        {
            foreach (string path in candidates)
            {
                if (!File.Exists(path)) continue;
                Version version = ReadVersion(path, prefix);
                if (version != null && version.CompareTo(minimum) >= 0) return path;
            }
            return null;
        }

        private static Version ReadVersion(string executable, string prefix)
        {
            try
            {
                var info = new ProcessStartInfo(executable, "--version")
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
                };
                using (var child = Process.Start(info))
                {
                    if (!child.WaitForExit(5000))
                    {
                        child.Kill();
                        return null;
                    }
                    string output = child.StandardOutput.ReadToEnd().Trim();
                    Version version;
                    if (child.ExitCode == 0 && output.StartsWith(prefix, StringComparison.Ordinal) &&
                        Version.TryParse(output.Substring(prefix.Length), out version)) return version;
                }
            }
            catch (Win32Exception) { }
            catch (InvalidOperationException) { }
            return null;
        }

        private void RunSetup(string executable, string arguments, string directory, string action)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            var info = new ProcessStartInfo(executable, arguments)
            {
                WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var progress = new Form { Text = "Maersy 正在" + action, Width = 410, Height = 110,
                StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
                ControlBox = false, ShowInTaskbar = true })
            using (var log = File.AppendText(logPath))
            using (var process = new Process { StartInfo = info })
            {
                progress.Controls.Add(new ProgressBar { Dock = DockStyle.Top, Style = ProgressBarStyle.Marquee });
                log.AutoFlush = true;
                log.WriteLine(DateTime.Now.ToString("s") + " " + action);
                var logLock = new object();
                DataReceivedEventHandler capture = delegate(object sender, DataReceivedEventArgs args)
                {
                    if (args.Data != null) lock (logLock) log.WriteLine(args.Data);
                };
                process.OutputDataReceived += capture;
                process.ErrorDataReceived += capture;
                progress.Show();
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                while (!process.WaitForExit(120)) Application.DoEvents();
                process.WaitForExit();
                log.WriteLine("退出码 0x" + process.ExitCode.ToString("X8"));
                if (process.ExitCode != 0)
                    throw new InvalidOperationException(action + "失败。请查看 " + logPath + "。");
            }
        }
    }
}
