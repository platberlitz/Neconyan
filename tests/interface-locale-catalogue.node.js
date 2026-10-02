import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));

test('German dictionaries have no duplicate keys that silently override reviewed translations', () => {
    for (const filename of ['de-de.json', 'neconyan/de-de.json']) {
        const text = readFileSync(new URL(`../public/locales/${filename}`, import.meta.url), 'utf8');
        const properties = parse(`(${text})`, { ecmaVersion: 'latest' }).body[0].expression.properties;
        const keys = properties.map(property => property.key.value);
        assert.equal(new Set(keys).size, keys.length, `duplicate key in ${filename}`);
    }
});

test('the interface catalogue collects captions from helpers, fallbacks, templates and arrays', () => {
    const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], { cwd: root, encoding: 'utf8', env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' } });
    assert.equal(run.status, 0, run.stderr);
    const keys = new Set(JSON.parse(run.stdout));
    // Helper argument inside an exported function, folder fallback, Home speaker, template, tab array,
    // and the In-Chat Agents bulk-edit popup, which sits inside a <template> element.
    for (const caption of ['Test keys', 'Unfiled', 'All books', 'Miso, Taro and Nori', 'Close ${0}', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'prompt rewrite', 'Characters, lorebooks and presets are snapshotted here, because nothing in Neconyan backs them up. Extension settings from Neconyan\'s own settings backups are available further down.', 'Scan World Info', 'Don\'t change']) {
        assert.ok(keys.has(caption), `missing ${caption}`);
    }
    // Developer-facing errors and identifiers never reach the page.
    for (const text of ['Server is not ready yet.', 'Could not close Meower.', 'BatchConflictError']) {
        assert.ok(!keys.has(text), `unexpected ${text}`);
    }
    // A template hole parsed as HTML becomes U+FFFD; such a key is a caption with a hole in it.
    assert.ok(![...keys].some(key => key.includes('\ufffd')), 'replacement character in the catalogue');
    const german = JSON.parse(readFileSync(new URL('../public/locales/neconyan/de-de.json', import.meta.url), 'utf8'));
    const slots = text => (text.match(/\$\{\d+\}/g) || []).sort();
    const entries = Object.entries(german);
    const panelCaptions = entries.slice(entries.findIndex(([key]) => key === 'Filter and organise'));
    assert.ok(panelCaptions.length > 70);
    for (const [key, value] of panelCaptions) {
        assert.deepEqual(slots(value), slots(key), `changed placeholders: ${key}`);
    }
    for (const key of ['Test keys', 'Unfiled', 'All books', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'prompt rewrite', 'Snapshot everything now']) {
        assert.ok(german[key] && german[key] !== key, `missing German panel caption: ${key}`);
    }
});
