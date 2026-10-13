package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

/** Explicit, signed APK updates. No server URL or server credentials cross this boundary. */
public final class ApkUpdater {
    static final int INSTALL_PERMISSION = 15;
    private static final int INSTALL_APK = 16;
    private static final long MAX_BYTES = 1024L * 1024 * 1024;
    private final Activity activity;
    private final BooleanSupplier workspaceVisible;
    private final BridgeCallerGate bridgeGate;
    private final PendingApkUpdate pendingUpdate;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled;
    private volatile boolean closed;
    private volatile HttpURLConnection connection;
    private boolean busy;
    private boolean restored;
    private String pendingVersion;
    private ProgressDialog progress;

    ApkUpdater(Activity activity, BooleanSupplier workspaceVisible, BridgeCallerGate bridgeGate) {
        this.activity = activity;
        this.workspaceVisible = workspaceVisible;
        this.bridgeGate = bridgeGate;
        this.pendingUpdate = new PendingApkUpdate(UpdateApkProvider.apkFile(activity));
    }

    @JavascriptInterface public boolean bridgeRequiresToken() { return true; }

    @JavascriptInterface public boolean installUpdate(String token, String version) {
        if (!bridgeGate.accepts(token)) return false;
        activity.runOnUiThread(() -> {
            if (!bridgeGate.accepts(token)) return;
            if (!isActivityAlive() || busy || !workspaceVisible.getAsBoolean()) return;
            try {
                if (ApkUpdatePolicy.versionCode(version) <= installed().getLongVersionCode()) throw new IOException("This APK is not newer than the installed app.");
                if (!activity.getPackageName().equals("io.github.platberlitz.neconyan")) throw new IOException("A debug app cannot be replaced by a release APK. Install the release app separately.");
                String url = ApkUpdatePolicy.downloadUrl(version, architecture());
                busy = true;
                new AlertDialog.Builder(activity).setTitle("Update Neconyan to v" + version + "?")
                    .setMessage("Download the official APK from GitHub? It may use several hundred MB. Android will ask you to approve installation. Your saved data stays on this device.")
                    .setNegativeButton("Cancel", (dialog, which) -> busy = false)
                    .setOnCancelListener(dialog -> busy = false)
                    .setPositiveButton("Download APK", (dialog, which) -> { if (bridgeGate.accepts(token)) download(version, url); else busy = false; }).show();
            } catch (Exception error) { fail(error); }
        });
        return true;
    }

    private String architecture() throws IOException {
        for (String abi : Build.SUPPORTED_ABIS) {
            if (abi.equals("arm64-v8a")) return "arm64";
            if (abi.equals("x86_64")) return "x86_64";
        }
        throw new IOException("No APK is available for this device.");
    }

