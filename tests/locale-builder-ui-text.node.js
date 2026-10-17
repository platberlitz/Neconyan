import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { uiText } from '../public/scripts/ui-text.js';

// The builder reads public/, src/ and default/ relative to its working directory, so these tests run it against a tiny
// fixture tree in a temporary folder. No real source file is read or changed.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-interface-locales.js');
const env = { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' };

const write = (scratch, file, text) => {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    writeFileSync(join(scratch, file), text);
};

function makeTree() {
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-ui-text-'));
    write(scratch, 'public/locales/lang.json', JSON.stringify([{ lang: 'xx-yy', display: 'Test language' }]));
    write(scratch, 'public/locales/xx-yy.json', '{}');
    write(scratch, 'default/content/assistants/manifest.json', JSON.stringify({ personalities: [] }));
    // Shared code in public/ may mark a message too, including where the caption rules stay quiet.
    write(scratch, 'public/scripts/page.js', [
        'export const shown = t`Page caption ${0}`;',
        'export function fail() { throw new Error(uiText(\'Public thrown message.\')); }',
        'export function unmarked() { throw new Error(\'Public unmarked error message.\'); }',
    ].join('\n'));
    write(scratch, 'src/server.js', [
        'import { uiText } from \'../public/scripts/ui-text.js\';',
        'export function fail() { throw new Error(uiText(\'Could not do the thing. Try again.\')); }',
        'export const plain = uiText(\'Plain message from the server\');',
        'export const joined = uiText(\'Joined message \' + \'from two parts.\');',
        'export const template = uiText(`Template message without holes`);',
        'export const padded = uiText(\'  Padded message  \');',
        'export const member = messages.uiText(\'Member call message\');',
        'export const variable = uiText(someVariable);',
        'export const empty = uiText();',
        'export const noLetters = uiText(\'12345\');',
        'export const otherName = uiTextOther(\'Not marked by the other name\');',
        'export const unmarked = \'A sentence in server code that is not marked.\';',
        'export const tagged = t`A tagged template in server code`;',
        'export const translated = translate(\'Server translate call\', \'server.key\');',
        'console.log(\'Server log line that is not marked\');',
        'res.send({ error: \'Server error sentence that is not marked.\' });',
    ].join('\n'));
    write(scratch, 'src/endpoints/deep/nested.js', 'export const nested = (res) => res.status(400).send({ error: uiText(\'Nested message from a deeper folder.\') });\n');
    write(scratch, 'src/node_modules/package/index.js', 'export const skipped = uiText(\'Message inside node_modules.\');\n');
    write(scratch, 'src/broken.js', 'export const = ;\n');
    return scratch;
}

const list = (scratch, extra = []) => {
    const run = spawnSync(process.execPath, [script, '--list', ...extra], { cwd: scratch, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    return { keys: new Set(JSON.parse(run.stdout)), stderr: run.stderr };
};

test('uiText returns its argument unchanged', () => {
    assert.equal(uiText('Could not save the file.'), 'Could not save the file.');
});

test('the builder collects a uiText literal from src/, even in a throw, and nothing else from those files', () => {
    const scratch = makeTree();
    try {
        const { keys, stderr } = list(scratch);
        for (const message of [
            'Could not do the thing. Try again.', 'Plain message from the server', 'Joined message from two parts.', 'Template message without holes',
            'Padded message', 'Member call message', 'Nested message from a deeper folder.',
        ]) {
            assert.ok(keys.has(message), `missing ${message}`);
        }
        // Unmarked text in the server's code is not a caption, whatever shape it has.
        for (const message of [
            'A sentence in server code that is not marked.', 'A tagged template in server code', 'Server translate call', 'server.key',
            'Server log line that is not marked', 'Server error sentence that is not marked.', 'Not marked by the other name', '12345',
            'Message inside node_modules.',
        ]) {
            assert.ok(!keys.has(message), `unexpected ${message}`);
        }
        assert.match(stderr, /Skipped src[\\/]broken\.js/, 'a server file that does not parse is reported, not silently dropped');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('the public pass keeps its own rules, and also collects a uiText literal where those rules stay quiet', () => {
    const scratch = makeTree();
    try {
        const { keys } = list(scratch);
        assert.ok(keys.has('Page caption ${0}'));
        assert.ok(keys.has('Public thrown message.'));
        assert.ok(!keys.has('Public unmarked error message.'));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});

test('the catalogue holds a uiText literal as its own English value, and a tree with no src/ still builds', () => {
    const scratch = makeTree();
    try {
        const written = spawnSync(process.execPath, [script, '--write-catalogue'], { cwd: scratch, encoding: 'utf8', env });
        assert.equal(written.status, 0, written.stderr);
        const catalogue = JSON.parse(readFileSync(join(scratch, 'public/locales/neconyan/en.json'), 'utf8'));
        assert.equal(catalogue['Could not do the thing. Try again.'], 'Could not do the thing. Try again.');
        assert.equal(catalogue['Padded message'], 'Padded message');

        rmSync(join(scratch, 'src'), { recursive: true, force: true });
        const { keys, stderr } = list(scratch);
        assert.ok(keys.has('Page caption ${0}'));
        assert.ok(!keys.has('Plain message from the server'));
        assert.equal(stderr, '');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
