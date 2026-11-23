import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'default', 'config.yaml'));
const { captureConversationLorebook } = await import('../src/generation/conversation-lorebook.js');

const entry = (uid, extra) => ({
    uid, key: [], keysecondary: [], comment: `c${uid}`, content: '', constant: false, selective: false,
    order: 100, position: 0, disable: false, ...extra,
});
const messages = text => [
    { name: 'Nova', mes: 'Hello there.' },
    { name: 'User', mes: text },
];

describe('Conversation Lorebook Override scan', () => {
    let root;
    let directories;

    function plant(name, entries, settings) {
        fs.writeFileSync(path.join(directories.worlds, `${name}.json`), JSON.stringify({ entries }));
        if (settings) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ world_info_settings: settings }));
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-lorebook-'));
        directories = { root, worlds: path.join(root, 'worlds') };
        fs.mkdirSync(directories.worlds);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const scan = (text, extra = {}) => captureConversationLorebook({
        directories, name: 'Book', messages: messages(text), character: { name: 'Nova', avatar: 'nova.png' }, ...extra,
    });

    test('keyed entry loads with its key and constant entry always loads', async () => {
        plant('Book', {
            0: entry(0, { key: ['zephyr'], content: 'ZEPHYR-LORE' }),
            1: entry(1, { constant: true, content: 'CONSTANT-LORE' }),
        });
        const withKey = await scan('Tell me about the zephyr.');
        assert.equal(withKey.name, 'Book');
        assert.equal(withKey.found, true);
        assert.match(withKey.text, /ZEPHYR-LORE/);
        assert.match(withKey.text, /CONSTANT-LORE/);
        const without = await scan('Tell me about the weather.');
        assert.doesNotMatch(without.text, /ZEPHYR-LORE/);
        assert.match(without.text, /CONSTANT-LORE/);
    });

    test('selective logic, probability and disabled entries follow the book', async () => {
        plant('Book', {
            0: entry(0, { key: ['lamp'], keysecondary: ['oil'], selective: true, selectiveLogic: 0, content: 'AND-LORE' }),
            1: entry(1, { key: ['lamp'], probability: 0, useProbability: true, content: 'NEVER-LORE' }),
            2: entry(2, { key: ['lamp'], disable: true, content: 'OFF-LORE' }),
        });
        assert.equal((await scan('A lamp.')).text, '');
        const both = await scan('A lamp with oil.');
        assert.match(both.text, /AND-LORE/);
        assert.doesNotMatch(both.text, /NEVER-LORE|OFF-LORE/);
    });

    test('scan depth limits how many recent messages are read', async () => {
        plant('Book', { 0: entry(0, { key: ['zephyr'], scanDepth: 1, content: 'ZEPHYR-LORE' }) });
        const old = [{ name: 'User', mes: 'The zephyr.' }, { name: 'Nova', mes: 'Nice.' }];
        const result = await captureConversationLorebook({ directories, name: 'Book', messages: old, character: {} });
        assert.equal(result.found, true);
        assert.equal(result.text, '');
    });

    test('a missing, empty or unreadable book loads nothing and does not throw', async () => {
        assert.deepEqual(await captureConversationLorebook({ directories, name: 'Nope', messages: messages('x') }), { name: 'Nope', found: false, text: '' });
        assert.equal(await captureConversationLorebook({ directories, name: '', messages: messages('x') }), null);
        assert.equal(await captureConversationLorebook({ directories, name: undefined, messages: messages('x') }), null);
        fs.writeFileSync(path.join(directories.worlds, 'Broken.json'), '{not json');
        for (const name of ['Broken', '../escape']) {
            const result = await captureConversationLorebook({ directories, name, messages: messages('x') });
            assert.equal(result.found, false);
            assert.equal(result.text, '');
        }
    });

    test('the account budget caps what loads', async () => {
        plant('Book', {
            0: entry(0, { constant: true, order: 1, content: 'FIRST '.repeat(40) }),
            1: entry(1, { constant: true, order: 2, content: 'SECOND '.repeat(40) }),
        }, { world_info_budget: 1 });
        const result = await scan('hi', { maxContext: 1000 });
        assert.doesNotMatch(result.text, /SECOND/);
    });

    test('only the named book is read', async () => {
        plant('Book', { 0: entry(0, { constant: true, content: 'CHOSEN-LORE' }) });
        plant('Other', { 0: entry(0, { constant: true, content: 'OTHER-LORE' }) });
        const result = await scan('hi');
        assert.match(result.text, /CHOSEN-LORE/);
        assert.doesNotMatch(result.text, /OTHER-LORE/);
    });
});