    private PackageInfo installed() throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), signingFlags());
    }

    @SuppressWarnings("deprecation")
    private int signingFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_SIGNATURES
            : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private Signature[] signingCertificates(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null)
            return info.signingInfo.getApkContentsSigners();
        return info.signatures;
    }

    private boolean isActivityAlive() {
        return !closed && !activity.isFinishing()
            && (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR1 || !activity.isDestroyed());
    }

    private void download(String version, String url) {
        if (!isActivityAlive()) { busy = false; return; }
        cancelled = false;
        progress = new ProgressDialog(activity);
        progress.setTitle("Downloading APK");
        progress.setMessage("Downloading the official GitHub release…");
        progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progress.setMax(100);
        progress.setIndeterminate(true);
        progress.setCancelable(false);
        progress.setButton(DialogInterface.BUTTON_NEGATIVE, "Cancel", (dialog, which) -> cancel());
        progress.show();
        worker.execute(() -> {
            File apk = UpdateApkProvider.apkFile(activity);
            File partial = null;
            try {
                if (!apk.getParentFile().isDirectory() && !apk.getParentFile().mkdirs()) throw new IOException("Could not create the private update folder.");
                String prefix = "download-" + android.os.Process.myPid() + "-";
                File[] stale = apk.getParentFile().listFiles((folder, name) -> name.startsWith("download-") && name.endsWith(".part.apk") && !name.startsWith(prefix));
                if (stale != null) for (File file : stale) file.delete();
                // A destroyed activity's worker must not remove a new activity's download.
                partial = File.createTempFile(prefix, ".part.apk", apk.getParentFile());
                apk.delete();
                transfer(url, partial);
                verify(partial, version);
                if (cancelled || closed) throw new IOException("APK download cancelled.");
                if (!partial.renameTo(apk)) throw new IOException("Could not save the update APK.");
                pendingUpdate.save(version);
                activity.runOnUiThread(() -> {
                    dismissProgress();
                    if (closed) { busy = false; return; }
                    if (cancelled) { finishPendingUpdate(); return; }
                    pendingVersion = version;
                    offerInstall();
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> { dismissProgress(); if (!closed && !cancelled) fail(error); else busy = false; });
            } finally {
                if (partial != null) partial.delete();
                HttpURLConnection active = connection;
                if (active != null) active.disconnect();
                connection = null;
            }
        });
    }

    private void transfer(String original, File target) throws Exception {
        URI uri = URI.create(original);
        for (int redirects = 0; redirects <= 5; redirects++) {
            if (closed || cancelled) throw new IOException("APK download cancelled.");
            if (!ApkUpdatePolicy.allowedDownload(uri, original)) throw new IOException("GitHub redirected to an untrusted download location.");
            HttpURLConnection request = (HttpURLConnection) uri.toURL().openConnection();
            connection = request;
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(20000);
            request.setReadTimeout(45000);
            request.setRequestProperty("Accept", "application/octet-stream");
            request.setRequestProperty("User-Agent", "Neconyan-Android-Update");
            int code = request.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String location = request.getHeaderField("Location");
                request.disconnect();
                if (location == null) throw new IOException("GitHub returned an empty download redirect.");
                uri = uri.resolve(location);
                continue;
            }
            if (code != 200) throw new IOException("GitHub download failed (HTTP " + code + "). Try checking for updates again.");
            long size = request.getContentLengthLong();
            if (size > MAX_BYTES || (size > 0 && size + 64L * 1024 * 1024 > target.getParentFile().getUsableSpace()))
                throw new IOException("There is not enough space for this APK, or it is too large.");
            long bytes = 0;
            int previous = -1;
            try (InputStream input = request.getInputStream(); OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[65536];
                for (int length; (length = input.read(buffer)) != -1;) {
                    bytes += length;
                    if (closed || cancelled || bytes > MAX_BYTES) throw new IOException("APK download stopped. Try again.");
                    output.write(buffer, 0, length);
                    int percent = size > 0 ? (int) Math.min(100, bytes * 100 / size) : -1;
                    if (percent != previous) {
                        previous = percent;
                        activity.runOnUiThread(() -> { if (progress != null) { progress.setIndeterminate(false); progress.setProgress(percent); } });
                    }
                }
            }
            if (bytes == 0 || (size > 0 && bytes != size)) throw new IOException("The APK download was incomplete. Try again.");
            return;
        }
        throw new IOException("GitHub returned too many download redirects.");
    }

    private void verify(File file, String version) throws Exception {
        PackageInfo current = installed();
        PackageInfo update = activity.getPackageManager().getPackageArchiveInfo(file.getPath(), signingFlags());
        if (update == null || !current.packageName.equals(update.packageName)
            || update.getLongVersionCode() != ApkUpdatePolicy.versionCode(version)
            || update.getLongVersionCode() <= current.getLongVersionCode()) throw new IOException("This file is not the requested Neconyan update.");
        Signature[] currentSigners = signingCertificates(current);
        Signature[] updateSigners = signingCertificates(update);
        if (currentSigners == null || currentSigners.length == 0 || updateSigners == null || updateSigners.length == 0)
            throw new IOException("Could not read the update's signature. Try downloading it again.");
        if (!new HashSet<>(Arrays.asList(currentSigners)).equals(new HashSet<>(Arrays.asList(updateSigners))))
            throw new IOException("The APK signing certificate does not match this app. It cannot update in place. Do not uninstall Neconyan; uninstalling would remove your saved data.");
    }

    private void offerInstall() {
        if (!isActivityAlive()) { busy = false; return; }
        try {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                new AlertDialog.Builder(activity).setTitle("Allow this APK update")
                    .setMessage("In Android settings, allow Neconyan to install apps, then return here to approve the update.")
                    .setNegativeButton("Cancel", (dialog, which) -> finishPendingUpdate())
                    .setOnCancelListener(dialog -> finishPendingUpdate())
                    .setPositiveButton("Open settings", (dialog, which) -> {
                        try { activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())), INSTALL_PERMISSION); }
                        catch (Exception error) { fail(error); }
                    }).show();
                return;
            }
            String version = pendingVersion;
            worker.execute(() -> {
                try {
                    // Recheck after settings, off the UI thread, before granting installer access.
                    verify(UpdateApkProvider.apkFile(activity), version);
                    activity.runOnUiThread(() -> {
                        if (closed) return;
                        try {
                            Uri uri = UpdateApkProvider.apkUri(activity);
                            Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                .putExtra(Intent.EXTRA_RETURN_RESULT, true);
                            install.setClipData(ClipData.newRawUri("Neconyan update", uri));
                            activity.startActivityForResult(install, INSTALL_APK);
                            pendingVersion = null;
                        } catch (Exception error) { fail(error); }
                    });
                } catch (Exception error) { activity.runOnUiThread(() -> fail(error)); }
            });
        } catch (Exception error) { fail(error); }
    }

    boolean onActivityResult(int requestCode) {
        if (requestCode == INSTALL_APK) { restored = true; finishPendingUpdate(); return true; }
        if (requestCode != INSTALL_PERMISSION) return false;
        restorePendingUpdate();
        if (pendingVersion != null) {
            if (activity.getPackageManager().canRequestPackageInstalls()) offerInstall();
            else fail(new IOException("APK installation was not allowed. You can try again from Server when ready."));
        }
        return true;
    }

    private boolean restorePendingUpdate() {
        if (restored || closed) return false;
        restored = true;
        try {
            pendingVersion = pendingUpdate.restore(installed().getLongVersionCode());
            if (pendingVersion != null) { busy = true; return true; }
        } catch (Exception error) { fail(error); }
        return false;
    }

    void onResume() { if (restorePendingUpdate()) offerInstall(); }

    private void finishPendingUpdate() {
        pendingVersion = null;
        busy = false;
        pendingUpdate.clear();
    }

    private void fail(Exception error) {
        if (closed) return;
        finishPendingUpdate();
        if (!isActivityAlive()) return;
        new AlertDialog.Builder(activity).setTitle("APK update not installed")
            .setMessage(error.getMessage() == null ? "Could not update the APK. Your saved data has not been changed." : error.getMessage())
            .setPositiveButton("OK", null).show();
    }
    private void dismissProgress() { if (progress != null) { progress.dismiss(); progress = null; } }
    private void cancel() { cancelled = true; HttpURLConnection active = connection; if (active != null) active.disconnect(); }
    void close() { closed = true; cancel(); dismissProgress(); worker.shutdownNow(); }
}
