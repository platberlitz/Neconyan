package io.github.platberlitz.neconyan;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final int MIN_WEBVIEW_MAJOR = 124;
    private WebView web;
    private TextView status;
    private String origin;
    private JSONObject credentials;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> chooser;
    private PermissionRequest media;
    private File export;
    private OutputStream exportStream;
    private long exportBytes;
    private String exportName;
    private final java.util.concurrent.atomic.AtomicBoolean connecting = new java.util.concurrent.atomic.AtomicBoolean();
    // A server that stays up this long has started properly; a later stop is not a startup failure.
    private static final long HEALTHY_MS = 120000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout actions;
    private volatile long serverStartedAt;
    private volatile long firstStartAt;
    private volatile boolean serverSafe;
    private volatile boolean serverSeen;
    private volatile boolean autoRestarted;
    private volatile long healthySince;
    private volatile boolean failed;
    private boolean loadFailed;
    private int loadFailures;
    private boolean safeNoticeShown;
    private boolean resumed;
    private boolean backupKeys;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(22, 23, 22));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        status = new TextView(this);
        status.setText("Starting Neconyan on your phone…\nYour chats stay on this device.");
        status.setTextColor(Color.rgb(246, 242, 232));
        status.setTextSize(18);
        status.setPadding(24, 32, 24, 32);
        root.addView(status);
        setContentView(root);
        if (!checkWebView(root)) return;
        actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.VERTICAL);
        actions.setPadding(24, 0, 24, 24);
        actions.setVisibility(View.GONE);
        addAction("Try again", view -> {
            failed = false;
            autoRestarted = false;
            healthySince = 0;
            serverStartedAt = 0;
            actions.setVisibility(View.GONE);
            status.setText("Starting Neconyan on your phone…\nYour chats stay on this device.");
            connect();
        });
        addAction("Save a backup of my data", view -> offerBackup());
        addAction("Copy details for a bug report", view -> copyDetails());
        addAction("Close Neconyan", view -> { stopService(new Intent(this, ServerService.class)); finish(); });
        root.addView(actions);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(22, 23, 22));
        web.setVisibility(View.GONE);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::handleBack);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.addJavascriptInterface(this, "NeconyanExport");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (local(uri)) return false;
                if (request.isForMainFrame()) external(uri);
                return true;
            }
            // A reset page load usually means the local server stopped. Find out and recover
            // instead of leaving WebView's own error page on screen.
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame() || !local(request.getUrl()) || failed) return;
                loadFailed = true;
                web.setVisibility(View.GONE);
                status.setText("Reconnecting to your workspace…");
                status.setVisibility(View.VISIBLE);
                if (++loadFailures >= 3) showFailure("Neconyan's page kept failing to load (" + error.getDescription() + ").");
                else connect();
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!local(Uri.parse(url)) || loadFailed || failed) return;
                if (Uri.parse(url).getPath().equals("/login")) { connect(); return; }
                loadFailures = 0;
                if (healthySince == 0) healthySince = System.currentTimeMillis();
                status.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                if (serverSafe && !safeNoticeShown) showSafeNotice();
                // The host creates blob links for cards and backups. Stream chunks across the
                // bridge so a large export never needs a second whole-file base64 copy in memory.
                view.evaluateJavascript("if (!window.neconyanDownloadHook) { window.neconyanDownloadHook = true; document.addEventListener('click', e => { const a = e.target.closest('a[download]'); if (a && a.href.startsWith('blob:')) { e.preventDefault(); window.neconyanSaveBlob(a.href, a.download); } }, true); window.neconyanSaveBlob = async (url, name) => { try { const blob = await (await fetch(url)).blob(); if (!NeconyanExport.beginExport(name || 'Neconyan-export', blob.size)) throw new Error('Another export is open, or the file exceeds 1 GiB.'); for (let at = 0; at < blob.size; at += 49152) { const bytes = new Uint8Array(await blob.slice(at, at + 49152).arrayBuffer()); if (!NeconyanExport.appendExport(btoa(String.fromCharCode(...bytes)))) throw new Error('Could not save the export. Check free storage.'); } NeconyanExport.finishExport(); } catch (e) { NeconyanExport.cancelExport(); alert(e.message); } }; }", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(intent, 10); } catch (ActivityNotFoundException error) { chooser.onReceiveValue(null); chooser = null; }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!local(request.getOrigin())) { request.deny(); return; }
                    List<String> permissions = new ArrayList<>();
                    for (String resource : request.getResources()) {
                        if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) permissions.add(Manifest.permission.RECORD_AUDIO);
                        else if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) permissions.add(Manifest.permission.CAMERA);
                    }
                    if (permissions.isEmpty()) { request.deny(); return; }
                    if (media != null) media.deny();
                    media = request;
                    requestPermissions(permissions.toArray(new String[0]), 12);
                });
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message message) {
                if (!gesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        if (local(request.getUrl())) web.loadUrl(request.getUrl().toString()); else external(request.getUrl());
                        popup.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport) message.obj).setWebView(popup);
                message.sendToTarget();
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (url.startsWith("blob:" + origin + "/")) {
                web.evaluateJavascript("window.neconyanSaveBlob(" + JSONObject.quote(url) + ", 'Neconyan-export')", null);
            } else if (local(Uri.parse(url))) {
                worker.execute(() -> download(url, URLUtil.guessFileName(url, disposition, mime)));
            } else external(Uri.parse(url));
        });
        try {
            credentials = ServerService.credentials(this);
            origin = "http://127.0.0.1:" + credentials.getInt("port");
            connect();
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 11);
        } catch (Exception error) { status.setText("Could not start Neconyan: " + error.getMessage()); }
    }

    private boolean checkWebView(LinearLayout root) {
        android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
        String version = provider == null || provider.versionName == null ? "Unavailable" : provider.versionName;
        int major = 0;
        try { major = Integer.parseInt(version.split("\\.")[0]); } catch (NumberFormatException ignored) { }
        if (major >= MIN_WEBVIEW_MAJOR) return true;
        status.setText("Update Android System WebView\n\nWebView draws Neconyan's interface. Version " + MIN_WEBVIEW_MAJOR
            + " or newer is required. Installed: " + version
            + ".\n\nUpdate your phone's WebView through your app store or system updater, then reopen Neconyan.");
        Button settings = new Button(this);
        settings.setText("Open WebView settings");
        settings.setMinHeight(Math.round(48 * getResources().getDisplayMetrics().density));
        settings.setOnClickListener(view -> {
            Intent intent = provider == null ? new Intent(android.provider.Settings.ACTION_SETTINGS)
                : new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + provider.packageName));
            try { startActivity(intent); } catch (ActivityNotFoundException error) {
                Toast.makeText(this, "Open your phone's Settings to update WebView.", Toast.LENGTH_LONG).show();
            }
        });
        root.addView(settings);
        Button close = new Button(this);
        close.setText("Close Neconyan");
        close.setMinHeight(Math.round(48 * getResources().getDisplayMetrics().density));
        close.setOnClickListener(view -> finish());
        root.addView(close);
        return false;
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[65536]; int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }
    private boolean local(Uri uri) {
        return origin != null && uri != null && (uri.getScheme() + "://" + uri.getAuthority()).equals(origin);
    }
    private void external(Uri uri) {
        if (!Arrays.asList("https", "http", "mailto").contains(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException error) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_LONG).show(); }
    }
    private void connect() {
        if (failed || !connecting.compareAndSet(false, true)) return;
        worker.execute(() -> {
            try { connectNow(); }
            catch (InterruptedException stopped) { Thread.currentThread().interrupt(); }
            catch (Exception error) { show("Neconyan is still starting. Open the app again to finish. (" + error.getMessage() + ")"); }
            finally { connecting.set(false); }
        });
    }
    // Starts the local server when it is not running, waits for it, and signs the page in.
    // A server that stops while starting is restarted once in safe mode before giving up.
    private void connectNow() throws Exception {
        String stopped = null;
        while (!isFinishing() && !failed) {
            if (stopped != null) {
                if (!restartAfterStop(stopped)) return;
            } else if (!serverProcessRunning()) {
                clearStaleMarker();
                if (serverStartedAt == 0) startServer(false);
                else if (!restartAfterStop("")) return;
            } else if (serverStartedAt == 0) {
                serverStartedAt = System.currentTimeMillis();
                serverSeen = true;
                serverSafe = readyMarker().optBoolean("safe", false);
                // Android can keep an idle :server process cached after its service ended; a
                // running service ignores this second start.
                startForegroundService(new Intent(this, ServerService.class).putExtra(ServerService.SAFE, serverSafe));
            }
            stopped = waitForWorkspace();
            if (stopped == null) return;
        }
    }
    private String waitForWorkspace() throws Exception {
        long startedAt = serverStartedAt;
        long deadline = System.currentTimeMillis() + 300000;
        Exception last = null;
        while (!isFinishing() && !failed && System.currentTimeMillis() < deadline) {
            try {
                JSONObject token = new JSONObject(request("/csrf-token", null, null));
                JSONObject login = new JSONObject().put("username", "neconyan").put("password", credentials.getString("password")).put("remember", true);
                request("/api/auth/browser/login", login.toString(), token.getString("token"));
                CookieManager.getInstance().flush();
                runOnUiThread(() -> { loadFailed = false; web.loadUrl(origin); });
                return null;
            } catch (Exception error) {
                last = error;
                File file = new File(getCacheDir(), "startup-status.txt");
                String text = file.isFile() ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim() : "";
                boolean fresh = !text.isEmpty();
                if (fresh && (text.startsWith("Could not start Neconyan:") || text.startsWith("Neconyan stopped"))) return text;
                if (serverProcessRunning()) serverSeen = true;
                else if (serverSeen || System.currentTimeMillis() - startedAt > 20000) return "";
                show(fresh ? text : "Starting your workspace…");
                Thread.sleep(500);
            }
        }
        if (isFinishing() || failed) return null;
        return "Neconyan took more than five minutes to start" + (last == null ? "." : " (" + last.getMessage() + ").");
    }
    private boolean restartAfterStop(String reason) throws InterruptedException {
        long up = healthySince == 0 ? 0 : System.currentTimeMillis() - healthySince;
        healthySince = 0;
        boolean safe;
        if (up >= HEALTHY_MS) {
            autoRestarted = false;
            safe = false;
            show("Neconyan stopped. Starting it again…");
        } else if (!serverSafe && !autoRestarted) {
            autoRestarted = true;
            safe = true;
            show("Neconyan stopped while starting.\nStarting again in safe mode, with background tasks paused…");
        } else {
            showFailure(reason);
            return false;
        }
        if (serverProcessRunning()) stopService(new Intent(this, ServerService.class));
        for (int i = 0; i < 30 && serverProcessRunning(); i++) Thread.sleep(500);
        clearStaleMarker();
        startServer(safe);
        return true;
    }
    private void startServer(boolean safe) {
        serverSafe = safe;
        serverSeen = false;
        serverStartedAt = System.currentTimeMillis();
        if (firstStartAt == 0) firstStartAt = serverStartedAt;
        new File(getCacheDir(), "startup-status.txt").delete();
        startForegroundService(new Intent(this, ServerService.class).putExtra(ServerService.SAFE, safe));
    }
    private boolean serverProcessRunning() {
        List<ActivityManager.RunningAppProcessInfo> processes = getSystemService(ActivityManager.class).getRunningAppProcesses();
        if (processes == null) return false;
        for (ActivityManager.RunningAppProcessInfo process : processes)
            if ((getPackageName() + ":server").equals(process.processName)) return true;
        return false;
    }
    private JSONObject readyMarker() {
        try { return new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(), "android-ready.json").toPath()), StandardCharsets.UTF_8)); }
        catch (Exception error) { return new JSONObject(); }
    }
    // A server that was killed outright leaves its ready marker behind; it must not look alive.
    private void clearStaleMarker() {
        if (!serverProcessRunning()) new File(getFilesDir(), "android-ready.json").delete();
    }
    private void show(String text) {
        runOnUiThread(() -> { if (!failed) status.setText(text); });
    }
    private void showFailure(String reason) {
        failed = true;
        String summary = failureSummary(reason);
        runOnUiThread(() -> {
            if (web != null) web.setVisibility(View.GONE);
            status.setText(summary);
            status.setVisibility(View.VISIBLE);
            actions.setVisibility(View.VISIBLE);
        });
    }
    private String failureSummary(String reason) {
        String cause;
        ApplicationExitInfo exit = lastServerExit(firstStartAt);
        if ((exit != null && exit.getReason() == ApplicationExitInfo.REASON_LOW_MEMORY) || logMentionsMemory())
            cause = "Your phone ran out of memory while Neconyan was loading your data.";
        else if (reason != null && !reason.isEmpty()) cause = reason;
        else if (exit != null) cause = "The local server stopped unexpectedly (" + exitReason(exit) + ").";
        else cause = "The local server stopped unexpectedly.";
        return "Neconyan could not start\n\n" + cause
            + "\n\nYour chats, characters and settings are still saved on this phone."
            + "\n\nTry again, or save a backup first. The backup is a ZIP file you can import into Neconyan on another device or in Termux (Settings > System & Device > Import & Restore).";
    }
    private ApplicationExitInfo lastServerExit(long since) {
        try {
            for (ApplicationExitInfo info : getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(getPackageName(), 0, 10))
                if (info.getProcessName() != null && info.getProcessName().endsWith(":server") && info.getTimestamp() >= since) return info;
        } catch (Exception ignored) { }
        return null;
    }
    private static String exitReason(ApplicationExitInfo info) {
        switch (info.getReason()) {
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "Android closed it to free memory";
            case ApplicationExitInfo.REASON_CRASH: return "app crash";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "native crash";
            case ApplicationExitInfo.REASON_SIGNALED: return "signal " + info.getStatus();
            case ApplicationExitInfo.REASON_EXIT_SELF: return "exited with code " + info.getStatus();
            case ApplicationExitInfo.REASON_ANR: return "stopped responding";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "Android stopped it for using too many resources";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "could not initialise";
            case ApplicationExitInfo.REASON_USER_REQUESTED: return "stopped from Android settings";
            case ApplicationExitInfo.REASON_USER_STOPPED: return "force-stopped";
            default: return "reason " + info.getReason();
        }
    }
    private boolean logMentionsMemory() {
        for (String name : new String[] { "server.log", "server.previous.log" }) {
            String log = tail(new File(getCacheDir(), name), 200);
            if (log.contains("heap out of memory") || log.contains("Allocation failed") || log.contains("OutOfMemory")) return true;
        }
        return false;
    }
    private static String tail(File file, int lines) {
        if (!file.isFile()) return "";
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            long start = Math.max(0, input.length() - 65536);
            byte[] bytes = new byte[(int) (input.length() - start)];
            input.seek(start);
            input.readFully(bytes);
            String[] all = new String(bytes, StandardCharsets.UTF_8).split("\n");
            return String.join("\n", Arrays.asList(all).subList(Math.max(0, all.length - lines), all.length));
        } catch (IOException error) { return "Could not read " + file.getName() + ": " + error.getMessage(); }
    }
    private void copyDetails() {
        StringBuilder text = new StringBuilder("Neconyan ");
        try { text.append(getPackageManager().getPackageInfo(getPackageName(), 0).versionName); } catch (Exception ignored) { text.append("(unknown version)"); }
        text.append(" on ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(", Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
        text.append("WebView: ").append(provider == null ? "unavailable" : provider.packageName + " " + provider.versionName).append('\n');
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        getSystemService(ActivityManager.class).getMemoryInfo(memory);
        text.append("Phone memory: ").append(memory.totalMem / (1024 * 1024)).append(" MB, server heap limit: ").append(ServerService.heapMegabytes(this))
            .append(" MB, last start: ").append(serverSafe ? "safe mode" : "normal").append("\n\n").append(status.getText()).append("\n\nRecent server exits:\n");
        try {
            for (ApplicationExitInfo info : getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(getPackageName(), 0, 10)) {
                if (info.getProcessName() == null || !info.getProcessName().endsWith(":server")) continue;
                text.append(new Date(info.getTimestamp())).append(": ").append(exitReason(info))
                    .append(info.getDescription() == null ? "" : ", " + info.getDescription())
                    .append(", memory ").append(info.getPss() / 1024).append(" MB\n");
            }
        } catch (Exception error) { text.append("Unavailable: ").append(error.getMessage()).append('\n'); }
        text.append("\nNative runtime:\n").append(tail(new File(getCacheDir(), "native-startup.txt"), 4));
        text.append("\nServer log (this start):\n").append(tail(new File(getCacheDir(), "server.log"), 40))
            .append("\n\nServer log (previous start):\n").append(tail(new File(getCacheDir(), "server.previous.log"), 40));
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Neconyan details", text.toString()));
        Toast.makeText(this, "Details copied. Paste them into your bug report.", Toast.LENGTH_LONG).show();
    }
    private void showSafeNotice() {
        safeNoticeShown = true;
        new AlertDialog.Builder(this).setTitle("Neconyan is in safe mode")
            .setMessage("Neconyan stopped while starting, so it started again with background tasks paused: automatic memory updates and automatic messages are off, and replies or jobs that were interrupted are paused so you can retry them.\n\nYour chats are safe. Safe mode ends when you stop Neconyan and open it again.")
            .setPositiveButton("Continue", null)
            .setNeutralButton("Save a backup", (dialog, which) -> offerBackup()).show();
    }
    private void offerBackup() {
        new AlertDialog.Builder(this).setTitle("Save a backup of your data")
            .setMessage("This saves your chats, characters, lorebooks, settings and other Neconyan data as a ZIP file. It works even when Neconyan cannot start.\n\nSaved API keys are left out unless you include them. Anyone with a backup that has keys can use them.")
            .setPositiveButton("Save backup", (dialog, which) -> chooseBackupFile(false))
            .setNeutralButton("Include API keys", (dialog, which) -> chooseBackupFile(true))
            .setNegativeButton("Cancel", null).show();
    }
    private void chooseBackupFile(boolean includeKeys) {
        backupKeys = includeKeys;
        String name = "Neconyan-backup-" + new java.text.SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date()) + ".zip";
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(save, 14); } catch (ActivityNotFoundException error) { Toast.makeText(this, "Install a file manager to save backups.", Toast.LENGTH_LONG).show(); }
    }
    private void saveBackup(Uri destination, boolean includeKeys) {
        Toast.makeText(this, "Saving your backup…", Toast.LENGTH_SHORT).show();
        // Own thread: the shared worker may be busy waiting for the server.
        new Thread(() -> {
            String message;
            try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("No output file");
                DataRescue.Result result = DataRescue.write(new File(getFilesDir(), "data"), output, includeKeys);
                message = "Backup saved: " + result.files + " files (" + Math.max(1, result.bytes / (1024 * 1024)) + " MB)."
                    + (result.skipped.isEmpty() ? "" : "\n\nThese files could not be read and were left out:\n" + String.join("\n", result.skipped.subList(0, Math.min(20, result.skipped.size()))));
            } catch (Exception error) {
                message = "The backup could not be saved: " + error.getMessage() + "\n\nCheck free storage and try another location.";
            }
            String text = message;
            runOnUiThread(() -> { if (!isFinishing()) new AlertDialog.Builder(this).setMessage(text).setPositiveButton("OK", null).show(); });
        }, "neconyan-backup").start();
    }
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            if (web != null && web.getVisibility() == View.VISIBLE && !failed && !connecting.get())
                worker.execute(() -> { if (!connecting.get() && !failed && !serverProcessRunning()) runOnUiThread(MainActivity.this::reconnect); });
            main.postDelayed(this, 5000);
        }
    };
    private void reconnect() {
        if (failed || web == null || web.getVisibility() != View.VISIBLE) return;
        web.setVisibility(View.GONE);
        status.setText("Reconnecting to your workspace…");
        status.setVisibility(View.VISIBLE);
        connect();
    }
    @Override public void onResume() {
        super.onResume();
        resumed = true;
        if (credentials == null || web == null || failed) return;
        if (status.getVisibility() == View.VISIBLE) connect();
        main.removeCallbacks(watchdog);
        main.post(watchdog);
    }
    @Override public void onPause() {
        resumed = false;
        main.removeCallbacks(watchdog);
        super.onPause();
    }
    private void addAction(String label, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setMinHeight(Math.round(48 * getResources().getDisplayMetrics().density));
        button.setOnClickListener(listener);
        actions.addView(button);
    }
    private void requireServerReady() throws Exception {
        // A private marker is written by the existing SERVER_STARTED event only
        // after binding succeeds. Never send cookies/passwords to a port squatter.
        JSONObject ready = new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(), "android-ready.json").toPath()), StandardCharsets.UTF_8));
        if (ready.getInt("port") != credentials.getInt("port") || ready.getInt("pid") <= 0 || ready.getInt("pid") == android.os.Process.myPid()) throw new IOException("The local server is not ready");
        android.system.Os.kill(ready.getInt("pid"), 0);
    }
    private String request(String path, String body, String csrf) throws Exception {
        requireServerReady();
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setConnectTimeout(2000); connection.setReadTimeout(10000);
        connection.setInstanceFollowRedirects(false);
        String cookie = CookieManager.getInstance().getCookie(origin);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        if (body != null) {
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("X-CSRF-Token", csrf);
            try (OutputStream stream = connection.getOutputStream()) { stream.write(body.getBytes(StandardCharsets.UTF_8)); }
        }
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Local server returned " + connection.getResponseCode());
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet())
                if ("Set-Cookie".equalsIgnoreCase(header.getKey())) for (String value : header.getValue()) CookieManager.getInstance().setCookie(origin, value);
            try (InputStream stream = connection.getInputStream()) { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); copy(stream, bytes); return bytes.toString("UTF-8"); }
        } finally { connection.disconnect(); }
    }

    @JavascriptInterface public synchronized boolean beginExport(String name, long size) {
        if (export != null || size < 0 || size > 1024L * 1024 * 1024) return false;
        try {
            export = File.createTempFile("neconyan-export-", ".tmp", getCacheDir());
            exportStream = new FileOutputStream(export); exportBytes = 0;
            exportName = new File(name == null ? "Neconyan-export" : name).getName().replaceAll("[\\p{Cntrl}]", "");
            if (exportName.trim().isEmpty()) exportName = "Neconyan-export";
            return true;
        } catch (IOException error) { cancelExport(); return false; }
    }
    @JavascriptInterface public synchronized boolean appendExport(String base64) {
        try {
            if (exportStream == null || base64.length() > 100000) return false;
            byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            exportBytes += bytes.length;
            if (exportBytes > 1024L * 1024 * 1024) { cancelExport(); return false; }
            exportStream.write(bytes); return true;
        } catch (Exception error) { cancelExport(); return false; }
    }
    @JavascriptInterface public synchronized void finishExport() {
        if (exportStream == null) return;
        try { exportStream.close(); exportStream = null; } catch (IOException error) { cancelExport(); return; }
        runOnUiThread(() -> {
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, exportName);
            try { startActivityForResult(save, 13); } catch (ActivityNotFoundException error) { cancelExport(); Toast.makeText(this, "Install a file manager to save exports.", Toast.LENGTH_LONG).show(); }
        });
    }
    @JavascriptInterface public synchronized void cancelExport() {
        try { if (exportStream != null) exportStream.close(); } catch (IOException ignored) { }
        exportStream = null;
        if (export != null) export.delete();
        export = null;
    }
    private void download(String url, String name) {
        if (!beginExport(name, 0)) return;
        HttpURLConnection connection = null;
        try {
            requireServerReady();
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(60000);
            String cookie = CookieManager.getInstance().getCookie(origin);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (connection.getResponseCode() != 200) throw new IOException("Export request failed");
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[49152]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (!appendExport(android.util.Base64.encodeToString(buffer, 0, count, android.util.Base64.NO_WRAP))) throw new IOException("Export too large or storage full");
                }
            }
            finishExport();
        } catch (Exception error) {
            cancelExport(); runOnUiThread(() -> Toast.makeText(this, "Export failed. Check free storage and try again.", Toast.LENGTH_LONG).show());
        } finally { if (connection != null) connection.disconnect(); }
    }
    // parseResult only reads getData(); pickers return a multi-file selection in
    // ClipData with getData() empty, which reached the page as no files at all.
    private static Uri[] chosenFiles(int result, Intent data) {
        if (result != RESULT_OK || data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null) {
            List<Uri> uris = new ArrayList<>();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
            if (!uris.isEmpty()) return uris.toArray(new Uri[0]);
        }
        return WebChromeClient.FileChooserParams.parseResult(result, data);
    }
    @Override public void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == 10 && chooser != null) { chooser.onReceiveValue(chosenFiles(result, data)); chooser = null; }
        if (code == 14 && result == RESULT_OK && data != null && data.getData() != null) saveBackup(data.getData(), backupKeys);
        if (code == 13 && export != null) {
            if (result != RESULT_OK || data == null) { cancelExport(); return; }
            Uri destination = data.getData();
            worker.execute(() -> {
                try {
                    try (InputStream input = new FileInputStream(export); OutputStream output = getContentResolver().openOutputStream(destination)) {
                        if (output == null) throw new IOException("No output file");
                        copy(input, output);
                    }
                    runOnUiThread(() -> Toast.makeText(this, "Export saved.", Toast.LENGTH_SHORT).show());
                    cancelExport();
                } catch (Exception error) { runOnUiThread(() -> new AlertDialog.Builder(this).setMessage("The export could not be saved. Choose another location.")
                    .setPositiveButton("Try again", (dialog, which) -> startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/octet-stream").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, exportName), 13))
                    .setNegativeButton("Cancel", (dialog, which) -> cancelExport()).show()); }
            });
        }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != 12 || media == null) return;
        List<String> granted = new ArrayList<>();
        for (int i = 0; i < permissions.length; i++) if (results[i] == PackageManager.PERMISSION_GRANTED)
            granted.add(permissions[i].equals(Manifest.permission.RECORD_AUDIO) ? PermissionRequest.RESOURCE_AUDIO_CAPTURE : PermissionRequest.RESOURCE_VIDEO_CAPTURE);
        if (granted.isEmpty()) media.deny(); else media.grant(granted.toArray(new String[0]));
        media = null;
    }
    // Android 9-12 still use this callback; Android 13+ register handleBack above.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { handleBack(); }
    private void handleBack() {
        if (web == null) { finish(); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        new AlertDialog.Builder(this).setMessage("Keep Neconyan running in the background?")
            .setPositiveButton("Keep running", (dialog, which) -> moveTaskToBack(true))
            .setNegativeButton("Stop and close", (dialog, which) -> { stopService(new Intent(this, ServerService.class)); finish(); }).show();
    }
    @Override public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        worker.shutdownNow();
        if (chooser != null) chooser.onReceiveValue(null);
        if (media != null) media.deny();
        cancelExport();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
