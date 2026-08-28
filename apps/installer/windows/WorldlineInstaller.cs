using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using WinForms = System.Windows.Forms;

namespace WorldlineBox.Installer
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool preview = HasArgument(args, "--preview");
            bool uninstall = HasArgument(args, "--uninstall") || HasArgument(args, "--uninstall-worker");
            string installDirectory = ReadArgument(args, "--install-dir");

            if (HasArgument(args, "--uninstall") && !HasArgument(args, "--uninstall-worker"))
            {
                RelaunchUninstallerFromTemp(installDirectory);
                return;
            }

            var application = new Application();
            application.ShutdownMode = ShutdownMode.OnMainWindowClose;
            application.Run(new InstallerWindow(preview, uninstall, installDirectory));
        }

        internal static bool HasArgument(string[] args, string name)
        {
            foreach (string arg in args)
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        internal static string ReadArgument(string[] args, string name)
        {
            for (int index = 0; index + 1 < args.Length; index++)
                if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
            return null;
        }

        private static void RelaunchUninstallerFromTemp(string installDirectory)
        {
            if (string.IsNullOrWhiteSpace(installDirectory))
                installDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

            string tempDirectory = Path.Combine(Path.GetTempPath(), "WorldlineBox", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDirectory);
            string worker = Path.Combine(tempDirectory, "世界线盒子卸载程序.exe");
            File.Copy(Process.GetCurrentProcess().MainModule.FileName, worker, true);
            Process.Start(new ProcessStartInfo(worker,
                "--uninstall-worker --install-dir \"" + installDirectory + "\"") { UseShellExecute = true });
        }
    }

    internal sealed class InstallerWindow : Window
    {
        private const string ProductName = "世界线盒子";
        private const string ApplicationExe = "WorldlineBox.exe";
        private const string FooterMagic = "WLBOX001";
        private static readonly Color Ink = Color.FromRgb(22, 43, 75);
        private static readonly Color Muted = Color.FromRgb(111, 132, 160);
        private static readonly Color Accent = Color.FromRgb(42, 137, 214);
        private static readonly Color AccentBright = Color.FromRgb(92, 187, 241);
        private static readonly Color Surface = Color.FromRgb(248, 251, 255);

        private readonly bool preview;
        private readonly bool uninstall;
        private readonly string requestedInstallDirectory;
        private Canvas canvas;
        private TextBox pathBox;
        private OptionToggle desktopOption;
        private OptionToggle startMenuOption;
        private Border progressFill;
        private TextBlock progressPercent;
        private TextBlock progressStatus;
        private bool busy;

        internal InstallerWindow(bool preview, bool uninstall, string installDirectory)
        {
            this.preview = preview;
            this.uninstall = uninstall;
            requestedInstallDirectory = installDirectory;
            Title = ProductName;
            Width = 680;
            Height = 500;
            MinWidth = Width;
            MinHeight = Height;
            MaxWidth = Width;
            MaxHeight = Height;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            FontFamily = new FontFamily("Microsoft YaHei UI");
            SnapsToDevicePixels = true;

            BuildWindow();
            if (uninstall) ShowUninstallPage(); else ShowInstallPage();
        }

        private void BuildWindow()
        {
            var shell = new Border
            {
                Margin = new Thickness(14),
                CornerRadius = new CornerRadius(20),
                BorderBrush = BrushOf(218, 231, 246),
                BorderThickness = new Thickness(1),
                Background = new SolidColorBrush(Surface),
                Effect = new DropShadowEffect
                {
                    BlurRadius = 28,
                    ShadowDepth = 8,
                    Opacity = 0.23,
                    Color = Color.FromRgb(20, 54, 91)
                }
            };
            Content = shell;
            canvas = new Canvas { ClipToBounds = true };
            shell.Child = canvas;
            AddDecorations();
            AddTitleBar();
        }

        private void ResetPage()
        {
            canvas.Children.Clear();
            AddDecorations();
            AddTitleBar();
        }

        private void AddDecorations()
        {
            var glow = new System.Windows.Shapes.Ellipse
            {
                Width = 360,
                Height = 360,
                Opacity = 0.16,
                Fill = new RadialGradientBrush(
                    Color.FromArgb(180, 107, 207, 255), Color.FromArgb(0, 107, 207, 255))
            };
            Canvas.SetLeft(glow, 390);
            Canvas.SetTop(glow, -170);
            canvas.Children.Add(glow);

            var glowLeft = new System.Windows.Shapes.Ellipse
            {
                Width = 280,
                Height = 280,
                Opacity = 0.1,
                Fill = new RadialGradientBrush(
                    Color.FromArgb(170, 90, 146, 255), Color.FromArgb(0, 90, 146, 255))
            };
            Canvas.SetLeft(glowLeft, -150);
            Canvas.SetTop(glowLeft, 250);
            canvas.Children.Add(glowLeft);

            AddCurve(-50, 252, 260, 375, 700, 220, 0.22);
            AddCurve(-70, 275, 240, 410, 720, 245, 0.11);
            AddSparkle(92, 104, 11);
            AddSparkle(580, 124, 9);
            AddSparkle(546, 385, 7);
            AddSparkle(120, 408, 6);
        }

        private void AddCurve(double x1, double y1, double cx, double cy, double x2, double y2, double opacity)
        {
            var figure = new PathFigure { StartPoint = new Point(x1, y1) };
            figure.Segments.Add(new BezierSegment(new Point(80, y1 - 34), new Point(cx - 95, cy + 34),
                new Point(cx, cy), true));
            figure.Segments.Add(new BezierSegment(new Point(cx + 120, cy - 48), new Point(x2 - 120, y2 + 30),
                new Point(x2, y2), true));
            var geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            canvas.Children.Add(new System.Windows.Shapes.Path
            {
                Data = geometry,
                Stroke = BrushOf(95, 173, 224),
                StrokeThickness = 1.2,
                Opacity = opacity
            });
        }

        private void AddSparkle(double x, double y, double size)
        {
            var star = new System.Windows.Shapes.Polygon
            {
                Points = new PointCollection
                {
                    new Point(size / 2, 0), new Point(size * .64, size * .36), new Point(size, size / 2),
                    new Point(size * .64, size * .64), new Point(size / 2, size),
                    new Point(size * .36, size * .64), new Point(0, size / 2), new Point(size * .36, size * .36)
                },
                Fill = BrushOf(112, 189, 234),
                Opacity = .28
            };
            Canvas.SetLeft(star, x);
            Canvas.SetTop(star, y);
            canvas.Children.Add(star);
        }

        private void AddTitleBar()
        {
            var dragArea = new Border { Width = 650, Height = 42, Background = Brushes.Transparent };
            dragArea.MouseLeftButtonDown += delegate
            {
                if (Mouse.LeftButton == MouseButtonState.Pressed) DragMove();
            };
            Canvas.SetLeft(dragArea, 0);
            Canvas.SetTop(dragArea, 0);
            canvas.Children.Add(dragArea);

            AddCaptionButton("−", 574, delegate { WindowState = WindowState.Minimized; }, false);
            AddCaptionButton("×", 610, delegate { if (!busy) Close(); }, true);
        }

        private void AddCaptionButton(string glyph, double x, Action action, bool close)
        {
            var text = new TextBlock
            {
                Text = glyph,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = close ? 14 : 12,
                Foreground = new SolidColorBrush(Muted),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var button = new Border
            {
                Width = 28,
                Height = 26,
                CornerRadius = new CornerRadius(7),
                Background = Brushes.Transparent,
                Child = text,
                Cursor = Cursors.Hand
            };
            button.MouseEnter += delegate { button.Background = close ? BrushOf(255, 231, 235) : BrushOf(232, 240, 249); };
            button.MouseLeave += delegate { button.Background = Brushes.Transparent; };
            button.MouseLeftButtonUp += delegate { action(); };
            Canvas.SetLeft(button, x);
            Canvas.SetTop(button, 10);
            canvas.Children.Add(button);
        }

        private void ShowInstallPage()
        {
            ResetPage();
            AddHeading("自定义安装", "让世界线盒子落在你选择的位置");
            AddLogo(268, 92, 116);

            var card = AddCard(104, 226, 444, 153);
            var label = Text("安装路径", 12, Ink, FontWeights.SemiBold);
            Place(card, label, 18, 13, 180, 22);

            var pathBorder = new Border
            {
                Width = 322,
                Height = 43,
                CornerRadius = new CornerRadius(13),
                BorderBrush = BrushOf(211, 226, 241),
                BorderThickness = new Thickness(1),
                Background = Brushes.White
            };
            pathBox = new TextBox
            {
                Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WorldlineBox"),
                BorderThickness = new Thickness(0),
                Background = Brushes.Transparent,
                Foreground = new SolidColorBrush(Ink),
                FontSize = 12.5,
                VerticalContentAlignment = VerticalAlignment.Center,
                Padding = new Thickness(14, 0, 8, 0)
            };
            pathBorder.Child = pathBox;
            Place(card, pathBorder, 18, 39, 322, 43);

            var browse = MakeButton("浏览", 74, 43, false);
            browse.MouseLeftButtonUp += delegate { BrowseForFolder(); };
            Place(card, browse, 350, 39, 74, 43);

            var size = Text("约需 1 GB · 安装时保留你的 .worldline 数据", 10.5, Muted, FontWeights.Normal);
            Place(card, size, 20, 88, 400, 20);

            desktopOption = new OptionToggle("创建桌面快捷方式", true);
            startMenuOption = new OptionToggle("创建开始菜单快捷方式", true);
            Place(card, desktopOption.Root, 18, 118, 190, 24);
            Place(card, startMenuOption.Root, 226, 118, 200, 24);

            var installButton = MakePrimaryButton("立即安装", 260, 48);
            installButton.MouseLeftButtonUp += async delegate { await BeginInstallAsync(); };
            Place(canvas, installButton, 196, 404, 260, 48);
        }

        private void ShowUninstallPage()
        {
            ResetPage();
            AddHeading("卸载世界线盒子", "应用文件会被移除，你的个人数据将继续保留");
            AddLogo(258, 105, 136);

            var card = AddCard(126, 273, 400, 94);
            var title = Text("准备移除世界线", 13, Ink, FontWeights.SemiBold);
            Place(card, title, 22, 18, 350, 24);
            var copy = Text("不会删除用户目录中的 .worldline 配置、会话和凭据。", 10.5, Muted, FontWeights.Normal);
            Place(card, copy, 22, 50, 360, 30);

            var button = MakePrimaryButton("确认卸载", 260, 48);
            button.MouseLeftButtonUp += async delegate { await BeginUninstallAsync(); };
            Place(canvas, button, 196, 400, 260, 48);
        }

        private void ShowProgressPage(string heading, string initialStatus)
        {
            ResetPage();
            AddHeading(heading, "请稍候，世界线正在完成必要的准备");
            AddLogo(252, 104, 148);
            progressStatus = Text(initialStatus, 11.5, Muted, FontWeights.Normal);
            progressStatus.TextAlignment = TextAlignment.Left;
            Place(canvas, progressStatus, 126, 304, 400, 26);

            var track = new Border
            {
                Width = 400,
                Height = 10,
                CornerRadius = new CornerRadius(5),
                Background = BrushOf(220, 235, 247)
            };
            Place(canvas, track, 126, 340, 400, 10);
            progressFill = new Border
            {
                Width = 0,
                Height = 10,
                CornerRadius = new CornerRadius(5),
                Background = new LinearGradientBrush(Accent, AccentBright, 0)
            };
            Place(canvas, progressFill, 126, 340, 0, 10);
            progressPercent = Text("0%", 12, Accent, FontWeights.SemiBold);
            progressPercent.TextAlignment = TextAlignment.Right;
            Place(canvas, progressPercent, 466, 365, 60, 24);
            var hint = Text("安装过程中请勿关闭此窗口", 10, Muted, FontWeights.Normal);
            hint.Opacity = .76;
            hint.TextAlignment = TextAlignment.Center;
            Place(canvas, hint, 176, 416, 300, 24);
        }

        private void ShowFinishedPage(bool removed)
        {
            busy = false;
            ResetPage();
            AddHeading(removed ? "卸载完成" : "安装完成", removed ? "期待在另一条世界线与你重逢" : "世界线盒子已经准备就绪");
            AddLogo(248, 112, 156);

            var ring = new System.Windows.Shapes.Ellipse
            {
                Width = 180,
                Height = 180,
                Stroke = BrushOf(108, 190, 233),
                StrokeThickness = 1,
                Opacity = .25
            };
            Place(canvas, ring, 236, 100, 180, 180);

            var copy = Text(removed ? "应用程序已从这台电脑移除，个人数据没有被触碰。" : "快捷方式和卸载入口均已创建，你现在可以启动世界线。",
                11, Muted, FontWeights.Normal);
            copy.TextAlignment = TextAlignment.Center;
            Place(canvas, copy, 126, 310, 400, 34);

            var button = MakePrimaryButton(removed ? "关闭" : "启动世界线", 260, 48);
            button.MouseLeftButtonUp += delegate
            {
                if (!removed)
                {
                    string directory = pathBox == null ? DefaultInstallDirectory() : pathBox.Text;
                    string executable = Path.Combine(directory, ApplicationExe);
                    if (File.Exists(executable)) Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
                }
                Close();
            };
            Place(canvas, button, 196, 390, 260, 48);
        }

        private void ShowErrorPage(bool removing, string message)
        {
            busy = false;
            ResetPage();
            AddHeading(removing ? "卸载未完成" : "安装未完成", "世界线遇到了一个问题");
            AddLogo(270, 108, 112);

            var card = AddCard(126, 250, 400, 118);
            var title = Text(removing ? "无法完成卸载" : "无法完成安装", 13, Ink, FontWeights.SemiBold);
            Place(card, title, 22, 18, 350, 24);
            var copy = Text(message, 10.5, Muted, FontWeights.Normal);
            copy.TextWrapping = TextWrapping.Wrap;
            copy.TextTrimming = TextTrimming.None;
            Place(card, copy, 22, 49, 356, 52);

            var button = MakePrimaryButton("返回", 220, 44);
            button.MouseLeftButtonUp += delegate
            {
                if (removing) ShowUninstallPage(); else ShowInstallPage();
            };
            Place(canvas, button, 216, 397, 220, 44);
        }

        private async Task BeginInstallAsync()
        {
            if (busy) return;
            string installDirectory;
            try
            {
                installDirectory = NormalizeInstallDirectory(pathBox.Text);
            }
            catch (Exception error)
            {
                ShowErrorPage(false, error.Message);
                return;
            }
            if (string.IsNullOrWhiteSpace(installDirectory)) return;
            pathBox.Text = installDirectory;
            bool makeDesktop = desktopOption.Checked;
            bool makeStartMenu = startMenuOption.Checked;
            busy = true;
            ShowProgressPage("正在安装", "正在准备世界线应用程序…");

            try
            {
                if (preview)
                {
                    await SimulateProgressAsync("正在展开应用文件…");
                }
                else
                {
                    await Task.Run(() => InstallPayload(installDirectory, makeDesktop, makeStartMenu));
                }
                SetProgress(100, "所有组件均已安装完成");
                await Task.Delay(380);
                pathBox = new TextBox { Text = installDirectory };
                ShowFinishedPage(false);
            }
            catch (Exception error)
            {
                ShowErrorPage(false, error.Message);
            }
        }

        private async Task BeginUninstallAsync()
        {
            if (busy) return;
            busy = true;
            ShowProgressPage("正在卸载", "正在移除应用文件和快捷方式…");
            try
            {
                if (preview) await SimulateProgressAsync("正在清理已安装的组件…");
                else await Task.Run(() => RemoveInstallation(DefaultInstallDirectory()));
                SetProgress(100, "卸载已完成");
                await Task.Delay(350);
                ShowFinishedPage(true);
            }
            catch (Exception error)
            {
                ShowErrorPage(true, error.Message);
            }
        }

        private async Task SimulateProgressAsync(string status)
        {
            for (int value = 0; value <= 100; value += 2)
            {
                SetProgress(value, value < 72 ? status : "正在创建快捷方式和卸载入口…");
                await Task.Delay(28);
            }
        }

        private void SetProgress(int percent, string status)
        {
            Dispatcher.Invoke(delegate
            {
                progressFill.Width = 4 * Math.Max(0, Math.Min(100, percent));
                progressPercent.Text = percent + "%";
                progressStatus.Text = status;
            });
        }

        private void InstallPayload(string installDirectory, bool makeDesktop, bool makeStartMenu)
        {
            PayloadLocation payload = LocatePayload();
            if (payload == null) throw new InvalidDataException("安装包不包含有效的世界线应用载荷。");
            Directory.CreateDirectory(installDirectory);

            long completed = 0;
            using (var executable = File.OpenRead(Process.GetCurrentProcess().MainModule.FileName))
            using (var segment = new SegmentStream(executable, payload.Offset, payload.Length))
            using (var archive = new ZipArchive(segment, ZipArchiveMode.Read, false, Encoding.UTF8))
            {
                long total = 0;
                foreach (ZipArchiveEntry entry in archive.Entries) total += Math.Max(1, entry.Length);
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string destination = SafeDestination(installDirectory, entry.FullName);
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream input = entry.Open())
                    using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        byte[] buffer = new byte[1024 * 1024];
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            output.Write(buffer, 0, read);
                            completed += read;
                            SetProgress(3 + (int)(completed * 88 / Math.Max(1, total)),
                                "正在部署世界线应用文件…");
                        }
                    }
                }

                string uninstaller = Path.Combine(installDirectory, "卸载世界线盒子.exe");
                executable.Position = 0;
                using (var output = new FileStream(uninstaller, FileMode.Create, FileAccess.Write, FileShare.None))
                    CopyBytes(executable, output, payload.Offset);
            }

            string app = Path.Combine(installDirectory, ApplicationExe);
            if (!File.Exists(app)) throw new FileNotFoundException("应用载荷中缺少 " + ApplicationExe);
            SetProgress(93, "正在创建快捷方式…");
            if (makeDesktop) CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "世界线.lnk"), app);
            if (makeStartMenu)
            {
                string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "世界线");
                Directory.CreateDirectory(menu);
                CreateShortcut(Path.Combine(menu, "世界线.lnk"), app);
                CreateShortcut(Path.Combine(menu, "卸载世界线盒子.lnk"), Path.Combine(installDirectory, "卸载世界线盒子.exe"),
                    "--uninstall --install-dir \"" + installDirectory + "\"");
            }
            RegisterUninstaller(installDirectory);
            AddToolPaths(installDirectory);
        }

        private void RemoveInstallation(string installDirectory)
        {
            string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "世界线.lnk");
            if (File.Exists(desktop)) File.Delete(desktop);
            string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "世界线");
            if (Directory.Exists(menu)) Directory.Delete(menu, true);
            RemoveToolPaths(installDirectory);
            Registry.LocalMachine.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\WorldlineBox", false);
            if (Directory.Exists(installDirectory)) Directory.Delete(installDirectory, true);
        }

        private void RegisterUninstaller(string installDirectory)
        {
            string uninstaller = Path.Combine(installDirectory, "卸载世界线盒子.exe");
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\WorldlineBox"))
            {
                key.SetValue("DisplayName", ProductName);
                key.SetValue("DisplayVersion", "0.1.0");
                key.SetValue("Publisher", "世界线");
                key.SetValue("DisplayIcon", Path.Combine(installDirectory, ApplicationExe));
                key.SetValue("InstallLocation", installDirectory);
                key.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall --install-dir \"" + installDirectory + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        private static void CreateShortcut(string shortcutPath, string target, string arguments = "")
        {
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(type);
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = target;
            shortcut.Arguments = arguments;
            shortcut.WorkingDirectory = Path.GetDirectoryName(target);
            shortcut.IconLocation = target + ",0";
            shortcut.Save();
            Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }

        private void AddToolPaths(string installDirectory)
        {
            UpdatePath(Path.Combine(installDirectory, "resources", "tools", "ffmpeg", "windows-x64"), true);
            UpdatePath(Path.Combine(installDirectory, "resources", "tools", "yt-dlp", "windows-x64"), true);
        }

        private void RemoveToolPaths(string installDirectory)
        {
            UpdatePath(Path.Combine(installDirectory, "resources", "tools", "ffmpeg", "windows-x64"), false);
            UpdatePath(Path.Combine(installDirectory, "resources", "tools", "yt-dlp", "windows-x64"), false);
        }

        private static void UpdatePath(string entry, bool add)
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", true))
            {
                string value = Convert.ToString(key.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames));
                var parts = new System.Collections.Generic.List<string>(value.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
                parts.RemoveAll(item => string.Equals(item.TrimEnd('\\'), entry.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase));
                if (add) parts.Add(entry);
                key.SetValue("Path", string.Join(";", parts.ToArray()), RegistryValueKind.ExpandString);
            }
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero, "Environment", 0x0002, 5000, IntPtr.Zero);
        }

        private PayloadLocation LocatePayload()
        {
            string path = Process.GetCurrentProcess().MainModule.FileName;
            using (var stream = File.OpenRead(path))
            {
                if (stream.Length < 24) return null;
                stream.Position = stream.Length - 24;
                byte[] footer = new byte[24];
                if (stream.Read(footer, 0, footer.Length) != footer.Length) return null;
                if (Encoding.ASCII.GetString(footer, 0, 8) != FooterMagic) return null;
                long offset = BitConverter.ToInt64(footer, 8);
                long length = BitConverter.ToInt64(footer, 16);
                if (offset <= 0 || length <= 0 || offset + length + 24 != stream.Length) return null;
                return new PayloadLocation { Offset = offset, Length = length };
            }
        }

        private static string SafeDestination(string root, string entry)
        {
            string rootPath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string destination = Path.GetFullPath(Path.Combine(rootPath, entry.Replace('/', Path.DirectorySeparatorChar)));
            if (!destination.StartsWith(rootPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("安装载荷包含不安全的文件路径。");
            return destination;
        }

        private static void CopyBytes(Stream input, Stream output, long count)
        {
            byte[] buffer = new byte[1024 * 1024];
            while (count > 0)
            {
                int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, count));
                if (read <= 0) throw new EndOfStreamException();
                output.Write(buffer, 0, read);
                count -= read;
            }
        }

        private string DefaultInstallDirectory()
        {
            if (!string.IsNullOrWhiteSpace(requestedInstallDirectory))
                return NormalizeInstallDirectory(requestedInstallDirectory);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WorldlineBox");
        }

        private static string NormalizeInstallDirectory(string selectedPath)
        {
            if (string.IsNullOrWhiteSpace(selectedPath)) return null;
            string fullPath = Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(selectedPath.Trim().Trim('"')));
            string volumeRoot = Path.GetPathRoot(fullPath);
            if (!string.Equals(fullPath, volumeRoot, StringComparison.OrdinalIgnoreCase))
                fullPath = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string leaf = Path.GetFileName(fullPath);
            return string.Equals(leaf, "WorldlineBox", StringComparison.OrdinalIgnoreCase)
                ? fullPath
                : Path.Combine(fullPath, "WorldlineBox");
        }

        private void BrowseForFolder()
        {
            using (var dialog = new WinForms.FolderBrowserDialog())
            {
                dialog.Description = "选择世界线安装位置";
                dialog.SelectedPath = pathBox.Text;
                if (dialog.ShowDialog() == WinForms.DialogResult.OK)
                    pathBox.Text = NormalizeInstallDirectory(dialog.SelectedPath);
            }
        }

        private void AddHeading(string heading, string subtitle)
        {
            var title = Text(heading, 20, Ink, FontWeights.SemiBold);
            title.TextAlignment = TextAlignment.Center;
            Place(canvas, title, 126, 44, 400, 34);
            var sub = Text(subtitle, 10.5, Muted, FontWeights.Normal);
            sub.TextAlignment = TextAlignment.Center;
            Place(canvas, sub, 126, 76, 400, 22);
        }

        private void AddLogo(double x, double y, double size)
        {
            var image = new System.Windows.Controls.Image
            {
                Width = size,
                Height = size,
                Stretch = Stretch.UniformToFill,
                Source = LoadLogo(),
                Clip = new RectangleGeometry(new Rect(0, 0, size, size), size * .19, size * .19)
            };
            var holder = new Border
            {
                Width = size,
                Height = size,
                CornerRadius = new CornerRadius(size * .19),
                Background = Brushes.White,
                Child = image,
                Effect = new DropShadowEffect { BlurRadius = 24, ShadowDepth = 7, Opacity = .22, Color = Color.FromRgb(35, 89, 135) }
            };
            Place(canvas, holder, x, y, size, size);
        }

        private static BitmapImage LoadLogo()
        {
            Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("WorldlineLogo.png");
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();
            stream.Dispose();
            return image;
        }

        private Border AddCard(double x, double y, double width, double height)
        {
            var card = new Border
            {
                Width = width,
                Height = height,
                CornerRadius = new CornerRadius(18),
                Background = new SolidColorBrush(Color.FromArgb(236, 255, 255, 255)),
                BorderBrush = BrushOf(221, 233, 246),
                BorderThickness = new Thickness(1),
                Child = new Canvas(),
                Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 4, Opacity = .08, Color = Color.FromRgb(40, 89, 128) }
            };
            Place(canvas, card, x, y, width, height);
            return card;
        }

        private static TextBlock Text(string value, double size, Color color, FontWeight weight)
        {
            return new TextBlock
            {
                Text = value,
                FontSize = size,
                FontWeight = weight,
                Foreground = new SolidColorBrush(color),
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis
            };
        }

        private Border MakePrimaryButton(string text, double width, double height)
        {
            var label = Text(text, 13.5, Colors.White, FontWeights.SemiBold);
            label.HorizontalAlignment = HorizontalAlignment.Center;
            label.VerticalAlignment = VerticalAlignment.Center;
            var button = new Border
            {
                Width = width,
                Height = height,
                CornerRadius = new CornerRadius(height / 2),
                Background = new LinearGradientBrush(Accent, AccentBright, 0),
                Child = label,
                Cursor = Cursors.Hand,
                Effect = new DropShadowEffect { BlurRadius = 17, ShadowDepth = 6, Opacity = .28, Color = Accent }
            };
            button.MouseEnter += delegate { button.Opacity = .9; };
            button.MouseLeave += delegate { button.Opacity = 1; };
            return button;
        }

        private Border MakeButton(string text, double width, double height, bool primary)
        {
            var label = Text(text, 11.5, primary ? Colors.White : Accent, FontWeights.SemiBold);
            label.HorizontalAlignment = HorizontalAlignment.Center;
            label.VerticalAlignment = VerticalAlignment.Center;
            return new Border
            {
                Width = width,
                Height = height,
                CornerRadius = new CornerRadius(13),
                Background = primary ? new SolidColorBrush(Accent) : Brushes.White,
                BorderBrush = BrushOf(199, 221, 239),
                BorderThickness = new Thickness(1),
                Child = label,
                Cursor = Cursors.Hand
            };
        }

        private static SolidColorBrush BrushOf(byte r, byte g, byte b)
        {
            var brush = new SolidColorBrush(Color.FromRgb(r, g, b));
            brush.Freeze();
            return brush;
        }

        private static void Place(Panel parent, UIElement element, double x, double y, double width, double height)
        {
            FrameworkElement framework = element as FrameworkElement;
            if (framework != null)
            {
                framework.Width = width;
                framework.Height = height;
            }
            Canvas.SetLeft(element, x);
            Canvas.SetTop(element, y);
            parent.Children.Add(element);
        }

        private static void Place(Border parent, UIElement element, double x, double y, double width, double height)
        {
            Place((Canvas)parent.Child, element, x, y, width, height);
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam,
            uint flags, uint timeout, IntPtr result);

        private sealed class PayloadLocation
        {
            internal long Offset;
            internal long Length;
        }
    }

    internal sealed class OptionToggle
    {
        private readonly Border box;
        private readonly TextBlock tick;
        internal Border Root { get; private set; }
        internal bool Checked { get; private set; }

        internal OptionToggle(string text, bool initial)
        {
            Checked = initial;
            tick = new TextBlock
            {
                Text = "✓",
                FontSize = 12,
                FontWeight = FontWeights.Bold,
                Foreground = Brushes.White,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            box = new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(5),
                BorderThickness = new Thickness(1),
                Child = tick
            };
            var label = new TextBlock
            {
                Text = text,
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 10.5,
                Foreground = new SolidColorBrush(Color.FromRgb(66, 91, 122)),
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(box);
            row.Children.Add(label);
            Root = new Border { Background = Brushes.Transparent, Child = row, Cursor = Cursors.Hand };
            Root.MouseLeftButtonUp += delegate { Checked = !Checked; Refresh(); };
            Refresh();
        }

        private void Refresh()
        {
            box.Background = Checked ? new SolidColorBrush(Color.FromRgb(42, 137, 214)) : Brushes.White;
            box.BorderBrush = Checked ? new SolidColorBrush(Color.FromRgb(42, 137, 214)) : new SolidColorBrush(Color.FromRgb(191, 210, 230));
            tick.Visibility = Checked ? Visibility.Visible : Visibility.Hidden;
        }
    }

    internal sealed class SegmentStream : Stream
    {
        private readonly Stream inner;
        private readonly long start;
        private readonly long length;
        private long position;

        internal SegmentStream(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.length = length;
            position = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (position >= length) return 0;
            inner.Position = start + position;
            int read = inner.Read(buffer, offset, (int)Math.Min(count, length - position));
            position += read;
            return read;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long next = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset;
            if (next < 0 || next > length) throw new IOException("Invalid payload seek.");
            position = next;
            return position;
        }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}
