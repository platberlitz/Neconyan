import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const app = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
const helperPath = path.resolve(`${app}PayloadInstaller.java`);
const servicePath = path.resolve(`${app}ServerService.java`);
const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

function block(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end} after ${start}`);
    return source.slice(from, to);
}

test('the server opens the payload once and publishes only through the verified installer', () => {
    const service = fs.readFileSync(servicePath, 'utf8');
    const helper = fs.readFileSync(helperPath, 'utf8');
    const install = block(service, 'private File installPayload()', 'private static boolean isInstalled');
    assert.equal((install.match(/getAssets\(\)\.open\("server\.zip"\)/g) || []).length, 1, 'the archive must be opened exactly once');
    assert.match(install, /PayloadInstaller\.recover\(runtime\);\s*if \(isInstalled\(runtime\)\)/);
    assert.match(install, /if \(oldRuntime != null\) PayloadInstaller\.recover\(oldRuntime\);/);
    const oldRecovery = install.indexOf('PayloadInstaller.recover(oldRuntime)');
    const sourceChoiceAt = install.indexOf('File source = extensionSource(runtime, oldRuntime)');
    assert.ok(oldRecovery !== -1 && sourceChoiceAt !== -1 && oldRecovery < sourceChoiceAt, 'the previous version must recover before extension selection');
    assert.match(install, /File source = extensionSource\(runtime, oldRuntime\)/);
    assert.match(install, /PayloadInstaller\.install\(archive, BuildConfig\.SERVER_SHA256, stage, runtime/);
    assert.doesNotMatch(install, /new DigestInputStream|new ZipInputStream|new FileOutputStream\(target\)/);
    assert.match(install, /PayloadInstaller\.deleteTree\(stage\)/);
    assert.match(install, /old\.getName\(\)\.matches\("runtime-\[a-f0-9\]\{16\}"\)/);
    assert.doesNotMatch(install, /old\.getName\(\)\.startsWith\("runtime-"\)/);
    assert.match(block(service, 'private static boolean isInstalled', 'private void preserveExtensions'), /installedHash\.equalsIgnoreCase\(BuildConfig\.SERVER_SHA256\)/);
    const sourceChoice = block(service, 'private static File extensionSource', 'private static boolean isInstalled');
    assert.match(sourceChoice, /PayloadInstaller\.rollback\(runtime\), PayloadInstaller\.previous\(runtime\), oldRuntime/);
    assert.match(sourceChoice, /oldRuntime == null \? null : PayloadInstaller\.rollback\(oldRuntime\)/);
    assert.match(sourceChoice, /oldRuntime == null \? null : PayloadInstaller\.previous\(oldRuntime\)/);
    assert.match(sourceChoice, /hasThirdPartyExtensions\(candidate\) && hasExtensionManifest\(candidate\)/);
    assert.match(sourceChoice, /for \(File candidate : candidates\) \{\s*if \(hasThirdPartyExtensions\(candidate\)\) return candidate;/);

    const recover = helper.indexOf('recover(runtime);');
    const preserve = helper.indexOf('if (preserver != null) preserver.preserve(staging);');
    const verify = helper.indexOf('if (!actual.equalsIgnoreCase(expectedSha256)) throw new IOException("The application package did not verify");');
    const marker = helper.indexOf('Files.write(new File(staging, COMPLETE).toPath()');
    const publish = helper.indexOf('if (!staging.renameTo(runtime))');
    const published = helper.indexOf('published = true;');
    const removePrevious = helper.indexOf('File previous = previous(runtime);');
    assert.ok(recover !== -1 && preserve !== -1 && verify !== -1 && marker !== -1 && publish !== -1 && published !== -1 && removePrevious !== -1);
    assert.ok(recover < preserve, 'the interrupted publish must be recovered before extension preservation');
    assert.ok(verify < marker, 'the complete marker must follow the full hash check');
    assert.ok(verify < publish, 'the runtime must not be published before the full hash check');
    assert.ok(published < removePrevious, 'the previous backup must be removed only after the publish succeeds');
    assert.match(helper, /boolean restored = !setAside \|\| rollback\.renameTo\(runtime\);/);
    assert.match(helper, /new DigestInputStream\(new BufferedInputStream\(archive, 65536\), digest\)/);
    assert.match(helper, /while \(hashed\.read\(buffer\) != -1\) \{ \}/, 'unread central-directory and trailing bytes must be drained');
    assert.match(helper, /target\.getCanonicalPath\(\)\.startsWith\(prefix\)/, 'path traversal protection must stay');
    assert.match(helper, /if \(!published\) \{\s*try \{ deleteTree\(staging\)/);
});

test('the JVM installer verifies archives, recovers interrupted publishes and blocks traversal', { skip: !hasJava, timeout: 120000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-payload-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const harness = path.join(root, 'PayloadInstallerTest.java');
    fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class PayloadInstallerTest {
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]);
        File valid = writeZip(root, "valid.zip", false, 200000);
        String validHash = sha256(valid);

        File runtime = new File(root, "runtime-valid");
        File staging = new File(root, "staging-valid");
        PayloadInstaller.install(new FileInputStream(valid), validHash, staging, runtime, null);
        check(new File(runtime, "app/main.js").isFile(), "valid archive did not extract a file");
        check(new File(runtime, "app/payload.bin").length() == 200000, "valid archive did not extract the payload");
        check(!staging.exists(), "valid install left staging behind");
        check(new String(Files.readAllBytes(new File(runtime, ".complete").toPath()), StandardCharsets.UTF_8).equals(validHash), "complete marker does not contain the verified hash");

        File replacement = new File(root, "runtime-replacement");
        check(replacement.mkdirs(), "cannot create replacement runtime");
        write(new File(replacement, "stale.txt"), "stale");
        PayloadInstaller.install(new FileInputStream(valid), validHash, new File(root, "staging-replacement"), replacement, null);
        check(new File(replacement, "app/main.js").isFile(), "verified replacement did not publish");
        check(!new File(replacement, "stale.txt").exists(), "verified replacement kept old application files");

        File recovered = new File(root, "runtime-recovered");
        File recoveredBackup = PayloadInstaller.previous(recovered);
        check(recoveredBackup.mkdirs(), "cannot create interrupted-publish backup");
        write(new File(recoveredBackup, "keep-extension.txt"), "extension");
        File recoveredStage = new File(root, "staging-recovered");
        // No explicit recover call: install must restore the backup before preservation.
        PayloadInstaller.install(new FileInputStream(valid), validHash, recoveredStage, recovered, prepared -> {
            copy(new File(recovered, "keep-extension.txt"), new File(prepared, "public/extensions/keep-extension.txt"));
        });
        check(new File(recovered, "public/extensions/keep-extension.txt").isFile(), "extension from the recovered runtime was lost");
        check(!recoveredBackup.exists(), "recovered backup was not cleared after a safe publish");

        File oldVersion = new File(root, "runtime-1111111111111111");
        File oldVersionRollback = PayloadInstaller.rollback(oldVersion);
        check(oldVersionRollback.mkdirs(), "cannot create old-version rollback state");
        write(new File(oldVersionRollback, "old-extension.txt"), "old extension");
        // Production recovers oldRuntime after an APK update changes the folder name.
        PayloadInstaller.recover(oldVersion);
        check(oldVersion.isDirectory() && !oldVersionRollback.exists(), "old-version rollback was not recovered");
        File newVersion = new File(root, "runtime-2222222222222222");
        PayloadInstaller.install(new FileInputStream(valid), validHash, new File(root, "staging-new-version"), newVersion, prepared -> {
            copy(new File(oldVersion, "old-extension.txt"), new File(prepared, "public/extensions/old-extension.txt"));
        });
        check(new File(newVersion, "public/extensions/old-extension.txt").isFile(), "extension from the old backup-only runtime was not migrated into the new runtime");

        File rollbackOnly = new File(root, "runtime-rollback-only");
        File rollbackOnlyPath = PayloadInstaller.rollback(rollbackOnly);
        check(rollbackOnlyPath.mkdirs(), "cannot create rollback-only state");
        write(new File(rollbackOnlyPath, "keep.txt"), "keep");
        PayloadInstaller.recover(rollbackOnly);
        check(rollbackOnly.isDirectory() && !rollbackOnlyPath.exists(), "rollback-only state was not recovered");

        File existing = new File(root, "runtime-existing");
        check(existing.mkdirs(), "cannot create existing runtime");
        write(new File(existing, ".complete"), "target-marker");
        write(new File(existing, "keep-old.txt"), "old");
        File existingBackup = PayloadInstaller.previous(existing);
        check(existingBackup.mkdirs(), "cannot create existing backup");
        write(new File(existingBackup, "extension.txt"), "extension");
        boolean[] backupAtPreserve = { false };
        PayloadInstaller.install(new FileInputStream(valid), validHash, new File(root, "staging-existing"), existing, prepared -> {
            backupAtPreserve[0] = PayloadInstaller.previous(existing).exists();
            copy(new File(existingBackup, "extension.txt"), new File(prepared, "public/extensions/extension.txt"));
        });
        check(backupAtPreserve[0], "the previous backup was removed before extension preservation");
        check(new File(existing, "public/extensions/extension.txt").isFile(), "backup extension was not preserved");
        check(!existingBackup.exists(), "the previous backup was not removed after the safe publish");
        check(!new File(existing, "keep-old.txt").exists(), "the old runtime survived the safe publish");

        File trailing = append(valid, new File(root, "trailing.zip"), 32768);
        String trailingHash = sha256(trailing);
        File trailingRuntime = new File(root, "runtime-trailing");
        PayloadInstaller.install(new FileInputStream(trailing), trailingHash, new File(root, "staging-trailing"), trailingRuntime, null);
        check(new File(trailingRuntime, ".complete").isFile(), "trailing bytes were not covered by the hash check");

        File live = new File(root, "runtime-live");
        check(live.mkdirs(), "cannot create live runtime");
        write(new File(live, ".complete"), "live-marker");
        write(new File(live, "keep.txt"), "keep");
        File liveBackup = PayloadInstaller.previous(live);
        check(liveBackup.mkdirs(), "cannot create live backup");
        write(new File(liveBackup, "extension.txt"), "extension");

        File trailingStage = new File(root, "staging-trailing-mismatch");
        expectFailure(() -> PayloadInstaller.install(new FileInputStream(trailing), validHash, trailingStage, live, null), "trailing bytes must fail the original hash");
        check(!trailingStage.exists(), "failed mismatch left staging behind");
        check(liveState(live), "trailing mismatch damaged the previous live installation");

        File altered = alterCentralDirectory(valid, new File(root, "central-altered.zip"));
        File centralStage = new File(root, "staging-central-mismatch");
        expectFailure(() -> PayloadInstaller.install(new FileInputStream(altered), validHash, centralStage, live, null), "altered central directory must fail the original hash");
        check(!centralStage.exists(), "failed central-directory check left staging behind");
        check(liveState(live), "central-directory mismatch damaged the previous live installation");

        File traversal = writeZip(root, "traversal.zip", true, 0);
        String traversalHash = sha256(traversal);
        File traversalStage = new File(root, "staging-traversal");
        expectFailure(() -> PayloadInstaller.install(new FileInputStream(traversal), traversalHash, traversalStage, live, null), "path traversal must be rejected");
        check(!traversalStage.exists(), "path traversal left staging behind");
        check(!new File(root, "escape.txt").exists() && !new File(root.getParentFile(), "escape.txt").exists(), "path traversal escaped the staging folder");
        check(liveState(live), "path traversal damaged the previous live installation");

        File preserveStage = new File(root, "staging-preserve-failure");
        expectFailure(() -> PayloadInstaller.install(new FileInputStream(valid), validHash, preserveStage, live, prepared -> {
            throw new IOException("simulated extension preservation failure");
        }), "preserver failure must abort the installation");
        check(!preserveStage.exists(), "preserver failure left staging behind");
        check(liveState(live), "preserver failure damaged the previous live installation");

        File failingStage = new File(root, "staging-failing-publish") {
            @Override public boolean renameTo(File destination) {
                return false;
            }
        };
        expectFailure(() -> PayloadInstaller.install(new FileInputStream(valid), validHash, failingStage, live, null), "a failed publish must throw");
        check(!failingStage.exists(), "failed publish left staging behind");
        check(!PayloadInstaller.rollback(live).exists(), "failed publish did not restore the live folder");
        check(liveState(live), "failed publish damaged the previous installation or its backup");

        System.out.println("PAYLOAD_INSTALL_OK");
    }

    private static boolean liveState(File live) throws IOException {
        return new File(live, "keep.txt").isFile()
            && PayloadInstaller.previous(live).isDirectory()
            && new String(Files.readAllBytes(new File(live, ".complete").toPath()), StandardCharsets.UTF_8).equals("live-marker");
    }

    private static File writeZip(File parent, String name, boolean traversal, int payloadSize) throws IOException {
        File file = new File(parent, name);
        try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(file))) {
            if (traversal) {
                zip.putNextEntry(new ZipEntry("../escape.txt"));
                zip.write("escape".getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
                return file;
            }
            zip.putNextEntry(new ZipEntry("app/"));
            zip.closeEntry();
            zip.putNextEntry(new ZipEntry("app/main.js"));
            zip.write("console.log('ok');".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            byte[] payload = new byte[payloadSize];
            for (int i = 0; i < payload.length; i++) payload[i] = (byte) ((i * 31 + 7) & 0xff);
            zip.putNextEntry(new ZipEntry("app/payload.bin"));
            zip.write(payload);
            zip.closeEntry();
        }
        return file;
    }

    private static void copy(File source, File target) throws IOException {
        target.getParentFile().mkdirs();
        Files.copy(source.toPath(), target.toPath());
    }

    private static File append(File source, File target, int bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(target); FileInputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            byte[] suffix = new byte[bytes];
            for (int i = 0; i < suffix.length; i++) suffix[i] = (byte) (i * 17 + 3);
            output.write(suffix);
        }
        return target;
    }

    private static File alterCentralDirectory(File source, File target) throws IOException {
        byte[] bytes = Files.readAllBytes(source.toPath());
        int eocd = -1;
        for (int i = bytes.length - 22; i >= 0; i--) {
            if ((bytes[i] & 0xff) == 0x50 && (bytes[i + 1] & 0xff) == 0x4b
                && (bytes[i + 2] & 0xff) == 0x05 && (bytes[i + 3] & 0xff) == 0x06) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new IOException("no end-of-central-directory record");
        int offset = (bytes[eocd + 16] & 0xff) | ((bytes[eocd + 17] & 0xff) << 8)
            | ((bytes[eocd + 18] & 0xff) << 16) | ((bytes[eocd + 19] & 0xff) << 24);
        if ((bytes[offset] & 0xff) != 0x50 || (bytes[offset + 1] & 0xff) != 0x4b
            || (bytes[offset + 2] & 0xff) != 0x01 || (bytes[offset + 3] & 0xff) != 0x02) {
            throw new IOException("central directory signature not found");
        }
        bytes[offset + 46] ^= 0x01;
        Files.write(target.toPath(), bytes);
        return target;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) hex.append(String.format("%02x", value));
        return hex.toString();
    }

    private static void write(File file, String text) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void expectFailure(Action action, String message) throws Exception {
        try {
            action.run();
        } catch (Exception expected) {
            return;
        }
        throw new AssertionError(message);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private interface Action {
        void run() throws Exception;
    }
}
`);
    execFileSync('javac', ['-d', root, helperPath, harness], { stdio: 'pipe' });
    const output = execFileSync('java', ['-cp', root, 'io.github.platberlitz.neconyan.PayloadInstallerTest', root], { encoding: 'utf8' });
    assert.match(output, /PAYLOAD_INSTALL_OK/);
});
