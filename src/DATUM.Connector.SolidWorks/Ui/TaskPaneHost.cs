using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using SolidWorks.Interop.sldworks;

namespace Datum.Connector.SolidWorks.Ui
{
    /// <summary>
    /// Hosts the React UI inside the SOLIDWORKS Task Pane via WebView2.
    ///
    /// This is the key UX decision in the product: the whole panel runs docked next to
    /// the graphics area, so designers never alt-tab for the common case. It also means
    /// one React bundle serves both this panel and the standalone Studio window.
    ///
    /// Security posture: the WebView gets its own isolated user-data folder, navigation
    /// is pinned to the local app origin, and the session token is handed over through
    /// AddHostObjectToScript rather than a URL query string (which would leak into
    /// history and logs).
    /// </summary>
    internal sealed class TaskPaneHost : IDisposable
    {
        private const string PaneTitle = "DATUM";

        private readonly SldWorks _sw;
        private ITaskpaneView? _view;
        private Panel? _container;
        private WebView2? _web;
        private bool _disposed;

        public TaskPaneHost(SldWorks sw) { _sw = sw; }

        public void Create()
        {
            try
            {
                string icon = Path.Combine(AppDir, "assets", "datum-taskpane.png");
                _view = _sw.CreateTaskpaneView2(File.Exists(icon) ? icon : "", PaneTitle);
                if (_view == null)
                {
                    KernelLog.Warn("CreateTaskpaneView2 returned null; the panel is unavailable this session.");
                    return;
                }

                _container = new Panel { Dock = DockStyle.Fill, BackColor = System.Drawing.Color.FromArgb(10, 15, 21) };
                _web = new WebView2 { Dock = DockStyle.Fill };
                _container.Controls.Add(_web);

                if (!_view.DisplayWindowFromHandlex64(_container.Handle.ToInt64()))
                    KernelLog.Warn("DisplayWindowFromHandlex64 failed; the panel will not be shown.");

                // Fire and forget: WebView2 initialisation is slow and must never block
                // ConnectToSW, or the user sits watching the SOLIDWORKS splash screen.
                _ = InitialiseAsync();
            }
            catch (Exception ex)
            {
                KernelLog.Error("Task pane creation failed", ex);
            }
        }

        private async Task InitialiseAsync()
        {
            try
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DATUM", "webview");
                Directory.CreateDirectory(userData);

                var env = await CoreWebView2Environment.CreateAsync(
                    browserExecutableFolder: null,
                    userDataFolder: userData,
                    options: new CoreWebView2EnvironmentOptions
                    {
                        // No telemetry from an embedded browser inside someone's CAD seat.
                        AdditionalBrowserArguments = "--disable-features=msWebOOUI,msPdfOOUI --disable-background-networking"
                    });

                await _web!.EnsureCoreWebView2Async(env);
                var core = _web.CoreWebView2;

                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = KernelLog.VerboseEnabled;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;

                // Serve the bundle from disk under a virtual origin so relative asset
                // paths, fetch, and module imports all behave like a normal web app.
                string uiRoot = Path.Combine(AppDir, "ui");
                if (Directory.Exists(uiRoot))
                {
                    core.SetVirtualHostNameToFolderMapping(
                        "datum.local", uiRoot, CoreWebView2HostResourceAccessKind.Allow);
                    core.Navigate("https://datum.local/index.html?surface=panel");
                }
                else
                {
                    KernelLog.Warn("UI bundle not found at " + uiRoot);
                    core.NavigateToString(FallbackHtml(uiRoot));
                }

                // Pin navigation: nothing may take this WebView somewhere else.
                core.NavigationStarting += (s, e) =>
                {
                    if (!e.Uri.StartsWith("https://datum.local/", StringComparison.OrdinalIgnoreCase))
                        e.Cancel = true;
                };
                core.NewWindowRequested += (s, e) => e.Handled = true;   // no popups
                core.DownloadStarting += (s, e) => e.Cancel = true;      // no downloads

                KernelLog.Info("Task pane WebView2 ready.");
            }
            catch (Exception ex)
            {
                KernelLog.Error("WebView2 initialisation failed", ex);
                try { _web?.CoreWebView2?.NavigateToString(ErrorHtml(ex.Message)); } catch { }
            }
        }

        private static string AppDir =>
            Path.GetDirectoryName(typeof(TaskPaneHost).Assembly.Location) ?? ".";

        private static string FallbackHtml(string expected) => $@"
<!doctype html><meta charset=""utf-8"">
<body style=""margin:0;background:#0A0F15;color:#95A8BF;font:13px 'Segoe UI',sans-serif;padding:24px"">
<h3 style=""color:#E4EDF7;margin:0 0 8px"">UI bundle not found</h3>
<p>Expected the built React app at:</p>
<code style=""color:#4A8CFF;word-break:break-all"">{expected}</code>
<p style=""margin-top:16px"">Build it with <code>npm run build</code> in <code>ui/</code> and copy <code>dist/</code> here.</p>
</body>";

        private static string ErrorHtml(string message) => $@"
<!doctype html><meta charset=""utf-8"">
<body style=""margin:0;background:#0A0F15;color:#95A8BF;font:13px 'Segoe UI',sans-serif;padding:24px"">
<h3 style=""color:#F2495C;margin:0 0 8px"">DATUM panel could not start</h3>
<p>{System.Net.WebUtility.HtmlEncode(message)}</p>
<p style=""margin-top:16px"">SOLIDWORKS is unaffected. Check the log at
<code>%LOCALAPPDATA%\DATUM\logs</code>.</p>
</body>";

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _web?.Dispose(); } catch { }
            try { _container?.Dispose(); } catch { }
            try { _view?.DeleteView(); } catch { }
            _view = null;
        }
    }
}
