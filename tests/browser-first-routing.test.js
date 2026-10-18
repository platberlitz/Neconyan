import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { jest, expect, test } from '@jest/globals';

function sourceFunction(file, name) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const node = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(row => row.declaration ?? row).find(row => row.id?.name === name);
    return source.slice(node.start, node.end);
}

const decision = sourceFunction('../public/script.js', 'willRunNativeRoleplayWorkflow');

test.each(['normal', 'swipe', 'continue', 'regenerate'])('%s stays browser-first even in a protected chat', type => {
    const stamp = jest.fn();
    const decide = vm.runInNewContext(`(${decision})`, {
        selected_group: null, characters: [{}], this_chid: 0,
        isNeconyanAssistant: () => false, roleplayAccountStamp: stamp,
    });
    expect(decide(type)).toBe(false);
    expect(decide(type, { skipNativeRoleplay: true })).toBe(false);
    expect(stamp).not.toHaveBeenCalled();
    expect(decide(type, { skipNativeRoleplay: false })).toBe(true);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(decide(type, { skipNativeRoleplay: false, signal: { aborted: true } })).toBe(false);
    expect(decide(type, { skipNativeRoleplay: false, quiet_prompt: 'A page-only prompt' })).toBe(false);
});

const requirements = sourceFunction('../public/scripts/browser-reply-routing.js', 'requiresServerReply');
test.each([false, true])('Notebook requirements preserve chat, character and lorebook scopes: %s', async required => {
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ required }) }));
    const characters = [{ avatar: 'Nova.png', shallow: true }];
    const decide = vm.runInNewContext(`(${requirements})`, {
        this_chid: 0, characters, unshallowCharacter: async () => { characters[0].data = { extensions: { world: 'Character world' } }; },
        getCurrentChatId: () => 'Chat.jsonl', selected_group: null,
        chat_metadata: { world_info: 'Chat world' }, power_user: { persona_description_lorebook: 'Persona world' },
        selected_world_info: ['Global world'], world_info: { charLore: [{ name: 'Nova', extraBooks: ['Extra world'] }] },
        roleplayAccountStamp: () => ({ owner: 'test-owner' }), getRequestHeaders: () => ({}), fetch,
    });
    expect(await decide()).toBe(required);
    expect(fetch.mock.calls[0][1].headers['X-Neconyan-Account']).toBe('test-owner');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ scopes: [{ chat: 'Nova.png:Chat', character: 'Nova.png',
        lorebooks: ['Global world', 'Chat world', 'Persona world', 'Character world', 'Extra world'] }] });
});

const workflowDecision = sourceFunction('../public/script.js', 'nativeRoleplayWorkflowFor')
    .replace('await import(\'./scripts/browser-reply-routing.js\')', '__routing');

test.each([false, true])('automatic routing loads a workflow only when required: %s', async required => {
    const workflows = { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => ({}) };
    const load = jest.fn(async () => workflows);
    const decide = vm.runInNewContext(`(${workflowDecision})`, {
        willRunNativeRoleplayWorkflow: () => true, loadNativeRoleplayWorkflows: load,
        __routing: { requiresServerReply: async () => required }, console,
    });
    expect(await decide('normal', {})).toEqual(required ? { name: 'roleplay.reply', workflows } : null);
    expect(load).toHaveBeenCalledTimes(Number(required));
});

test('required Notebook context never silently falls back when page prompts cannot be carried', async () => {
    const decide = vm.runInNewContext(`(${workflowDecision})`, {
        willRunNativeRoleplayWorkflow: () => true,
        loadNativeRoleplayWorkflows: async () => ({ roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => null }),
        __routing: { requiresServerReply: async () => true }, console,
    });
    await expect(decide('normal', {})).rejects.toThrow('Notebook context cannot be combined');
});

test('group requirements include every selected speaker and fail closed on a refused probe', async () => {
    const fetch = jest.fn(async () => ({ ok: false }));
    const decide = vm.runInNewContext(`(${requirements})`, {
        characters: [{ avatar: 'Nova.png' }, { avatar: 'Mira.png' }], unshallowCharacter: async () => {},
        getCurrentChatId: () => 'Group chat', selected_group: 'group-id', chat_metadata: {}, power_user: {},
        selected_world_info: [], world_info: {}, roleplayAccountStamp: () => ({ owner: 'test-owner' }),
        getRequestHeaders: () => ({}), fetch,
    });
    await expect(decide([0, 1])).rejects.toThrow('Could not check the selected Notebook context');
    expect(JSON.parse(fetch.mock.calls[0][1].body).scopes).toEqual([
        { chat: 'group:Group chat', character: 'Nova.png', lorebooks: [] },
        { chat: 'group:Group chat', character: 'Mira.png', lorebooks: [] },
    ]);
});
