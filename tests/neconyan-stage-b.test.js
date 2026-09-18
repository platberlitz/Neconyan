/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import {
    createNeconyanFolder, moveNeconyanLorebook, normalizeNeconyanLorebookFolders,
    renameNeconyanLorebookAssignment, unfileNeconyanLorebook,
} from '../public/scripts/neconyan-lorebook-folders.js';
import { normalizeAgentSetupPreset, serializeAgentRecord } from '../public/scripts/extensions/in-chat-agents/setup-presets.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function folderRuntime() {
    const source = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
    const field = { find() { return this; }, text: () => '', remove() { return this; }, append() { return this; } };
    const context = vm.createContext({
        world_info: { unrelated: 'keep', neconyanFolders: { folders: [createNeconyanFolder('Places', 'places')], assignments: { Notes: 'places' } } },
        world_names: ['Notes'], worldInfoEditor: null, selected_world_info: [],
        structuredClone, NECONYAN_LOREBOOK_FOLDERS_KEY: 'neconyanFolders', normalizeNeconyanLorebookFolders,
        saveSettings: jest.fn(async () => true), getRequestHeaders: () => ({}),
        warnNeconyanFolderSaveFailure: jest.fn(),
        fetch: async () => ({ ok: true, json: async () => ({ world_names: ['Renamed'] }) }),
        $: () => field, Option: class {}, updatePersonaLorebookActions() {}, updateWorldInfoWorkspaceState() {},
    });
    const functions = ['getNeconyanLorebookFolders', 'updateNeconyanLorebookFolders', 'updateWorldInfoList']
        .map(name => source.match(new RegExp(`^export (?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace('export ', ''));
    vm.runInContext('let neconyanLorebookFolderSaveChain = Promise.resolve();\n' + functions.join('\n'), context);
    return context;
}

describe('Neconyan Lorebook folders', () => {
    test('exact book identities survive moves, getters, renames and reloads', async () => {
        const context = folderRuntime();
        context.world_names = ['__proto__', 'constructor', 'toString', ' Notes', 'Notes'];
        for (const name of context.world_names) {
            const result = await context.updateNeconyanLorebookFolders(metadata => moveNeconyanLorebook(metadata, name, 'places'));
            expect(Object.hasOwn(result.assignments, name)).toBe(true);
            expect(result.assignments[name]).toBe('places');
        }
        context.world_info.neconyanFolders = JSON.parse(JSON.stringify(context.world_info.neconyanFolders));
        const current = context.getNeconyanLorebookFolders();
        expect(Object.keys(current.assignments).sort()).toEqual([...context.world_names].sort());
        expect(unfileNeconyanLorebook(current, ' Notes').assignments.Notes).toBe('places');
        expect(unfileNeconyanLorebook(current, 'toString').assignments.toString).toBeUndefined();
        expect(renameNeconyanLorebookAssignment(current, 'Notes', '__proto__').assignments.__proto__).toBe('places');
        expect(renameNeconyanLorebookAssignment(current, 'Notes', 'Notes').assignments.Notes).toBe('places');
    });

    test('a queued settings save cannot resurrect a rolled-back folder change', async () => {
        const context = folderRuntime();
        const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        const saveSettings = script.match(/^export async function saveSettings\([\s\S]*?^}/m)[0].replace('export ', '');
        let release;
        let started;
        const reached = new Promise(resolve => { started = resolve; });
        const captured = [];
        context.saveSettingsInner = async () => {
            captured.push(structuredClone(context.world_info.neconyanFolders));
            if (captured.length === 1) { started(); await new Promise(resolve => { release = resolve; }); return false; }
            return true;
        };
        vm.runInContext('let settingsSaveQueue = Promise.resolve();\n' + saveSettings, context);
        const mutation = context.updateNeconyanLorebookFolders(metadata => moveNeconyanLorebook(metadata, 'Notes', ''));
        const failure = mutation.catch(error => error);
        await reached;
        const unrelatedSave = context.saveSettings(0, { returnResult: true });
        release();
        const [error] = await Promise.all([failure, unrelatedSave]);
        expect(error.message).toContain('could not be saved');
        expect(captured).toHaveLength(3);
        expect(captured[1].assignments).toEqual({});
        expect(captured[2].assignments).toEqual({ Notes: 'places' });
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({ Notes: 'places' });
    });

    test('failed compensating saves keep the prior state and expose a retry', async () => {
        const context = folderRuntime();
        context.saveSettings.mockResolvedValue(false);
        await expect(context.updateNeconyanLorebookFolders(metadata => moveNeconyanLorebook(metadata, 'Notes', ''))).rejects.toThrow('previous folder state could not be saved');
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({ Notes: 'places' });
        expect(context.warnNeconyanFolderSaveFailure).toHaveBeenCalledTimes(1);
    });

    test('normalization preserves metadata and distinguishes an empty library from no filter', () => {
        const source = { unknown: { keep: true }, folders: [createNeconyanFolder('Places', 'places')], assignments: { Notes: 'places' } };
        expect(normalizeNeconyanLorebookFolders(source).assignments).toEqual({ Notes: 'places' });
        expect(normalizeNeconyanLorebookFolders(source, []).assignments).toEqual({});
        expect(unfileNeconyanLorebook(source, 'Notes').unknown).toEqual({ keep: true });
    });

    test('refreshing renamed book names keeps the folder until reconciliation saves it', async () => {
        const context = folderRuntime();
        await context.updateWorldInfoList();
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({ Notes: 'places' });
        await context.updateNeconyanLorebookFolders(metadata => renameNeconyanLorebookAssignment(metadata, 'Notes', 'Renamed'));
        expect(context.world_info.neconyanFolders.assignments).toEqual({ Renamed: 'places' });
        expect(context.world_info.unrelated).toBe('keep');
        expect(context.saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
    });

    test('failed folder moves roll back and retry, while committed book renames retain a retryable mapping', async () => {
        const context = folderRuntime();
        context.saveSettings.mockResolvedValueOnce(false);
        await expect(context.updateNeconyanLorebookFolders(metadata => moveNeconyanLorebook(metadata, 'Notes', ''))).rejects.toThrow('could not be saved');
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({ Notes: 'places' });
        await context.updateNeconyanLorebookFolders(metadata => moveNeconyanLorebook(metadata, 'Notes', ''));
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({});
        context.world_info.neconyanFolders.assignments = { Notes: 'places' };
        context.world_names = ['Renamed'];
        context.saveSettings.mockResolvedValueOnce(false);
        await expect(context.updateNeconyanLorebookFolders(metadata => renameNeconyanLorebookAssignment(metadata, 'Notes', 'Renamed'), { retainOnFailure: true })).rejects.toThrow();
        expect(context.getNeconyanLorebookFolders().assignments).toEqual({ Renamed: 'places' });
    });
});

async function storeRuntime({ loaded = true } = {}) {
    jest.resetModules();
    const settingsSave = jest.fn(async () => true);
    const extensionSettings = {};
    let uuid = 0;
    jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}), saveSettingsDebounced() {}, saveSettings: settingsSave }));
    jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: extensionSettings, getContext: () => ({ groupId: null }) }));
    jest.unstable_mockModule('../public/scripts/utils.js', () => ({ regexFromString: value => new RegExp(String(value ?? '')), uuidv4: () => `uuid-${++uuid}` }));
    const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
    const initial = [
        { id: 'a', name: 'A', prompt: 'old A', enabled: true, settings: { apiKey: 'test-only', secretId: 'reference' }, toolSchema: { properties: { password: { type: 'string' } } }, companion: { futureOption: { keep: true }, feedback: { futureOption: true } }, tools: [{ name: 'test', futureHandler: 'keep', parameters: { type: 'object', properties: { password: { type: 'string' } } } }] },
        { id: 'extra', name: 'Extra', prompt: 'keep extra', enabled: true, unknown: { keep: true } },
    ];
    if (loaded) store.loadAgents(initial);
    const agents = new Map(initial.map(agent => [agent.id, structuredClone(agent)]));
    const presets = new Map();
    const writes = [];
    const state = { hook: async () => {} };
    globalThis.fetch = jest.fn(async (url, options) => {
        const payload = JSON.parse(options.body);
        if (url.endsWith('/api/settings/get')) return { ok: true, json: async () => ({ inChatAgents: [...agents.values()] }) };
        if (url.endsWith('/presets/save')) { presets.set(payload.id, structuredClone(payload)); return { ok: true, json: async () => payload }; }
        if (url.endsWith('/presets/list')) return { ok: true, json: async () => [...presets.values()] };
        if (url.endsWith('/presets/delete')) { presets.delete(payload.id); return { ok: true }; }
        writes.push({ url, payload: structuredClone(payload) });
        await state.hook(url, payload);
        const current = agents.get(payload.id);
        const revision = current ? createHash('sha256').update(serializeAgentRecord(current)).digest('hex') : 'missing';
        if (options.headers['If-Match'] !== revision) return { ok: false, status: 409, json: async () => ({ error: 'Concurrent record change.' }) };
        if (url.endsWith('/save')) agents.set(payload.id, structuredClone(payload));
        else if (url.endsWith('/delete')) agents.delete(payload.id);
        else throw new Error(`Unexpected URL: ${url}`);
        return { ok: true };
    });
    const preset = { id: 'scene', name: 'Scene', version: 1, agents: [{ id: 'a', name: 'A', prompt: 'new A', enabled: true }, { id: 'b', name: 'B', prompt: 'new B', enabled: false }], globalSettings: {} };
    return { store, agents, presets, writes, state, preset, initial, settingsSave, extensionSettings };
}

describe('Agent setup apply and recovery', () => {
    test('scoped enable changes commit with settings and preserve the other scope', async () => {
        const runtime = await storeRuntime();
        runtime.store.setGlobalSettings({ separateRecentChats: true, scopedEnabledAgentIdsInitialized: true, enabledAgentIdsByChatType: { individual: ['a'], group: ['a', 'extra'] } });
        await runtime.store.saveAgentEnabledState(['a'], false, 'individual');
        expect(runtime.store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({ individual: [], group: ['a', 'extra'] });
        expect(runtime.store.getAgentById('a').enabled).toBe(true);
        await runtime.store.saveAgentEnabledState(['a'], false, 'group');
        expect(runtime.store.getAgentById('a').enabled).toBe(false);
        expect(runtime.agents.get('a').enabled).toBe(false);
        expect(runtime.presets.size).toBe(0);
    });

    test('a declined enabled-scope settings save restores both records and switches', async () => {
        const runtime = await storeRuntime();
        runtime.store.setGlobalSettings({ separateRecentChats: true, scopedEnabledAgentIdsInitialized: true, enabledAgentIdsByChatType: { individual: ['a', 'extra'], group: [] } });
        const before = structuredClone(runtime.store.getGlobalSettings());
        runtime.settingsSave.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
        await expect(runtime.store.saveAgentEnabledState(['a'], false, 'individual')).rejects.toThrow();
        expect(runtime.store.getGlobalSettings()).toEqual(before);
        expect(runtime.store.getAgentById('a').enabled).toBe(true);
        expect(runtime.agents.get('a')).toEqual(runtime.initial[0]);
        expect(runtime.presets.size).toBe(0);
    });

    test('a failed middle deletion restores the earlier deleted record', async () => {
        const runtime = await storeRuntime();
        runtime.state.hook = async (url, payload) => {
            if (url.endsWith('/delete') && payload.id === 'extra') throw new Error('Deletion failed');
        };
        await expect(runtime.store.deleteAgentBatch(['a', 'extra'])).rejects.toThrow('Deletion failed');
        expect([...runtime.agents.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(runtime.initial);
        expect(runtime.store.getAgents().map(agent => agent.id)).toEqual(['a', 'extra']);
        expect(runtime.presets.size).toBe(0);
    });

    test('batch deletion preserves a record changed by another client', async () => {
        const runtime = await storeRuntime();
        runtime.agents.get('a').prompt = 'External correction';
        await expect(runtime.store.deleteAgentBatch(['a'])).rejects.toThrow('changed');
        expect(runtime.agents.get('a').prompt).toBe('External correction');
        expect(runtime.writes).toHaveLength(0);
    });

    test('an unloaded library cannot overwrite a setup or seed empty enabled scopes', async () => {
        const runtime = await storeRuntime({ loaded: false });
        expect(runtime.store.areAgentsLoaded()).toBe(false);
        await runtime.store.loadAgentSetupPresets();
        await expect(runtime.store.saveAgentSetupPreset('Scene', { id: 'scene' })).rejects.toThrow('finish loading');
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset)).rejects.toThrow('finish loading');
        expect(runtime.store.initializeScopedAgentEnableState()).toBe(false);
        expect(runtime.store.getGlobalSettings().scopedEnabledAgentIdsInitialized).toBe(false);
        expect(runtime.presets.size).toBe(0);
        expect(runtime.writes).toEqual([]);
        runtime.store.loadAgents(runtime.initial);
        const saved = await runtime.store.saveAgentSetupPreset('Scene', { id: 'scene' });
        expect(saved.agents.map(agent => agent.id)).toEqual(['a', 'extra']);
    });

    test('round trip preserves arbitrary field names and rejects ambiguous identifiers', async () => {
        const runtime = await storeRuntime();
        const saved = await runtime.store.saveAgentSetupPreset('One', { id: 'one' });
        expect(saved.agents[0]).toMatchObject({ settings: { apiKey: 'test-only', secretId: 'reference' }, toolSchema: { properties: { password: { type: 'string' } } } });
        expect(normalizeAgentSetupPreset({ ...saved, agents: [saved.agents[0], saved.agents[0]] })).toBeNull();
        expect(normalizeAgentSetupPreset({ ...saved, id: '../outside' })).toBeNull();
        await runtime.store.loadAgentSetupPresets();
        expect(runtime.store.getAgentSetupPresets()).toHaveLength(1);
        await runtime.store.deleteAgentSetupPreset('one');
        expect(runtime.presets.size).toBe(0);
        expect(runtime.agents.size).toBe(2);
    });

    test('load is repeatable, preserves unknown live fields, and pauses extra agents without deleting them', async () => {
        const runtime = await storeRuntime();
        const confirmExtras = jest.fn(async () => true);
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset, { confirmExtras })).resolves.toBe(true);
        expect(confirmExtras.mock.calls[0][0].map(agent => agent.id)).toEqual(['extra']);
        expect(runtime.agents.get('a')).toMatchObject({ prompt: 'new A', settings: { apiKey: 'test-only', secretId: 'reference' } });
        expect(runtime.agents.get('a')).toMatchObject({ companion: { futureOption: { keep: true }, feedback: { futureOption: true } }, tools: [{ futureHandler: 'keep', parameters: { properties: { password: { type: 'string' } } } }] });
        expect(runtime.agents.get('extra')).toMatchObject({ enabled: false, unknown: { keep: true } });
        expect(runtime.store.isAgentSetupCurrent(runtime.preset)).toBe(true);
        await runtime.store.applyAgentSetupPreset(runtime.preset);
        expect([...runtime.agents.keys()].sort()).toEqual(['a', 'b', 'extra']);
        expect(runtime.presets.size).toBe(0);
        expect(runtime.store.getGlobalSettings().scopedEnabledAgentIdsInitialized).toBe(false);
        expect(runtime.store.isAgentEnabledForAnyScope(runtime.store.getAgentById('a'))).toBe(true);
    });

    test('loading an older setup keeps migration markers forward and reports current only when apply would change nothing', async () => {
        const runtime = await storeRuntime();
        runtime.store.setGlobalSettings({ trackerCompanionAutoLoopVersion: 4, trackerCompanionAutoLoopApplied: true, connectionProfile: 'profile-x' });
        const stale = { ...runtime.preset, globalSettings: { ...runtime.preset.globalSettings, trackerCompanionAutoLoopVersion: 1, trackerCompanionAutoLoopApplied: false } };
        // A sparse setup that does not mention the profile would reset it to the default on apply, so it is not "current".
        expect(runtime.store.isAgentSetupCurrent(stale)).toBe(false);
        await expect(runtime.store.applyAgentSetupPreset(stale)).resolves.toBe(true);
        expect(runtime.store.getGlobalSettings().trackerCompanionAutoLoopVersion).toBe(4);
        expect(runtime.store.getGlobalSettings().trackerCompanionAutoLoopApplied).toBe(true);
        expect(runtime.store.isAgentSetupCurrent(stale)).toBe(true);
    });

    test('failed apply rolls back only its own writes and queues a concurrent new agent safely', async () => {
        const runtime = await storeRuntime();
        let release;
        let failed = false;
        const reached = new Promise(resolve => {
            runtime.state.hook = async (_url, payload) => {
                if (payload.id === 'b' && !failed) { failed = true; resolve(); await new Promise(done => { release = done; }); throw new Error('Write failed'); }
            };
        });
        const load = runtime.store.applyAgentSetupPreset(runtime.preset);
        const failure = load.catch(error => error);
        await reached;
        expect(runtime.store.getAgentById('a').prompt).toBe('old A');
        const later = runtime.store.saveAgent({ id: 'outside', name: 'Outside', prompt: 'concurrent' });
        release();
        expect(await failure).toMatchObject({ message: 'Write failed' });
        await later;
        expect(runtime.agents.get('a')).toEqual(runtime.initial[0]);
        expect(runtime.agents.has('b')).toBe(false);
        expect(runtime.agents.get('outside')).toMatchObject({ prompt: 'concurrent' });
        expect(runtime.writes.filter(write => write.url.endsWith('/delete'))).toEqual([]);
        expect(runtime.presets.size).toBe(0);
    });

    test('rollback preserves a record another client edited after the setup wrote it', async () => {
        const runtime = await storeRuntime();
        runtime.state.hook = async (_url, payload) => {
            if (payload.id === 'b') {
                // Another browser edits agent "a" after this setup already wrote it, then this setup fails.
                runtime.agents.set('a', { ...runtime.agents.get('a'), prompt: 'edited elsewhere' });
                throw new Error('Write failed');
            }
        };
        const error = await runtime.store.applyAgentSetupPreset(runtime.preset).catch(e => e);
        expect(error.message).toContain('Write failed');
        expect(error.message).toContain('Recovery needs attention');
        expect(runtime.agents.get('a').prompt).toBe('edited elsewhere');
        expect(runtime.presets.size).toBe(1);
        expect(runtime.store.getAgentById('a').prompt).toBe('old A');
    });

    test('rollback stops issuing requests once the account changes', async () => {
        const runtime = await storeRuntime();
        let account = 'one';
        runtime.state.hook = async (_url, payload) => {
            if (payload.id === 'b') { account = 'two'; throw new Error('Write failed'); }
        };
        const before = runtime.writes.length;
        const error = await runtime.store.applyAgentSetupPreset(runtime.preset, { canPersist: () => account === 'one' }).catch(e => e);
        expect(error.message).toContain('Recovery needs attention');
        // Only the two attempted setup writes happened; no restore request was sent for the other account.
        expect(runtime.writes.slice(before).map(write => write.payload.id)).toEqual(['a', 'b']);
        expect(runtime.presets.size).toBe(1);
    });

    test('rollback refuses an edit made after its recovery read but before its write', async () => {
        const runtime = await storeRuntime();
        runtime.state.hook = async (_url, payload) => {
            if (payload.id === 'b') throw new Error('Write failed');
            if (payload.id === 'a' && payload.prompt === 'old A') {
                runtime.agents.set('a', { ...runtime.agents.get('a'), prompt: 'newer external edit' });
            }
        };
        const error = await runtime.store.applyAgentSetupPreset(runtime.preset).catch(value => value);
        expect(error.message).toContain('Recovery needs attention');
        expect(runtime.agents.get('a').prompt).toBe('newer external edit');
        expect(runtime.presets.size).toBe(1);
    });

    test('unfinished recovery blocks automatic agents until a complete setup is applied', async () => {
        const runtime = await storeRuntime();
        runtime.presets.set('recovery', { ...runtime.preset, id: 'recovery', recoveryFor: 'interrupted' });
        await runtime.store.loadAgentSetupPresets();
        expect(runtime.store.hasPendingAgentRecovery()).toBe(true);
        expect(runtime.store.areAgentsGloballyEnabled()).toBe(false);
        await runtime.store.applyAgentSetupPreset(runtime.preset);
        expect(runtime.store.hasPendingAgentRecovery()).toBe(false);
        expect(runtime.store.areAgentsGloballyEnabled()).toBe(true);
        expect(runtime.presets.get('recovery').recoveryStatus).toBe('completed');
    });

    test('partial libraries preserve healthy agents and cannot replace a complete saved setup', async () => {
        const runtime = await storeRuntime();
        runtime.store.loadAgents([...runtime.initial, { id: 'broken', tools: [null] }, runtime.initial[0]]);
        expect(runtime.store.getAgents().map(agent => agent.id)).toEqual(['a', 'extra']);
        expect(runtime.store.getAgentLibraryErrors()).toHaveLength(2);
        expect(runtime.store.areAgentsGloballyEnabled()).toBe(false);
        await expect(runtime.store.saveAgentSetupPreset('Incomplete')).rejects.toThrow('incomplete');
        expect(runtime.presets.size).toBe(0);
    });

    test('legacy regex identities remain unique and stable after their acknowledged migration', async () => {
        const runtime = await storeRuntime();
        const raw = { id: 'a', regexScripts: [{ findRegex: 'A' }, { id: 'same', findRegex: 'B' }, { id: 'same', findRegex: 'C' }] };
        runtime.agents.set('a', raw);
        runtime.store.loadAgents([raw]);
        const before = runtime.store.getAgentById('a').regexScripts.map(script => script.id);
        expect(new Set(before).size).toBe(3);
        await runtime.store.persistAgentIdentityRepairs();
        runtime.store.loadAgents([runtime.agents.get('a')]);
        expect(runtime.store.getAgentById('a').regexScripts.map(script => script.id)).toEqual(before);
    });

    test('a whole-record edit queued during setup loading is rejected instead of reverting the setup', async () => {
        const runtime = await storeRuntime();
        let release;
        let reached;
        const waiting = new Promise(resolve => { reached = resolve; });
        runtime.state.hook = async (_url, payload) => {
            if (payload.id === 'b') { reached(); await new Promise(resolve => { release = resolve; }); }
        };
        const applying = runtime.store.applyAgentSetupPreset(runtime.preset);
        await waiting;
        const stale = runtime.store.saveAgent({ ...runtime.store.getAgentById('a'), name: 'Late edit' }).catch(error => error);
        release();
        await applying;
        expect((await stale).message).toContain('changed while the edit was waiting');
        expect(runtime.agents.get('a').prompt).toBe('new A');
    });

    test('failed settings commit restores agent files and settings; failed rollback retains a saved recovery setup', async () => {
        const runtime = await storeRuntime();
        const originalGlobals = structuredClone(runtime.store.getGlobalSettings());
        runtime.settingsSave.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset)).rejects.toThrow('setup settings');
        expect(runtime.agents.get('a')).toEqual(runtime.initial[0]);
        expect(runtime.store.getGlobalSettings()).toEqual(originalGlobals);
        runtime.state.hook = async (_url, payload) => {
            if (payload.id === 'b' || payload.prompt === 'old A') throw new Error('Storage unavailable');
        };
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset)).rejects.toMatchObject({ recoveryPreset: { agents: runtime.initial } });
        expect([...runtime.presets.values()][0]).toMatchObject({ agents: runtime.initial, globalSettings: originalGlobals });
    });

    test('unacknowledged deletion preserves live state and cancellation writes no agents', async () => {
        const runtime = await storeRuntime();
        runtime.state.hook = async url => { if (url.endsWith('/delete')) throw new Error('Delete failed'); };
        await expect(runtime.store.deleteAgent('a')).rejects.toThrow('Delete failed');
        expect(runtime.store.getAgentById('a')).not.toBeNull();
        expect(runtime.agents.has('a')).toBe(true);
        const writes = runtime.writes.length;
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset, { confirmExtras: async () => false })).resolves.toBe(false);
        expect(runtime.writes).toHaveLength(writes);
        await expect(runtime.store.applyAgentSetupPreset(runtime.preset, { isCurrent: () => false })).rejects.toThrow('workspace changed');
        expect(runtime.writes).toHaveLength(writes);
    });

    test('a later import failure rolls back earlier copies and a retry installs exactly one linked set', async () => {
        const runtime = await storeRuntime();
        const globals = structuredClone(runtime.store.getGlobalSettings());
        const pack = { format: 'sillybunny-inchat-agents', version: 1, agents: [
            { id: 'tpl-first', name: 'Imported first', prompt: 'first', enabled: true, companion: { dependencies: ['second'] } },
            { id: 'second', name: 'Imported second', prompt: 'second', enabled: true, companion: { contextRecipientAgentIds: ['tpl-first'] } },
        ] };
        runtime.state.hook = async (_url, payload) => { if (payload.name === 'Imported second') throw new Error('Second write failed'); };
        await expect(runtime.store.importAgents(pack)).rejects.toThrow('Second write failed');
        expect([...runtime.agents.values()]).toEqual(runtime.initial);
        expect(runtime.store.getGlobalSettings()).toEqual(globals);
        expect(runtime.presets.size).toBe(0);
        runtime.state.hook = async () => {};
        const [first, second] = await runtime.store.importAgents(pack);
        expect(runtime.agents.size).toBe(4);
        expect(first).toMatchObject({ enabled: false, sourceTemplateId: 'tpl-first', companion: { dependencies: [second.id] } });
        expect(second).toMatchObject({ enabled: false, companion: { contextRecipientAgentIds: [first.id] } });
        expect(runtime.store.getGlobalSettings()).toEqual(globals);
        expect(runtime.agents.get('extra')).toEqual(runtime.initial[1]);
    });

    test('a failed middle reorder restores all previous orders', async () => {
        const runtime = await storeRuntime();
        const initial = runtime.initial.map((agent, index) => ({ ...agent, injection: { order: 10 + index * 10 } }));
        runtime.agents.clear();
        initial.forEach(agent => runtime.agents.set(agent.id, structuredClone(agent)));
        runtime.store.loadAgents(initial);
        runtime.state.hook = async (_url, payload) => { if (payload.id === 'extra' && payload.injection.order === 0) throw new Error('Order write failed'); };
        await expect(runtime.store.reorderAgentsIntoOrderSlots(['extra', 'a'])).rejects.toThrow('Order write failed');
        expect([...runtime.agents.values()]).toEqual(initial);
        expect(runtime.store.getAgentById('a').injection.order).toBe(10);
        expect(runtime.store.getAgentById('extra').injection.order).toBe(20);
    });

    test('custom kits preserve same-template variants, local links and repeat installation', async () => {
        const runtime = await storeRuntime();
        const group = { id: 'linked-kit', name: 'Linked kit', builtin: false };
        const snapshots = [
            { id: 'local-a', name: 'First variant', sourceTemplateId: 'tpl-tracker', prompt: 'track A', companion: { dependencies: ['local-b'] } },
            { id: 'local-b', name: 'Second variant', sourceTemplateId: 'tpl-tracker', prompt: 'track B', companion: { contextRecipientAgentIds: ['local-a'] } },
        ];
        const [first, second] = await runtime.store.installAgentGroup(group, snapshots);
        expect(first.companion.dependencies).toEqual([second.id]);
        expect(second.companion.contextRecipientAgentIds).toEqual([first.id]);
        expect(runtime.agents.size).toBe(4);
        const writes = runtime.writes.length;
        await expect(runtime.store.installAgentGroup(group, snapshots)).resolves.toEqual([]);
        expect(runtime.writes).toHaveLength(writes);
        expect(runtime.agents.get('a')).toEqual(runtime.initial[0]);
        expect(runtime.agents.get('extra')).toEqual(runtime.initial[1]);
        runtime.store.loadCustomGroups([{ ...group, customAgents: snapshots }]);
        expect(runtime.store.getCustomGroups()[0].customAgents.map(agent => agent.id)).toEqual(['local-a', 'local-b']);
    });

    test('a failed kit installation leaves no partial copies, and malformed packs write nothing', async () => {
        const runtime = await storeRuntime();
        runtime.state.hook = async (_url, payload) => { if (payload.name === 'Second') throw new Error('Kit write failed'); };
        await expect(runtime.store.installAgentGroup({ id: 'kit', name: 'Kit' }, [
            { id: 'first', name: 'First', prompt: 'one' }, { id: 'second', name: 'Second', prompt: 'two' },
        ])).rejects.toThrow('Kit write failed');
        expect([...runtime.agents.values()]).toEqual(runtime.initial);
        const writes = runtime.writes.length;
        await expect(runtime.store.importAgents({ format: 'sillybunny-inchat-agents', agents: [{ id: 'same' }, { id: 'same' }] })).rejects.toThrow('repeats agent identifier');
        expect(runtime.writes).toHaveLength(writes);
        expect(runtime.presets.size).toBe(0);
    });

    test('tool registrations recover after setup success, rollback and cancellation even when selection persistence fails', async () => {
        for (const outcome of ['success', 'rollback', 'cancel']) {
            const runtime = await storeRuntime();
            const source = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
            const action = source.match(/^async function loadSelectedAgentSetup\([\s\S]*?^}/m)[0];
            let registered = true;
            const sync = jest.fn(() => { registered = runtime.store.areAgentsGloballyEnabled(); });
            runtime.settingsSave.mockImplementation(async () => { sync(); return true; });
            if (outcome === 'rollback') {
                let failed = false;
                runtime.state.hook = async (_url, payload) => {
                    if (payload.id === 'b' && !failed) { failed = true; throw new Error('Temporary failure'); }
                };
            }
            const context = vm.createContext({
                agentSetupOperationAllowed: () => true,
                getAgentSetupPresetById: () => runtime.preset,
                selectedAgentSetupId: runtime.preset.id,
                getCurrentUserHandle: () => 'test', getChatGeneration: () => 1,
                is_send_press: false, is_group_generating: false, isAgentGenerationActive: () => false,
                document: { querySelectorAll: () => [] }, window: { confirm: () => outcome !== 'cancel' },
                applyingAgentSetup: false, agentSetupOperationBusy: false,
                setAgentSetupStatus() {}, applyAgentSetupPreset: runtime.store.applyAgentSetupPreset,
                buildConnectionProfileNameMap: () => new Map(), rememberAgentSetupSelection: async () => false,
                syncToolAgentRegistrations: sync, renderAgentList() {}, renderAgentSetupControls() {},
                toastr: { error() {} }, escapeHtml: value => value,
            });
            vm.runInContext(action, context);
            await context.loadSelectedAgentSetup();
            expect(sync).toHaveBeenCalled();
            expect(registered).toBe(true);
            expect(context.agentSetupOperationBusy).toBe(false);
        }
    });
});
