import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const javaDir = new URL('../android/app/src/main/java/io/github/platberlitz/neconyan/', import.meta.url);
const readJava = name => readFileSync(new URL(name, javaDir), 'utf8');
const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

test('DeviceMemoryProfile serialises coarse memory capacity and sanitises null or throwing services', { skip: !hasJava }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'android-device-memory-'));
    try {
        const androidAppDir = path.join(directory, 'android', 'app');
        const androidContentDir = path.join(directory, 'android', 'content');
        const orgJsonDir = path.join(directory, 'org', 'json');
        mkdirSync(androidAppDir, { recursive: true });
        mkdirSync(androidContentDir, { recursive: true });
        mkdirSync(orgJsonDir, { recursive: true });

        writeFileSync(path.join(androidContentDir, 'Context.java'), `package android.content;
public class Context {
    private final Object service;
    private final boolean throwsOnGet;
    public Context(Object service, boolean throwsOnGet) {
        this.service = service;
        this.throwsOnGet = throwsOnGet;
    }
    @SuppressWarnings("unchecked")
    public <T> T getSystemService(Class<T> serviceClass) {
        if (throwsOnGet) throw new RuntimeException("service unavailable");
        return (T) service;
    }
}
`);

        writeFileSync(path.join(androidAppDir, 'ActivityManager.java'), `package android.app;
public class ActivityManager {
    public static class MemoryInfo {
        public long totalMem;
        public long availMem;
        public boolean lowMemory;
    }
    private final long totalMem;
    private final boolean lowRamDevice;
    private final boolean throwsOnRead;
    public ActivityManager(long totalMem, boolean lowRamDevice, boolean throwsOnRead) {
        this.totalMem = totalMem;
        this.lowRamDevice = lowRamDevice;
        this.throwsOnRead = throwsOnRead;
    }
    public void getMemoryInfo(MemoryInfo outInfo) {
        if (throwsOnRead) throw new SecurityException("cannot read memory info");
        outInfo.totalMem = totalMem;
        outInfo.availMem = 123456L;
    }
    public boolean isLowRamDevice() {
        if (throwsOnRead) throw new RuntimeException("cannot query low ram flag");
        return lowRamDevice;
    }
}
`);

        writeFileSync(path.join(orgJsonDir, 'JSONObject.java'), `package org.json;
import java.util.*;
public class JSONObject {
    private final Map<String, Object> entries = new LinkedHashMap<>();
    public JSONObject put(String key, Object value) {
        entries.put(key, value);
        return this;
    }
    @Override public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : entries.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\\"").append(entry.getKey()).append("\\":");
            Object v = entry.getValue();
            if (v instanceof String) sb.append("\\"").append(v).append("\\"");
            else sb.append(String.valueOf(v));
        }
        return sb.append("}").toString();
    }
}
`);

        const harness = path.join(directory, 'DeviceMemoryProfileTest.java');
        writeFileSync(harness, `package io.github.platberlitz.neconyan;
import android.app.ActivityManager;
import android.content.Context;
public class DeviceMemoryProfileTest {
    static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        check("null".equals(DeviceMemoryProfile.readJson(null)), "null context must return null literal");
        check("null".equals(DeviceMemoryProfile.readJson(new Context(null, false))), "null ActivityManager must return null literal");
        check("null".equals(DeviceMemoryProfile.readJson(new Context(null, true))), "throwing Context must return null literal");
        check("null".equals(DeviceMemoryProfile.readJson(new Context(new ActivityManager(4096L * 1024L * 1024L, false, true), false))), "throwing ActivityManager must return null literal");
        check("null".equals(DeviceMemoryProfile.serialize(0L, false)), "zero totalMem must return null literal");
        check("null".equals(DeviceMemoryProfile.serialize(-1024L, true)), "negative totalMem must return null literal");

        String lowRamJson = DeviceMemoryProfile.readJson(new Context(new ActivityManager(2048L * 1024L * 1024L, true, false), false));
        check("{\\"schema\\":1,\\"totalMemoryMiB\\":2048,\\"isLowRamDevice\\":true}".equals(lowRamJson), "2 GiB low-RAM profile mismatch: " + lowRamJson);
        check(!lowRamJson.contains("availMem"), "available memory must not be exposed");

        String fourGbPhoneJson = DeviceMemoryProfile.readJson(new Context(new ActivityManager(3750L * 1024L * 1024L, false, false), false));
        check("{\\"schema\\":1,\\"totalMemoryMiB\\":3750,\\"isLowRamDevice\\":false}".equals(fourGbPhoneJson), "4 GB handset (~3.66 GiB) profile mismatch: " + fourGbPhoneJson);

        String highRamJson = DeviceMemoryProfile.readJson(new Context(new ActivityManager(8192L * 1024L * 1024L, false, false), false));
        check("{\\"schema\\":1,\\"totalMemoryMiB\\":8192,\\"isLowRamDevice\\":false}".equals(highRamJson), "8 GiB profile mismatch: " + highRamJson);
    }
}
`);

        const source = new URL('DeviceMemoryProfile.java', javaDir).pathname;
        const compile = spawnSync('javac', [
            '--release', '17',
            '-d', directory,
            path.join(androidContentDir, 'Context.java'),
            path.join(androidAppDir, 'ActivityManager.java'),
            path.join(orgJsonDir, 'JSONObject.java'),
            source,
            harness,
        ], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);

        const run = spawnSync('java', ['-cp', directory, 'io.github.platberlitz.neconyan.DeviceMemoryProfileTest'], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('MainActivity passes DeviceMemoryProfile only through the existing origin-guarded installAndroidNativeBridge call', () => {
    const activity = readJava('MainActivity.java');
    const profileSource = readJava('DeviceMemoryProfile.java');

    assert.doesNotMatch(profileSource, /@JavascriptInterface/);
    assert.doesNotMatch(activity, /addJavascriptInterface\([^)]*DeviceMemoryProfile/);
    assert.match(
        activity,
        /import\('\/scripts\/android-native-bridge\.js'\)\.then\(module => module\.installAndroidNativeBridge\("\s*\+\s*JSONObject\.quote\(bridgeToken\)\s*\+\s*","\s*\+\s*JSONObject\.quote\(origin\)\s*\+\s*","\s*\+\s*DeviceMemoryProfile\.readJson\(MainActivity\.this\)\s*\+\s*"\)\)"/,
    );
});
