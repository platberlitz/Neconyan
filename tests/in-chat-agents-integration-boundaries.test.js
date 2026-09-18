/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { areVariablesReadOnly, withReadOnlyVariables } from '../public/scripts/variable-read-only.js';

function load(context, path, names) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const node of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
        const declaration = node.declaration ?? node;
        if (names.includes(declaration.id?.name)) vm.runInContext(source.slice(declaration.start, declaration.end), context);
    }
}

describe('read-only variable substitution', () => {
    test('all variable writers stay read-only through nested substitutions and recover after an error', () => {
        const context = vm.createContext({ areVariablesReadOnly, chat_metadata: { variables: { keep: 'old' } }, extension_settings: { variables: { global: { keep: 'old' } } }, saveMetadataDebounced: jest.fn(), saveSettingsDebounced: jest.fn(), readVariableValue: value => value, isNumericOperand: value => !Number.isNaN(Number(value)), booleanOperandToString: String });
        load(context, '../public/scripts/variables.js', ['getLocalVariable', 'getGlobalVariable', 'setLocalVariable', 'setGlobalVariable', 'addLocalVariable', 'addGlobalVariable', 'deleteLocalVariable', 'deleteGlobalVariable', 'existsLocalVariable', 'existsGlobalVariable']);
        const before = JSON.stringify([context.chat_metadata, context.extension_settings]);
        withReadOnlyVariables(() => {
            for (const method of ['setLocalVariable', 'setGlobalVariable', 'addLocalVariable', 'addGlobalVariable', 'deleteLocalVariable', 'deleteGlobalVariable']) context[method]('keep', 'changed');
            withReadOnlyVariables(() => context.setLocalVariable('nested', 'changed'));
            expect(context.getLocalVariable('keep')).toBe('old');
            expect(areVariablesReadOnly()).toBe(true);
        });
        expect(JSON.stringify([context.chat_metadata, context.extension_settings])).toBe(before);
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(() => withReadOnlyVariables(() => { throw new Error('substitution failed'); })).toThrow('substitution failed');
        expect(areVariablesReadOnly()).toBe(false);
        context.setLocalVariable('keep', 'new');
        expect(context.chat_metadata.variables.keep).toBe('new');
        context.chat_metadata = {};
        withReadOnlyVariables(() => context.getLocalVariable('absent'));
        expect(context.chat_metadata).toEqual({});
    });
});

test('a failed legacy-kit migration keeps its source and a retry skips acknowledged records', async () => {
    const saved = new Map();
    const legacy = [{ id: 'one', name: 'One', templateIds: [] }, { id: 'two', name: 'Two', templateIds: [] }];
    let fail = true;
    const context = vm.createContext({ structuredClone, legacyGroupsRetired: false, extension_settings: { inChatAgents: { groups: legacy } }, getCustomGroups: () => [...saved.values()], saveGroup: jest.fn(async group => { if (group.id === 'two' && fail) throw new Error('Write failed'); saved.set(group.id, group); }), persistExtensionState: jest.fn(() => { delete context.extension_settings.inChatAgents.groups; }) });
    load(context, '../public/scripts/extensions/in-chat-agents/index.js', ['migrateLegacyGroups', 'migrateStoredLegacyGroups']);
    await expect(context.migrateStoredLegacyGroups()).rejects.toThrow('Write failed');
    expect(context.extension_settings.inChatAgents.groups).toBe(legacy);
    expect(context.persistExtensionState).not.toHaveBeenCalled();
    fail = false;
    await context.migrateStoredLegacyGroups();
    expect(context.saveGroup.mock.calls.map(([group]) => group.id)).toEqual(['one', 'two', 'two']);
    expect(context.extension_settings.inChatAgents.groups).toBeUndefined();
});

test.each(['message', 'companion', 'composer'])('the manual picker rejects a changed %s target instead of applying to the replacement', async kind => {
    const chat = [{ mes: 'Original reply', swipe_id: 0, is_user: false }];
    const composer = { value: 'Original draft' };
    const result = { status: 'done', content: 'Original note', agentName: 'Note' };
    const selected = kind === 'message' ? 'message' : kind === 'companion' ? 'companion:note' : 'composer';
    const picker = { append() {}, find(selector) { return selector.includes('message-range') ? { val: () => '0' } : { map: () => ({ get: () => [selected] }) }; } };
    const context = vm.createContext({ chat, chatLoadRevision: 1, messageEditRevisions: new WeakMap(), getCurrentSnapshotChatId: () => 'chat-a', getChatGeneration: () => 1, getAgentPostProcessingTarget: () => null, getLastAssistantMessageIndex: () => 0, getCompanionResults: () => ({ note: result }), document: { getElementById: () => composer }, escapeHtml: String, $: () => picker, toastr: { warning: jest.fn(), info: jest.fn() }, POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1 }, Popup: class { async show() { if (kind === 'message') chat[0].swipe_id++; if (kind === 'companion') result.content = 'Changed note'; if (kind === 'composer') composer.value = 'Changed draft'; return 1; } } });
    load(context, '../public/scripts/extensions/in-chat-agents/agent-runner.js', ['captureMessageTargetState', 'isMessageTargetCurrent']);
    load(context, '../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', ['captureCompanionTarget', 'captureCompanionResultTarget']);
    load(context, '../public/scripts/extensions/in-chat-agents/index.js', ['getManualAgentRunMessageIndices', 'pickManualAgentRunTargets']);
    expect(await context.pickManualAgentRunTargets({ name: 'Agent' })).toBeNull();
    expect(context.toastr.warning).toHaveBeenCalledTimes(1);
});
