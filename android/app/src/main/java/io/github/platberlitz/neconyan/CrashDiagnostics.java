package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.Context;
import android.os.*;
import android.webkit.WebView;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class CrashDiagnostics {
    private static DiagnosticStore store(Context context) {
        return new DiagnosticStore(new File(context.getNoBackupFilesDir(), "crash-reports"));
    }

    static String environment(Context context) {
        StringBuilder text = new StringBuilder();
        try {
            text.append("Neconyan ").append(context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName)
                .append("\nPayload: ").append(BuildConfig.SERVER_SHA256)
                .append("\nProcess: ").append(Application.getProcessName()).append(" PID ").append(android.os.Process.myPid())
                .append("\nDevice: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append("\nAndroid: ").append(Build.VERSION.RELEASE).append(" API ").append(Build.VERSION.SDK_INT)
                .append("\nBuild: ").append(Build.DISPLAY).append("\nABIs: ").append(Arrays.toString(Build.SUPPORTED_ABIS))
                .append("\nUptime ms: ").append(SystemClock.elapsedRealtime());
            android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
            text.append("\nWebView: ").append(provider == null ? "unavailable" : provider.packageName + " " + provider.versionName);
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            context.getSystemService(ActivityManager.class).getMemoryInfo(memory);
            Runtime runtime = Runtime.getRuntime();
            text.append("\nMemory bytes: total=").append(memory.totalMem).append(" available=").append(memory.availMem)
                .append(" lowMemory=").append(memory.lowMemory).append(" threshold=").append(memory.threshold)
                .append("\nJava heap bytes: used=").append(runtime.totalMemory() - runtime.freeMemory()).append(" maximum=").append(runtime.maxMemory())
                .append("\nNative heap bytes: ").append(Debug.getNativeHeapAllocatedSize())
                .append("\nFree storage bytes: ").append(context.getFilesDir().getUsableSpace())
                .append("\nServer heap limit MB: ").append(ServerService.heapMegabytes(context));
        } catch (Throwable error) { text.append("\nSome device details unavailable: ").append(error.getClass().getSimpleName()); }
        return text.toString();
    }

    static boolean record(Context context, String kind, Throwable error, String details) {
        try {
            StringBuilder text = new StringBuilder("Captured at ").append(new Date()).append("\nEvent: ").append(kind)
                .append('\n').append(details == null ? "" : details).append('\n').append(environment(context));
            if (error != null) {
                // printStackTrace includes cause chains and suppressed exceptions. Cap the writer itself.
                Writer bounded = new Writer() {
                    int remaining = 24000;
                    public void write(char[] chars, int offset, int count) {
                        int length = Math.min(remaining, count);
                        text.append(chars, offset, length); remaining -= length;
                    }
                    public void flush() { }
                    public void close() { }
                };
                text.append("\nException, causes and suppressed errors:\n");
                error.printStackTrace(new PrintWriter(bounded));
            }
            appendRequests(context, text);
            boolean saved = store(context).save(System.currentTimeMillis() + "-" + android.os.Process.myPid() + "-" + UUID.randomUUID(), text.toString());
            if (!saved) android.util.Log.e("Neconyan", "Could not save crash diagnostics; private storage may be unavailable.");
            return saved;
        } catch (Throwable ignored) { return false; }
    }

    static final String NO_TRACE = "Android has not supplied a trace. The exit reason above is the available evidence.";

    static void collectExits(Context context) {
        try {
            DiagnosticStore store = store(context);
            for (ApplicationExitInfo info : context.getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(context.getPackageName(), 0, 20)) {
                int reason = info.getReason();
                if (expectedStop(context, info)) continue;
                if (reason == ApplicationExitInfo.REASON_USER_REQUESTED || reason == ApplicationExitInfo.REASON_USER_STOPPED
                    || reason == ApplicationExitInfo.REASON_PACKAGE_UPDATED || reason == ApplicationExitInfo.REASON_PERMISSION_CHANGE
                    || (reason == ApplicationExitInfo.REASON_EXIT_SELF && info.getStatus() == 0)) continue;
                String id = info.getTimestamp() + "-exit-" + info.getPid();
                // Android keeps returning the same history; decode each trace once.
                if (!store.needsExit(id, NO_TRACE)) continue;
                StringBuilder text = new StringBuilder("Android process exit at ").append(new Date(info.getTimestamp()))
                    .append("\nProcess: ").append(info.getProcessName()).append(" PID ").append(info.getPid())
                    .append("\nReason: ").append(reasonName(reason)).append(" (").append(reason).append(")")
                    .append("\nStatus / signal: ").append(info.getStatus()).append("\nDescription: ").append(info.getDescription())
                    .append("\nImportance: ").append(info.getImportance()).append("\nPSS KiB: ").append(info.getPss())
                    .append("\nRSS KiB: ").append(info.getRss())
                    .append("\nDevice details captured on recovery, not at the moment of the exit:\n").append(environment(context));
                boolean hasTrace = false;
                try (InputStream trace = info.getTraceInputStream()) {
                    text.append("\nSystem trace:\n");
                    if (trace == null) text.append(NO_TRACE);
                    else if (reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                        text.append(Tombstone.describe(trace)); hasTrace = true;
                    }
                    else {
                        byte[] bytes = new byte[24000];
                        int length = 0;
                        while (length < bytes.length) {
                            int count = trace.read(bytes, length, bytes.length - length);
                            if (count < 0) break;
                            length += count;
                        }
                        text.append(new String(bytes, 0, length, StandardCharsets.UTF_8));
                        hasTrace = length > 0;
                    }
                } catch (Exception error) { text.append("\nTrace unreadable: ").append(error.getClass().getSimpleName()).append('\n').append(NO_TRACE); }
                // Stable name lets delayed Android traces enrich the same report instead of duplicating it.
                store.saveExit(id, text.toString(), hasTrace);
            }
        } catch (Exception error) { android.util.Log.w("Neconyan", "Could not collect Android exit records", error); }
    }

    static void markServerStopping(Context context) {
        File directory = new File(context.getNoBackupFilesDir(), "expected-server-stops");
        directory.mkdirs();
        try (DataOutputStream output = new DataOutputStream(new FileOutputStream(new File(directory, String.valueOf(android.os.Process.myPid()))))) {
            output.writeLong(System.currentTimeMillis());
        } catch (IOException ignored) { }
        File[] files = directory.listFiles();
        if (files != null) {
            Arrays.sort(files, Comparator.comparingLong(File::lastModified));
            for (int i = 0; i < files.length - 20; i++) files[i].delete();
        }
    }

    private static boolean expectedStop(Context context, ApplicationExitInfo info) {
        if (info.getReason() != ApplicationExitInfo.REASON_SIGNALED || (info.getStatus() != 15 && info.getStatus() != 9)) return false;
        File file = new File(context.getNoBackupFilesDir(), "expected-server-stops/" + info.getPid());
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) {
            long elapsed = info.getTimestamp() - input.readLong();
            return elapsed >= 0 && elapsed < 30000;
        } catch (IOException ignored) { return false; }
    }

    static String reasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "Android closed the process to free memory";
            case ApplicationExitInfo.REASON_CRASH: return "Java crash";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "Native crash";
            case ApplicationExitInfo.REASON_ANR: return "Application not responding";
            case ApplicationExitInfo.REASON_SIGNALED: return "Terminated by a signal; sender and underlying cause unavailable";
            case ApplicationExitInfo.REASON_EXIT_SELF: return "Process exited itself";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "Android resource limit";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "Initialisation failure";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "Required process died";
            default: return "Android did not provide a specific cause";
        }
    }

    private static void appendRequests(Context context, StringBuilder text) {
        for (String name : new String[] { "requests.txt", "requests.previous.txt", "native-startup.txt" }) {
            File file = new File(context.getCacheDir(), name);
            if (!file.isFile()) continue;
            try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                byte[] bytes = new byte[(int) Math.min(input.length(), 8000)];
                input.seek(input.length() - bytes.length); input.readFully(bytes);
                text.append("\n\n").append(name).append(":\n").append(new String(bytes, StandardCharsets.UTF_8));
            } catch (IOException error) { text.append("\nCould not read ").append(name); }
        }
        text.append("\n\nNo chat content, request bodies, credentials or full server logs collected. Error and system trace text should be reviewed before sharing.");
    }

    static String reports(Context context) { return store(context).readAll(); }
    static String latestReport(Context context) { return store(context).readNewest(1); }
    static String latest(Context context) {
        File[] files = store(context).files();
        return files.length == 0 ? "" : files[files.length - 1].getName();
    }
}
