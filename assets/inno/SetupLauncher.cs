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

                string installer = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer", "WorldlineBoxInstall.exe");
                if (!File.Exists(installer) || !File.Exists(Path.ChangeExtension(installer, null) + "-1.bin"))
                {
                    throw new FileNotFoundException(Chinese
                        ? "请完整解压安装包，再打开 WorldlineBoxSetup.exe。"
                        : "Extract the entire installer ZIP, then open WorldlineBoxSetup.exe.");
                }

                if (quiet)
                    return RunInstaller(installer, OriginalArguments());

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
                    return ShowProgress(installer, "/WLBREADY=" + token + OriginalArguments(), ready);
                }
            }
        }
        catch (Exception error)
        {
            if (!quiet)
                MessageBox.Show(error.Message, Caption, MessageBoxButton.OK, MessageBoxImage.Error);
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

    private static int ShowProgress(string installer, string arguments, EventWaitHandle ready)
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
        string status = Chinese ? "正在准备安装" : "Preparing setup";
        ((TextBlock)window.FindName("InstallerLabel")).Text = Chinese ? "安装程序" : "Windows installer";
        ((TextBlock)window.FindName("Status")).Text = status;
        ((TextBlock)window.FindName("Detail")).Text = Chinese
            ? "安装向导即将打开。Windows 可能会请求管理员权限。"
            : "The setup wizard is opening. Windows may ask for permission.";
        var progress = (ProgressBar)window.FindName("Progress");
        progress.IsIndeterminate = true;
        progress.Tag = SystemParameters.ClientAreaAnimation ? "animate" : null;
        AutomationProperties.SetName(progress, status);
        window.MouseLeftButtonDown += (sender, eventArgs) => window.DragMove();

        Task<int> installerProcess = null;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
        window.ContentRendered += (sender, eventArgs) =>
        {
            if (installerProcess != null)
                return;
            installerProcess = Task.Run(() => RunInstaller(installer, arguments));
            timer.Start();
        };
        timer.Tick += (sender, eventArgs) =>
        {
            if (ready.WaitOne(0) || installerProcess.IsCompleted)
                window.Close();
        };
        var app = new Application();
        app.Run(window);
        timer.Stop();
        return installerProcess == null ? 2 : installerProcess.GetAwaiter().GetResult();
    }
}
