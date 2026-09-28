import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateLegacyNamesForUser, migrateLegacySettingsNames, migrateLegacyWorldNames } from '../src/legacy-name-migration.js';

function oldSettings() {
    return {
        _version: 41,
        _settingsRevision: 7,
        accountStorage: {
            'SillyBunnyStoryMode_editHintShown': 'true',
            'SillyBunnyWorldInfoLab.history.v1': '[]',
            'sb-settings-inline-drawer:x:drawer:deep-swipe-sillybunny:0': 'open',
            'NeconyanUnrelated': 'kept',
        },
        extension_settings: {
            sillybunny_conversation: { threads: [{ id: 'a' }], automation: { mode: 'server', acknowledgement: { account: 'default-user', settingsRevision: 7 } } },
            'SillyBunny-Deep-Swipe': { enabled: true },
            'SillyBunny-Terminal-UI': { theme: 'stale' },
            'Neconyan-Terminal-UI': { theme: 'current' },
            SillyBunnyPromptingLab: { suite: 1 },
            SillyBunnyCardTimeMachine: { snapshots: 2 },
            character_attachments: { '__SillyBunny-Card-Time-Machine__': [{ name: 'tm' }], 'default_SillyBunnyGuide.png': [{ name: 'user content' }] },
            disabledExtensions: ['third-party/SillyBunny-Deep-Swipe', 'third-party/Neconyan-Deep-Swipe', 'caption'],
            'dialogue-colors': { colorData: { 'SillyBunny System': '#fff' } },
        },
    };
}

test('settings keys move to their Neconyan names and user content stays', () => {
    const settings = oldSettings();
    assert.equal(migrateLegacySettingsNames(settings), true);
    const extensions = settings.extension_settings;
    assert.deepEqual(extensions.neconyan_conversation.threads, [{ id: 'a' }]);
    assert.deepEqual(extensions['Neconyan-Deep-Swipe'], { enabled: true });
    assert.deepEqual(extensions['Neconyan-Terminal-UI'], { theme: 'current' });
    assert.deepEqual(extensions.NeconyanPromptingLab, { suite: 1 });
    assert.deepEqual(extensions.NeconyanCardTimeMachine, { snapshots: 2 });
    assert.deepEqual(extensions.character_attachments['__Neconyan-Card-Time-Machine__'], [{ name: 'tm' }]);
    assert.deepEqual(extensions.character_attachments['default_SillyBunnyGuide.png'], [{ name: 'user content' }]);
    assert.deepEqual(extensions.disabledExtensions, ['third-party/Neconyan-Deep-Swipe', 'caption']);
    assert.deepEqual(extensions['dialogue-colors'], { colorData: { 'SillyBunny System': '#fff' } });
    assert.deepEqual(settings.accountStorage, {
        'NeconyanStoryMode_editHintShown': 'true',
        'NeconyanWorldInfoLab.history.v1': '[]',
        'sb-settings-inline-drawer:x:drawer:deep-swipe-neconyan:0': 'open',
        'NeconyanUnrelated': 'kept',
    });
    for (const key of Object.keys(extensions)) assert.doesNotMatch(key, /sillybunny/i);
    assert.equal(migrateLegacySettingsNames(settings), false);
});

test('a saved account moves once and later starts leave it alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-legacy-names-'));
    try {
        const directories = { root, worlds: path.join(root, 'worlds') };
        fs.mkdirSync(path.join(root, 'characters'), { recursive: true });
        fs.mkdirSync(directories.worlds);
        fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(oldSettings(), null, 4));
        fs.writeFileSync(path.join(directories.worlds, 'Book.json'), JSON.stringify({
            extensions: { sillybunny_pathfinder: { version: 1, nodes: [] }, SillyBunnyWorldInfoLab: { testCases: [] } },
            originalData: { extensions: { SillyBunnyWorldInfoLab: { testCases: [1] } } },
            entries: { 0: { uid: 0, content: 'SillyBunny is a word in this entry', extensions: { sillybunny_pathfinder: { nodeId: 'n1' } } } },
        }));
        fs.writeFileSync(path.join(directories.worlds, 'Plain.json'), '{"entries":{}}');
        const journal = { version: 1, originalData: Buffer.from('old').toString('base64'), originalHash: 'x' };
        fs.writeFileSync(path.join(root, 'characters', 'Card.png.sillybunny-write-recovery'), JSON.stringify(journal));
        fs.writeFileSync(path.join(root, 'characters', `.sillybunny-write-12.${'a'.repeat(16)}.tmp`), 'partial');
        fs.mkdirSync(path.join(root, 'characters', `.sillybunny-chat-${'b'.repeat(64)}.lock`));
        fs.writeFileSync(path.join(root, 'characters', 'SillyBunnyGuide.png'), 'card');

        assert.deepEqual(migrateLegacyNamesForUser(directories), { settings: true, worlds: 1, files: 3 });

        const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
        assert.equal(settings._version, 42);
        assert.equal(settings._settingsRevision, 8);
        assert.equal(settings.extension_settings.neconyan_conversation.automation.acknowledgement.settingsRevision, 8);
        assert.equal(Object.hasOwn(settings.extension_settings, 'sillybunny_conversation'), false);

        const book = JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Book.json'), 'utf8'));
        assert.deepEqual(book.extensions, { neconyan_pathfinder: { version: 1, nodes: [] }, NeconyanWorldInfoLab: { testCases: [] } });
        assert.deepEqual(book.originalData.extensions, { NeconyanWorldInfoLab: { testCases: [1] } });
        assert.deepEqual(book.entries[0].extensions, { neconyan_pathfinder: { nodeId: 'n1' } });
        assert.equal(book.entries[0].content, 'SillyBunny is a word in this entry');
        assert.equal(fs.readFileSync(path.join(directories.worlds, 'Plain.json'), 'utf8'), '{"entries":{}}');

        assert.deepEqual(fs.readdirSync(path.join(root, 'characters')).sort(), ['Card.png.neconyan-write-recovery', 'SillyBunnyGuide.png']);

        const settingsBefore = fs.readFileSync(path.join(root, 'settings.json'), 'utf8');
        assert.deepEqual(migrateLegacyNamesForUser(directories), { settings: false, worlds: 0, files: 0 });
        assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), settingsBefore);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an existing Neconyan journal is not overwritten by an old one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-legacy-names-'));
    try {
        fs.writeFileSync(path.join(root, 'a.json.sillybunny-write-recovery'), 'old');
        fs.writeFileSync(path.join(root, 'a.json.neconyan-write-recovery'), 'new');
        assert.deepEqual(migrateLegacyNamesForUser({ root }), { settings: false, worlds: 0, files: 0 });
        assert.equal(fs.readFileSync(path.join(root, 'a.json.neconyan-write-recovery'), 'utf8'), 'new');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('world books without old keys are reported unchanged', () => {
    assert.equal(migrateLegacyWorldNames({ entries: { 0: { extensions: { neconyan_pathfinder: {} } } } }), false);
    assert.equal(migrateLegacyWorldNames(null), false);
});
