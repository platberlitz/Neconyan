import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;
test('native summaries, bounded individual reads and seen policy run on the host', { skip: !hasJava }, t => {
    const root = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'neconyan-summary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const harness = path.join(root, 'SummaryTest.java');
    fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.io.*; import java.util.*;
public class SummaryTest { public static void main(String[] args) {
    DiagnosticStore store = new DiagnosticStore(new File(args[0], "reports"));
    CrashReport.Entry entry = CrashReport.create("200-crash", 200, "server", "android-process-exit", 42, 100, "incident-one", 2, "11", "Error password=private", 150, "Earlier activity", "Earlier memory", "x".repeat(70000));
    if (!entry.summary.contains("signal 11") || entry.summary.contains("free memory")) throw new AssertionError("signal confidence");
    if (CrashReport.summary("server", "exit", 9, "11").contains("signal 11")) throw new AssertionError("resource usage is not a signal");
    if (!CrashReport.summary("page", "renderer-closed", -1, "unknown").contains("definite cause")) throw new AssertionError("renderer confidence");
    if (!CrashReport.summary("server", "exit", 3, "9").contains("local server to free memory")) throw new AssertionError("Android memory");
    if (!CrashReport.summary("app", "uncaught-java-exception", -1, "unknown").contains("application error")) throw new AssertionError("Java error");
    if (!CrashReport.isRoutineIsolatedExit(13, 0, "isolated not needed")) throw new AssertionError("Android 11/13 routine renderer cleanup");
    if (!CrashReport.isRoutineIsolatedExit(13, 0, "[ISOLATED NOT NEEDED] isolated not needed")) throw new AssertionError("Android 15 routine renderer cleanup");
    if (!CrashReport.isRoutineIsolatedExit(13, 0, "remove task") || !CrashReport.isRoutineIsolatedExit(13, 0, "[REMOVE TASK] remove task")) throw new AssertionError("Android Recents task removal");
    for (String clean : new String[] { "SwipeUpClean", "OneKeyClean", "ForceClean", "GarbageClean", "LockScreenClean", "GameClean", "OptimizationClean", "[UNKNOWN] SwipeUpClean" }) {
        if (!CrashReport.isRoutineIsolatedExit(13, 0, clean)) throw new AssertionError("OEM routine task cleanup: " + clean);
    }
    for (int reason : new int[] { 0, 2, 3, 4, 5, 6, 9 }) {
        if (CrashReport.isRoutineIsolatedExit(reason, 0, "isolated not needed")) throw new AssertionError("real failure hidden: " + reason);
        if (CrashReport.isRoutineIsolatedExit(reason, 0, "SwipeUpClean")) throw new AssertionError("real failure hidden: " + reason);
    }
    if (CrashReport.isRoutineIsolatedExit(13, 11, "isolated not needed") || CrashReport.isRoutineIsolatedExit(13, 11, "SwipeUpClean")) throw new AssertionError("nonzero exit hidden");
    if (CrashReport.isRoutineIsolatedExit(13, 0, null) || CrashReport.isRoutineIsolatedExit(13, 0, "unknown system stop")
        || CrashReport.isRoutineIsolatedExit(13, 0, "AutoPowerKill") || CrashReport.isRoutineIsolatedExit(13, 0, "AutoThermalKill")) throw new AssertionError("unknown cause hidden");
    if (!CrashReport.matchesNode(42, 100000, 300000, 1000000, 42, 900000, 500000)) throw new AssertionError("payload preparation delay");
    if (!CrashReport.matchesNode(42, 100000, 800000, 1000000, 42, 900000, 100000)) throw new AssertionError("reopened activity with running server");
    if (CrashReport.matchesNode(42, 600000, 800000, 1000000, 42, 900000, 100000)) throw new AssertionError("reused old PID");
    if (CrashReport.matchesNode(42, 100000, 300000, 1000000, 43, 900000, 500000)) throw new AssertionError("wrong PID");
    if (!CrashReport.firstTraceError("Signal 6\\nAbort message: actual cause password=private\\n").contains("actual cause")) throw new AssertionError("trace preview");
    String fatal = CrashReport.fatalRuntimeLines("Private model output\\nFATAL ERROR: Reached heap limit password=private\\n 1: 0xabc runtime_frame\\nAnother private output\\n");
    if (!fatal.contains("FATAL ERROR") || fatal.contains("Private model") || fatal.contains("Another private") || fatal.contains("password=private")) throw new AssertionError("fatal log isolation");
    if (!store.save("200-crash", entry.text)) throw new AssertionError("save");
    if (store.readEntry("../escape.txt") != null) throw new AssertionError("traversal");
    entry = store.readEntry("200-crash.txt");
    if (entry.text.length() > 60000 || entry.text.contains("private")) throw new AssertionError("bound/redaction");
    if (store.listEntries().get(0).text.length() > CrashReport.MAX_HEADER_BYTES) throw new AssertionError("loaded body for list");
    String expanded = entry.text.replace("\\n\\nDetails:\\n", "\\nTrace status: available\\nExtra one: a\\nExtra two: b\\nExtra three: c\\n\\nDetails:\\n");
    if (!CrashReport.parse(entry.id, expanded).summary.contains("signal 11")) throw new AssertionError("header headroom");
    String oversize = entry.text.replace("\\n\\nDetails:\\n", "\\nPadding: " + "z".repeat(CrashReport.MAX_HEADER_BYTES) + "\\n\\nDetails:\\n");
    if (!CrashReport.parse(entry.id, oversize).component.equals("unknown")) throw new AssertionError("header byte bound");
    store.saveExit("300-exit-42", entry.text.replace("\\n\\nDetails:\\n", "\\n\\nDetails:\\nNO TRACE in earlier evidence\\n"), true);
    if (store.needsExit("300-exit-42", "NO TRACE")) throw new AssertionError("same-incident earlier missing trace caused repeated decode");
    if (!store.readEntry("300-exit-42.txt").traceAvailable) throw new AssertionError("trace status not parsed");
    CrashReport.Entry routine = CrashReport.create("400-exit-20163", 400, "app", "android-process-exit", 20163, 0, "400-exit-20163", 13, "0", "Android did not supply an error message.", 0, "No earlier activity sample was available.", "No earlier memory measurement was available.", "Android process exit at Wed Oct 14 06:45:27 GMT+01:00 2026\\nProcess: com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0 PID 20163\\nReason: Android did not provide a specific cause (13)\\nStatus / signal: 0\\nDescription: SwipeUpClean\\nImportance: 400\\n");
    if (!CrashReport.isRoutineExitReport(routine) || CrashReport.isRoutineExitReport(entry)) throw new AssertionError("routine exit report detection");
    store.saveExit("400-exit-20163", routine.text, false);
    if ("400-exit-20163.txt".equals(store.newestEntry().id) || store.readEntry("400-exit-20163.txt") != null || store.readAll().contains("SwipeUpClean")) throw new AssertionError("saved routine exit was not pruned");
    File blocked = new File(args[0], "blocked");
    try { new FileOutputStream(blocked).close(); } catch (Exception e) { throw new AssertionError(e); }
    DiagnosticStore unreadable = new DiagnosticStore(blocked);
    if (!unreadable.listEntries().isEmpty() || unreadable.readError().isEmpty()) throw new AssertionError("invented empty success");
    if (!CrashReport.shouldOffer(entry, "", Set.of())) throw new AssertionError("new incident");
    if (CrashReport.shouldOffer(entry, "200-crash.txt", Set.of())) throw new AssertionError("seen boundary");
    if (CrashReport.shouldOffer(entry, "", Set.of("incident-one"))) throw new AssertionError("enrichment duplicate");
    if (!CrashReport.displayText(entry, false).contains("could not be saved")) throw new AssertionError("save failure presentation");
    System.out.println(CrashReport.displayText(entry, false));
    if (!CrashReport.parse("100-legacy.txt", "Old report").component.equals("unknown")) throw new AssertionError("legacy");
    System.out.println("passed");
} }`);
    const java = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
    execFileSync('javac', ['-d', root, java + 'CrashReport.java', java + 'DiagnosticStore.java', harness]);
    const output = execFileSync('java', ['-cp', root, 'io.github.platberlitz.neconyan.SummaryTest', root], { encoding: 'utf8' });
    if (process.env.NECONYAN_NATIVE_COPY_OUTPUT) fs.writeFileSync(process.env.NECONYAN_NATIVE_COPY_OUTPUT, 'Host fixture, not an Android screen.\n\n' + output);
    assert.match(output, /passed/);
});
