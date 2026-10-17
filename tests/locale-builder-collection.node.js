import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));

// `--list` prints the collected keys and exits before anything is written or translated.
let collected;
function collectedKeys() {
    if (!collected) {
        const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' } });
        assert.equal(run.status, 0, run.stderr);
        collected = JSON.parse(run.stdout);
    }
    return collected;
}

// Keys with touching placeholders, like 'Group: ${0}${1}', cannot be translated safely: at run time the
// localiser cannot tell where one value ends and the next begins. The list is frozen so no new one appears; it
// only shrinks.
const adjacentPlaceholders = /\$\{\d+\}\s*\$\{\d+\}/;
const adjacentKeys = keys => keys.filter(key => adjacentPlaceholders.test(key));

// Fails, naming the key, when a collected adjacent-placeholder key is not allow-listed. Returns the allow-listed
// keys that are no longer collected, which are not a failure: the list is shrunk deliberately.
function checkAdjacentKeys(keys, allowed) {
    const unlisted = adjacentKeys(keys).filter(key => !allowed.includes(key));
    assert.deepEqual(unlisted, [], `adjacent placeholders cannot be translated safely; put a word between them:\n${unlisted.map(key => JSON.stringify(key)).join('\n')}`);
    return allowed.filter(key => !keys.includes(key));
}

const allowList = JSON.parse(readFileSync(new URL('./fixtures/adjacent-placeholder-keys.json', import.meta.url), 'utf8'));

test('the catalogue does not collect HTTP header names', () => {
    const keys = new Set(collectedKeys());
    // Header names are protocol values read with response.headers.get(...), not captions.
    for (const header of ['Content-Disposition', 'Content-Encoding', 'Content-Length', 'X-Character-Revision', 'X-Custom-Content-Type', 'X-Generation-Status', 'X-Generation-Status-Text', 'X-Neconyan-Account', 'X-Neconyan-Roleplay', 'X-World-Info-Revision']) {
        assert.ok(!keys.has(header), `header name collected as a caption: ${header}`);
    }
});

test('no catalogue key has adjacent placeholders beyond the frozen allow-list', t => {
    assert.ok(allowList.length > 0 && allowList.every(key => adjacentPlaceholders.test(key)), 'the allow-list holds only adjacent-placeholder keys');
    for (const key of checkAdjacentKeys(collectedKeys(), allowList)) t.diagnostic(`no longer collected, can leave the allow-list: ${JSON.stringify(key)}`);
});

test('the adjacent-placeholder check names a new key and tolerates a retired one', () => {
    const allowed = ['Group: ${0}${1}', 'Retired: ${0}${1}'];
    const keys = ['Group: ${0}${1}', 'Apart: ${0} of ${1}', 'Plain caption'];
    assert.deepEqual(adjacentKeys([...keys, 'Spaced: ${0} ${1}']), ['Group: ${0}${1}', 'Spaced: ${0} ${1}']);
    // An allow-listed key that is gone is reported, not failed.
    assert.deepEqual(checkAdjacentKeys(keys, allowed), ['Retired: ${0}${1}']);
    // A planted adjacent key that is not allow-listed fails, and the message names it.
    assert.throws(() => checkAdjacentKeys([...keys, 'Planted: ${0}${1}'], allowed), error => error.message.includes('"Planted: ${0}${1}"'));
    assert.throws(() => checkAdjacentKeys([...keys, 'Planted: ${0}\n${1}'], allowed), assert.AssertionError);
    assert.deepEqual(checkAdjacentKeys([...keys, 'Planted: ${0}${1}'], [...allowed, 'Planted: ${0}${1}']), ['Retired: ${0}${1}']);
});
