/* eslint playwright/expect-expect: off -- Node assertions exercise the settings route. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { router } = await import('../src/endpoints/settings.js');
const get = router.stack.find(layer => layer.route?.path === '/get').route.stack[0].handle;

test('settings-only reads return the latest disk contents without opening any catalogues', t => {
    const f = fixture(t);
    const file = path.join(f.scope.directories.root, 'settings.json');
    let result;
    const response = { send: body => { result = body; }, sendStatus: status => assert.fail(`Unexpected status ${status}`) };
    // Only root is supplied. Reading any preset/agent directory would fail.
    const request = { body: { settingsOnly: true }, user: { directories: { root: f.scope.directories.root } } };
    for (const version of [1, 2]) {
        const source = JSON.stringify({ _version: version, extension_settings: { example: { lastCommit: String(version) } } });
        fs.writeFileSync(file, source);
        get(request, response);
        assert.deepEqual(result, { settings: source });
    }
});

function catalogueRequest(t, body) {
    const f = fixture(t);
    const directories = { ...f.scope.directories };
    for (const key of ['novelAI_Settings', 'openAI_Settings', 'textGen_Settings', 'koboldAI_Settings', 'worlds', 'themes',
        'movingUI', 'quickreplies', 'instruct', 'context', 'sysprompt', 'reasoning', 'inChatAgents']) {
        directories[key] = path.join(directories.root, key);
        fs.mkdirSync(directories[key], { recursive: true });
    }
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ _version: 3 }));
    fs.writeFileSync(path.join(directories.openAI_Settings, 'Default.json'), JSON.stringify({ temperature: 1 }));
    fs.writeFileSync(path.join(directories.worlds, 'Atlas.json'), JSON.stringify({ entries: {} }));
    fs.writeFileSync(path.join(directories.quickreplies, 'Set.json'), JSON.stringify({ name: 'Set', version: 2, qrList: [] }));
    fs.writeFileSync(path.join(directories.instruct, 'Plain.json'), JSON.stringify({ name: 'Plain' }));
    return { body, user: { directories, profile: { handle: f.scope.owner ?? 'fixture' } } };
}

function call(request) {
    let result;
    let status = 200;
    get(request, {
        send: body => { result = body; },
        status: code => { status = code; return { send: body => { result = body; } }; },
        sendStatus: code => { status = code; },
    });
    return { result, status };
}

test('named sections return exactly the matching parts of the full bootstrap', t => {
    const full = call(catalogueRequest(t, {})).result;
    assert.equal(full.world_names[0], 'Atlas');
    const expected = {
        settings: ['settings'],
        presets: ['novelai_settings', 'novelai_setting_names', 'openai_settings', 'openai_setting_names',
            'textgenerationwebui_presets', 'textgenerationwebui_preset_names', 'koboldai_settings', 'koboldai_setting_names',
            'instruct', 'context', 'sysprompt', 'reasoning'],
        worlds: ['world_names'],
        quickReplies: ['quickReplyPresets'],
        agents: ['inChatAgents', 'inChatAgentLoadErrors', 'inChatAgentRevisions', 'inChatAgentAccount'],
    };
    for (const [section, keys] of Object.entries(expected)) {
        const { result, status } = call(catalogueRequest(t, { sections: [section] }));
        assert.equal(status, 200);
        assert.deepEqual(Object.keys(result).sort(), [...keys].sort(), section);
        for (const key of keys) assert.deepEqual(result[key], full[key], `${section}.${key}`);
    }
});

test('extension reads return only the named blocks from the latest file', t => {
    const request = catalogueRequest(t, { extensionSettings: ['dialogue-colors', 'absent'] });
    const file = path.join(request.user.directories.root, 'settings.json');
    for (const version of [1, 2]) {
        fs.writeFileSync(file, JSON.stringify({
            _version: version,
            chatroom_prompt: 'x'.repeat(1000),
            extension_settings: { 'dialogue-colors': { sequence: version }, other: { big: 'y'.repeat(1000) } },
        }));
        assert.deepEqual(call(request), { status: 200, result: { extension_settings: { 'dialogue-colors': { sequence: version } } } });
    }
    fs.writeFileSync(file, JSON.stringify({ _version: 3 }));
    assert.deepEqual(call(request).result, { extension_settings: {} });
    for (const extensionSettings of [[], [''], [7]]) {
        assert.equal(call(catalogueRequest(t, { extensionSettings })).status, 400);
    }
    fs.writeFileSync(file, '{broken');
    assert.equal(call(request).status, 500);
});

test('a section request skips settings.json and rejects unknown names', t => {
    const request = catalogueRequest(t, { sections: ['worlds'] });
    fs.rmSync(path.join(request.user.directories.root, 'settings.json'));
    assert.deepEqual(call(request).result, { world_names: ['Atlas'] });
    for (const sections of [[], ['everything'], ['worlds', 'themes']]) {
        const { status, result } = call(catalogueRequest(t, { sections }));
        assert.equal(status, 400);
        assert.deepEqual(result, { error: 'unknown_settings_section' });
    }
});
