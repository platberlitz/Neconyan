import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
const activity = read(`${app}MainActivity.java`);
const service = read(`${app}ServerService.java`);
const bootstrap = read('android/server-bootstrap.mjs');

test('Java crashes are captured in both Android processes before Android terminates them', () => {
    const application = read(`${app}NeconyanApplication.java`);
    assert.match(read('android/app/src/main/AndroidManifest.xml'), /android:name="\.NeconyanApplication"/);
    assert.match(application, /Thread\.setDefaultUncaughtExceptionHandler/);
    assert.ok(application.indexOf('CrashDiagnostics.record') < application.indexOf('previous.uncaughtException'));
    assert.match(read(`${app}CrashDiagnostics.java`), /getNoBackupFilesDir/);
});

test('renderer loss is handled for both main and popup WebViews and offers an explicit restart', () => {
    assert.equal((activity.match(/onRenderProcessGone\(WebView view/g) || []).length, 2);
    const renderer = block(activity, 'private void rendererGone', '@JavascriptInterface public boolean bridgeRequiresToken');
    assert.match(renderer, /view\.destroy\(\)/);
    assert.match(renderer, /web = null/);
    assert.match(renderer, /CrashDiagnostics\.record/);
    assert.match(activity, /if \(web == null\) \{ ActivityBreadcrumbs.state\("recreating"\); recreate\(\); return; \}/);
    const restart = block(activity, 'private boolean restartAfterStop', 'private void recordServerCrash');
    assert.ok(restart.indexOf('CrashDiagnostics.serverRecovery') < restart.indexOf('stopService'));
    assert.ok(renderer.indexOf('frozenActivity') < renderer.indexOf('view.destroy'));
    assert.ok(renderer.indexOf('recordReport') < renderer.indexOf('Copy report'));
});

function block(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end} after ${start}`);
    return source.slice(from, to);
}

test('a server killed outright is detected by its process, not trusted from a stale ready marker', () => {
    const loop = block(activity, 'private void connectNow()', 'private String waitForWorkspace()');
    assert.match(loop, /!serverProcessRunning\(\)\) \{\s*clearStaleMarker\(\);/);
    const wait = block(activity, 'private String waitForWorkspace()', 'private boolean restartAfterStop');
    assert.match(wait, /else if \(serverSeen \|\| now - startedAt > 20000\) return "";/);
    assert.match(block(activity, 'private void clearStaleMarker()', 'private void show('), /if \(!serverProcessRunning\(\)\) new File\(getFilesDir\(\), "android-ready\.json"\)\.delete\(\);/);
});

test('a server that stops while starting gets one safe-mode restart, then a failure screen with a backup', () => {
    const restart = block(activity, 'private boolean restartAfterStop', 'private void startServer');
    assert.match(restart, /up >= HEALTHY_MS/);
    assert.match(restart, /else if \(!serverSafe && !autoRestarted\) \{\s*autoRestarted = true;\s*safe = true;/);
    assert.match(restart, /showFailure\(reason\);\s*return false;/);
    assert.match(block(activity, 'private void startServer', 'private boolean serverProcessRunning'), /putExtra\(ServerService\.SAFE, safe\)/);
    assert.match(activity, /addAction\("Save a backup of my data"/);
    assert.match(activity, /DataRescue\.write\(new File\(getFilesDir\(\), "data"\), output, includeKeys\)/);
});

test('a failed page load reconnects instead of leaving the WebView error page on screen', () => {
    const error = block(activity, 'public void onReceivedError', 'public void onPageFinished');
    assert.match(error, /loadFailed = true;/);
    assert.match(error, /connect\(\);/);
    assert.match(block(activity, 'public void onPageFinished', '}\n'), /loadFailed \|\| failed\) return;/);
});

test('the service passes safe mode and a memory-sized heap, and keeps the previous log', () => {
    assert.match(service, /boolean safe = intent != null && intent\.getBooleanExtra\(SAFE, false\);/);
    assert.match(service, /"--max-old-space-size=" \+ heapMegabytes\(this\)/);
    assert.match(service, /safe \? "safe" : "normal" \}/);
    assert.match(service, /"server\.previous\.log"/);
    assert.doesNotMatch(service, /--max-old-space-size=512"/);
});

test('the bootstrap accepts only normal or safe and turns safe into a safe server start', () => {
    assert.match(bootstrap, /\['normal', 'safe'\]\.includes\(mode\)/);
    assert.match(bootstrap, /if \(mode === 'safe'\) process\.env\.NECONYAN_SAFE_START = '1';/);
    assert.match(bootstrap, /safe: mode === 'safe'/);
});

test('a native crash leaves Android a crash record that the bug report details include', () => {
    const gradle = read('android/app/build.gradle');
    const main = read('src/server-main.js');
    // Node's own SIGSEGV handler would hide the crash from Android's crash dumper.
    assert.match(service, /"--disable-wasm-trap-handler", "--icu-data-dir=/);
    assert.match(service, /rotate\("requests\.txt", "requests\.previous\.txt"\);/);
    const record = block(activity, 'private void recordServerCrash()', 'private void startServer');
    assert.match(record, /info\.getTraceInputStream\(\)/);
    assert.match(record, /Tombstone\.describe\(trace\)/);
    assert.match(record, /"native-crash\.txt"/);
    assert.match(block(activity, 'private boolean restartAfterStop', 'private void recordServerCrash'), /ActivityBreadcrumbs\.execute\(this::collectCrashDetails\), 20000\)/);
    const details = block(activity, 'private void copyDetails()', 'private void showSafeNotice');
    assert.match(details, /visibleReport != null \? visibleReport : serverIncident/);
    assert.match(details, /DiagnosticStore\.redact\(text\.toString\(\)\)/);
    assert.match(details, /server\.log|server\.previous\.log/);
    assert.match(details, /native-startup\.txt|native-crash\.txt|requests\.previous\.txt/);
    assert.match(bootstrap, /process\.env\.NECONYAN_REQUEST_TRACE = path\.join\(process\.env\.TMPDIR, 'requests\.txt'\);/);
    assert.match(main, /app\.use\(createRequestTrace\(process\.env\.NECONYAN_REQUEST_TRACE\)\);/);
    // Four-part hotfix versions such as 1.2.4.1 still produce a version code above every older release.
    assert.match(gradle, /versionCode numbers\[0\] \* 1000000 \+ numbers\[1\] \* 10000 \+ numbers\[2\] \* 100 \+ \(numbers\.size\(\) > 3 \? numbers\[3\] : 0\)/);
});

test('native report presentation is early, resumed and acknowledged only after showing', () => {
    assert.ok(activity.indexOf('recoverCrashReports();') < activity.indexOf('if (!checkWebView(root))'));
    const reader = block(activity, 'private boolean showCrashReport', 'private void copyReport');
    assert.ok(reader.indexOf('crashDialog.show();') < reader.indexOf('acknowledgeReport(entry)'));
    assert.match(reader, /!resumed/);
    assert.match(reader, /setOnClickListener/);
    assert.match(activity, /Intent.ACTION_SEND/);
    assert.doesNotMatch(activity, /logMentionsMemory|phone ran out of memory/);
    const bridge = read(`${app}NeconyanDiagnostics.java`);
    assert.match(bridge, /!local \|\| nonce.isEmpty\(\) \|\| !nonce.equals\(token\)/);
    assert.match(bridge, /json.length\(\) > 4096/);
    assert.doesNotMatch(bridge, /Files\.|FileOutputStream/);
    assert.match(read(`${app}NeconyanApplication.java`), /onTrimMemory/);
    assert.match(read(`${app}NeconyanApplication.java`), /onLowMemory/);
});

test('the activity bridge admits a hidden or pagehide sample quickly', () => {
    const bridge = read(`${app}NeconyanDiagnostics.java`);
    const gate = Number(bridge.match(/now - receivedAt < (\d+)/)?.[1]);
    assert.ok(gate > 0 && gate <= 500, `the ${gate} ms gate must not drop the final pagehide sample`);
    assert.match(bridge, /json\.length\(\) > 4096/);
    assert.match(bridge, /!local \|\| nonce\.isEmpty\(\) \|\| !nonce\.equals\(token\)/);
});

test('the Android server loads full ICU data so word splitting cannot crash it', () => {
    const payload = read('scripts/build-android-payload.js');
    // The runtime's built-in English-only ICU data has no word-break rules (issue 80).
    assert.match(service, /"--icu-data-dir=" \+ new File\(runtime, "icu"\)\.getPath\(\), "--import"/);
    assert.match(payload, /release-78\.3\/icu4c-78\.3-data-bin-l\.zip/);
    assert.match(payload, /zipSha256: '982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c'/);
    assert.match(payload, /sha256: 'd5cf2a40dccbe471781ec7af85693bff542ff12f0b670c9630c4e72d60714b8b'/);
    assert.match(payload, /path\.join\(staging, 'icu', icu\.file\)/);
});

test('the server starts after the WebView check and before the WebView is built', () => {
    const check = activity.indexOf('if (!checkWebView(root)) return;');
    const connect = activity.indexOf('credentials = ServerService.credentials(this);');
    const build = activity.indexOf('web = new WebView(this);');
    assert.ok(check !== -1 && connect !== -1 && build !== -1);
    assert.ok(check < connect, 'the WebView capability check must happen before the server starts');
    assert.ok(connect < build, 'the server request must overlap WebView construction');
    // Failure and status callbacks may run before the WebView exists.
    assert.ok(activity.indexOf('status = new TextView(this);') < connect);
    assert.ok(activity.indexOf('root.addView(actions);') < connect);
});

test('an early connection marks the page load before posting and bounds duplicate suppression', () => {
    const load = block(activity, 'private void loadWorkspace()', 'private void connectNow()');
    assert.match(load, /workspaceRequested = true;\s*workspaceRequestedAt = SystemClock\.elapsedRealtime\(\);\s*runOnUiThread/);
    assert.match(load, /web == null\) \{\s*workspaceRequested = false;\s*return;\s*\}/);
    assert.match(load, /loadFailed = false;\s*web\.loadUrl\(origin\)/);
    assert.doesNotMatch(activity, /pendingPageLoad|webReady/);
    assert.match(block(activity, 'private String waitForWorkspace()', 'private boolean restartAfterStop'), /loadWorkspace\(\);/);
    assert.match(activity, /if \(failed \|\| pageLoadInProgress\(\) \|\| !connecting\.compareAndSet\(false, true\)\) return;/);
    assert.match(block(activity, 'private boolean pageLoadInProgress()', 'private void loadWorkspace()'), /workspaceRequested && SystemClock\.elapsedRealtime\(\) - workspaceRequestedAt < PAGE_LOAD_RETRY_MS/);
    assert.match(activity, /PAGE_LOAD_RETRY_MS = 30000/);
    assert.match(block(activity, 'public void onReceivedError', 'public void onPageFinished'), /workspaceRequested = false;/);
    assert.match(block(activity, 'public void onPageFinished', '}\n'), /workspaceRequested = false;/);
    assert.match(activity, /if \(web != null\) web\.setVisibility\(View\.GONE\);/);
});

test('startup polling checks the marker quickly but throttles disk and process work', () => {
    const wait = block(activity, 'private String waitForWorkspace()', 'private boolean restartAfterStop');
    assert.match(wait, /boolean marker = readyMarkerPresent\(\);/);
    assert.match(wait, /if \(marker\) logMarkerSeen\(\);/);
    assert.match(wait, /if \(now - lastProbe >= 500\) \{/);
    assert.match(wait, /else if \(serverSeen \|\| now - startedAt > 20000\) return "";/);
    assert.match(wait, /Thread\.sleep\(marker \? 500 : 100\);/);
    assert.match(wait, /ready marker is written only after the server starts listening/);
    assert.match(block(activity, 'private boolean readyMarkerPresent()', 'private void logMarkerSeen'), /new File\(getFilesDir\(\), "android-ready\.json"\)\.isFile\(\)/);
    // The comment matches the bootstrap: the marker is written on SERVER_STARTED.
    assert.match(bootstrap, /serverEvents\.once\(EVENT_NAMES\.SERVER_STARTED[\s\S]*?writeFileAtomicSync\(readyPath/);
});

test('startup status skips an unchanged UI post and still records direct changes', () => {
    const set = block(activity, 'private void setStatusText', 'private void show');
    const show = block(activity, 'private void show(String text)', 'private void showFailure');
    assert.match(set, /shownStatus = text;\s*status\.setText\(text\);/);
    assert.match(show, /String message = DiagnosticStore\.redact\(text\);/);
    const earlyReturn = show.indexOf('if (message.equals(shownStatus)) return;');
    const post = show.indexOf('runOnUiThread');
    assert.ok(earlyReturn !== -1 && post !== -1 && earlyReturn < post, 'an unchanged status must not post to the UI thread');
    assert.match(show, /shownStatus = message;\s*runOnUiThread/);
    assert.match(show, /status\.setText\(message\)/);
    assert.doesNotMatch(show, /status\.getText\(\)/);
});

test('startup duration logs cover each checkpoint without credentials or URLs', () => {
    for (const event of ['activity created', 'server requested', 'WebView built', 'ready marker seen', 'page finished']) {
        assert.match(activity, new RegExp(`logStartup\\("${event}"\\)`), event);
    }
    const calls = activity.match(/logStartup\([^\n]+\);/g) || [];
    assert.ok(calls.length >= 5);
    for (const call of calls) assert.doesNotMatch(call, /origin|password|credential|http|port|getString|getInt/i);
    const log = block(activity, 'private void logStartup', 'private void show(');
    assert.match(log, /STARTUP_LOG_TAG/);
    assert.doesNotMatch(log, /origin|password|credential|http/i);
});
