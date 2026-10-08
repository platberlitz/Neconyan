package io.github.platberlitz.neconyan;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Copies the private account folder into a ZIP that Neconyan's account import
 * accepts, without starting the local server. A file that cannot be read is
 * skipped and listed so the rest of the account still reaches the backup.
 */
final class DataRescue {
    private static final Pattern CHAT_LOCK = Pattern.compile("\\.neconyan-chat-[0-9a-f]{64}\\.lock(\\.owner)?");
    private static final Pattern KEY_MIGRATION = Pattern.compile("secrets_migration_.*\\.json");

    static final class Result {
        int files;
        long bytes;
        final List<String> skipped = new ArrayList<>();
    }

    private DataRescue() { }

    /** Account folders inside the data root. Android runs one account, default-user. */
    static List<File> accounts(File dataRoot) {
        List<File> accounts = new ArrayList<>();
        File single = new File(dataRoot, "default-user");
        if (single.isDirectory()) { accounts.add(single); return accounts; }
        File[] children = dataRoot.listFiles();
        if (children == null) return accounts;
        Arrays.sort(children);
        for (File child : children) {
            String name = child.getName();
            if (child.isDirectory() && !name.startsWith("_") && !name.startsWith(".") && !Files.isSymbolicLink(child.toPath())) accounts.add(child);
        }
        return accounts;
    }

    static Result write(File dataRoot, OutputStream destination, boolean includeKeys) throws IOException {
        List<File> accounts = accounts(dataRoot);
        if (accounts.isEmpty()) throw new FileNotFoundException("No saved Neconyan data was found on this phone");
        Result result = new Result();
        byte[] buffer = new byte[65536];
        try (ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(destination, 65536))) {
            for (File account : accounts) addTree(zip, account, "data/" + account.getName(), "", includeKeys, buffer, result);
        }
        return result;
    }

    private static void addTree(ZipOutputStream zip, File folder, String prefix, String relative, boolean includeKeys, byte[] buffer, Result result) throws IOException {
        File[] children = folder.listFiles();
        if (children == null) { result.skipped.add(relative.isEmpty() ? prefix : relative); return; }
        Arrays.sort(children);
        for (File child : children) {
            String path = relative.isEmpty() ? child.getName() : relative + "/" + child.getName();
            if (Files.isSymbolicLink(child.toPath())) continue;
            if (child.isDirectory()) {
                // Server job records describe work in this install, not account content.
                if (relative.isEmpty() && child.getName().equals("jobs")) continue;
                addTree(zip, child, prefix, path, includeKeys, buffer, result);
                continue;
            }
            if (!Files.isRegularFile(child.toPath(), LinkOption.NOFOLLOW_LINKS) || CHAT_LOCK.matcher(child.getName()).matches()) continue;
            if (!includeKeys && (path.equals("secrets.json") || relative.equals("backups") && KEY_MIGRATION.matcher(child.getName()).matches())) continue;
            InputStream input;
            try { input = new FileInputStream(child); } catch (IOException error) { result.skipped.add(path); continue; }
            ZipEntry entry = new ZipEntry(prefix + "/" + path);
            entry.setTime(child.lastModified());
            zip.putNextEntry(entry);
            try (InputStream stream = input) {
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    zip.write(buffer, 0, count);
                    result.bytes += count;
                }
                result.files++;
            } catch (IOException error) {
                // The entry keeps what was readable; it is still listed so the user knows to check it.
                result.skipped.add(path);
            }
            zip.closeEntry();
        }
    }
}
