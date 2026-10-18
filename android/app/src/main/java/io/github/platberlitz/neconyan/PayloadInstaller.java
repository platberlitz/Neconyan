package io.github.platberlitz.neconyan;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

// Installs the bundled server archive without ever trusting a partially extracted
// copy. The whole archive is hashed through one asset stream, including the
// central directory and any trailing bytes that ZipInputStream has not consumed.
final class PayloadInstaller {
    private static final long MAX_EXTRACTED_BYTES = 3L * 1024 * 1024 * 1024;
    private static final String COMPLETE = ".complete";

    interface Preserver {
        void preserve(File staging) throws Exception;
    }

    private PayloadInstaller() {
    }

    static void install(InputStream archive, String expectedSha256, File staging, File runtime, Preserver preserver) throws Exception {
        if (expectedSha256 == null || !expectedSha256.matches("[a-fA-F0-9]{64}")) throw new IOException("The application package checksum is invalid");
        // Recover an installation left between the two publish renames before the
        // caller has a chance to preserve extensions from a missing runtime folder.
        recover(runtime);
        deleteTree(staging);
        if (!staging.mkdirs() && !staging.isDirectory()) throw new IOException("Cannot create the private application folder");
        boolean published = false;
        try {
            String actual = extract(archive, staging);
            if (!actual.equalsIgnoreCase(expectedSha256)) throw new IOException("The application package did not verify");
            if (preserver != null) preserver.preserve(staging);
            // The marker is written inside staging, so it becomes visible only with the
            // verified tree when the rename publishes the installation.
            Files.write(new File(staging, COMPLETE).toPath(), expectedSha256.getBytes(StandardCharsets.UTF_8));
            File rollback = rollback(runtime);
            boolean setAside = false;
            if (exists(runtime)) {
                deleteTree(rollback);
                if (!runtime.renameTo(rollback)) throw new IOException("Cannot set aside the previous application");
                setAside = true;
            }
            if (!staging.renameTo(runtime)) {
                boolean restored = !setAside || rollback.renameTo(runtime);
                throw new IOException(restored
                    ? "Cannot finish installing the application"
                    : "Cannot finish installing the application or restore the previous copy");
            }
            published = true;
            // Older copies are removed only after the verified tree is in place.
            if (setAside) {
                try { deleteTree(rollback); } catch (IOException ignored) { }
            }
            File previous = previous(runtime);
            try { deleteTree(previous); } catch (IOException ignored) { }
        } finally {
            if (!published) {
                try { deleteTree(staging); } catch (IOException ignored) { }
            }
        }
    }

    // Recover the live folder if a publish stopped after moving it aside. The backup
    // is restored first so the next preservation pass sees the user's extensions.
    static void recover(File runtime) throws IOException {
        if (exists(runtime)) return;
        File rollback = rollback(runtime);
        if (exists(rollback)) {
            if (!rollback.renameTo(runtime)) throw new IOException("Cannot recover the previous application");
            return;
        }
        File previous = previous(runtime);
        if (exists(previous) && !previous.renameTo(runtime)) throw new IOException("Cannot recover the previous application");
    }

    static File rollback(File runtime) {
        return new File(runtime.getParentFile(), runtime.getName() + ".rollback");
    }

    static File previous(File runtime) {
        return new File(runtime.getParentFile(), runtime.getName() + ".previous");
    }

    private static boolean exists(File file) {
        return Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS);
    }

    private static String extract(InputStream archive, File staging) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        String prefix = staging.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[65536];
        long size = 0;
        byte[] hash;
        // ZipInputStream reads in small default chunks. Buffer the asset reads under
        // the digest stream so extraction does not multiply asset-stream calls.
        try (DigestInputStream hashed = new DigestInputStream(new BufferedInputStream(archive, 65536), digest)) {
            ZipInputStream zip = new ZipInputStream(hashed);
            boolean extracted = false;
            try {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    File target = new File(staging, entry.getName());
                    if (!target.getCanonicalPath().startsWith(prefix)) throw new IOException("Unsafe application package path");
                    if (entry.isDirectory()) {
                        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Cannot create an application folder");
                    } else {
                        File parent = target.getParentFile();
                        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create an application folder");
                        if (target.isDirectory()) throw new IOException("Unsafe application package path");
                        try (OutputStream output = new FileOutputStream(target)) {
                            int count;
                            while ((count = zip.read(buffer)) != -1) {
                                size += count;
                                if (size > MAX_EXTRACTED_BYTES) throw new IOException("The application package is too large");
                                output.write(buffer, 0, count);
                            }
                        }
                    }
                    zip.closeEntry();
                }
                extracted = true;
            } finally {
                if (extracted) {
                    // Bytes ZipInputStream already read ahead were hashed by the digest
                    // stream. Drain whatever remains so the whole asset is covered.
                    while (hashed.read(buffer) != -1) { }
                }
                zip.close();
            }
            hash = digest.digest();
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : hash) hex.append(String.format("%02x", value));
        return hex.toString();
    }

    static void deleteTree(File file) throws IOException {
        if (!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Cannot inspect the application folder");
            for (File child : children) deleteTree(child);
        }
        Files.delete(file.toPath());
    }
}
