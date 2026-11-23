import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'default', 'config.yaml'));
const { captureConversationLorebook, conversationCharacterLorebooks } = await import('../src/generation/conversation-lorebook.js');

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

describe('Conversation Character default lorebooks', () => {
    let root;
    let directories;
    const nova = { name: 'Nova', extensions: { world: 'Main' } };

    function book(name, entries) {
        fs.writeFileSync(path.join(directories.worlds, `${name}.json`), JSON.stringify({ entries }));
    }
    function saveSettings({ charLore = [], scan, globalSelect = [] } = {}) {
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
            world_info_settings: { world_info: { charLore, globalSelect }, ...scan },
        }));
    }
    const capture = (text, extra = {}) => captureConversationLorebook({
        directories, name: '', messages: messages(text), character: nova, avatar: 'nova.png', ...extra,
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-lorebook-default-'));
        directories = { root, worlds: path.join(root, 'worlds') };
        fs.mkdirSync(directories.worlds);
        book('Main', {
            0: entry(0, { key: ['zephyr'], content: 'MAIN-KEYED' }),
            1: entry(1, { constant: true, content: 'MAIN-CONSTANT' }),
            2: entry(2, { constant: true, probability: 0, useProbability: true, content: 'MAIN-NEVER' }),
        });
        book('Extra', {
            0: entry(0, { key: ['harbour'], content: 'EXTRA-KEYED' }),
            1: entry(1, { constant: true, content: 'EXTRA-CONSTANT' }),
        });
        book('Global', { 0: entry(0, { constant: true, content: 'GLOBAL-LORE' }) });
        book('Unlinked', { 0: entry(0, { constant: true, content: 'UNLINKED-LORE' }) });
        saveSettings({ charLore: [{ name: 'nova', extraBooks: ['Extra'] }], globalSelect: ['Global'] });
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('the linked books are the main book, then extra books for that card file, without repeats', () => {
        saveSettings({ charLore: [{ name: 'nova', extraBooks: ['Extra', 'Main', 'Extra', ''] }, { name: 'other', extraBooks: ['Unlinked'] }] });
        assert.deepEqual(conversationCharacterLorebooks(directories, nova, 'nova.png'), ['Main', 'Extra']);
        assert.deepEqual(conversationCharacterLorebooks(directories, { data: { extensions: { world: 'Main' } } }, 'nova.png'), ['Main', 'Extra']);
        assert.deepEqual(conversationCharacterLorebooks(directories, {}, 'nova.png'), ['Extra', 'Main']);
        assert.deepEqual(conversationCharacterLorebooks(directories, nova, ''), ['Main']);
        assert.deepEqual(conversationCharacterLorebooks(directories, { name: 'Plain' }, 'plain.png'), []);
    });

    test('keyed and constant entries from the main and extra books load together', async () => {
        const result = await capture('The zephyr reached the harbour.');
        assert.equal(result.characterDefault, true);
        assert.equal(result.found, true);
        assert.deepEqual(result.books, ['Main', 'Extra']);
        assert.equal(result.name, 'Main, Extra');
        for (const text of ['MAIN-KEYED', 'MAIN-CONSTANT', 'EXTRA-KEYED', 'EXTRA-CONSTANT']) assert.match(result.text, new RegExp(text));
        assert.doesNotMatch(result.text, /MAIN-NEVER|GLOBAL-LORE|UNLINKED-LORE/);
        const quiet = await capture('Just the weather.');
        assert.doesNotMatch(quiet.text, /MAIN-KEYED|EXTRA-KEYED/);
        assert.match(quiet.text, /MAIN-CONSTANT/);
        assert.match(quiet.text, /EXTRA-CONSTANT/);
    });

    test('only books that added entries are named', async () => {
        book('Extra', { 0: entry(0, { key: ['harbour'], content: 'EXTRA-KEYED' }) });
        const result = await capture('Nothing keyed here.');
        assert.equal(result.name, 'Main');
        assert.deepEqual(result.books, ['Main', 'Extra']);
    });

    test('a card with no linked lorebook loads nothing', async () => {
        assert.equal(await capture('zephyr', { character: { name: 'Plain' }, avatar: 'plain.png' }), null);
    });

    test('a missing or unreadable linked book is skipped and its sibling still loads', async () => {
        saveSettings({ charLore: [{ name: 'nova', extraBooks: ['Gone', 'Broken', 'Folder', 'x'.repeat(300), 'Extra'] }] });
        fs.writeFileSync(path.join(directories.worlds, 'Broken.json'), '{not json');
        fs.mkdirSync(path.join(directories.worlds, 'Folder.json'));
        const result = await capture('harbour', { character: { name: 'Nova', extensions: { world: 'Missing' } } });
        assert.deepEqual(result.books, ['Extra']);
        assert.equal(result.name, 'Extra');
        assert.match(result.text, /EXTRA-KEYED/);
        const none = await capture('harbour', { character: { name: 'Nova', extensions: { world: 'Missing' } }, avatar: 'lonely.png' });
        assert.deepEqual(none, { name: '', books: [], found: false, text: '', characterDefault: true });
    });

    test('a named override reads only that book and a missing one never falls back', async () => {
        const chosen = await capture('zephyr harbour', { name: 'Unlinked' });
        assert.deepEqual(chosen, { name: 'Unlinked', found: true, text: 'UNLINKED-LORE' });
        assert.deepEqual(await capture('zephyr harbour', { name: 'Nope' }), { name: 'Nope', found: false, text: '' });
    });

    test('character filters match the card file name without its extension', async () => {
        book('Main', {
            0: entry(0, { constant: true, characterFilter: { names: ['nova'], isExclude: false }, content: 'FOR-NOVA' }),
            1: entry(1, { constant: true, characterFilter: { names: ['other'], isExclude: false }, content: 'FOR-OTHER' }),
        });
        const result = await capture('hi');
        assert.match(result.text, /FOR-NOVA/);
        assert.doesNotMatch(result.text, /FOR-OTHER/);
    });

    test('the account scan settings and budget apply across the linked books', async () => {
        book('Main', { 0: entry(0, { constant: true, order: 2, content: 'FIRST-LORE' }) });
        book('Extra', { 0: entry(0, { constant: true, order: 1, content: 'SECOND '.repeat(200) }) });
        saveSettings({ charLore: [{ name: 'nova', extraBooks: ['Extra'] }], scan: { world_info_budget: 5 } });
        const result = await capture('hi', { maxContext: 1000 });
        assert.match(result.text, /FIRST/);
        assert.doesNotMatch(result.text, /SECOND/);
        assert.equal(result.name, 'Main');
    });
});
