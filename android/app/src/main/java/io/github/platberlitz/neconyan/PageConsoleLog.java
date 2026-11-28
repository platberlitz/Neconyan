package io.github.platberlitz.neconyan;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/**
 * Page warnings and errors for bug reports. Release builds turn off the WebView inspector, so this is
 * the only record of what the page complained about. Ordinary log lines are dropped because they are
 * where page code prints user text; what is kept is one short, redacted line per message.
 */
final class PageConsoleLog {
    static final String LOG_TAG = "NeconyanPage";
    static final String FILE = "page-console.txt";
    static final String PREVIOUS = "page-console.previous.txt";
    static final int MAX_MESSAGE_CHARS = 240;
    static final int MAX_FILE_BYTES = 32 * 1024;
    static final int MAX_LINES_PER_MINUTE = 20;
    private static final long MINUTE_MS = 60_000;
    private final File directory;
    private String lastLine;
    private long lastAt, windowStart;
    private int windowLines, skipped;

    PageConsoleLog(File directory) { this.directory = directory; }

    /** One line for a warning or an error; null for every other level and for empty messages. */
    static String format(String level, String message, String source, int line) {
        if (!"warning".equals(level) && !"error".equals(level)) return null;
        String text = message == null ? "" : message;
        int newline = text.indexOf('\n');
        if (newline >= 0) text = text.substring(0, newline);
        text = text.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
        if (text.isEmpty()) return null;
        if (text.length() > MAX_MESSAGE_CHARS) text = text.substring(0, MAX_MESSAGE_CHARS) + "…";
        return DiagnosticStore.redact(level + " " + where(source, line) + " " + text);
    }

    /** The script path and line, without the local origin or any query string. */
    static String where(String source, int line) {
        String path = source == null ? "" : source.replaceAll("[?#].*$", "");
        path = path.replaceFirst("^https?://(?:127\\.0\\.0\\.1|localhost)(?::\\d+)?", "");
        if (path.length() > 120) path = "…" + path.substring(path.length() - 120);
        if (path.isEmpty()) path = "page";
        return line > 0 ? path + ":" + line : path;
    }

    /**
     * The text to write for a formatted line, or null when it repeats the previous one or the page has
     * already logged its share this minute. A page stuck in an error loop costs one line, not a full file.
     */
    synchronized String admit(long now, String line) {
        if (line == null) return null;
        if (line.equals(lastLine) && now - lastAt < MINUTE_MS) { skipped++; return null; }
        if (now - windowStart >= MINUTE_MS) { windowStart = now; windowLines = 0; }
        if (windowLines >= MAX_LINES_PER_MINUTE) { skipped++; return null; }
        windowLines++;
        lastLine = line;
        lastAt = now;
        String entry = Instant.ofEpochMilli(now) + " " + line + "\n";
        if (skipped > 0) entry = Instant.ofEpochMilli(now) + " " + skipped + " repeated or excess page messages skipped\n" + entry;
        skipped = 0;
        return entry;
    }

    /** Appends to the current file, keeping one previous file once it reaches its size limit. */
    void append(String entry) throws IOException {
        if (entry == null || entry.isEmpty()) return;
        byte[] bytes = entry.getBytes(StandardCharsets.UTF_8);
        synchronized (PageConsoleLog.class) {
            File current = new File(directory, FILE);
            if (current.length() + bytes.length > MAX_FILE_BYTES) {
                File previous = new File(directory, PREVIOUS);
                if (previous.exists() && !previous.delete()) throw new IOException("Could not replace " + PREVIOUS);
                if (current.exists() && !current.renameTo(previous)) throw new IOException("Could not rotate " + FILE);
            }
            try (FileOutputStream output = new FileOutputStream(current, true)) { output.write(bytes); }
        }
    }
}
