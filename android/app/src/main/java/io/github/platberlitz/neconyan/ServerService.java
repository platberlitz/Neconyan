package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.util.HashSet;
import java.util.Set;

public final class ServerService extends Service {
    public static final String STOP = "io.github.platberlitz.neconyan.STOP";
    public static final String SAFE = "safe";
    private static native int startNode(String[] arguments, String cache);
    private boolean started;
    private boolean nodeStarted;
    private PowerManager.WakeLock wake;
    private FileObserver busyWatcher;
    private boolean stopping;
    private static final String BUSY = "android-busy";
    private static final java.util.concurrent.atomic.AtomicBoolean runtimeClaimed = new java.util.concurrent.atomic.AtomicBoolean();

    public static synchronized JSONObject credentials(Context context) throws Exception {
        File file = new File(context.getNoBackupFilesDir(), "launcher.json");
        if (file.isFile()) return new JSONObject(new String(Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder password = new StringBuilder();
        for (byte value : bytes) password.append(String.format("%02x", value));
        int port;
        try (ServerSocket socket = new ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))) { port = socket.getLocalPort(); }
        JSONObject value = new JSONObject().put("port", port).put("password", password.toString());
        File temporary = new File(file.getParentFile(), "launcher.tmp");
        Files.write(temporary.toPath(), value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE);
        return value;
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("server", "Local Neconyan server", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { stopSelf(); return START_NOT_STICKY; }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ServerService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        startForeground(1, new Notification.Builder(this, "server").setContentTitle("Neconyan is running on your phone")
            .setContentText("Tap to open. Stop when you have finished chatting.").setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open).addAction(new Notification.Action.Builder(null, "Stop", stop).build()).setOngoing(true).build());
        if (!started) {
            started = true;
            ActivityBreadcrumbs.state("starting");
            boolean safe = intent != null && intent.getBooleanExtra(SAFE, false);
            new File(getFilesDir(), "android-ready.json").delete();
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Neconyan:server");
            wake.setReferenceCounted(false);
            // Starting up keeps the phone awake. After that the server creates this marker while it
            // is working and removes it when idle, so an idle server no longer stops the phone sleeping.
            new File(getFilesDir(), BUSY).delete();
            busyWatcher = new FileObserver(getFilesDir(), FileObserver.CREATE | FileObserver.DELETE | FileObserver.MOVED_TO | FileObserver.MOVED_FROM) {
                @Override public void onEvent(int event, String path) { if (BUSY.equals(path)) syncWake(); }
            };
            busyWatcher.startWatching();
            wake.acquire();
            new Thread(() -> {
                try {
                    status("Preparing Neconyan on your phone…");
                    File runtime = installPayload();
                    JSONObject credentials = credentials(this);
                    status("Starting your workspace…");
                    System.loadLibrary("neconyan-node");
                    if (!runtimeClaimed.compareAndSet(false, true)) throw new IOException("The previous local server is still stopping");
                    nodeStarted = true;
                    ActivityBreadcrumbs.state("running");
                    // Keep the previous run's log and request trace so a crash can still be explained after the restart.
                    rotate("server.log", "server.previous.log");
                    rotate("requests.txt", "requests.previous.txt");
                    // Without the WebAssembly trap handler Node leaves SIGSEGV to Android's crash
                    // dumper, so a native crash produces a tombstone instead of a silent 'signal 11'.
                    // The runtime's built-in ICU data has no word-break rules and Intl.Segmenter
                    // crashes without them, so Node loads the full data shipped in the payload.
                    int exit = startNode(new String[] { "node", "--max-old-space-size=" + heapMegabytes(this), "--disable-wasm-trap-handler", "--icu-data-dir=" + new File(runtime, "icu").getPath(), "--import", new File(runtime, "file-stats.mjs").getPath(), new File(runtime, "server-bootstrap.mjs").getPath(),
                        getFilesDir().getPath(), credentials.getString("port"), credentials.getString("password"), safe ? "safe" : "normal" }, getCacheDir().getPath());
                    status("Neconyan stopped (" + exit + "). Reopen the app to start it again.");
                    // Diagnostic writes must never stop the service from closing cleanly.
                    if (exit != 0) try { CrashDiagnostics.recordReport(this, "server", "native-runtime-exit", null, "Local server returned exit code " + exit + ". No Java exception was supplied.", String.valueOf(exit), ActivityBreadcrumbs.current()); } catch (Throwable ignored) { }
                    stopSelf();
                } catch (Throwable error) {
                    try { CrashDiagnostics.record(this, "server-startup-failure", error, "The Android server service could not start the workspace."); } catch (Throwable ignored) { }
                    try { status("Could not start Neconyan: " + error.getMessage() + ". Your saved data has been kept. Reopen the app to try again."); } catch (Exception ignored) { }
                    stopSelf();
                }
            }, "neconyan-server").start();
        }
        // Reopen after process loss; do not repeatedly boot a failing native runtime.
        return START_NOT_STICKY;
    }

