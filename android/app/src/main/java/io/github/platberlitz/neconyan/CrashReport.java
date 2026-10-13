package io.github.platberlitz.neconyan;

import java.util.*;

/** Report identity and presentation policy, independent of Android. */
final class CrashReport {
    static final class Entry {
        final String id, incident, component, event, status, summary, error, activity, memory, text;
        final long at, processStart, activityAt;
        final int pid, reason;
        final boolean traceAvailable;
        Entry(String id, Map<String, String> header, String text) {
            this.id = id;
            incident = header.getOrDefault("Incident ID", id);
            component = header.getOrDefault("Component", "unknown"); event = header.getOrDefault("Event", "legacy");
            at = number(header.get("Event timestamp ms")); processStart = number(header.get("Process start ms")); activityAt = number(header.get("Activity timestamp ms"));
            pid = (int) number(header.get("Process PID")); reason = header.containsKey("Reason code") ? (int) number(header.get("Reason code")) : -1;
            status = header.getOrDefault("Status", "unknown");
            traceAvailable = "available".equals(header.get("Trace status"));
            summary = header.getOrDefault("Summary", "Saved report from an earlier Neconyan version. Read the details for its recorded evidence.");
            error = header.getOrDefault("Error", "Android did not supply an error message.");
            activity = header.getOrDefault("Last activity", "No earlier activity sample was available.");
            memory = header.getOrDefault("Memory sample", "No earlier memory measurement was available.");
            this.text = text;
        }
    }
    static long number(String value) { try { return Long.parseLong(value); } catch (Exception ignored) { return 0; } }
    static String line(String value, int maximum) {
        String text = DiagnosticStore.redact(value).replace('\r', ' ').replace('\n', ' ');
        return text.substring(0, Math.min(text.length(), maximum));
    }
    static Entry parse(String id, String text) {
        if (id == null || !id.matches("[a-zA-Z0-9-]+\\.txt")) return null;
        text = DiagnosticStore.redact(text);
        Map<String, String> header = new LinkedHashMap<>();
        if (text.startsWith("Neconyan crash report v2\n")) {
            int boundary = text.indexOf("\n\nDetails:\n");
            if (boundary > 0 && boundary <= 4096) {
                String[] lines = text.substring(0, boundary).split("\n");
                if (lines.length <= 16) for (String line : lines) {
                    int colon = line.indexOf(": ");
                    if (colon > 0) header.put(line.substring(0, colon), line.substring(colon + 2));
                }
            }
        }
        return new Entry(id, header, text);
    }
    static String summary(String component, String event, int reason, String status) {
        String subject = component.equals("server") ? "Neconyan's local server" : "Neconyan";
        if (reason == 3) return "Android closed " + subject + " to free memory.";
        if (event.equals("renderer-crash")) return "The page renderer crashed. Android did not provide an error message.";
        if (event.equals("renderer-closed")) return "Android closed the page renderer. It did not provide a definite cause.";
        if (Arrays.asList("uncaught-java-exception", "activity-startup-failure", "server-startup-failure").contains(event) || reason == 4) return subject + " stopped because of an application error.";
        if (event.equals("node-failure")) return subject + " reported an error. Read the recorded error and causes.";
        if (event.equals("runtime-heap-limit")) return "The local server log reported that its JavaScript memory limit was reached.";
        if (reason == 9) return subject + " stopped after signal " + line(status, 20) + ". Android did not say why the signal was sent.";
        if (reason == 6) return subject + " stopped responding. Read the system trace for the available evidence.";
        return subject + " stopped unexpectedly. No definite cause was available.";
    }
    static Entry create(String id, long at, String component, String event, int pid, long start, String incident, int reason,
        String status, String error, long activityAt, String activity, String memory, String details) {
        String header = "Neconyan crash report v2\nReport ID: " + line(id, 100) + "\nEvent timestamp ms: " + at
            + "\nComponent: " + line(component, 20) + "\nEvent: " + line(event, 80) + "\nProcess PID: " + pid + "\nProcess start ms: " + start
            + "\nIncident ID: " + line(incident, 100) + "\nReason code: " + reason + "\nStatus: " + line(status, 40)
            + "\nSummary: " + summary(component, event, reason, status) + "\nError: " + line(error, 400)
            + "\nActivity timestamp ms: " + activityAt + "\nLast activity: " + line(activity, 450) + "\nMemory sample: " + line(memory, 450);
        return parse(id + ".txt", header + "\n\nDetails:\n" + DiagnosticStore.redact(details));
    }
    static boolean shouldOffer(Entry entry, String seenBoundary, Set<String> incidents) {
        return entry != null && entry.id.compareTo(seenBoundary == null ? "" : seenBoundary) > 0 && !incidents.contains(entry.incident);
    }
    static String firstTraceError(String text) {
        for (String line : text.substring(0, Math.min(24000, text.length())).split("\n")) {
            if (line.startsWith("Abort message: ") || line.startsWith("Cause: ")) return line(line, 400);
        }
        return "";
    }
    static boolean matchesNode(int expectedPid, long nativeStart, long observedAt, long stoppedAt, int pid, long at, long nodeStart) {
        return expectedPid > 0 && pid == expectedPid && at >= (nativeStart > 0 ? nativeStart : observedAt) && at <= stoppedAt + 1000
            && nodeStart <= at && (nativeStart <= 0 || nodeStart >= nativeStart - 1000);
    }
    static String fatalRuntimeLines(String text) {
        StringBuilder out = new StringBuilder(); int lines = 0; boolean fatal = false;
        for (String line : text.split("\n")) {
            String clean = line.trim();
            if (clean.startsWith("FATAL ERROR: ")) fatal = true;
            else if (!fatal || !clean.matches("[0-9]+: 0x[0-9a-fA-F]+.*")) continue;
            String next = DiagnosticStore.redact(clean) + "\n";
            if (++lines > 20 || (out + next).getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 4096) break;
            out.append(next);
        }
        return out.toString();
    }
    static String displayText(Entry entry, boolean saved) {
        return entry.summary + "\n\nStopped: " + (entry.at > 0 ? java.text.DateFormat.getDateTimeInstance().format(new Date(entry.at)) : "Time unavailable")
            + "\n\n" + entry.error + "\n\n" + entry.activity + "\n\n" + entry.memory
            + (saved ? "" : "\n\nThe report could not be saved. Copy or share it before closing this screen.")
            + "\n\nReports stay on this device. Error messages and system traces may contain private text. Review before sharing.";
    }
}
