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
