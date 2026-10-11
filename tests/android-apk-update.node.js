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
    assert.match(source, /@JavascriptInterface public void installUpdate\(String version\)/);
    assert.match(source, /!workspaceVisible\.getAsBoolean\(\)/);
    assert.match(source, /setPositiveButton\("Download APK"/);
    assert.match(source, /current\.packageName\.equals\(update\.packageName\)/);
    assert.match(source, /update\.getLongVersionCode\(\) <= current\.getLongVersionCode\(\)/);
    assert.match(source, /current\.signingInfo\.getApkContentsSigners\(\)/);
    assert.match(source, /update\.signingInfo\.getApkContentsSigners\(\)/);
    assert.match(source, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
    assert.match(source, /Intent\.ACTION_VIEW/);
    assert.match(source, /putExtra\(Intent\.EXTRA_RETURN_RESULT, true\)/);
    assert.doesNotMatch(source, /ACTION_DELETE|\.getFilesDir\(\)|CookieManager|Authorization|password/);
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
