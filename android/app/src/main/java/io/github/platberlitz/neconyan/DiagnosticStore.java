package io.github.platberlitz.neconyan;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Small private reports, independent of Android so persistence can be exercised on the host. */
final class DiagnosticStore {
    static final int MAX_CHARS = 60000;
    private static final Object WRITE_LOCK = new Object();
    private final File directory;
    DiagnosticStore(File directory) { this.directory = directory; }

    static String redact(String text) {
        if (text == null) return "";
        return text.substring(0, Math.min(text.length(), MAX_CHARS))
            .replaceAll("(?i)\\b(Bearer|Basic)\\s+[^\\s,;\"']+", "$1 [redacted]")
            .replaceAll("(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|cookie)\\s*[\"']?\\s*[:=]\\s*)(?:\"[^\"]*(?:\"|$)|'[^']*(?:'|$)|[^\\s,;}]+)", "$1[redacted]")
            .replaceAll("\\b(?:sk|sess)-[a-zA-Z0-9_-]{12,}", "[redacted]")
            .replaceAll("(https?://)[^\\s/@]+:[^\\s/@]+@", "$1[redacted]@")
            .replaceAll("((?:https?|file)://[^\\s?#)]+)[?#][^\\s)]*", "$1?[redacted]")
            .replaceAll("(/[\\w/.-]+)\\?[^\\s)]*", "$1?[redacted]");
    }

    /** False when the saved report already holds a trace, or retention would delete it straight away. */
    boolean needsExit(String id, String missingTraceText) {
        synchronized (WRITE_LOCK) {
            if (!id.matches("[a-zA-Z0-9-]+")) return false;
            File existing = new File(directory, id + ".txt");
            if (!existing.isFile()) {
                File[] files = files();
                return files.length < 10 || (id + ".txt").compareTo(files[files.length - 10].getName()) > 0;
            }
            try {
                return new String(Files.readAllBytes(existing.toPath()), StandardCharsets.UTF_8).contains(missingTraceText);
            } catch (IOException error) { return true; }
        }
    }

    boolean saveExit(String id, String report, boolean hasTrace) {
        // Android can remove a trace after making it available. Never replace richer evidence with that absence.
        synchronized (WRITE_LOCK) {
            if (!id.matches("[a-zA-Z0-9-]+")) return false;
            if (!hasTrace && new File(directory, id + ".txt").isFile()) return true;
            return saveLocked(id, report);
        }
    }

    boolean save(String id, String report) {
        synchronized (WRITE_LOCK) { return saveLocked(id, report); }
    }

    private boolean saveLocked(String id, String report) {
        if (!id.matches("[a-zA-Z0-9-]+")) return false;
        File temporary = null;
        try {
            Files.createDirectories(directory.toPath());
            temporary = File.createTempFile("pending-", ".tmp", directory);
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(redact(report).getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), new File(directory, id + ".txt").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            File[] files = files();
            for (int i = 0; i < files.length - 10; i++) Files.deleteIfExists(files[i].toPath());
            return true;
        } catch (Exception error) { return false; }
        finally { if (temporary != null) temporary.delete(); }
    }

    File[] files() {
        File[] files = directory.listFiles((dir, name) -> name.matches("[a-zA-Z0-9-]+\\.txt"));
        if (files == null) return new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        return files;
    }

    String readAll() {
        return readNewest(10);
    }

    String readNewest(int maximum) {
        StringBuilder result = new StringBuilder();
        File[] files = files();
        for (int i = files.length - 1; i >= Math.max(0, files.length - maximum); i--) {
            try {
                if (files[i].length() > MAX_CHARS * 4L) continue;
                result.append("\n\n=== ").append(files[i].getName()).append(" ===\n")
                    .append(new String(Files.readAllBytes(files[i].toPath()), StandardCharsets.UTF_8));
            } catch (IOException error) { result.append("\nReport could not be read: ").append(error.getClass().getSimpleName()); }
        }
        return result.length() == 0 ? "No saved Android crash reports." : result.toString();
    }
}
