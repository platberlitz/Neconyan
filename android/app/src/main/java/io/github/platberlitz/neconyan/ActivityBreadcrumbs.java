package io.github.platberlitz.neconyan;

import android.app.*;
import android.content.Context;
import android.os.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** One bounded record per process. No disk work runs on a WebView or pressure callback. */
final class ActivityBreadcrumbs {
    static final long START = System.currentTimeMillis();
    static final ScheduledExecutorService WRITER = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "neconyan-diagnostics"));
    private static Context context;
    private static JSONObject snapshot;
    private static JSONArray events = new JSONArray(), pressure = new JSONArray();
    private static JSONObject memory;
    private static boolean pending, foreground;
    private static long writtenAt, pressureAt;
    private static String processKind;
    private static ScheduledFuture<?> heartbeatTask;

    static void initialise(Context app) {
        context = app.getApplicationContext();
        processKind = Application.getProcessName().endsWith(":server") ? "server" : "app";
        schedule();
    }
    private static boolean oneOf(String value, String allowed) { return Arrays.asList(allowed.split(",")).contains(value); }
    private static long number(JSONObject input, String key, long maximum) {
        Object value = input == null ? null : input.opt(key);
        if (!(value instanceof Number)) return -1;
        double d = ((Number) value).doubleValue();
        return Double.isFinite(d) && d >= 0 && d == Math.floor(d) && d <= 9007199254740991L ? Math.min((long) d, maximum) : -1;
    }
    private static void numeric(JSONObject target, JSONObject source, String key, long maximum) throws JSONException {
        long value = number(source, key, maximum); target.put(key, value < 0 ? JSONObject.NULL : value);
    }
    static JSONObject validateSnapshot(JSONObject input) throws JSONException {
        JSONObject out = new JSONObject().put("schema", 1);
        String id = input.optString("pageSessionId", "");
        if (!id.matches("[a-zA-Z0-9:-]{1,100}")) throw new JSONException("Invalid document");
        out.put("pageSessionId", id);
        numeric(out, input, "at", 9007199254740991L); numeric(out, input, "uptimeMs", 2592000000L);
        out.put("ready", input.opt("ready") == Boolean.TRUE);
        for (String key : new String[] { "view", "mode", "visibility" }) {
            String value = input.optString(key, "unknown");
            String allowed = key.equals("view") ? "startup,home,chat,settings,tool,unknown" : key.equals("mode") ? "roleplay,conversation,meower,story,unknown" : "visible,hidden";
            out.put(key, oneOf(value, allowed) ? value : "unknown");
        }
        for (String section : new String[] { "chat", "dom", "heap" }) {
            JSONObject source = input.optJSONObject(section), target = new JSONObject();
            String[] fields = section.equals("chat") ? new String[] { "messageCount", "estimatedTextBytes", "sampledMessages", "measuredAt" }
                : section.equals("dom") ? new String[] { "renderedChildren", "measuredAt" } : new String[] { "usedBytes", "totalBytes", "limitBytes" };
            for (String key : fields) numeric(target, source, key, key.endsWith("Bytes") ? 1099511627776L : key.equals("measuredAt") ? 9007199254740991L : 1000000);
            if (section.equals("chat")) target.put("estimate", "utf16-text-only").put("complete", source != null && source.opt("complete") == Boolean.TRUE);
            out.put(section, target);
        }
        JSONObject generation = input.optJSONObject("generation"), generated = new JSONObject();
        String phase = generation == null ? "unknown" : generation.optString("phase");
        generated.put("phase", oneOf(phase, "idle,preparing,pre-agents,generating,post-agents,companions,rendering,saving,waiting-review,unknown") ? phase : "unknown");
        String location = generation == null ? "unknown" : generation.optString("location");
        generated.put("location", oneOf(location, "browser,server,unknown") ? location : "unknown"); out.put("generation", generated);
        JSONObject agents = input.optJSONObject("agents"), safeAgents = new JSONObject();
        numeric(safeAgents, agents, "enabledCount", 1000000); numeric(safeAgents, agents, "omittedRunningCount", 1000000);
        JSONArray running = agents == null ? null : agents.optJSONArray("running"), safeRunning = new JSONArray();
        if (running != null) for (int i = 0; i < Math.min(8, running.length()); i++) {
            JSONObject agent = running.optJSONObject(i); if (agent == null) continue;
            String label = agent.optString("label", "Custom agent 1");
            if (!oneOf(label, "Format Fixer,Proofreader,Prose Polisher,Scene Tracker,Time Tracker,Combined reply") && !label.matches("Custom agent [1-9][0-9]{0,3}")) label = "Custom agent 1";
            phase = agent.optString("phase", "unknown"); location = agent.optString("location", "unknown");
            safeRunning.put(new JSONObject().put("label", label).put("phase", oneOf(phase, "pre,post,companions,synthesis,repair,regex,unknown") ? phase : "unknown")
                .put("location", oneOf(location, "browser,server,unknown") ? location : "unknown"));
        }
        safeAgents.put("running", safeRunning); out.put("agents", safeAgents);
        JSONObject extensions = new JSONObject(); numeric(extensions, input.optJSONObject("extensions"), "enabledCount", 1000000); out.put("extensions", extensions);
        return out;
    }
    static synchronized boolean accept(String json, String expectedDocument) {
        if (json == null || json.length() > 4096 || json.getBytes(StandardCharsets.UTF_8).length > 4096) return false;
        try {
            JSONObject input = new JSONObject(json), next = validateSnapshot(input.getJSONObject("snapshot"));
            if (!next.getString("pageSessionId").equals(expectedDocument)) return false;
            snapshot = next;
            JSONArray source = input.optJSONArray("events"), safe = new JSONArray();
            if (source != null) for (int i = 0; i < Math.min(12, source.length()); i++) {
                JSONObject item = source.optJSONObject(i); if (item == null) continue;
                String type = item.optString("type");
                if (oneOf(type, "page-start,app-ready,chat-open,generation-start,generation-end,generation-stop,agent-start,agent-end,agent-error,agent-cancel,swipe,visibility,pagehide,pageshow,memory-pressure")) {
                    JSONObject event = new JSONObject().put("type", type); numeric(event, item, "at", 9007199254740991L); safe.put(event);
                }
            }
            events = safe; schedule(); return true;
        } catch (Throwable ignored) { return false; }
    }
    static synchronized void foreground(boolean value) { foreground = value; if (!value && heartbeatTask != null) heartbeatTask.cancel(false); schedule(); }
    static synchronized void pressure(int level) {
        long now = System.currentTimeMillis();
        if (now - pressureAt < 2000) return;
        pressureAt = now;
        try {
            JSONArray next = new JSONArray();
            for (int i = Math.max(0, pressure.length() - 7); i < pressure.length(); i++) next.put(pressure.get(i));
            next.put(new JSONObject().put("at", now).put("level", level).put("label", level == 20 ? "UI hidden; not evidence of low memory" : level == -1 ? "Low memory callback" : "Memory trim callback").put("processKind", processKind));
            pressure = next;
        } catch (JSONException ignored) { }
        schedule();
    }
    static synchronized void state(String value) {
        if (!oneOf(value, "starting,running,stopping,closed,recreating")) return;
        try { events.put(new JSONObject().put("at", System.currentTimeMillis()).put("type", value));
            if (events.length() > 12) { JSONArray next = new JSONArray(); for (int i = events.length() - 12; i < events.length(); i++) next.put(events.get(i)); events = next; }
        } catch (JSONException ignored) { }
        schedule();
    }
    private static synchronized void schedule() {
        if (pending || context == null) return;
        pending = true;
        WRITER.schedule(ActivityBreadcrumbs::write, Math.max(0, 5000 - (System.currentTimeMillis() - writtenAt)), TimeUnit.MILLISECONDS);
    }
    private static void sampleMemory() {
        try {
            ActivityManager manager = context.getSystemService(ActivityManager.class);
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo(); manager.getMemoryInfo(info);
            JSONObject measured = new JSONObject().put("at", System.currentTimeMillis()).put("availableBytes", info.availMem).put("totalBytes", info.totalMem)
                .put("thresholdBytes", info.threshold).put("lowMemory", info.lowMemory).put("memoryClassMb", manager.getMemoryClass()).put("largeMemoryClassMb", manager.getLargeMemoryClass());
            synchronized (ActivityBreadcrumbs.class) { memory = measured; }
        } catch (Exception ignored) { }
    }
    static synchronized String current() {
        try { return new JSONObject().put("schema", 1).put("pid", android.os.Process.myPid()).put("processStartMs", START).put("processKind", processKind)
            .put("snapshot", snapshot == null ? JSONObject.NULL : snapshot).put("events", events).put("pressure", pressure).put("memory", memory == null ? JSONObject.NULL : memory).toString();
        } catch (JSONException ignored) { return "{}"; }
    }
    private static void write() {
        sampleMemory();
        String text = current();
        File directory = new File(context.getNoBackupFilesDir(), "crash-activity"), temporary = null;
        try {
            if (text.getBytes(StandardCharsets.UTF_8).length <= 8192) {
                Files.createDirectories(directory.toPath()); temporary = File.createTempFile("pending-", ".tmp", directory);
                Files.writeString(temporary.toPath(), text, StandardCharsets.UTF_8);
                Files.move(temporary.toPath(), new File(directory, "activity-" + android.os.Process.myPid() + "-" + START + ".json").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                File[] files = directory.listFiles((dir, name) -> name.matches("activity-[0-9]+-[0-9]+\\.json"));
                if (files != null) { Arrays.sort(files, Comparator.comparingLong(File::lastModified)); for (int i = 0; i < files.length - 6; i++) files[i].delete(); }
            }
        } catch (Exception ignored) { }
        finally { if (temporary != null) temporary.delete(); }
        synchronized (ActivityBreadcrumbs.class) { writtenAt = System.currentTimeMillis(); pending = false; }
        synchronized (ActivityBreadcrumbs.class) {
            if (heartbeatTask != null) heartbeatTask.cancel(false);
            if (foreground) heartbeatTask = WRITER.schedule(() -> { synchronized (ActivityBreadcrumbs.class) { if (foreground) schedule(); } }, 30000, TimeUnit.MILLISECONDS);
        }
    }
    static String historical(Context app, int pid, long stopAt) {
        File[] files = new File(app.getNoBackupFilesDir(), "crash-activity").listFiles((dir, name) -> name.matches("activity-" + pid + "-[0-9]+\\.json"));
        if (files == null) return "";
        Arrays.sort(files, Comparator.comparing(File::getName).reversed());
        for (File file : files) try {
            if (file.length() > 8192) continue;
            String text = Files.readString(file.toPath()); JSONObject input = new JSONObject(text);
            if (input.optLong("processStartMs", Long.MAX_VALUE) <= stopAt && input.optLong("processStartMs", 0) >= stopAt - 2592000000L) return text;
        } catch (Exception ignored) { }
        return "";
    }
    static String lastPage(Context app, long stopAt) {
        File[] files = new File(app.getNoBackupFilesDir(), "crash-activity").listFiles((dir, name) -> name.matches("activity-[0-9]+-[0-9]+\\.json"));
        if (files == null) return "";
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        String selected = ""; long latest = 0;
        for (int i = 0; i < Math.min(6, files.length); i++) try {
            if (files[i].length() > 8192) continue;
            String text = Files.readString(files[i].toPath()); JSONObject input = new JSONObject(text), page = input.optJSONObject("snapshot");
            if (page == null) continue;
            long at = page.optLong("at", Long.MAX_VALUE);
            if (at > latest && at <= stopAt) { latest = at; selected = text; }
        } catch (Exception ignored) { }
        return selected;
    }
}
