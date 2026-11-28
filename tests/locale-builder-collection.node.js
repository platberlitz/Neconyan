import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { load } from 'cheerio';

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

test('the checkpoint tooltip is collected under its full multiline key', () => {
    const key = 'Open checkpoint chat\nShift+Click to replace the existing checkpoint with a new one';
    const $ = load(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
    assert.equal($('#message_template .mes_bookmark').attr('data-tooltip'), key);
    const keys = collectedKeys();
    assert.ok(keys.includes(key));
    assert.ok(!keys.includes(`[data-tooltip]${key}`));
});

test('the Structured Prefill slot hint is collected as a complete paragraph', () => {
    const key = 'Use [[keep]] to keep the following text visible. [[end]] ends the reply at that point. [[pg]] inserts text from the starter model below.';
    const oldKey = '] keeps the following text visible. [[end]] ends the reply at that point. [[pg]] inserts text from the starter model below.';
    const $ = load(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
    const hint = $('#structured-prefill-settings summary[data-i18n="Template slots"]').parent().find('p[data-i18n]');
    assert.equal(hint.text(), key);
    assert.equal(hint.attr('data-i18n'), key);
    const keys = collectedKeys();
    assert.ok(keys.includes(key));
    assert.deepEqual(keys.filter(entry => entry.startsWith(']')), []);
    const english = JSON.parse(readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
    assert.equal(english[key], key);
    assert.ok(!Object.hasOwn(english, oldKey));
});

test('the catalogue does not collect HTTP header names', () => {
    const keys = new Set(collectedKeys());
    // Header names are protocol values read with response.headers.get(...), not captions.
    for (const header of ['Content-Disposition', 'Content-Encoding', 'Content-Length', 'X-Character-Revision', 'X-Custom-Content-Type', 'X-Generation-Status', 'X-Generation-Status-Text', 'X-Neconyan-Account', 'X-Neconyan-Roleplay', 'X-World-Info-Revision']) {
        assert.ok(!keys.has(header), `header name collected as a caption: ${header}`);
    }
});

test('no catalogue key has adjacent placeholders beyond the frozen allow-list', t => {
    assert.equal(allowList.length, 39, 'adjacent-placeholder allow-list reflects M102a retirement of Lorebook and Pawthfinder adjacent keys');
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

const builderScript = join(root, 'scripts', 'build-interface-locales.js');

function writeFixtureFile(scratch, file, text) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, file), text);
}

function makeFixtureTree(files) {
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-l10n-collect-'));
    writeFixtureFile(scratch, 'public/locales/lang.json', JSON.stringify([{ lang: 'xx-yy', display: 'Test language' }]));
    writeFixtureFile(scratch, 'public/locales/xx-yy.json', '{}');
    writeFixtureFile(scratch, 'default/content/assistants/manifest.json', JSON.stringify({ personalities: [] }));
    for (const [file, text] of Object.entries(files)) {
        writeFixtureFile(scratch, file, text);
    }
    return scratch;
}

function listFixture(scratch) {
    const run = spawnSync(process.execPath, [builderScript, '--list'], {
        cwd: scratch,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    return new Set(JSON.parse(run.stdout));
}

test('model-only assistant knowledge files are excluded while quiet-context UI strings and AutoComplete counts remain', () => {
    const keys = new Set(collectedKeys());
    const en = JSON.parse(readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
    for (const excluded of [
        'Schedules, reminders and quiet hours',
        'Memory Shard and hiding summarised messages',
        'First paws tour',
        'No matching verified section is available for this turn. Ask for the feature name or clarify the task before giving undocumented app instructions.',
    ]) {
        assert.ok(!keys.has(excluded), `model-only key leaked into --list: ${excluded}`);
        assert.ok(!Object.hasOwn(en, excluded), `model-only key leaked into en.json: ${excluded}`);
    }
    for (const retained of [
        'The account reset is complete.',
        'Connection profile reloaded',
        'Restore page-tour invitations you hid or already tried.',
        '1 match',
        '${0} matches',
    ]) {
        assert.ok(keys.has(retained), `expected UI key missing from --list: ${retained}`);
        assert.ok(Object.hasOwn(en, retained), `expected UI key missing from en.json: ${retained}`);
    }

    const scratch = makeFixtureTree({
        'public/scripts/neconyan-assistant-knowledge/sample.js': 'export const topic = { title: \'Model only topic title\', content: \'Use <tag>fragment text\' };\n',
        'public/scripts/neconyan-assistant-knowledge.js': 'export const fallback = \'\\nModel fallback sentence.\';\n',
        'public/scripts/ui.js': 'export const dialog = { title: \'Visible dialog title\' };\n',
    });
    try {
        const fixtureKeys = listFixture(scratch);
        assert.ok(!fixtureKeys.has('Model only topic title'));
        assert.ok(!fixtureKeys.has('fragment text'));
        assert.ok(!fixtureKeys.has('Model fallback sentence.'));
        assert.ok(fixtureKeys.has('Visible dialog title'));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('sortable and CSS-class placeholders are excluded while hyphenated UI placeholders and sortable error messages remain', () => {
    const keys = new Set(collectedKeys());
    const en = JSON.parse(readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
    for (const excluded of [
        'ica--agent-card-placeholder',
        'ica--cdash-row-placeholder',
        'ica--tpanel-agent-placeholder',
        'neconyan-rail-placeholder',
    ]) {
        assert.ok(!keys.has(excluded), `CSS placeholder leaked into --list: ${excluded}`);
        assert.ok(!Object.hasOwn(en, excluded), `CSS placeholder leaked into en.json: ${excluded}`);
    }
    assert.ok(keys.has('The new order could not be saved. Try again.'));
    assert.ok(Object.hasOwn(en, 'The new order could not be saved. Try again.'));

    const scratch = makeFixtureTree({
        'public/scripts/sortable-ui.js': [
            'rows.sortable({ placeholder: \'my-slot-placeholder extra-class\', stop: () => toastr.error(err || \'Sortable error message.\') });',
            'const indirect = { placeholder: \'custom--drag-placeholder\', hint: \'Sortable file parsed sentinel.\' };',
            'const inputs = [{ placeholder: \'e-mail\' }, { placeholder: \'read-only\' }, { placeholder: \'Search items...\' }];',
        ].join('\n'),
    });
    try {
        const fixtureKeys = listFixture(scratch);
        assert.ok(!fixtureKeys.has('my-slot-placeholder extra-class'));
        assert.ok(!fixtureKeys.has('custom--drag-placeholder'));
        assert.ok(fixtureKeys.has('Sortable error message.'));
        assert.ok(fixtureKeys.has('Sortable file parsed sentinel.'));
        assert.ok(fixtureKeys.has('e-mail'));
        assert.ok(fixtureKeys.has('read-only'));
        assert.ok(fixtureKeys.has('Search items...'));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('keyboard key lists are excluded while theme names and standalone labels remain', () => {
    const keys = new Set(collectedKeys());
    const en = JSON.parse(readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
    for (const excluded of ['Escape', 'End']) {
        assert.ok(!keys.has(excluded), `keyboard key leaked into --list: ${excluded}`);
        assert.ok(!Object.hasOwn(en, excluded), `keyboard key leaked into en.json: ${excluded}`);
    }
    for (const retained of ['Amber Dusk', 'Witching Hour', 'Home']) {
        assert.ok(keys.has(retained), `expected UI key missing from --list: ${retained}`);
        assert.ok(Object.hasOwn(en, retained), `expected UI key missing from en.json: ${retained}`);
    }

    const scratch = makeFixtureTree({
        'public/scripts/keys-ui.js': [
            'const NAV = new Set([\'Escape\', \'Enter\', \'ArrowDown\', \'End\']);',
            'const PAGING = [\'PageUp\', \'PageDown\', \'Home\'];',
            'const THEMES = new Set([\'Amber Dusk\', \'Witching Hour\']);',
            'const LABELS = [\'Home\', \'Help\'];',
            'export const sentinel = \'Keyboard fixture sentinel.\';',
        ].join('\n'),
    });
    try {
        const fixtureKeys = listFixture(scratch);
        for (const excluded of ['Escape', 'End', 'PageUp', 'PageDown']) {
            assert.ok(!fixtureKeys.has(excluded), `unexpected keyboard key in fixture: ${excluded}`);
        }
        for (const retained of ['Amber Dusk', 'Witching Hour', 'Home', 'Help', 'Keyboard fixture sentinel.']) {
            assert.ok(fixtureKeys.has(retained), `missing positive sentinel in fixture: ${retained}`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
