using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace Datum.Studio;

public partial class MainWindow : Window
{
    private readonly SessionDiscovery _discovery = new();
    private readonly DispatcherPoller _poller;
    private SessionDiscovery.Session? _session;
    private bool _webReady;

    public MainWindow()
    {
        InitializeComponent();

        // Poll rather than watch the file: the orchestrator can be killed without
        // deleting its handshake, so presence of the file proves nothing and only a
        // health probe does.
        _poller = new DispatcherPoller(TimeSpan.FromSeconds(5), () => _ = ConnectAsync());

        Loaded += async (_, _) =>
        {
            await InitialiseWebViewAsync();
            await ConnectAsync();
            _poller.Start();
        };

        Closed += (_, _) => _poller.Stop();
    }

    private async Task InitialiseWebViewAsync()
    {
        try
        {
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DATUM", "webview-studio");
            Directory.CreateDirectory(userData);

            var env = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userData,
                options: new CoreWebView2EnvironmentOptions
                {
                    AdditionalBrowserArguments = "--disable-background-networking",
                });

            await Web.EnsureCoreWebView2Async(env);
            var core = Web.CoreWebView2;

            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;

            // Pin navigation to loopback. Nothing in this shell should ever reach the
            // internet, and a compromised page must not be able to send it there.
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase))
                    e.Cancel = true;
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;

            // A crashed renderer must not leave a blank window with no explanation.
            core.ProcessFailed += (_, e) =>
            {
                ShowOffline("The interface process stopped.",
                    $"{e.ProcessFailedKind}. Press Reconnect to reload.");
            };

            _webReady = true;
        }
        catch (Exception ex)
        {
            _webReady = false;
            ShowOffline("WebView2 could not start.",
                ex.Message + "\n\nInstall the Microsoft Edge WebView2 Runtime and restart.");
        }
    }

    private async Task ConnectAsync()
    {
        var result = await _discovery.DiscoverAsync();

        switch (result.State)
        {
            case SessionDiscovery.State.Connected when _webReady:
                // Only navigate when the target actually changed. Re-navigating on every
                // poll would discard whatever the user was doing every five seconds.
                if (_session?.Port != result.Session!.Port || _session?.Token != result.Session.Token)
                {
                    _session = result.Session;
                    Web.CoreWebView2.Navigate(_session.StudioUrl);
                }
                ShowOnline(result.Message);
                break;

            case SessionDiscovery.State.NotRunning:
                _session = null;
                ShowOffline("The orchestrator is not running.",
                    "Start DATUM.Orchestrator.exe, then press Reconnect.");
                break;

            case SessionDiscovery.State.Stale:
                _session = null;
                ShowOffline("Found a session file, but nothing is answering.", result.Message);
                break;
        }
    }

    private void ShowOnline(string message)
    {
        StatusDot.Fill = new SolidColorBrush(Color.FromRgb(0x31, 0xC0, 0x7A));
        StatusText.Text = message;
        OfflinePanel.Visibility = Visibility.Collapsed;
        Web.Visibility = Visibility.Visible;
    }

    private void ShowOffline(string message, string hint)
    {
        StatusDot.Fill = new SolidColorBrush(Color.FromRgb(0xF0, 0xA3, 0x2A));
        StatusText.Text = message;
        OfflineMessage.Text = message;
        OfflineHint.Text = hint;
        OfflinePanel.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
    }

    private async void OnReconnectClick(object sender, RoutedEventArgs e)
    {
        ReconnectButton.IsEnabled = false;
        StatusText.Text = "Reconnecting…";
        try
        {
            if (!_webReady) await InitialiseWebViewAsync();
            _session = null; // force a fresh navigate even if the address is unchanged
            await ConnectAsync();
        }
        finally
        {
            ReconnectButton.IsEnabled = true;
        }
    }
}

/// <summary>
/// Timer that marshals its callback onto the UI thread.
///
/// A bare System.Threading.Timer would fire on a pool thread and throw the moment it
/// touched a WPF control, which is a class of bug that only shows up under load.
/// </summary>
internal sealed class DispatcherPoller
{
    private readonly System.Windows.Threading.DispatcherTimer _timer;

    public DispatcherPoller(TimeSpan interval, Action tick)
    {
        _timer = new System.Windows.Threading.DispatcherTimer { Interval = interval };
        _timer.Tick += (_, _) => tick();
    }

    public void Start() => _timer.Start();
    public void Stop() => _timer.Stop();
}
