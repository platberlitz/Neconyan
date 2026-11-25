import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const localesRoot = new URL('../public/locales/', import.meta.url);
const neconyanLocalesRoot = new URL('../public/locales/neconyan/', import.meta.url);
const RTL_LOCALES = new Set(['ar-sa']);
const RTL_MARKS = new Set([0x200E, 0x200F, 0x061C, 0x200C]);
const ZWJ_FOLLOWING_RE = /\p{Extended_Pictographic}/u;
const UNESCAPED_UNICODE_ESCAPE_RE = /(?<!\\)(?:\\\\)*\\u([0-9a-f]{4})/gi;

function isAlwaysBanned(cp) {
    return cp === 0x200B || cp === 0xFEFF || cp === 0x2060 || cp === 0x00AD || cp === 0x034F || cp === 0x180E
        || (cp >= 0x2028 && cp <= 0x2029)
        || (cp >= 0x202A && cp <= 0x202E)
        || (cp >= 0x2061 && cp <= 0x2069)
        || (cp >= 0x0000 && cp <= 0x0008)
        || cp === 0x000B || cp === 0x000C
        || (cp >= 0x000E && cp <= 0x001F)
        || (cp >= 0x007F && cp <= 0x009F);
}

function formatCodePoint(cp) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function isAllowedZwjPreceding(ch) {
    const cp = ch.codePointAt(0);
    return cp === 0xFE0F || (cp >= 0x1F3FB && cp <= 0x1F3FF) || ZWJ_FOLLOWING_RE.test(ch);
}

function isAllowedZwj(chars, index) {
    const prev = chars[index - 1];
    const next = chars[index + 1];
    return Boolean(prev && next && isAllowedZwjPreceding(prev) && ZWJ_FOLLOWING_RE.test(next));
}

function scanText(text, { locale, isKey, where, includeAlwaysBanned = true }) {
    const hits = [];
    const chars = [...text];
    for (let i = 0; i < chars.length; i += 1) {
        const cp = chars[i].codePointAt(0);
        if (includeAlwaysBanned && isAlwaysBanned(cp)) {
            hits.push(`${where}: banned ${formatCodePoint(cp)}`);
            continue;
        }
        if (RTL_MARKS.has(cp)) {
            if (isKey || !RTL_LOCALES.has(locale)) {
                hits.push(`${where}: disallowed RTL mark ${formatCodePoint(cp)}`);
            }
            continue;
        }
        if (cp === 0x200D && !isAllowedZwj(chars, i)) {
            hits.push(`${where}: disallowed ZWJ U+200D`);
        }
    }
    return hits;
}

function scanRawJson(raw, fileLabel) {
    const hits = [];
    const lines = raw.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const lineNumber = lineIndex + 1;
        const chars = [...line];
        for (let col = 0; col < chars.length; col += 1) {
            const cp = chars[col].codePointAt(0);
            if (lineIndex === 0 && col === 0 && cp === 0xFEFF) {
                hits.push(`${fileLabel}:1: UTF-8 BOM U+FEFF`);
                continue;
            }
            if (isAlwaysBanned(cp)) {
                hits.push(`${fileLabel}:${lineNumber}: raw banned ${formatCodePoint(cp)}`);
            }
        }
        UNESCAPED_UNICODE_ESCAPE_RE.lastIndex = 0;
        let match;
        while ((match = UNESCAPED_UNICODE_ESCAPE_RE.exec(line)) !== null) {
            const cp = Number.parseInt(match[1], 16);
            if (isAlwaysBanned(cp)) {
                hits.push(`${fileLabel}:${lineNumber}: escaped banned \\u${match[1]} (${formatCodePoint(cp)})`);
            }
        }
    }
    return hits;
}

