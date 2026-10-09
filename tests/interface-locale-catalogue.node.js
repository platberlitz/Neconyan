import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    // the In-Chat Agents bulk-edit popup, which sits inside a <template> element, and a filter label that
    // BotSearcher declares in its server folder and its client puts on the page.
    for (const caption of ['Test keys', 'Unfiled', 'All books', 'Miso, Taro and Nori', 'Close ${0}', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'rewrites reply', 'Characters, lorebooks and presets are snapshotted here, because nothing in Neconyan backs them up. Extension settings from Neconyan\'s own settings backups are available further down.', 'Scan World Info', 'Don\'t change', 'Has all of these tags']) {
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
    for (const key of ['Test keys', 'Unfiled', 'All books', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'rewrites reply', 'Snapshot everything now']) {
        assert.ok(german[key] && german[key] !== key, `missing German panel caption: ${key}`);
    }
});

test('the catalogue can be written and listed without a translator, and one language can be selected', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-catalogue-'));
    // A stand-in translator. It records every call in a trace file and answers each string with a marked
    // copy, so a call that should never happen leaves evidence and a call that should happen leaves a mark.
    const trace = join(scratch, 'translator-calls.log');
    const translator = join(scratch, 'translator.cjs');
    writeFileSync(translator, `
        const fs = require('node:fs');
        let input = '';
        process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
            const { language, strings } = JSON.parse(input);
            fs.appendFileSync(process.env.NECONYAN_TEST_TRACE, language + '\\n');
            process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(strings).map(([index, value]) => [index, value + ' [' + language + ']']))));
        });
    `);
    // The command goes through a shell on every platform, so the paths travel in the environment, unquoted.
    const env = {
        ...process.env,
        NECONYAN_TRANSLATION_COMMAND: `"${process.execPath}" -e "require(process.env.NECONYAN_TEST_TRANSLATOR)"`,
        NECONYAN_TEST_TRANSLATOR: translator,
        NECONYAN_TEST_TRACE: trace,
    };
    const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [];
    const supplements = join(scratch, 'public', 'locales', 'neconyan');
    const readSupplement = name => JSON.parse(readFileSync(join(supplements, name + '.json'), 'utf8'));
    try {
        // The builder reads public/ and default/ relative to its working directory. Copy only what it
        // reads: markup, scripts and dictionaries, minus the catalogue it is about to write.
        const wanted = source => /[\\/](lib|webfonts|img|sounds)$/.test(source) ? false
            : statSync(source).isDirectory() || (/\.(html|js|json)$/.test(source) && !/[\\/]locales[\\/]neconyan[\\/]en\.json$/.test(source));
        cpSync(join(root, 'public'), join(scratch, 'public'), { recursive: true, filter: wanted });
        cpSync(join(root, 'default', 'content', 'assistants', 'manifest.json'), join(scratch, 'default', 'content', 'assistants', 'manifest.json'));
        const script = join(root, 'scripts', 'build-interface-locales.js');

        // --write-catalogue and --list never reach the translator.
        const written = spawnSync(process.execPath, [script, '--write-catalogue'], { cwd: scratch, encoding: 'utf8', env });
        assert.equal(written.status, 0, written.stderr);
        const catalogue = readSupplement('en');
        assert.ok(Object.keys(catalogue).length > 10000);
        assert.ok(!Object.values(catalogue).some(value => value.includes('�')), 'replacement character in a catalogue value');
        assert.ok(!existsSync(join(supplements, 'en.json.tmp')), 'temporary file left behind');
        const listed = spawnSync(process.execPath, [script, '--list'], { cwd: scratch, encoding: 'utf8', env });
        assert.equal(listed.status, 0, listed.stderr);
        assert.deepEqual(JSON.parse(listed.stdout), Object.keys(catalogue).sort());
        assert.deepEqual(calls(), [], 'the translator was invoked by a catalogue-only run');

        // A bad language selection fails before any work, and without a command the builder only reports.
        const unknown = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: 'pt-br' } });
        assert.notEqual(unknown.status, 0);
        assert.match(unknown.stderr, /Unknown language pt-br/);
        const empty = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: ' , ' } });
        assert.notEqual(empty.status, 0);
        assert.match(empty.stderr, /names no language/);
        const report = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_COMMAND: '', NECONYAN_TRANSLATION_LANGS: 'pt-pt' } });
        assert.equal(report.status, 0, report.stderr);
        assert.deepEqual(JSON.parse(report.stdout).locales, ['pt-pt']);
        assert.deepEqual(calls(), [], 'the translator was invoked by a report-only run');

        // Selecting one language translates that supplement's missing keys and touches no other file.
        // Leave Portuguese exactly five keys short of the catalogue so a single batch covers them; a key
        // the base dictionary already translates does not count as missing, so take keys it lacks.
        const base = JSON.parse(readFileSync(join(scratch, 'public', 'locales', 'pt-pt.json'), 'utf8'));
        const missing = Object.keys(catalogue).filter(key => !Object.hasOwn(base, key)).slice(0, 5);
        assert.equal(missing.length, 5);
        const portuguese = Object.fromEntries(Object.entries(catalogue).filter(([key]) => !missing.includes(key)));
        writeFileSync(join(supplements, 'pt-pt.json'), JSON.stringify(portuguese, null, 2) + '\n');
        const before = Object.fromEntries(readdirSync(supplements).map(name => [name, readFileSync(join(supplements, name), 'utf8')]));
        const translated = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: 'pt-pt' } });
        assert.equal(translated.status, 0, translated.stderr);
        assert.deepEqual(calls(), ['Português (Portuguese brazil)'], `expected exactly one translator call, for Portuguese\n${translated.stdout}${translated.stderr}`);
        const after = readSupplement('pt-pt');
        for (const key of missing) assert.equal(after[key], `${catalogue[key]} [Português (Portuguese brazil)]`, `untranslated: ${key}`);
        assert.equal(Object.keys(after).length, Object.keys(catalogue).length);
        for (const name of Object.keys(before)) {
            if (name === 'pt-pt.json') continue;
            assert.equal(readFileSync(join(supplements, name), 'utf8'), before[name], `${name} changed by a Portuguese-only run`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
