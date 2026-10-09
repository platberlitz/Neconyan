import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
const activity = read(`${app}MainActivity.java`);
const service = read(`${app}ServerService.java`);
const bootstrap = read('android/server-bootstrap.mjs');

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
    assert.match(wait, /else if \(serverSeen \|\| System\.currentTimeMillis\(\) - startedAt > 20000\) return "";/);
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
    assert.match(block(activity, 'private boolean restartAfterStop', 'private void recordServerCrash'), /worker\.execute\(this::recordServerCrash\), 20000\)/);
    const details = block(activity, 'private void copyDetails()', 'private void showSafeNotice');
    assert.match(details, /recordServerCrash\(\);\s*text\.append\("\\nCrash record:\\n"\)\.append\(tail\(new File\(getCacheDir\(\), "native-crash\.txt"\), 80\)\)/);
    assert.match(details, /"requests\.txt"/);
    assert.match(details, /"requests\.previous\.txt"/);
    assert.match(bootstrap, /process\.env\.NECONYAN_REQUEST_TRACE = path\.join\(process\.env\.TMPDIR, 'requests\.txt'\);/);
    assert.match(main, /if \(process\.env\.NECONYAN_REQUEST_TRACE\) \{\s*app\.use\(createRequestTrace\(process\.env\.NECONYAN_REQUEST_TRACE\)\);/);
    // Four-part hotfix versions such as 1.2.4.1 still produce a version code above every older release.
    assert.match(gradle, /versionCode numbers\[0\] \* 1000000 \+ numbers\[1\] \* 10000 \+ numbers\[2\] \* 100 \+ \(numbers\.size\(\) > 3 \? numbers\[3\] : 0\)/);
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
