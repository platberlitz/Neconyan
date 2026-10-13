import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const java = new URL('../android/app/src/main/java/io/github/platberlitz/neconyan/', import.meta.url);
const read = name => readFileSync(new URL(name, java), 'utf8');

test('actual Java capability refuses missing/wrong/stale tokens and rotates cryptographic secrets', () => {
    const directory = mkdtempSync('/tmp/opencode/android-bridge-gate-');
    try {
        const harness = path.join(directory, 'BridgeGateTest.java');
        writeFileSync(harness, `package io.github.platberlitz.neconyan;
public class BridgeGateTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        BridgeCallerGate gate = new BridgeCallerGate();
        check(!gate.accepts(null)); check(!gate.accepts("")); check(!gate.accepts("a".repeat(64)));
        String first = gate.issue(); check(first.matches("[a-f0-9]{64}")); check(gate.accepts(first));
        check(!gate.accepts(first.substring(1))); check(!gate.accepts("x" + first.substring(1)));
        String second = gate.issue(); check(!first.equals(second)); check(!gate.accepts(first)); check(gate.accepts(second));
        gate.clear(); check(!gate.accepts(second)); check(!gate.accepts(null));
    }
}`);
        const source = new URL('BridgeCallerGate.java', java).pathname;
        const compile = spawnSync('javac', ['--release', '17', '-d', directory, source, harness], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stderr);
        const run = spawnSync('java', ['-cp', directory, 'io.github.platberlitz.neconyan.BridgeGateTest'], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('every native action validates the token before effects; setup is main-page-only and origin-bound', () => {
    const activity = read('MainActivity.java'), updater = read('ApkUpdater.java');
    for (const [source, name] of [[activity, 'showCrashReports'], [activity, 'beginExport'], [activity, 'appendExport'], [activity, 'finishExport'], [activity, 'cancelExport'], [updater, 'installUpdate']]) {
        const method = source.match(new RegExp(`@JavascriptInterface public (?:synchronized )?boolean ${name}\\(String token[^)]*\\) \\{\\s*if \\(!bridgeGate.accepts\\(token\\)\\) return false;`));
        assert.ok(method, `${name} must reject before work`);
    }
    assert.match(read('BridgeCallerGate.java'), /new SecureRandom/); assert.match(read('BridgeCallerGate.java'), /MessageDigest\.isEqual/);
    assert.match(activity, /onPageStarted[\s\S]*?bridgeGate\.clear\(\)/);
    assert.match(activity, /onDestroy\(\)[\s\S]*?bridgeGate\.clear\(\)/);
    assert.match(activity, /import\('\/scripts\/android-native-bridge\.js'\)[\s\S]*?JSONObject\.quote\(bridgeToken\)[\s\S]*?JSONObject\.quote\(origin\)/);
    assert.doesNotMatch(activity, /loadUrl\([^;]*bridgeToken/);
    const finished = activity.slice(activity.indexOf('public void onPageFinished('), activity.indexOf('web.setWebChromeClient('));
    // A URL mismatch (e.g. replaceState during load) must never keep the workspace hidden; only token delivery is guarded.
    assert.doesNotMatch(finished, /if \(!url\.equals\(view\.getUrl\(\)\)\) return/);
    assert.ok(finished.indexOf('web.setVisibility(View.VISIBLE)') < finished.indexOf('bridgeGate.issue()'));
    assert.match(finished, /String current = view\.getUrl\(\);\s*if \(current == null \|\| !local\(Uri\.parse\(current\)\)\) return;\s*if \(bridgeToken == null\) bridgeToken = bridgeGate\.issue\(\);/);
    assert.match(updater, /runOnUiThread\(\(\) -> \{\s*if \(!bridgeGate\.accepts\(token\)\) return/);
    assert.equal((activity.match(/token != null && !bridgeGate.accepts\(token\)/g) || []).length, 2);
});
