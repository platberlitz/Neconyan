import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const java = new URL('../android/app/src/main/java/io/github/platberlitz/neconyan/', import.meta.url);
const read = name => readFileSync(new URL(name, java), 'utf8');
const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

function runHarness(name, sources, body) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'android-page-console-'));
    try {
        const harness = path.join(directory, `${name}.java`);
        writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.io.*;
import java.nio.charset.StandardCharsets;
public class ${name} {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
${body}
    }
}`);
        const files = sources.map(source => new URL(source, java).pathname);
        const compile = spawnSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', directory, ...files, harness], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);
        const run = spawnSync('java', ['-cp', directory, `io.github.platberlitz.neconyan.${name}`, directory], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        return run.stdout;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('page warnings become one short, redacted line without the local origin or query strings', { skip: !hasJava }, () => {
    runHarness('PageConsoleFormatTest', ['PageConsoleLog.java', 'DiagnosticStore.java', 'CrashReport.java'], `
        check(PageConsoleLog.format("log", "Reply text the user wrote", "http://127.0.0.1:8000/script.js", 3) == null, "plain logs are dropped");
        check(PageConsoleLog.format("info", "Reply text", "", 0) == null, "info is dropped");
        check(PageConsoleLog.format("warning", " \\n second line", "", 0) == null, "an empty first line is dropped");
        String line = PageConsoleLog.format("error", "Uncaught TypeError: x is undefined\\n    at reply (http://127.0.0.1:8000/scripts/a.js:9:2)",
            "http://127.0.0.1:8000/scripts/a.js?v=12&token=abc#top", 42);
        check("error /scripts/a.js:42 Uncaught TypeError: x is undefined".equals(line), line);
        check("warning page Slow frame".equals(PageConsoleLog.format("warning", "Slow\\t\\u0007frame", null, 0)), "control characters collapse");
        String secret = PageConsoleLog.format("warning", "Request failed: Authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnopqrstu https://user:pass@example.com/v1?key=1", "", 0);
        check(!secret.contains("abcdefghijklmnop") && !secret.contains("sk-abc") && !secret.contains("user:pass") && !secret.contains("key=1"), secret);
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 400; i++) huge.append('x');
        String cut = PageConsoleLog.format("warning", huge.toString(), "", 0);
        check(cut.endsWith("…") && cut.length() == "warning page ".length() + PageConsoleLog.MAX_MESSAGE_CHARS + 1, cut);
        StringBuilder deep = new StringBuilder("https://127.0.0.1:9/");
        for (int i = 0; i < 30; i++) deep.append("folder").append(i).append('/');
        String where = PageConsoleLog.where(deep.append("x.js").toString(), 5);
        check(where.startsWith("…") && where.endsWith("x.js:5") && where.length() <= 1 + 120 + 2, where);
    `);
});

test('a page stuck in an error loop costs a few lines, and the file rotates at its size limit', { skip: !hasJava }, () => {
    runHarness('PageConsoleAdmitTest', ['PageConsoleLog.java', 'DiagnosticStore.java', 'CrashReport.java'], `
        File directory = new File(args[0]);
        PageConsoleLog log = new PageConsoleLog(directory);
        long start = 1_700_000_000_000L;
        check(log.admit(start, null) == null, "null lines are ignored");
        String first = log.admit(start, "error page boom");
        check(first != null && first.endsWith(" error page boom\\n") && !first.contains("skipped"), first);
        check(log.admit(start + 10, "error page boom") == null, "an identical line within a minute is skipped");
        int admitted = 1;
        for (int i = 0; i < 40; i++) if (log.admit(start + 20 + i, "error page loop " + i) != null) admitted++;
        check(admitted == PageConsoleLog.MAX_LINES_PER_MINUTE, "per-minute cap, got " + admitted);
        String later = log.admit(start + 61_000, "warning page later");
        check(later.contains(" 21 repeated or excess page messages skipped\\n") && later.endsWith(" warning page later\\n"), later);
        check(log.admit(start + 62_000, "warning page later2") != null && !log.admit(start + 63_000, "warning page later3").contains("skipped"), "the skipped count resets");

        StringBuilder entry = new StringBuilder();
        for (int i = 0; i < 1000; i++) entry.append('e');
        entry.append('\\n');
        for (int i = 0; i < 40; i++) log.append(entry.toString());
        File current = new File(directory, PageConsoleLog.FILE), previous = new File(directory, PageConsoleLog.PREVIOUS);
        check(previous.isFile() && previous.length() <= PageConsoleLog.MAX_FILE_BYTES, "previous " + previous.length());
        check(current.isFile() && current.length() <= PageConsoleLog.MAX_FILE_BYTES, "current " + current.length());
        check(current.length() + previous.length() == 40L * entry.length(), "no entry lost in rotation");
        log.append("");
        log.append(null);
    `);
});

test('one missed server check never reloads the workspace; three in a row do', { skip: !hasJava }, () => {
    runHarness('ServerWatchTest', ['LocalServerWatch.java'], `
        LocalServerWatch watch = new LocalServerWatch();
        check(!watch.record(false) && !watch.record(false) && watch.misses() == 2, "two misses wait");
        check(!watch.record(true) && watch.misses() == 0, "an answer forgets earlier misses");
        check(!watch.record(false) && !watch.record(false), "misses start again");
        watch.reset();
        check(!watch.record(false) && !watch.record(false) && watch.misses() == 2, "reset after the app returns");
        check(watch.record(false) && watch.misses() == 0, "the third miss in a row reconnects once");
        check(!watch.record(false), "and counting starts over");
        check(LocalServerWatch.MISSES_BEFORE_RECONNECT == 3, "three checks, five seconds apart");
    `);
});

test('the activity records page warnings off the WebView thread and keeps release logcat redacted', () => {
    const activity = read('MainActivity.java');
    const client = activity.slice(activity.indexOf('web.setWebChromeClient(new WebChromeClient() {'), activity.indexOf('web.setDownloadListener('));
    assert.match(client, /@Override public boolean onConsoleMessage\(ConsoleMessage message\) \{\s*recordPageConsole\(message\);[\s\S]*?return !BuildConfig\.DEBUG;\s*\}/);
    const record = activity.slice(activity.indexOf('private void recordPageConsole('), activity.indexOf('private void addAction(String label'));
    assert.match(record, /PageConsoleLog\.format\(name, message\.message\(\), message\.sourceId\(\), message\.lineNumber\(\)\)/);
    assert.match(record, /pageConsole\.admit\(System\.currentTimeMillis\(\), line\);\s*if \(entry == null\) return;/);
    assert.match(record, /ActivityBreadcrumbs\.execute\(\(\) -> \{\s*try \{ log\.append\(entry\); \}/);
    assert.match(record, /Log\.e\(PageConsoleLog\.LOG_TAG, line\);\s*else android\.util\.Log\.w\(PageConsoleLog\.LOG_TAG, line\);/, 'only the redacted line reaches logcat');
    assert.match(activity, /PageConsoleLog\.FILE, PageConsoleLog\.PREVIOUS, "server\.log"/, 'Copy details includes page messages');
    assert.match(read('CrashDiagnostics.java'), /"native-startup\.txt", PageConsoleLog\.FILE \}/, 'crash reports include page messages');
});

test('the watchdog asks the server itself before reloading, and the page hears the app leave and return', () => {
    const activity = read('MainActivity.java');
    const watchdog = activity.slice(activity.indexOf('private final Runnable watchdog'), activity.indexOf('private void reconnect()'));
    assert.doesNotMatch(watchdog, /!serverProcessRunning\(\)\) runOnUiThread\(MainActivity\.this::reconnect\)/, 'one process-list miss must not reload');
    assert.match(watchdog, /checkingServer\.compareAndSet\(false, true\)\s*&& !executeIfOpen\(worker, MainActivity\.this::checkLocalServer\)\) checkingServer\.set\(false\);/);
    assert.match(watchdog, /boolean reachable = serverProcessRunning\(\) \|\| localServerAnswers\(\);/);
    assert.match(watchdog, /if \(serverWatch\.record\(reachable\) && !connecting\.get\(\) && !failed\) runOnUiThread\(MainActivity\.this::reconnect\);\s*\} finally \{ checkingServer\.set\(false\); \}/);
    assert.match(watchdog, /requireServerReady\(\);[\s\S]*?new URL\(origin \+ "\/version"\)[\s\S]*?setInstanceFollowRedirects\(false\)[\s\S]*?getResponseCode\(\) > 0/);
    assert.match(activity, /private void reconnect\(\) \{\s*if \([^\n]*\) return;\s*serverWatch\.reset\(\);/);

    const resume = activity.slice(activity.indexOf('@Override public void onResume()'), activity.indexOf('@Override public void onPause()'));
    assert.match(resume, /resumed = true;\s*serverWatch\.reset\(\);\s*notifyAppLifecycle\("resumed"\);/);
    const pause = activity.slice(activity.indexOf('@Override public void onPause()'), activity.indexOf('@Override public void onStop()'));
    assert.match(pause, /notifyAppLifecycle\("paused"\);\s*super\.onPause\(\);/);
    const stop = activity.slice(activity.indexOf('@Override public void onStop()'), activity.indexOf('@Override public void onTrimMemory('));
    assert.match(stop, /notifyAppLifecycle\("stopped"\);\s*notifyMemoryLifecycle\("background"\);/);
    assert.match(activity, /private void notifyAppLifecycle\(String state\) \{\s*dispatchPageEvent\("neconyan:app-lifecycle", state\);/);
    const dispatch = activity.slice(activity.indexOf('private void dispatchPageEvent('), activity.indexOf('private void recordPageConsole('));
    assert.match(dispatch, /if \(web == null \|\| failed \|\| web\.getUrl\(\) == null \|\| !local\(Uri\.parse\(web\.getUrl\(\)\)\)\) return;/, 'only the local workspace page is told');
    assert.match(dispatch, /new CustomEvent\(" \+ JSONObject\.quote\(name\) \+ ",\{detail:\{state:"\s*\+ JSONObject\.quote\(state\) \+ "\}\}\)\)"/);
    // The handoff adds no foreground notification: the server's own stays the only one.
    assert.doesNotMatch(activity, /\bstartForeground\(/);
    assert.deepEqual(activity.match(/startForegroundService\([^;]*/g).map(call => call.includes('ServerService.class')), [true, true]);
});
