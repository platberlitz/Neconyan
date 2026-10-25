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

const normalizeLocation = sourceFunction('../public/scripts/browser-reply-routing.js', 'normalizeReplyGenerationLocation');
const preferServer = sourceFunction('../public/scripts/browser-reply-routing.js', 'prefersServerReplies');

function preference(powerUser) {
    return vm.runInNewContext(`(() => { ${normalizeLocation}\n${preferServer}\nreturn { prefersServerReplies }; })()`, { power_user: powerUser })
        .prefersServerReplies();
}

test.each([
    [undefined, 'browser', false],
    [null, 'browser', false],
    ['', 'browser', false],
    ['browser', 'browser', false],
    ['server', 'server', true],
    ['SERVER', 'browser', false],
    ['remote', 'browser', false],
])('reply location %p normalises to %s and prefers the server: %s', (saved, normalized, server) => {
    expect(vm.runInNewContext(`(${normalizeLocation})`, {})(saved)).toBe(normalized);
    expect(preference({ reply_generation_location: saved })).toBe(server);
    expect(preference({})).toBe(false);
});

const workflowDecision = sourceFunction('../public/script.js', 'nativeRoleplayWorkflowFor')
    .replace('await import(\'./scripts/browser-reply-routing.js\')', '__routing');

function workflowContext(workflows, routing, willRun = () => true) {
    return vm.runInNewContext(`(${workflowDecision})`, {
        willRunNativeRoleplayWorkflow: willRun, loadNativeRoleplayWorkflows: async () => workflows, __routing: routing, console,
    });
}

test.each([false, true])('browser preference routes a workflow only when Notebook context requires it: %s', async required => {
    const workflows = { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => ({}) };
    const load = jest.fn(async () => workflows);
    const decide = vm.runInNewContext(`(${workflowDecision})`, {
        willRunNativeRoleplayWorkflow: () => true, loadNativeRoleplayWorkflows: load,
        __routing: { prefersServerReplies: () => false, requiresServerReply: async () => required }, console,
    });
    expect(await decide('normal', {})).toEqual(required ? { name: 'roleplay.reply', workflows } : null);
    expect(load).toHaveBeenCalledTimes(Number(required));
});

test.each(['normal', 'swipe', 'continue', 'regenerate'])('server preference routes %s without probing Notebook requirements', async type => {
    const workflows = { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => ({}) };
    const requiresServerReply = jest.fn(async () => false);
    const decide = workflowContext(workflows, { prefersServerReplies: () => true, requiresServerReply });
    expect(await decide(type, {})).toEqual({ name: 'roleplay.reply', workflows });
    expect(requiresServerReply).not.toHaveBeenCalled();
});

test('explicit browser and background choices ignore the saved preference', async () => {
    const workflows = { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => ({}) };
    const routing = { prefersServerReplies: jest.fn(() => true), requiresServerReply: jest.fn(async () => false) };
    expect(await workflowContext(workflows, routing, () => false)('normal', { skipNativeRoleplay: true })).toBeNull();
    expect(await workflowContext(workflows, routing)('normal', { skipNativeRoleplay: false }))
        .toEqual({ name: 'roleplay.reply', workflows });
    expect(routing.prefersServerReplies).not.toHaveBeenCalled();
    expect(routing.requiresServerReply).not.toHaveBeenCalled();
});

test('server preference falls back when page prompts cannot be carried only without a Notebook requirement', async () => {
    const workflows = { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => null };
    const requiresServerReply = jest.fn(async () => false);
    expect(await workflowContext(workflows, { prefersServerReplies: () => true, requiresServerReply })('normal', {})).toBeNull();
    expect(requiresServerReply).toHaveBeenCalledTimes(1);

    const required = jest.fn(async () => true);
    await expect(workflowContext(workflows, { prefersServerReplies: () => true, requiresServerReply: required })('normal', {}))
        .rejects.toThrow('Notebook context cannot be combined');
    expect(required).toHaveBeenCalledTimes(1);
});

test('server preference falls back when the server workflow is unavailable only without a Notebook requirement', async () => {
    const requiresServerReply = jest.fn(async () => false);
    expect(await workflowContext(null, { prefersServerReplies: () => true, requiresServerReply })('normal', {})).toBeNull();
    expect(requiresServerReply).toHaveBeenCalledTimes(1);

    const required = jest.fn(async () => true);
    await expect(workflowContext(null, { prefersServerReplies: () => true, requiresServerReply: required })('normal', {}))
        .rejects.toThrow('needs a server reply');
    expect(required).toHaveBeenCalledTimes(1);
});

test('required Notebook context never silently falls back when page prompts cannot be carried', async () => {
    const decide = workflowContext(
        { roleplayWorkflowNameFor: () => 'roleplay.reply', capturePagePrompts: async () => null },
        { prefersServerReplies: () => false, requiresServerReply: async () => true });
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
