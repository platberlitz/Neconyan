import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const java = path.join(root, 'android/app/src/main/java/io/github/platberlitz/neconyan');
const read = name => fs.readFileSync(path.join(java, name), 'utf8');

test('native release policy executes version ordering and trusted download checks', t => {
    if (spawnSync('javac', ['-version']).error) return t.skip('Java compiler is not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-apk-policy-'));
    try {
        const harness = path.join(directory, 'ApkPolicyTest.java');
        fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.net.URI;
public class ApkPolicyTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        check(ApkUpdatePolicy.versionCode("1.2.4.1") == 1020401);
        check(ApkUpdatePolicy.versionCode("1.2.10") > ApkUpdatePolicy.versionCode("1.2.9"));
        check(ApkUpdatePolicy.versionCode("1.2.4.1") > ApkUpdatePolicy.versionCode("1.2.4"));
        for (String version : new String[] { "../evil", "1.2.3-beta", "1.2.100", "01.2.3", "999999999999999999.2.3" }) {
            boolean failed = false;
            try { ApkUpdatePolicy.versionCode(version); } catch (IllegalArgumentException expected) { failed = true; }
            check(failed);
        }
        String url = ApkUpdatePolicy.downloadUrl("1.3.0", "arm64");
        check(url.equals("https://github.com/platberlitz/Neconyan/releases/download/v1.3.0/Neconyan-1.3.0-android-arm64.apk"));
        check(ApkUpdatePolicy.downloadUrl("1.3.0", "x86_64").endsWith("-android-x86_64.apk"));
        check(ApkUpdatePolicy.allowedDownload(URI.create(url), url));
        check(ApkUpdatePolicy.allowedDownload(URI.create("https://release-assets.githubusercontent.com/asset?token=x"), url));
        for (String bad : new String[] { "http://release-assets.githubusercontent.com/file", "https://github.com/another/repo", "https://evil.example/file", "https://release-assets.githubusercontent.com.evil.example/file", "https://user@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file" })
            check(!ApkUpdatePolicy.allowedDownload(URI.create(bad), url));
    }
}`);
        const compile = spawnSync('javac', ['-d', directory, path.join(java, 'ApkUpdatePolicy.java'), harness], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);
        const run = spawnSync('java', ['-cp', directory, 'io.github.platberlitz.neconyan.ApkPolicyTest'], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('APK updates require confirmation, a newer matching package and matching signing certificates', () => {
    const source = read('ApkUpdater.java');
    assert.match(source, /@JavascriptInterface public boolean installUpdate\(String token, String version\)/);
    assert.match(source, /!workspaceVisible\.getAsBoolean\(\)/);
    assert.match(source, /setPositiveButton\("Download APK"/);
    assert.match(source, /current\.packageName\.equals\(update\.packageName\)/);
    assert.match(source, /update\.getLongVersionCode\(\) <= current\.getLongVersionCode\(\)/);
    assert.match(source, /info\.signingInfo\.getApkContentsSigners\(\)/);
    assert.match(source, /GET_SIGNING_CERTIFICATES \| PackageManager\.GET_SIGNATURES/);
    assert.match(source, /getPackageArchiveInfo\(file\.getPath\(\), signingFlags\(\)\)/);
    assert.match(source, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.P/);
    assert.match(source, /Could not read the update's signature/);
    assert.match(source, /isFinishing\(\)[\s\S]*isDestroyed\(\)/);
    assert.doesNotMatch(source, /TimeUnit\.MINUTES\.toNanos\(30\)|deadline/);
    assert.match(source, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
    assert.match(source, /Intent\.ACTION_VIEW/);
    assert.match(source, /putExtra\(Intent\.EXTRA_RETURN_RESULT, true\)/);
    assert.doesNotMatch(source, /ACTION_DELETE|\.getFilesDir\(\)|CookieManager|Authorization|password/);
});

test('a verified pending APK survives recreation, but cancellation and completed installs remove it', t => {
    if (spawnSync('javac', ['-version']).error) return t.skip('Java compiler is not installed');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-pending-apk-'));
    try {
        const harness = path.join(directory, 'PendingApkTest.java');
        fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.io.File;
import java.nio.file.Files;
public class PendingApkTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        File directory = new File(args[0]);
        File apk = new File(directory, "update.apk");
        File record = new File(directory, "pending-version");
        File data = new File(directory, "saved-data");
        Files.writeString(data.toPath(), "unchanged");
        PendingApkUpdate pending = new PendingApkUpdate(apk);
        check(pending.restore(1020900) == null);
        Files.writeString(apk.toPath(), "verified fixture");
        pending.save("1.3.0.1");
        check(Files.readString(record.toPath()).matches("1[.]3[.]0[.]1\\n[0-9]+"));
        // Recreate the updater, as Android does when returning from installation settings.
        PendingApkUpdate recreated = new PendingApkUpdate(apk);
        check("1.3.0.1".equals(recreated.restore(1020900)));
        recreated.clear();
        check(!apk.exists() && !record.exists());
        Files.writeString(apk.toPath(), "verified fixture");
        pending.save("1.3.0.1");
        check(new PendingApkUpdate(apk).restore(1030001) == null);
        check(!apk.exists() && !record.exists());
        for (String invalid : new String[] { "../evil", "x".repeat(65) }) {
            Files.writeString(apk.toPath(), "fixture");
            Files.writeString(record.toPath(), invalid);
            check(new PendingApkUpdate(apk).restore(1020900) == null);
            check(!apk.exists() && !record.exists());
        }
        Files.writeString(record.toPath(), "1.3.0.1");
        check(pending.restore(1020900) == null);
        check(!record.exists());
        Files.writeString(apk.toPath(), "verified fixture");
        Files.writeString(record.toPath(), "1.3.0.1\\n" + (System.currentTimeMillis() - 60L * 60 * 1000 - 1));
        check(pending.restore(1020900) == null);
        check(!apk.exists() && !record.exists());
        check(Files.readString(data.toPath()).equals("unchanged"));
    }
}`);
        const compile = spawnSync('javac', ['-d', directory, path.join(java, 'ApkUpdatePolicy.java'), path.join(java, 'PendingApkUpdate.java'), harness], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);
        const run = spawnSync('java', ['-cp', directory, 'io.github.platberlitz.neconyan.PendingApkTest', directory], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }

    const source = read('ApkUpdater.java');
    assert.match(source, /pendingUpdate\.save\(version\)/);
    assert.match(source, /pendingUpdate\.restore\(installed\(\)\.getLongVersionCode\(\)\)/);
    assert.match(read('PendingApkUpdate.java'), /MAX_AGE_MS = 60L \* 60 \* 1000/);
    assert.match(source, /void onResume\(\)/);
    assert.match(read('MainActivity.java'), /apkUpdater\.onResume\(\)/);
});

test('only the private verified APK can be shared with the Android installer, read-only', () => {
    const provider = read('UpdateApkProvider.java');
    assert.match(provider, /if \(!apkUri\(getContext\(\)\)\.equals\(uri\)\)/);
    assert.match(provider, /if \(!"r"\.equals\(mode\)\)/);
    assert.match(provider, /ParcelFileDescriptor\.MODE_READ_ONLY/);
    const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
    assert.match(manifest, /android:name="\.UpdateApkProvider"[\s\S]*?android:exported="false" android:grantUriPermissions="true"/);
    const activity = read('MainActivity.java');
    assert.match(activity, /addJavascriptInterface\(apkUpdater, "NeconyanAndroid"\)/);
    assert.match(activity, /apkUpdater\.onActivityResult\(code\)/);
    assert.match(activity, /apkUpdater\.close\(\)/);
});
