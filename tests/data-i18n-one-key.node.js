import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

// The page splits a data-i18n value on ';' into separate keys (public/scripts/i18n.js, public/scripts/ui-localization.js and
// scripts/build-interface-locales.js all do), and there is no way to escape a semicolon. A caption that contains one is
// therefore looked up as two half keys that exist nowhere: it stays English in every language and each half is written
// over the whole element text. This guard finds every data-i18n value that would be cut that way.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const SKIPPED = new Set(['node_modules', 'lib', 'locales', 'webfonts']);

// Same tag test as translateElement() in public/scripts/i18n.js.
const TAGGED = /^\[([^\]]+)\](.+)$/s;
// The HTML parser's own entity decoding, so '&#10;' is a line break and is not mistaken for a semicolon.
const decode = raw => load(`<i a="${raw.replace(/"/g, '&quot;')}">`)('i').attr('a');

/**
 * The plain-text parts that make a ';' split cut a caption, or null when the value is a deliberate list of tagged keys.
 * @param {string} value A decoded data-i18n value
 * @returns {string[]|null}
 */
function cutParts(value) {
    const parts = value.split(';');
    if (parts.length < 2) return null;
    const plain = parts.map((part, index) => ({ part, index })).filter(({ part }) => part.trim() && !TAGGED.test(part));
    return plain.length > 1 || plain.some(({ index }) => index > 0) ? plain.map(({ part }) => part.trim()) : null;
}

// Legacy two-key fallbacks that are not a cut caption. The list may only shrink: every entry must still be found.
const ALLOWED = [{ file: 'scripts/templates/promptManagerListHeader.html', value: 'Tokens;prompt_manager_tokens', why: 'legacy two-key fallback' }];

function* publicFiles(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED.has(entry.name)) yield* publicFiles(path.join(directory, entry.name));
        } else if (/\.(html|js)$/.test(entry.name)) {
            yield path.join(directory, entry.name);
        }
    }
}

function scan() {
    const found = [];
    let scanned = 0;
    let multiKey = 0;
    for (const file of publicFiles(publicRoot)) {
        const text = fs.readFileSync(file, 'utf8');
        const relative = path.relative(publicRoot, file).split(path.sep).join('/');
        for (const match of text.matchAll(/data-i18n=(?:"([^"]*)"|'([^']*)')/g)) {
            const value = decode(match[1] ?? match[2]);
            scanned++;
            if (value.includes(';')) multiKey++;
            if (cutParts(value)) found.push({ file: relative, line: text.slice(0, match.index).split('\n').length, value });
        }
    }
    return { found, scanned, multiKey };
}

const result = scan();
const isAllowed = hit => ALLOWED.some(entry => entry.file === hit.file && entry.value === hit.value);

test('no data-i18n value is cut by a semicolon', () => {
    const cut = result.found.filter(hit => !isAllowed(hit));
    assert.deepEqual(
        cut.map(hit => `${hit.file}:${hit.line} ${hit.value}`),
        [],
        'A data-i18n value is split on semicolons, so a caption that contains one stays English in every language. '
        + 'Reword it with a full stop (or a comma) so that the whole sentence is one key.',
    );
});

test('every allow-list entry is still found, so the list can only shrink', () => {
    for (const entry of ALLOWED) {
        assert.ok(result.found.some(hit => hit.file === entry.file && hit.value === entry.value), `${entry.file} ${entry.value} (${entry.why}) is no longer found; remove it from the allow-list`);
    }
});

test('the rule flags a cut caption and leaves tagged lists alone', () => {
    const placeholder = decode('[placeholder]Example:&#10;[Scene: rainy rooftop at midnight; Tone: quiet and tense]');
    assert.ok(placeholder.includes('\n'));
    assert.ok(cutParts(placeholder));
    assert.ok(cutParts('Keep it short; some fail.'));
    assert.ok(cutParts('A;B'));
    assert.ok(cutParts('[title]x;Label'), 'a tag followed by plain text is ambiguous on purpose: allow-list it with a reason if one is ever legitimate');
    assert.equal(cutParts('[aria-label]Expand panel;[title]Drag panel'), null);
    assert.equal(cutParts('Text;[title]Tip'), null);
    assert.equal(cutParts('a;'), null);
    const tooltip = decode('[data-tooltip]Open checkpoint chat&#10;Shift+Click to replace the current chat');
    assert.ok(tooltip.includes('\n') && !tooltip.includes(';'));
    assert.equal(cutParts(tooltip), null);
});

test('the scan is not vacuous', () => {
    assert.ok(result.scanned > 1000, `only ${result.scanned} data-i18n values were scanned`);
    assert.ok(result.multiKey >= 1, 'no multi-key value was seen');
});
