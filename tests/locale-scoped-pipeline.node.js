import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assembleLocaleData } from '../public/scripts/locale-assembly.js';

// A scoped string is named by its scoped key alone. If the builder also collected its English text as an exact key, a catalogue
// refresh and a machine fill would put that text into the matching dictionary, where it changes the same words everywhere on the page.
const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts', 'build-interface-locales.js');
// The catalogue-only commands never reach a translator; keep the variable out of every child unless a test sets it for one.
const quietEnv = { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' };
delete quietEnv.NECONYAN_TRANSLATION_LANGS;

const write = (scratch, file, text) => {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, file), text);
};

function makeTree(files) {
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-scoped-literals-'));
    write(scratch, 'public/locales/lang.json', JSON.stringify([{ lang: 'xx-yy', display: 'Test language' }]));
    write(scratch, 'public/locales/xx-yy.json', '{}');
    write(scratch, 'default/content/assistants/manifest.json', JSON.stringify({ personalities: [] }));
    for (const [file, text] of Object.entries(files)) write(scratch, file, text);
    return scratch;
}

const list = (scratch) => {
    const run = spawnSync(process.execPath, [script, '--list'], { cwd: scratch, encoding: 'utf8', env: quietEnv, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    return new Set(JSON.parse(run.stdout));
};

test('a literal passed to translate() with a scoped key is collected only under that key', () => {
    const scratch = makeTree({
        'public/scripts/page.js': [
            'export const kept = translate(\'Image kept\', \'scoped.test.RMV\');',
            'export const label = translate(\'Show only\', \'scoped.test.ONE\');',
            'export const template = translate(\'Could not insert the image: ${0}\', \'scoped.test.TWO\');',
            // Other uses of translate() keep their rules.
            'export const plain = translate(\'Plain sentence here\');',
            'export const unscoped = translate(\'Keyed sentence here\', \'not.a.scoped.key\');',
            'export const computed = translate(someText, \'scoped.test.THREE\');',
            // The same words used elsewhere without a scoped key are an ordinary caption and stay collected.
            'export const elsewhere = [\'Use a description\'];',
            'export const sameWords = translate(\'Use a description\', \'scoped.test.FOUR\');',
            'export const sentence = \'Image kept\';',
        ].join('\n'),
    });
    try {
        const keys = list(scratch);
        for (const key of ['scoped.test.RMV', 'scoped.test.ONE', 'scoped.test.TWO', 'scoped.test.FOUR']) assert.ok(keys.has(key), `scoped key not collected: ${key}`);
        assert.ok(!keys.has('Show only'), 'a scoped literal also became an exact key');
        assert.ok(!keys.has('Could not insert the image: ${0}'));
        assert.ok(keys.has('Plain sentence here'), 'translate() with one argument is still collected');
        assert.ok(keys.has('Keyed sentence here') && keys.has('not.a.scoped.key'), 'an unscoped second argument keeps both');
        assert.ok(!keys.has('scoped.test.THREE') && !keys.has('someText'), 'a computed first argument is not collected, as before');
        // 'Image kept' and 'Use a description' also stand alone as sentences elsewhere, so those uses are collected as before.
        assert.ok(keys.has('Image kept'), 'the same words used elsewhere without a scoped key are still collected');
        assert.ok(keys.has('Use a description'));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('with no other use, the scoped literal is not an exact key at all', () => {
    const scratch = makeTree({ 'public/scripts/page.js': 'export const kept = translate(\'Image kept\', \'scoped.test.RMV\');\nexport const wrap = translate(\'Wrapped words\', \'scoped.test.WRAP\');' });
    try {
        const keys = list(scratch);
        assert.deepEqual([...keys].sort(), ['scoped.test.RMV', 'scoped.test.WRAP']);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('an attribute that data-i18n reaches through a scoped key is not an exact caption; other attributes and exact keys are', () => {
    const scratch = makeTree({
        'public/index.html': [
            '<html><body>',
            '<button data-i18n="[title]scoped.test.TIP" title="Hold to talk">Go</button>',
            '<input data-i18n="[placeholder]scoped.test.HOLD;[title]Exact title key" placeholder="Type something here" title="Exact title text">',
            '<input data-i18n="[aria-label]Exact aria key" aria-label="Exact aria text">',
            '<button data-i18n="scoped.test.LABEL" title="Unrelated tooltip text">Scoped label</button>',
            '<button title="Plain tooltip text">Plain</button>',
            '</body></html>',
        ].join('\n'),
    });
    try {
        const keys = list(scratch);
        for (const key of ['scoped.test.TIP', 'scoped.test.HOLD', 'scoped.test.LABEL', 'Exact title key', 'Exact aria key']) assert.ok(keys.has(key), `not collected: ${key}`);
        assert.ok(!keys.has('Hold to talk'), 'a scoped title became an exact caption');
        assert.ok(!keys.has('Type something here'), 'a scoped placeholder became an exact caption');
        // The scoped key covers its own attribute only.
        assert.ok(keys.has('Unrelated tooltip text'), 'a title the scoped label does not cover is still collected');
        assert.ok(keys.has('Plain tooltip text'));
        assert.ok(keys.has('Exact title text') && keys.has('Exact aria text'), 'attributes under exact keys are collected as before');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('the real tree no longer collects the four scoped English texts, and still collects every scoped key', () => {
    const run = spawnSync(process.execPath, [script, '--list'], { cwd: root, encoding: 'utf8', env: quietEnv, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    const keys = new Set(JSON.parse(run.stdout));
    const catalogue = JSON.parse(readFileSync(join(root, 'public/locales/neconyan/en.json'), 'utf8'));
    const scoped = Object.entries(catalogue).filter(([key]) => key.startsWith('scoped.'));
    assert.equal(scoped.length, 52);
    for (const [key, english] of scoped) {
        assert.ok(keys.has(key), `scoped key not collected: ${key}`);
        // No other use of these words sits outside a scoped key today, so none of them is an exact key.
        assert.ok(!keys.has(english), `the English of ${key} is also an exact key`);
    }
    for (const text of ['Image kept', 'Show only', 'Send the image', 'Use a description']) assert.ok(!keys.has(text), text);
});

// --- The whole pipeline: catalogue, simulated machine fill, assembly ---------------------------------------------------

const hashFolder = folder => {
    const rows = [];
    const walk = directory => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) walk(file); else rows.push(`${relative(folder, file).replaceAll('\\', '/')} ${createHash('sha256').update(readFileSync(file)).digest('hex')}`);
        }
    };
    walk(folder);
    return rows.sort();
};

test('after a catalogue write and a simulated machine fill, no scoped string reaches the matching dictionary', { timeout: 600000 }, () => {
    const worktreeLocales = join(root, 'public', 'locales');
    const hashesBefore = hashFolder(worktreeLocales);
    const environmentBefore = process.env.NECONYAN_TRANSLATION_COMMAND;
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-scoped-pipeline-'));
    try {
        // 1. Copy public/ and src/ (what the builder reads), minus the vendored libraries and media.
        const wanted = source => /[\\/](lib|webfonts|img|sounds)$/.test(source) ? false
            : statSync(source).isDirectory() || /\.(html|js|json)$/.test(source);
        cpSync(join(root, 'public'), join(scratch, 'public'), { recursive: true, filter: wanted });
        cpSync(join(root, 'src'), join(scratch, 'src'), { recursive: true, filter: source => !/[\\/]node_modules$/.test(source) });
        cpSync(join(root, 'default', 'content', 'assistants', 'manifest.json'), join(scratch, 'default', 'content', 'assistants', 'manifest.json'));
        rmSync(join(scratch, 'public', 'locales', 'neconyan', 'en.json'));

        // 2. Write the catalogue there.
        const written = spawnSync(process.execPath, [script, '--write-catalogue'], { cwd: scratch, encoding: 'utf8', env: quietEnv });
        assert.equal(written.status, 0, written.stderr);
        const catalogue = JSON.parse(readFileSync(join(scratch, 'public', 'locales', 'neconyan', 'en.json'), 'utf8'));
        const scopedKeys = Object.keys(catalogue).filter(key => key.startsWith('scoped.'));
        // E1's seven plus 44 review-dialog keys (E2-D 43 and CNV-28), plus the Nano reasoning label.
        assert.equal(scopedKeys.length, 52, 'the freshly written catalogue holds 51 image keys and the Nano reasoning key');

        // 2b. The scratch copies of the pt-pt files may already hold translated scoped entries (the real ones, once they are translated).
        //     Remove them from the scratch copies only, so the fill below makes them and the exact XX: checks stay; keep what else the
        //     supplement held, to check the fill leaves it alone.
        const scratchLocale = file => join(scratch, 'public', 'locales', file);
        for (const file of ['pt-pt.json', 'neconyan/pt-pt.json']) {
            const table = JSON.parse(readFileSync(scratchLocale(file), 'utf8'));
            writeFileSync(scratchLocale(file), `${JSON.stringify(Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('scoped.'))), null, 2)}\n`);
        }
        const supplementBeforeFill = JSON.parse(readFileSync(scratchLocale('neconyan/pt-pt.json'), 'utf8'));

        // 3. Fill pt-pt with a stand-in translator. The command is set for that child process only.
        const translator = join(scratch, 'fake-translator.cjs');
        writeFileSync(translator, [
            'let input = \'\';',
            'process.stdin.on(\'data\', chunk => { input += chunk; }).on(\'end\', () => {',
            '    const { strings } = JSON.parse(input);',
            '    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(strings).map(([index, value]) => [index, \'XX:\' + value]))));',
            '});',
        ].join('\n'));
        const fill = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: {
            ...process.env, NECONYAN_TRANSLATION_COMMAND: `"${process.execPath}" "${translator}"`, NECONYAN_TRANSLATION_LANGS: 'pt-pt',
        } });
        assert.equal(fill.status, 0, fill.stderr + fill.stdout);
        assert.equal(process.env.NECONYAN_TRANSLATION_COMMAND, environmentBefore, 'the variable was set for the child process only');

        // 4. Assemble the filled pt-pt files exactly as the page does.
        const read = file => JSON.parse(readFileSync(join(scratch, 'public', 'locales', file), 'utf8'));
        const filledCatalogue = read('neconyan/en.json');
        const supplement = read('neconyan/pt-pt.json');
        const base = read('pt-pt.json');
        const { dictionary, scoped } = assembleLocaleData({ base, supplement, catalogue: filledCatalogue });
        const scopedEntries = Object.entries(filledCatalogue).filter(([key]) => key.startsWith('scoped.'));
        assert.equal(scopedEntries.length, 52);
        // An entry that held a translation keeps it. An empty entry counts as not translated yet, and the fill is meant to complete it.
        const translatedBeforeFill = Object.entries(supplementBeforeFill).filter(([, value]) => value !== '');
        assert.ok(translatedBeforeFill.length > 0, 'the supplement held no translation before the fill, so the check below would prove nothing');
        for (const [key, value] of translatedBeforeFill) assert.equal(supplement[key], value, `the fill changed the existing supplement entry ${key}`);

        // 5. The scoped strings are filled, in the scoped table only, and leave nothing behind in the matching dictionary.
        for (const [key, english] of scopedEntries) {
            assert.equal(supplement[key], `XX:${english}`, `the machine fill did not reach ${key}`);
            assert.equal(scoped[key], `XX:${english}`, `the scoped table lacks ${key}`);
            assert.ok(!Object.hasOwn(dictionary, key), `${key} is in the matching dictionary`);
            assert.ok(!Object.hasOwn(dictionary, english), `the English of ${key} is a key of the matching dictionary: ${english}`);
        }
        for (const text of ['Image kept', 'Show only', 'Send the image', 'Use a description', 'Review chat images']) {
            assert.ok(!Object.hasOwn(dictionary, text), `the matching dictionary holds the key: ${text}`);
            assert.ok(!Object.hasOwn(supplement, text), `the supplement holds the key: ${text}`);
        }
        assert.deepEqual(Object.keys(scoped).filter(key => !key.startsWith('scoped.')), []);
        // No alias: the scoped strings change nothing in the matching dictionary. The same assembly without them gives the same keys and values.
        const without = assembleLocaleData({
            base,
            supplement: Object.fromEntries(Object.entries(supplement).filter(([key]) => !key.startsWith('scoped.'))),
            catalogue: Object.fromEntries(Object.entries(filledCatalogue).filter(([key]) => !key.startsWith('scoped.'))),
        });
        assert.deepEqual(Object.keys(dictionary), Object.keys(without.dictionary));
        assert.deepEqual(dictionary, without.dictionary);
        assert.deepEqual(without.scoped, {});
        // The fill really ran for the scoped strings, so the check above is not an empty pass.
        assert.ok(Object.values(supplement).some(value => String(value).startsWith('XX:')));
        // And the catalogue the builder wrote holds no exact key for them, which is where a leak would start.
        for (const text of ['Image kept', 'Show only', 'Send the image', 'Use a description']) {
            assert.ok(!Object.hasOwn(catalogue, text), `the fresh catalogue holds the exact key: ${text}`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    // The worktree's own locale files were never written.
    assert.deepEqual(hashFolder(worktreeLocales), hashesBefore, 'a file under public/locales changed');
    assert.equal(existsSync(join(root, 'public', 'locales', 'neconyan', 'en.json.tmp')), false);
});
