using System;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Threading;

namespace Datum.Studio;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // An unhandled exception on the UI thread kills a WPF app silently — the window
        // just vanishes. Catching it means the user gets a message and a log file instead
        // of concluding the product is broken with no evidence.
        DispatcherUnhandledException += OnDispatcherException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            Log(args.ExceptionObject as Exception, fatal: true);
    }

    private void OnDispatcherException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Log(e.Exception, fatal: false);

        MessageBox.Show(
            $"DATUM Studio hit an unexpected error.\n\n{e.Exception.Message}\n\n" +
            "Your SOLIDWORKS session and any open model are unaffected. " +
            "Details were written to the log folder.",
            "DATUM Studio",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);

        // Handled: the shell hosts a web view, so a single failure is rarely fatal to the
        // whole process and tearing down would lose more than it protects.
        e.Handled = true;
    }

    private static void Log(Exception? ex, bool fatal)
    {
        if (ex is null) return;

        try
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DATUM", "logs");
            Directory.CreateDirectory(dir);

            var sb = new StringBuilder()
                .AppendLine($"{DateTime.Now:O} {(fatal ? "FATAL" : "ERROR")} {ex.GetType().Name}: {ex.Message}")
                .AppendLine(ex.StackTrace);

            File.AppendAllText(Path.Combine(dir, $"studio-{DateTime.Now:yyyyMMdd}.log"), sb.ToString());
        }
        catch
        {
            // A failed log write must never become the thing that crashes the app.
        }
    }
}
