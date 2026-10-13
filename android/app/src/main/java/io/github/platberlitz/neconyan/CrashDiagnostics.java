package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.Context;
import android.os.*;
import android.webkit.WebView;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
                if (chat != null && chat.has("agentHistoryEntries") && !chat.isNull("agentHistoryEntries")) result.activity += " Agent history: " + chat.optLong("agentHistoryEntries") + " entries.";
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
        return recordReport(context, component, kind, error, details, status, activity, System.currentTimeMillis());
    }
    static Result recordReport(Context context, String component, String kind, Throwable error, String details, String status, String activity, long at) {
        String id = at + "-" + android.os.Process.myPid() + "-" + UUID.randomUUID();
        boolean sameProcess = !component.equals("page") && (!component.equals("server") || Application.getProcessName().endsWith(":server"));
        Evidence sample = evidence(activity, at, sameProcess ? "same-process" : "last-observed-page");
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
        CrashReport.Entry entry = CrashReport.create(id, at, component, kind, sameProcess ? android.os.Process.myPid() : 0, sameProcess ? ActivityBreadcrumbs.START : 0,
            id, -1, status, errorLine, sample.at, sample.activity, sample.memory, text.toString());
        boolean saved = store(context).save(id, entry.text);
        return new Result(entry, saved);
    }

    static Result serverRecovery(Context context, int pid, long startedAt, long stoppedAt, String reason) {
        long nativeStart = 0;
        try { nativeStart = new JSONObject(ActivityBreadcrumbs.historical(context, pid, stoppedAt)).optLong("processStartMs", 0); } catch (Exception ignored) { }
        File directory = new File(context.getFilesDir(), "data/crash-reports");
        File[] files = directory.listFiles((dir, name) -> name.matches("crash-[a-zA-Z0-9.-]+\\.json"));
        if (files != null) {
            Arrays.sort(files, Comparator.comparing(File::getName).reversed());
            for (int i = 0; i < Math.min(10, files.length); i++) try {
                if (files[i].length() > 128 * 1024) continue;
                JSONObject report = new JSONObject(new String(Files.readAllBytes(files[i].toPath()), StandardCharsets.UTF_8));
                JSONObject environment = report.optJSONObject("environment"), error = report.optJSONObject("error");
                long at = java.time.Instant.parse(report.getString("at")).toEpochMilli();
                long processStart = at - Math.round(environment == null ? 0 : environment.optDouble("uptimeSeconds", 0) * 1000);
                if (environment == null || !CrashReport.matchesNode(pid, nativeStart, startedAt, stoppedAt, environment.optInt("pid"), at, processStart)) continue;
                String message = error == null ? "The server did not supply an error message." : error.optString("name", "Error") + ": " + error.optString("message", "");
                String id = at + "-node-" + pid;
                Evidence sample = evidence(ActivityBreadcrumbs.current(), at, "last-observed-page");
                String details = "Recorded Node error and causes:\n" + (error == null ? "Unavailable" : error.toString(2))
                    + "\nServer runtime and activity:\n" + report.toString(2) + sample.details;
                CrashReport.Entry entry = CrashReport.create(id, at, "server", "node-failure", pid, nativeStart, id, -1, "unknown", message, sample.at, sample.activity, sample.memory, details);
                return new Result(entry, store(context).save(id, entry.text));
            } catch (Exception ignored) { }
        }
        for (CrashReport.Entry summary : store(context).listEntries()) {
            if (summary.component.equals("server") && summary.at >= startedAt && summary.at <= stoppedAt + 1000 && (pid <= 0 || summary.pid == pid)) {
                CrashReport.Entry entry = store(context).readEntry(summary.id);
                if (entry != null) return withFatalRuntimeLog(context, new Result(entry, true), startedAt);
            }
        }
        Result fallback = recordReport(context, "server", "server-stop", null, "The local server stopped. No matched Node exception or Android exit was available.\n" + DiagnosticStore.redact(reason), "unknown", ActivityBreadcrumbs.current());
        CrashReport.Entry old = fallback.entry;
        String id = old.id.substring(0, old.id.length() - 4);
        CrashReport.Entry entry = CrashReport.create(id, old.at, "server", old.event, pid, nativeStart, old.incident, old.reason, old.status,
            old.error, old.activityAt, old.activity, old.memory, old.text);
        return withFatalRuntimeLog(context, new Result(entry, store(context).save(id, entry.text)), startedAt);
    }
    private static Result withFatalRuntimeLog(Context context, Result original, long since) {
        if (!original.entry.error.equals("Android did not supply an error message.")) return original;
        File file = new File(context.getCacheDir(), "server.log");
        if (!file.isFile() || file.lastModified() < since) return original;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            byte[] bytes = new byte[(int) Math.min(input.length(), 65536)];
            input.seek(input.length() - bytes.length); input.readFully(bytes);
            String excerpt = CrashReport.fatalRuntimeLines(new String(bytes, StandardCharsets.UTF_8));
            if (excerpt.isEmpty()) return original;
            CrashReport.Entry previous = original.entry;
            String id = previous.id.substring(0, previous.id.length() - 4);
            String event = excerpt.contains("JavaScript heap") || excerpt.contains("heap limit") ? "runtime-heap-limit" : previous.event;
            CrashReport.Entry entry = CrashReport.create(id, previous.at, "server", event, previous.pid, previous.processStart, previous.incident, previous.reason,
                previous.status, "Fatal runtime log excerpt: " + excerpt.split("\n")[0], previous.activityAt, previous.activity, previous.memory,
                "Fatal runtime log excerpt (log evidence, not proof of Android-wide memory exhaustion):\n" + excerpt + "\n" + previous.text);
            return new Result(entry, store(context).save(id, entry.text));
        } catch (Exception ignored) { return original; }
    }
    static Result enrichServer(Context context, CrashReport.Entry original, CrashReport.Entry exit) {
        if (original == null || exit == null || original.pid <= 0 || original.pid != exit.pid || !exit.component.equals("server")
            || Math.abs(exit.at - original.at) > 30000) return null;
        if (original.processStart > 0 && exit.processStart > 0 && original.processStart != exit.processStart) return null;
        String id = original.id.substring(0, original.id.length() - 4);
        long at = Math.min(original.at, exit.at);
        long activityAt = original.activityAt <= at ? original.activityAt : exit.activityAt <= at ? exit.activityAt : 0;
        String activity = activityAt == 0 ? "No earlier activity sample was available." : activityAt == original.activityAt ? original.activity : exit.activity;
        if (activityAt > 0) activity = activity.replaceFirst("recorded [0-9]+ seconds", "recorded " + (at - activityAt) / 1000 + " seconds");
        String details = (original.at > exit.at ? "Original recovery report, recorded after the exit; its activity is not necessarily earlier evidence:\n" : "Original recorded error:\n")
            + original.text.substring(0, Math.min(24000, original.text.length())) + "\n\nAndroid exit evidence:\n" + exit.text;
        CrashReport.Entry entry = CrashReport.create(id, at, "server", original.event, original.pid, original.processStart, original.incident,
            exit.reason, exit.status, original.error, activityAt, activity, original.at <= exit.at ? original.memory : exit.memory, details);
        String text = entry.text.replaceFirst("\n\nDetails:\n", "\nTrace status: " + (exit.traceAvailable || original.traceAvailable ? "available" : "pending") + "\n\nDetails:\n");
        entry = CrashReport.parse(original.id, text);
        return new Result(entry, store(context).save(id, entry.text));
    }

    static final String NO_TRACE = "Android has not supplied a trace. The exit reason above is the available evidence.";

    static void collectExits(Context context) {
        collectExits(context, entry -> {});
    }
    static void collectExits(Context context, Consumer<Result> available) {
        try {
            DiagnosticStore store = store(context);
            for (ApplicationExitInfo info : context.getSystemService(ActivityManager.class).getHistoricalProcessExitReasons(context.getPackageName(), 0, 20)) {
                int reason = info.getReason();
                if (expectedStop(context, info)) continue;
                if (reason == ApplicationExitInfo.REASON_USER_REQUESTED || reason == ApplicationExitInfo.REASON_USER_STOPPED
                    || reason == 16 /* REASON_PACKAGE_UPDATED, added in API 31 */ || reason == ApplicationExitInfo.REASON_PERMISSION_CHANGE
                    || (reason == ApplicationExitInfo.REASON_EXIT_SELF && info.getStatus() == 0)) continue;
                String id = info.getTimestamp() + "-exit-" + info.getPid();
                // Android keeps returning the same history; decode each trace once.
                if (!store.needsExit(id, NO_TRACE)) continue;
                String component = info.getProcessName() != null && info.getProcessName().endsWith(":server") ? "server" : "app";
                String oldActivity = ActivityBreadcrumbs.historical(context, info.getPid(), info.getTimestamp());
                Evidence sample = evidence(oldActivity, info.getTimestamp(), "same-process");
                if (sample.at == 0 && component.equals("server")) {
                    Evidence page = evidence(ActivityBreadcrumbs.lastPage(context, info.getTimestamp()), info.getTimestamp(), "last-observed-page");
                    sample.at = page.at; sample.activity = page.activity; sample.details += page.details;
                    if (sample.memory.equals("No earlier memory measurement was available.")) sample.memory = page.memory;
                }
                long start = 0;
                try { start = new JSONObject(oldActivity).optLong("processStartMs", 0); } catch (Exception ignored) { }
                String incident = id;
                CrashReport.Entry matched = null;
                for (CrashReport.Entry prior : store.listEntries()) {
                    if (prior.id.equals(id + ".txt") || prior.event.equals("android-process-exit")) continue;
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
                boolean metadataSaved = store.saveExit(id, metadata.text, false);
                CrashReport.Entry retained = metadataSaved ? store.readEntry(id + ".txt") : null;
                available.accept(new Result(retained == null ? metadata : retained, metadataSaved));
                boolean hasTrace = false;
                try (InputStream trace = info.getTraceInputStream()) {
                    text.append("\nSystem trace:\n");
                    if (trace == null) text.append(NO_TRACE);
                    else if (reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                        String decoded = Tombstone.describe(trace);
                        text.append(decoded); hasTrace = true;
                        String traceError = CrashReport.firstTraceError(decoded);
                        if (matched == null && !traceError.isEmpty()) errorLine = traceError;
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
                boolean saved = store.saveExit(id, entry.text, hasTrace);
                retained = saved ? store.readEntry(id + ".txt") : null;
                available.accept(new Result(retained == null ? entry : retained, saved));
            }
        } catch (Throwable error) { android.util.Log.w("Neconyan", "Could not collect Android exit records", error); }
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