function walkParsedJson(node, locale, fileLabel, pathLabel, hits) {
    if (typeof node === 'string') {
        for (const cp of [0x0008, 0x000C]) {
            if (node.includes(String.fromCodePoint(cp))) {
                hits.push(`${fileLabel} (${pathLabel}): banned ${formatCodePoint(cp)}`);
            }
        }
        hits.push(...scanText(node, { locale, isKey: false, where: `${fileLabel} (${pathLabel})`, includeAlwaysBanned: false }));
        return;
    }
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            walkParsedJson(node[i], locale, fileLabel, `${pathLabel}[${i}]`, hits);
        }
        return;
    }
    if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            for (const cp of [0x0008, 0x000C]) {
                if (key.includes(String.fromCodePoint(cp))) {
                    hits.push(`${fileLabel} (key ${JSON.stringify(key)}): banned ${formatCodePoint(cp)}`);
                }
            }
            hits.push(...scanText(key, { locale, isKey: true, where: `${fileLabel} (key ${JSON.stringify(key)})`, includeAlwaysBanned: false }));
            walkParsedJson(value, locale, fileLabel, JSON.stringify(key), hits);
        }
    }
}

function scanLocaleJson(raw, locale, fileLabel) {
    const hits = scanRawJson(raw, fileLabel);
    const parsed = JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
    walkParsedJson(parsed, locale, fileLabel, '$', hits);
    return hits;
}

function listLocaleJsonFiles() {
    const files = [];
    for (const [dirUrl, prefix] of [[localesRoot, 'public/locales'], [neconyanLocalesRoot, 'public/locales/neconyan']]) {
        const names = readdirSync(dirUrl).filter(name => name.endsWith('.json')).sort();
        for (const name of names) {
            files.push({
                url: new URL(name, dirUrl),
                label: `${prefix}/${name}`,
                locale: basename(name, '.json'),
            });
        }
    }
    return files;
}

test('all locale JSON files are free of banned invisible and control characters', () => {
    const files = listLocaleJsonFiles();
    assert.ok(files.length >= 38, `expected at least 38 locale JSON files, found ${files.length}`);
    const hits = [];
    for (const file of files) {
        const raw = readFileSync(file.url, 'utf8');
        hits.push(...scanLocaleJson(raw, file.locale, file.label));
    }
    assert.deepEqual(hits, []);
});

test('invisible-character checker rules handle banned chars, RTL marks, astral emoji ZWJ, escapes, and shadowed duplicates', () => {
    assert.deepEqual(scanLocaleJson('{"greeting":"Hello, world!"}', 'en', 'clean.json'), []);
    assert.equal(scanLocaleJson('{"k":"bad\u200Btext"}', 'nl-nl', 'zwsp.json').length, 1);
    assert.equal(scanLocaleJson('\uFEFF{"k":"ok"}', 'en', 'bom.json').length, 1);
    assert.equal(scanLocaleJson('{"k":"spoof\u202Etxt"}', 'en', 'rlo.json').length, 1);
    assert.equal(scanLocaleJson('{"k":"ltr\u200Emark"}', 'nl-nl', 'ltr-lrm.json').length, 1);
    assert.deepEqual(scanLocaleJson('{"k":"استخدم \u200E/emote\u200E الآن"}', 'ar-sa', 'ar-val.json'), []);
    assert.equal(scanLocaleJson('{"k\u200E":"ok"}', 'ar-sa', 'ar-key.json').length, 1);
    assert.deepEqual(scanLocaleJson('{"k":"👩\u200D💻 👩\u{1F3FD}\u200D🔬"}', 'en', 'emoji-zwj.json'), []);
    assert.equal(scanLocaleJson('{"k":"a\u200Db"}', 'en', 'stray-zwj.json').length, 1);
    assert.equal(scanLocaleJson('{"k":"bad\u200B","k":"clean"}', 'ru-ru', 'dup-literal.json').length, 1);
    assert.equal(scanLocaleJson('{"k":"bad\\u200b","k":"clean"}', 'ru-ru', 'dup-escape.json').length, 1);
    assert.deepEqual(scanLocaleJson('{"k":"literal \\\\u200b"}', 'en', 'escaped-backslash.json'), []);
});