    private synchronized void syncWake() {
        if (wake == null || stopping) return;
        if (new File(getFilesDir(), BUSY).exists()) { if (!wake.isHeld()) wake.acquire(); }
        else if (wake.isHeld()) wake.release();
    }

    private synchronized void stopWake() {
        stopping = true;
        if (busyWatcher != null) busyWatcher.stopWatching();
        if (wake != null && wake.isHeld()) wake.release();
    }

    private void rotate(String current, String previous) throws IOException {
        File file = new File(getCacheDir(), current);
        if (file.isFile()) Files.move(file.toPath(), new File(getCacheDir(), previous).toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    // Large chats need more than a fixed 512 MB heap; leave most of the phone's memory to Android.
    static int heapMegabytes(Context context) {
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        context.getSystemService(ActivityManager.class).getMemoryInfo(memory);
        long quarter = memory.totalMem / (4L * 1024 * 1024);
        return (int) Math.max(512, Math.min(2048, quarter));
    }

    private void status(String text) throws IOException {
        Files.write(new File(getCacheDir(), "startup-status.txt").toPath(), DiagnosticStore.redact(text).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private File installPayload() throws Exception {
        File runtime = new File(getNoBackupFilesDir(), "runtime-" + BuildConfig.SERVER_SHA256.substring(0, 16));
        SharedPreferences installed = getSharedPreferences("runtime", MODE_PRIVATE);
        // A previous publish may have stopped between moving the live folder aside and
        // installing the verified tree. Restore it before choosing where to preserve
        // user extensions from.
        PayloadInstaller.recover(runtime);
        if (isInstalled(runtime)) {
            if (!installed.edit().putString("directory", runtime.getName()).commit()) throw new IOException("Cannot record the installed application");
            return runtime;
        }
        File stage = new File(getNoBackupFilesDir(), "runtime-staging");
        PayloadInstaller.deleteTree(stage);
        String previousName = installed.getString("directory", "");
        File oldRuntime = previousName.matches("runtime-[a-f0-9]{16}") ? new File(getNoBackupFilesDir(), previousName) : null;
        // An APK update can change the runtime folder name. Recover the previous
        // version's interrupted publish too, or its extensions stay in .rollback.
        if (oldRuntime != null) PayloadInstaller.recover(oldRuntime);
        File source = extensionSource(runtime, oldRuntime);
        // One asset stream serves both hashing and extraction. PayloadInstaller only
        // publishes the staged tree after the complete archive checksum matches.
        try (InputStream archive = getAssets().open("server.zip")) {
            PayloadInstaller.install(archive, BuildConfig.SERVER_SHA256, stage, runtime, prepared -> {
                if (source != null) preserveExtensions(source, prepared);
            });
        }
        if (!installed.edit().putString("directory", runtime.getName()).commit()) throw new IOException("Cannot record the installed application");
        // User data is in files/data, never inside these replaceable application folders.
        // Only complete version folders are swept; interrupted publish backups are left
        // for PayloadInstaller to recover or remove, never deleted blindly by name.
        File[] siblings = getNoBackupFilesDir().listFiles();
        if (siblings != null) for (File old : siblings) {
            if (old.isDirectory() && old.getName().matches("runtime-[a-f0-9]{16}") && !old.equals(runtime)) {
                try { PayloadInstaller.deleteTree(old); } catch (IOException error) { android.util.Log.w("Neconyan", "Previous application files could not be removed", error); }
            }
        }
        return runtime;
    }

    private static File extensionSource(File runtime, File oldRuntime) {
        File[] candidates = { runtime, PayloadInstaller.rollback(runtime), PayloadInstaller.previous(runtime), oldRuntime,
            oldRuntime == null ? null : PayloadInstaller.rollback(oldRuntime),
            oldRuntime == null ? null : PayloadInstaller.previous(oldRuntime) };
        for (File candidate : candidates) {
            if (hasThirdPartyExtensions(candidate) && hasExtensionManifest(candidate)) return candidate;
        }
        // A damaged source still blocks deletion of its backup; preserveExtensions
        // will fail the install rather than drop extension files.
        for (File candidate : candidates) {
            if (hasThirdPartyExtensions(candidate)) return candidate;
        }
        return runtime.exists() ? runtime : oldRuntime;
    }

    private static boolean hasThirdPartyExtensions(File runtime) {
        if (runtime == null || !runtime.isDirectory()) return false;
        File[] extensions = new File(runtime, "public/scripts/extensions/third-party").listFiles();
        return extensions != null && extensions.length > 0;
    }

    private static boolean hasExtensionManifest(File runtime) {
        return runtime != null && new File(runtime, "bundled-extensions.json").isFile();
    }

    private static boolean isInstalled(File runtime) {
        File marker = new File(runtime, ".complete");
        if (!marker.isFile()) return false;
        try {
            String installedHash = new String(Files.readAllBytes(marker.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
            return installedHash.equalsIgnoreCase(BuildConfig.SERVER_SHA256);
        } catch (IOException error) {
            return false;
        }
    }

    private void preserveExtensions(File previous, File stage) throws Exception {
        File source = new File(previous, "public/scripts/extensions/third-party");
        File[] extensions = source.listFiles();
        if (extensions == null) return;
        File manifest = new File(previous, "bundled-extensions.json");
        if (!manifest.isFile()) throw new IOException("The previous application's extension inventory is missing");
        JSONArray inventory = new JSONArray(new String(Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        Set<String> bundled = new HashSet<>();
        for (int i = 0; i < inventory.length(); i++) bundled.add(inventory.getString(i));
        for (File extension : extensions) {
            if (bundled.contains(extension.getName())) continue;
            File target = new File(stage, "public/scripts/extensions/third-party/" + extension.getName());
            if (target.exists()) {
                File backups = new File(getFilesDir(), "data/default-user/files/Android extension backups");
                if (!backups.isDirectory() && !backups.mkdirs()) throw new IOException("Cannot preserve a conflicting extension");
                target = new File(Files.createTempDirectory(backups.toPath(), "before-update-").toFile(), extension.getName());
            }
            copyTree(extension, target);
        }
    }

    private static void copyTree(File source, File target) throws IOException {
        if (source.isDirectory() && !Files.isSymbolicLink(source.toPath())) {
            Files.createDirectory(target.toPath());
            File[] children = source.listFiles();
            if (children == null) throw new IOException("Cannot inspect a custom extension");
            for (File child : children) copyTree(child, new File(target, child.getName()));
        } else Files.copy(source.toPath(), target.toPath(), LinkOption.NOFOLLOW_LINKS);
    }

    @Override public void onDestroy() {
        ActivityBreadcrumbs.state("stopping");
        new File(getFilesDir(), "android-ready.json").delete();
        stopWake();
        if (nodeStarted) {
            // Node handles SIGTERM through Neconyan's existing orderly shutdown.
            try { CrashDiagnostics.markServerStopping(this); } catch (Throwable ignored) { }
            new Handler(Looper.getMainLooper()).postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 10000);
            android.os.Process.sendSignal(android.os.Process.myPid(), 15);
        }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
