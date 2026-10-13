package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.Context;
import android.os.*;
import android.webkit.WebView;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Consumer;
import org.json.*;

final class CrashDiagnostics {
    static DiagnosticStore store(Context context) {
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
            text.append("\nMemory measured at capture/recovery: ").append(new Date())
                .append("\nMemory class MB: ").append(context.getSystemService(ActivityManager.class).getMemoryClass())
                .append(" large: ").append(context.getSystemService(ActivityManager.class).getLargeMemoryClass());
        } catch (Throwable error) { text.append("\nSome device details unavailable: ").append(error.getClass().getSimpleName()); }
        return text.toString();
    }

    static boolean record(Context context, String kind, Throwable error, String details) {
        String component = Application.getProcessName().endsWith(":server") ? "server" : "app";
        return recordReport(context, component, kind, error, details, "unknown", ActivityBreadcrumbs.current()).saved;
    }
    static final class Result {
        final CrashReport.Entry entry; final boolean saved;
        Result(CrashReport.Entry entry, boolean saved) { this.entry = entry; this.saved = saved; }
    }
    static final class Evidence {
        long at;
        String activity = "No earlier activity sample was available.", memory = "No earlier memory measurement was available.", details = "";
    }
    static Evidence evidence(String json, long stoppedAt, String relationship) {
        Evidence result = new Evidence();
        try {
            if (json == null || json.length() > 8192) return result;
            JSONObject input = new JSONObject(json), snapshot = input.optJSONObject("snapshot"), memory = input.optJSONObject("memory");
            if (snapshot != null && snapshot.optLong("at", Long.MAX_VALUE) <= stoppedAt) {
                result.at = snapshot.optLong("at", 0);
                JSONObject chat = snapshot.optJSONObject("chat"), agents = snapshot.optJSONObject("agents");
                result.activity = "Last known activity, recorded " + Math.max(0, (stoppedAt - result.at) / 1000) + " seconds before the stop (" + relationship + "): " + snapshot.optString("mode", "unknown")
                    + (chat == null || chat.isNull("messageCount") ? ". Message count unavailable." : ", " + chat.optLong("messageCount") + " messages.");
                JSONArray running = agents == null ? null : agents.optJSONArray("running");
                List<String> labels = new ArrayList<>();
                if (running != null) for (int i = 0; i < Math.min(8, running.length()); i++) labels.add(running.getJSONObject(i).optString("label", "Custom agent 1"));
                if (!labels.isEmpty()) result.activity += " Running " + String.join(" and ", labels) + ". This records activity, not the cause.";
                result.details += "\nLast known page activity (" + relationship + "), age ms " + (stoppedAt - result.at) + ":\n" + snapshot.toString(2);
            }
            if (memory != null && memory.optLong("at", Long.MAX_VALUE) <= stoppedAt) {
                result.memory = "Memory recorded " + Math.max(0, (stoppedAt - memory.optLong("at")) / 1000) + " seconds before the stop: " + memory.optLong("availableBytes") / 1048576
                    + " MiB available of " + memory.optLong("totalBytes") / 1048576 + " MiB. Android's low-memory threshold was " + memory.optLong("thresholdBytes") / 1048576 + " MiB. Measured: " + new Date(memory.optLong("at")) + ".";
                result.details += "\nEarlier device memory:\n" + memory.toString(2);
            }
            JSONArray pressure = input.optJSONArray("pressure");
            if (pressure != null) {
                JSONArray earlier = new JSONArray();
                for (int i = 0; i < Math.min(8, pressure.length()); i++) if (pressure.getJSONObject(i).optLong("at", Long.MAX_VALUE) <= stoppedAt) earlier.put(pressure.get(i));
                result.details += "\nEarlier pressure callbacks (absence does not rule out pressure):\n" + earlier.toString(2);
            }
        } catch (Exception ignored) { }
        return result;
    }
    static Result recordReport(Context context, String component, String kind, Throwable error, String details, String status, String activity) {
        long at = System.currentTimeMillis();
        String id = at + "-" + android.os.Process.myPid() + "-" + UUID.randomUUID();
        Evidence sample = evidence(activity, at, component.equals("page") ? "last-observed-page" : "same-process");
        String errorLine = error == null ? "Android did not supply an error message." : error.getClass().getName() + ": " + error.getMessage();
        StringBuilder text = new StringBuilder();
        try {
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
            text.append('\n').append(details == null ? "" : details).append(sample.details)
                .append("\nAt capture, not necessarily at failure:\n").append(environment(context));
            appendRequests(context, text);
        } catch (Throwable ignored) { text.append("\nSome diagnostic details could not be collected."); }
        CrashReport.Entry entry = CrashReport.create(id, at, component, kind, component.equals("page") ? 0 : android.os.Process.myPid(), ActivityBreadcrumbs.START,
            id, -1, status, errorLine, sample.at, sample.activity, sample.memory, text.toString());
        boolean saved = store(context).save(id, entry.text);
        return new Result(entry, saved);
    }

    static final String NO_TRACE = "Android has not supplied a trace. The exit reason above is the available evidence.";

    static void collectExits(Context context) {
        collectExits(context, entry -> {});
    }
    static void collectExits(Context context, Consumer<CrashReport.Entry> available) {
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
                String component = info.getProcessName() != null && info.getProcessName().endsWith(":server") ? "server" : "app";
                String oldActivity = ActivityBreadcrumbs.historical(context, info.getPid(), info.getTimestamp());
                Evidence sample = evidence(oldActivity, info.getTimestamp(), "same-process");
                long start = 0;
                try { start = new JSONObject(oldActivity).optLong("processStartMs", 0); } catch (Exception ignored) { }
                String incident = id;
                CrashReport.Entry matched = null;
                for (CrashReport.Entry prior : store.listEntries()) {
                    if (prior.pid == info.getPid() && start > 0 && prior.processStart == start && prior.at <= info.getTimestamp() && info.getTimestamp() - prior.at <= 10000) { incident = prior.incident; matched = store.readEntry(prior.id); break; }
                }
                String errorLine = matched == null ? "Android did not supply an error message." : matched.error;
                StringBuilder text = new StringBuilder("Android process exit at ").append(new Date(info.getTimestamp()))
                    .append("\nProcess: ").append(info.getProcessName()).append(" PID ").append(info.getPid())
                    .append("\nReason: ").append(reasonName(reason)).append(" (").append(reason).append(")")
                    .append("\nStatus / signal: ").append(info.getStatus()).append("\nDescription: ").append(info.getDescription())
                    .append("\nImportance: ").append(info.getImportance()).append("\nPSS KiB: ").append(info.getPss())
                    .append("\nRSS KiB: ").append(info.getRss())
                    .append(sample.details).append("\nDevice details captured on recovery, not at the moment of the exit:\n").append(environment(context));
                if (matched != null) text.insert(0, "Recorded application error from the same process instance:\n" + matched.text + "\n\n");
                CrashReport.Entry metadata = CrashReport.create(id, info.getTimestamp(), component, "android-process-exit", info.getPid(), start, incident, reason,
                    String.valueOf(info.getStatus()), errorLine, sample.at, sample.activity, sample.memory, text + "\n" + NO_TRACE);
                store.saveExit(id, metadata.text, false);
                available.accept(metadata);
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
                CrashReport.Entry entry = CrashReport.create(id, info.getTimestamp(), component, "android-process-exit", info.getPid(), start, incident, reason,
                    String.valueOf(info.getStatus()), errorLine, sample.at, sample.activity, sample.memory, text.toString());
                store.saveExit(id, entry.text, hasTrace);
                available.accept(entry);
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
