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
import java.util.zip.*;
import java.util.HashSet;
import java.util.Set;

public final class ServerService extends Service {
    public static final String STOP = "io.github.platberlitz.neconyan.STOP";
    private static native int startNode(String[] arguments, String cache);
    private boolean started;
    private boolean nodeStarted;
    private PowerManager.WakeLock wake;
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
            new File(getFilesDir(), "android-ready.json").delete();
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Neconyan:server");
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
                    int exit = startNode(new String[] { "node", "--max-old-space-size=512", "--import", new File(runtime, "file-stats.mjs").getPath(), new File(runtime, "server-bootstrap.mjs").getPath(),
                        getFilesDir().getPath(), credentials.getString("port"), credentials.getString("password") }, getCacheDir().getPath());
                    status("Neconyan stopped (" + exit + "). Reopen the app to start it again.");
                    stopSelf();
                } catch (Throwable error) {
                    try { status("Could not start Neconyan: " + error.getMessage() + ". Your saved data has been kept. Reopen the app to try again."); } catch (Exception ignored) { }
                    stopSelf();
                }
            }, "neconyan-server").start();
        }
        // Reopen after process loss; do not repeatedly boot a failing native runtime.
        return START_NOT_STICKY;
    }

    private void status(String text) throws IOException {
        Files.write(new File(getCacheDir(), "startup-status.txt").toPath(), text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private File installPayload() throws Exception {
        File runtime = new File(getNoBackupFilesDir(), "runtime-" + BuildConfig.SERVER_SHA256.substring(0, 16));
        SharedPreferences installed = getSharedPreferences("runtime", MODE_PRIVATE);
        if (new File(runtime, ".complete").isFile()) {
            if (!installed.edit().putString("directory", runtime.getName()).commit()) throw new IOException("Cannot record the installed application");
            return runtime;
        }
        File stage = new File(getNoBackupFilesDir(), "runtime-staging");
        deleteTree(stage);
        if (!stage.mkdirs()) throw new IOException("Cannot create the private application folder");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new DigestInputStream(getAssets().open("server.zip"), digest)) { byte[] block = new byte[65536]; while (input.read(block) != -1) { } }
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format("%02x", value));
        if (!hash.toString().equals(BuildConfig.SERVER_SHA256)) throw new IOException("The application package did not verify");
        long size = 0;
        byte[] buffer = new byte[65536];
        String prefix = stage.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(getAssets().open("server.zip"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(stage, entry.getName());
                if (!target.getCanonicalPath().startsWith(prefix)) throw new IOException("Unsafe application package path");
                if (entry.isDirectory()) { target.mkdirs(); continue; }
                target.getParentFile().mkdirs();
                try (OutputStream output = new FileOutputStream(target)) {
                    int count;
                    while ((count = zip.read(buffer)) != -1) {
                        size += count;
                        if (size > 3L * 1024 * 1024 * 1024) throw new IOException("The application package is too large");
                        output.write(buffer, 0, count);
                    }
                }
            }
        }
        String previousName = installed.getString("directory", "");
        if (previousName.matches("runtime-[a-f0-9]{16}")) preserveExtensions(new File(getNoBackupFilesDir(), previousName), stage);
        Files.write(new File(stage, ".complete").toPath(), BuildConfig.SERVER_SHA256.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (!stage.renameTo(runtime)) throw new IOException("Cannot finish installing the application");
        if (!installed.edit().putString("directory", runtime.getName()).commit()) throw new IOException("Cannot record the installed application");
        // User data is in files/data, never inside these replaceable application folders.
        File[] siblings = getNoBackupFilesDir().listFiles();
        if (siblings != null) for (File old : siblings) {
            if (old.isDirectory() && old.getName().startsWith("runtime-") && !old.equals(runtime)) {
                try { deleteTree(old); } catch (IOException error) { android.util.Log.w("Neconyan", "Previous application files could not be removed", error); }
            }
        }
        return runtime;
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

    private static void deleteTree(File file) throws IOException {
        if (!Files.exists(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Cannot inspect the application folder");
            for (File child : children) deleteTree(child);
        }
        Files.delete(file.toPath());
    }

    @Override public void onDestroy() {
        new File(getFilesDir(), "android-ready.json").delete();
        if (wake != null && wake.isHeld()) wake.release();
        if (nodeStarted) {
            // Node handles SIGTERM through Neconyan's existing orderly shutdown.
            new Handler(Looper.getMainLooper()).postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 10000);
            android.os.Process.sendSignal(android.os.Process.myPid(), 15);
        }
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
