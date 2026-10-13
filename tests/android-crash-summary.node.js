import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('native summaries, bounded individual reads and seen policy run on the host', t => {
    const root = fs.mkdtempSync('/tmp/opencode/crash-relaunch/summary-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const harness = path.join(root, 'SummaryTest.java');
    fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.io.*; import java.util.*;
public class SummaryTest { public static void main(String[] args) {
    DiagnosticStore store = new DiagnosticStore(new File(args[0], "reports"));
    CrashReport.Entry entry = CrashReport.create("200-crash", 200, "server", "android-process-exit", 42, 100, "incident-one", 9, "11", "Error password=private", 150, "Earlier activity", "Earlier memory", "x".repeat(70000));
    if (!entry.summary.contains("signal 11") || entry.summary.contains("free memory")) throw new AssertionError("signal confidence");
    if (!CrashReport.summary("page", "renderer-closed", -1, "unknown").contains("definite cause")) throw new AssertionError("renderer confidence");
    if (!CrashReport.summary("server", "exit", 3, "9").contains("local server to free memory")) throw new AssertionError("Android memory");
    if (!CrashReport.summary("app", "uncaught-java-exception", -1, "unknown").contains("application error")) throw new AssertionError("Java error");
    if (!store.save("200-crash", entry.text)) throw new AssertionError("save");
    if (store.readEntry("../escape.txt") != null) throw new AssertionError("traversal");
    entry = store.readEntry("200-crash.txt");
    if (entry.text.length() > 60000 || entry.text.contains("private")) throw new AssertionError("bound/redaction");
    if (store.listEntries().get(0).text.length() > 4096) throw new AssertionError("loaded body for list");
    if (!CrashReport.shouldOffer(entry, "", Set.of())) throw new AssertionError("new incident");
    if (CrashReport.shouldOffer(entry, "200-crash.txt", Set.of())) throw new AssertionError("seen boundary");
    if (CrashReport.shouldOffer(entry, "", Set.of("incident-one"))) throw new AssertionError("enrichment duplicate");
    if (!CrashReport.parse("100-legacy.txt", "Old report").component.equals("unknown")) throw new AssertionError("legacy");
    System.out.println("passed");
} }`);
    const java = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
    execFileSync('javac', ['-d', root, java + 'CrashReport.java', java + 'DiagnosticStore.java', harness]);
    assert.match(execFileSync('java', ['-cp', root, 'io.github.platberlitz.neconyan.SummaryTest', root], { encoding: 'utf8' }), /passed/);
});
