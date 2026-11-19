using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Reflection;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

internal static class SetupLauncher
{
    private const string Product = "WorldlineBox";
    private const string SetupMutex = @"Local\WorldlineBox.SetupLauncher";
    private static readonly bool Chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
    private static readonly string Caption = Product + (Chinese ? " 安装程序" : " Setup");

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = Array.Exists(args, arg =>
            String.Equals(arg, "/silent", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(arg, "/verysilent", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(arg, "/help", StringComparison.OrdinalIgnoreCase) || arg == "/?");

        try
        {
            bool firstInstance;
            using (new Mutex(false, SetupMutex, out firstInstance))
            {
                if (!firstInstance)
                {
                    IntPtr progress = FindWindow(null, Caption);
                    if (!quiet && progress != IntPtr.Zero)
                        SetForegroundWindow(progress);
                    return 1;
                }

                if (quiet)
                    return SetupPayload.Run(installer => RunInstaller(installer, OriginalArguments()), (copied, total) => { });

                string token = Guid.NewGuid().ToString("N");
                // The elevated wizard may run under a different administrator account.
                var security = new EventWaitHandleSecurity();
                using (var identity = WindowsIdentity.GetCurrent())
                    security.AddAccessRule(new EventWaitHandleAccessRule(
                        identity.User, EventWaitHandleRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new EventWaitHandleAccessRule(
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                    EventWaitHandleRights.Modify, AccessControlType.Allow));
                using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset,
                    @"Local\WorldlineBox.SetupReady." + token, out firstInstance, security))
                {
                    return ShowProgress("/WLBREADY=" + token + OriginalArguments(), ready);
                }
            }
        }
        catch (Exception error)
        {
            if (!quiet)
                MessageBox.Show(error is InvalidDataException
                    ? (Chinese ? "安装文件不完整或已损坏，请重新下载安装程序。"
                               : "The installer is incomplete or damaged. Download it again.")
                    : error.Message, Caption, MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }

    private static string OriginalArguments()
    {
        string commandLine = Environment.CommandLine;
        int end = commandLine.StartsWith("\"") ? commandLine.IndexOf('"', 1) + 1
            : commandLine.IndexOfAny(new[] { ' ', '\t' });
        return end > 0 ? commandLine.Substring(end) : "";
    }

    private static int RunInstaller(string installer, string arguments)
    {
        using (var process = Process.Start(new ProcessStartInfo(installer, arguments) { UseShellExecute = false }))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static int ShowProgress(string arguments, EventWaitHandle ready)
    {
        var resources = Assembly.GetExecutingAssembly();
        Window window;
        using (var layout = resources.GetManifestResourceStream("SetupProgress.xaml"))
            window = (Window)XamlReader.Load(layout);
        window.Title = Caption;
        using (var logo = resources.GetManifestResourceStream("SetupLogo.png"))
        {
            var source = BitmapFrame.Create(logo, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            ((Image)window.FindName("Logo")).Source = source;
            window.Icon = source;
        }
        var status = (TextBlock)window.FindName("Status");
        var detail = (TextBlock)window.FindName("Detail");
        ((TextBlock)window.FindName("InstallerLabel")).Text = Chinese ? "安装程序" : "Windows installer";
        status.Text = Chinese ? "正在准备安装" : "Preparing setup";
        detail.Text = Chinese ? "正在读取安装文件…" : "Reading the installer…";
        var progress = (ProgressBar)window.FindName("Progress");
        progress.IsIndeterminate = true;
        progress.Tag = SystemParameters.ClientAreaAnimation ? "animate" : null;
        AutomationProperties.SetName(progress, status.Text);
        window.MouseLeftButtonDown += (sender, eventArgs) => window.DragMove();

        Task<int> installerProcess = null;
        long copiedBytes = 0, totalBytes = 0;
        var animate = progress.Tag;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
        window.ContentRendered += (sender, eventArgs) =>
        {
            if (installerProcess != null)
                return;
            installerProcess = Task.Run(() => SetupPayload.Run(installer => RunInstaller(installer, arguments),
                (copied, total) =>
                {
                    Interlocked.Exchange(ref totalBytes, total);
                    Interlocked.Exchange(ref copiedBytes, copied);
                }));
            timer.Start();
        };
        timer.Tick += (sender, eventArgs) =>
        {
            if (ready.WaitOne(0) || installerProcess.IsCompleted)
            {
                window.Close();
                return;
            }
            long total = Interlocked.Read(ref totalBytes);
            if (total == 0)
                return;
            long copied = Interlocked.Read(ref copiedBytes);
            bool opening = copied >= total;
            progress.IsIndeterminate = opening;
            progress.Tag = opening ? animate : null;
            progress.Value = (double)copied / total * 100;
            if (opening)
            {
                status.Text = Chinese ? "正在打开安装向导" : "Opening setup";
                detail.Text = Chinese ? "Windows 可能会请求管理员权限。" : "Windows may ask for administrator permission.";
                AutomationProperties.SetName(progress, status.Text);
            }
            else
            {
                string percent = ((double)copied / total).ToString("0%");
                detail.Text = Chinese ? "已准备 " + percent + "，完成后会打开安装向导。"
                    : "Preparing installation files · " + percent;
            }
        };
        var app = new Application();
        app.Run(window);
        timer.Stop();
        return installerProcess == null ? 2 : installerProcess.GetAwaiter().GetResult();
    }
}
