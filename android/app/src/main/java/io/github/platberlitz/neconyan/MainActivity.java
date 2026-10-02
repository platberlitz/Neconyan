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
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    status.setText("Neconyan could not load. Close and reopen the app to restart your local workspace.");
                    status.setVisibility(View.VISIBLE);
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!local(Uri.parse(url))) return;
                if (Uri.parse(url).getPath().equals("/login")) { connect(); return; }
                status.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
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
            startForegroundService(new Intent(this, ServerService.class));
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
        if (!connecting.compareAndSet(false, true)) return;
        worker.execute(() -> {
            try {
            long startedAt = System.currentTimeMillis();
            long deadline = startedAt + 300000;
            Exception last = null;
            while (!isFinishing() && System.currentTimeMillis() < deadline) {
                try {
                    JSONObject token = new JSONObject(request("/csrf-token", null, null));
                    JSONObject login = new JSONObject().put("username", "neconyan").put("password", credentials.getString("password")).put("remember", true);
                    request("/api/auth/browser/login", login.toString(), token.getString("token"));
                    CookieManager.getInstance().flush();
                    runOnUiThread(() -> web.loadUrl(origin));
                    return;
                } catch (Exception error) {
                    last = error;
                    try {
                        File file = new File(getCacheDir(), "startup-status.txt");
                        String text = file.isFile() ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) : "Starting your workspace…";
                        runOnUiThread(() -> status.setText(text));
                        if (file.lastModified() >= startedAt && text.startsWith("Could not start Neconyan:")) return;
                        Thread.sleep(500);
                    } catch (Exception interrupted) { break; }
                }
            }
            String message = "Neconyan could not start. Close and reopen the app. " + (last == null ? "" : last.getMessage());
            runOnUiThread(() -> status.setText(message));
            } finally { connecting.set(false); }
        });
    }
    @Override public void onResume() {
        super.onResume();
        if (credentials != null) {
            startForegroundService(new Intent(this, ServerService.class));
            if (status.getVisibility() == View.VISIBLE) connect();
        }
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
        worker.shutdownNow();
        if (chooser != null) chooser.onReceiveValue(null);
        if (media != null) media.deny();
        cancelExport();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
