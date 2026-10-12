package io.github.platberlitz.neconyan;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;

/** Keep an already confirmed update across Android recreating the activity or process. */
final class PendingApkUpdate {
    private static final long MAX_AGE_MS = 60L * 60 * 1000;
    private final File apk;
    private final File record;

    PendingApkUpdate(File apk) {
        this.apk = apk;
        this.record = new File(apk.getParentFile(), "pending-version");
    }

    void save(String version) throws IOException {
        ApkUpdatePolicy.versionCode(version);
        if (!apk.isFile()) throw new IOException("The verified update APK is missing.");
        File temporary = new File(record.getParentFile(), "pending-version.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write((version + "\n" + System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        Files.move(temporary.toPath(), record.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    String restore(long installedVersion) throws IOException {
        if (!record.isFile()) return null;
        if (record.length() <= 96 && apk.isFile()) {
            String value = new String(Files.readAllBytes(record.toPath()), StandardCharsets.UTF_8);
            try {
                int separator = value.indexOf('\n');
                if (separator <= 0 || separator != value.lastIndexOf('\n')) throw new IllegalArgumentException("Invalid pending update record.");
                String version = value.substring(0, separator);
                long savedAt = Long.parseLong(value.substring(separator + 1));
                long age = System.currentTimeMillis() - savedAt;
                if (age >= 0 && age < MAX_AGE_MS && ApkUpdatePolicy.versionCode(version) > installedVersion) return version;
            }
            catch (IllegalArgumentException ignored) { }
        }
        clear();
        return null;
    }

    void clear() {
        record.delete();
        apk.delete();
    }
}
