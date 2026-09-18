/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect -- Jest hooks and table-driven tests. */
/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const chat = [];
let chatId;
let enabled;
let books;
let context;
const generateRaw = jest.fn();
const sendRequest = jest.fn();
const loadWorldInfo = jest.fn();
const markSummaryMemoryInjected = jest.fn();
const runAsInternalPromptTransform = jest.fn(request => request());

await jest.unstable_mockModule('../public/script.js', () => ({
    chat,
    getCurrentChatId: () => chatId,
    generateRaw,
    normalizeContentText: value => String(value ?? ''),
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => context }));
await jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({ removeReasoningFromString: value => value }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ isPathfinderSubmoduleEnabled: () => enabled }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({ runAsInternalPromptTransform }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/pathfinder/summary-memory-store.js', () => ({
    isSummaryMemoryEntry: entry => entry.name?.startsWith('[Summary]'),
    markSummaryMemoryInjected,
}));

const { runSidecarRetrieval, injectPathfinderRetrieval } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js');
const { sidecarGenerateWithProfile } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js');
const { runPipeline } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/pipeline-runner.js');
const { initializePromptStore, savePrompt } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-store.js');
const { getDefaultPrompts, getDefaultPipelines } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/prompts/default-prompts.js');
const { replaceSettings, setSettings, getTree, clearAllTrees } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');
const { buildTreeFromMetadata, buildTreeWithLLM } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-builder.js');
const { clearFeed, getFeedItems } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/activity-feed.js');
const { getRetrievalOutputLimit, fitRetrievalEntries, countRetrievalTokens, formatRetrievalContext } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/retrieval-budget.js');
const promptTypes = { IN_PROMPT: 0 };
const promptRoles = { SYSTEM: 0 };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('Pawthfinder retrieval with real pipeline and model transport stubs', () => {
    let prompts;
    let writePrompt;

    beforeEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        clearAllTrees();
        clearFeed();
        chatId = 'chat-a';
        enabled = true;
        chat.splice(0, chat.length, { name: 'User', is_user: true, mes: 'We enter the town.' });
        books = {
            'Book A': { entries: { 1: { uid: 1, comment: 'Town', content: 'The first town.', key: ['town'] } } },
        };
        loadWorldInfo.mockReset().mockImplementation(async name => structuredClone(books[name]));
        sendRequest.mockReset().mockResolvedValue('{"candidates":["Town"]}');
        generateRaw.mockReset().mockResolvedValue('{"candidates":["Town"]}');
        context = {
            chat, loadWorldInfo, ConnectionManagerRequestService: { sendRequest },
            getMaxContextTokens: () => 128000,
            getMaxPromptTokens: () => 120000,
            getTokenCountAsync: async text => Math.ceil(String(text).length / 4),
        };
        globalThis.window = { SillyTavern: { getContext: () => context } };
        globalThis.toastr = { warning: jest.fn(), error: jest.fn() };
        replaceSettings({
            pipelineEnabled: true,
            pipelineId: 'single-pass',
            enabledLorebooks: ['Book A'],
            includeContextualLorebooks: false,
            connectionProfile: 'profile-a',
            retrievalTimeoutSeconds: 1,
        });
        initializePromptStore(getDefaultPrompts(), getDefaultPipelines());
        prompts = {};
        writePrompt = jest.fn((key, value) => { prompts[key] = value; });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        delete globalThis.window;
        delete globalThis.toastr;
    });

    test('preserves configured templates and accepts unique titles from existing prompts', async () => {
        const custom = { ...getDefaultPrompts()['candidate-selector'], userPromptTemplate: '{{chat_history}}\n{{entry_list}}', connectionProfile: 'custom-profile' };
        savePrompt(custom);
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);

        expect(result.success).toBe(true);
        expect(result.selectedEntries).toEqual([expect.objectContaining({ bookName: 'Book A', uid: 1, name: 'Town' })]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
        expect(sendRequest).toHaveBeenCalledWith('custom-profile', [
            { role: 'system', content: custom.systemPrompt },
            { role: 'user', content: 'User: We enter the town.\n- ["Book A",1] Town' },
        ], 64000, expect.objectContaining({ stream: false }), { temperature: custom.settings.temperature });
    });

    test('keeps duplicate titles tied to their book and UID through both stages and injection', async () => {
        books['Book B'] = { entries: { 1: { uid: 1, comment: 'Town', content: 'The second town.' } } };
        setSettings({ enabledLorebooks: ['Book A', 'Book B'], pipelineId: 'default' });
        sendRequest.mockResolvedValueOnce(JSON.stringify({ candidates: ['["Book A",1] Town', '["Book B",1] Town'] }))
            .mockResolvedValueOnce(JSON.stringify({ selected: ['["Book B",1] Town'] }));

        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);

        expect(sendRequest.mock.calls[1][1][1].content).toContain('### ["Book A",1] Town\nThe first town.');
        expect(sendRequest.mock.calls[1][1][1].content).toContain('### ["Book B",1] Town\nThe second town.');
        expect(result.selectedEntries).toEqual([expect.objectContaining({ bookName: 'Book B', uid: 1 })]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The second town.');
        expect(prompts.pathfinder_pipeline_retrieval).not.toContain('The first town.');
        await injectPathfinderRetrieval(result, writePrompt, promptTypes, promptRoles, [{ world: 'Book A', uid: 1 }]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The second town.');
    });

    test('does not resolve a bare duplicate title to the first or last book', async () => {
        books['Book B'] = structuredClone(books['Book A']);
        setSettings({ enabledLorebooks: ['Book A', 'Book B'] });
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(result.selectedEntries).toEqual([]);
        expect(prompts.pathfinder_pipeline_retrieval).toBe('');
    });

    test('only actual native activation removes lore, not old keywords or a constant rejected by the native budget', async () => {
        books['Book A'].entries[2] = { uid: 2, comment: 'Forest', content: 'Forest lore.', key: ['forest'] };
        books['Book A'].entries[3] = { uid: 3, comment: 'Always', content: 'Budget-rejected lore.', constant: true };
        chat.unshift({ name: 'User', is_user: true, mes: 'forest' }, ...Array.from({ length: 6 }, () => ({ mes: 'Elsewhere.' })));
        sendRequest.mockResolvedValue('{"candidates":["Town","Forest","Always"]}');
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);

        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
        expect(prompts.pathfinder_pipeline_retrieval).toContain('Forest lore.');
        expect(prompts.pathfinder_pipeline_retrieval).toContain('Budget-rejected lore.');
        await injectPathfinderRetrieval(result, writePrompt, promptTypes, promptRoles, [{ world: 'Book A', uid: 1 }]);
        expect(prompts.pathfinder_pipeline_retrieval).not.toContain('The first town.');
        expect(prompts.pathfinder_pipeline_retrieval).toContain('Forest lore.');
        expect(prompts.pathfinder_pipeline_retrieval).toContain('Budget-rejected lore.');
    });

    test('includes a bounded snapshot of chat in the tool-only prepass', async () => {
        setSettings({ pipelineEnabled: false, sidecarEnabled: true });
        chat.splice(0, chat.length, ...Array.from({ length: 15 }, (_, index) => ({ is_user: true, mes: `turn-${index}!` })));
        sendRequest.mockImplementation(async () => getTree('Book A').children[0].id);
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);

        expect(result.success).toBe(true);
        expect(sendRequest.mock.calls[0][1][1].content).not.toContain('turn-4!');
        expect(sendRequest.mock.calls[0][1][1].content).toContain('User: turn-5!');
        expect(sendRequest.mock.calls[0][1][1].content).toContain('User: turn-14!');
        expect(prompts.pathfinder_sidecar_retrieval).toContain('The first town.');
    });

    test('does not write after switching chats while the transport ignores cancellation', async () => {
        const started = deferred();
        const response = deferred();
        sendRequest.mockImplementation(() => { started.resolve(); return response.promise; });
        const pending = runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        await started.promise;
        chatId = 'chat-b';
        chat.splice(0, chat.length, { is_user: true, mes: 'Different chat.' });
        writePrompt.mockClear();
        response.resolve('{"candidates":["Town"]}');

        await expect(pending).resolves.toEqual({ success: false });
        expect(writePrompt).not.toHaveBeenCalled();
        expect(markSummaryMemoryInjected).not.toHaveBeenCalled();
        expect(sendRequest.mock.calls[0][1][1].content).toContain('We enter the town.');
        expect(sendRequest.mock.calls[0][1][1].content).not.toContain('Different chat.');
    });

    test('warns at the slow threshold and still injects the eventual successful response', async () => {
        jest.useFakeTimers();
        const started = deferred();
        const response = deferred();
        const controller = new AbortController();
        sendRequest.mockImplementation(() => { started.resolve(); return response.promise; });
        const pending = runSidecarRetrieval(writePrompt, promptTypes, promptRoles, controller.signal);
        await started.promise;
        await jest.advanceTimersByTimeAsync(1000);

        expect(globalThis.toastr.warning).toHaveBeenCalledWith('Pawthfinder is processing lore for this reply...', 'Please wait');
        expect(controller.signal.aborted).toBe(false);
        response.resolve('{"candidates":["Town"]}');
        const result = await pending;
        expect(result.success).toBe(true);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('explicit cancellation still aborts and never falls back to another request', async () => {
        const started = deferred();
        const controller = new AbortController();
        sendRequest.mockImplementation((_profile, _messages, _tokens, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            started.resolve();
        }));
        const pending = runSidecarRetrieval(writePrompt, promptTypes, promptRoles, controller.signal);
        await started.promise;
        controller.abort();
        await expect(pending).resolves.toEqual({ success: false });
        expect(generateRaw).not.toHaveBeenCalled();
        expect(prompts.pathfinder_pipeline_retrieval).toBe('');
    });

    test('reports terminal failure distinctly from a successful empty selection on retry', async () => {
        sendRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('[]');
        generateRaw.mockRejectedValueOnce(new Error('offline'));
        const failed = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(failed.success).toBe(false);
        const retried = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(retried.success).toBe(true);
        expect(retried.selectedEntries).toEqual([]);
        expect(sendRequest).toHaveBeenCalledTimes(2);
    });

    test('does not report a failed lorebook read as a successful empty selection', async () => {
        await buildTreeFromMetadata('Book A', books['Book A']);
        loadWorldInfo.mockRejectedValueOnce(new Error('offline'));
        await expect(runSidecarRetrieval(writePrompt, promptTypes, promptRoles)).resolves.toEqual({ success: false });
        const retried = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(retried.success).toBe(true);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
    });

    test('retains first-stage entries when the optional filter exhausts both transports', async () => {
        setSettings({ pipelineId: 'default' });
        sendRequest.mockResolvedValueOnce('{"candidates":["Town"]}').mockRejectedValueOnce(new Error('profile offline'));
        generateRaw.mockRejectedValueOnce(new Error('main offline'));
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);

        expect(result.success).toBe(true);
        expect(result.cacheable).toBe(false);
        expect(result.stageResults.map(stage => stage.success)).toEqual([true, false]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
    });

    test('treats blank transport output as failure instead of deleting valid first-stage entries', async () => {
        setSettings({ pipelineId: 'default' });
        sendRequest.mockResolvedValueOnce('{"candidates":["Town"]}').mockResolvedValueOnce('');
        generateRaw.mockResolvedValueOnce('');
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(result.cacheable).toBe(false);
        expect(result.stageResults.map(stage => stage.success)).toEqual([true, false]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
    });

    test('does not send blacklisted entries from an outdated tree to the model', async () => {
        books['Book A'].entries[2] = { uid: 2, comment: 'Private', content: 'Private lore.' };
        await buildTreeFromMetadata('Book A', books['Book A']);
        books['Book A'].entries[2].agentBlacklisted = true;
        await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(sendRequest.mock.calls[0][1][1].content).not.toContain('Private');
    });

    test('does not send revoked book content to the optional filter or inject it afterwards', async () => {
        setSettings({ pipelineId: 'default' });
        sendRequest.mockImplementationOnce(async () => {
            setSettings({ bookPermissions: { 'Book A': { read: 'none' } } });
            return '{"candidates":["Town"]}';
        }).mockResolvedValueOnce('{"selected":["Town"]}');
        await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(sendRequest.mock.calls[1][1][1].content).not.toContain('The first town.');
        expect(prompts.pathfinder_pipeline_retrieval).toBe('');
    });

    test('keeps native duplicates when the existing de-duplication setting is off', async () => {
        setSettings({ dedupeNaturalActivation: false });
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        await injectPathfinderRetrieval(result, writePrompt, promptTypes, promptRoles, [{ world: 'Book A', uid: 1 }]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
    });

    test('keeps the public pipeline title list and also returns unambiguous entry data', async () => {
        await buildTreeFromMetadata('Book A', books['Book A']);
        const result = await runPipeline('single-pass', chat);
        expect(result.selectedEntries).toEqual(['Town']);
        expect(result.selectedEntryData).toEqual([expect.objectContaining({ bookName: 'Book A', uid: 1 })]);
    });

    test('propagates terminal LLM failure and guards the raw fallback as auxiliary work', async () => {
        sendRequest.mockRejectedValue(new Error('profile offline'));
        const failure = new Error('main offline');
        generateRaw.mockRejectedValue(failure);
        await expect(sidecarGenerateWithProfile('prompt', 'system', 'profile-a', 123)).rejects.toBe(failure);
        expect(runAsInternalPromptTransform).toHaveBeenCalledTimes(2);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ responseLength: 123, cacheScope: 'auxiliary', trimNames: false }));
    });

    test('does not start either transport with an already-cancelled signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(sidecarGenerateWithProfile('prompt', '', 'profile-a', 123, controller.signal)).rejects.toBe(controller.signal.reason);
        expect(sendRequest).not.toHaveBeenCalled();
        expect(generateRaw).not.toHaveBeenCalled();
    });

    test.each(['{"selected":', '{"selected":5}', 'null', 'unrelated prose'])('an invalid optional filter preserves earlier candidates: %s', async response => {
        setSettings({ pipelineId: 'default' });
        sendRequest.mockResolvedValueOnce('{"candidates":["Town"]}').mockResolvedValueOnce(response);
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(result.cacheable).toBe(false);
        expect(result.stageResults.map(stage => stage.success)).toEqual([true, false]);
        expect(prompts.pathfinder_pipeline_retrieval).toContain('The first town.');
    });

    test('a complete JSON array preserves titles containing braces and escaped quotes', async () => {
        const title = 'Town {North} "Gate"';
        books['Book A'].entries[1].comment = title;
        sendRequest.mockResolvedValue(JSON.stringify([title]));
        expect((await runSidecarRetrieval(writePrompt, promptTypes, promptRoles)).selectedEntries[0].name).toBe(title);
    });

    test.each(['single-pass', 'skip', 'failure'])('candidate limits survive %s selection', async mode => {
        books['Book A'].entries = Object.fromEntries(Array.from({ length: 6 }, (_, uid) => [uid, { uid, comment: `Entry${uid}`, content: `Lore${uid}` }]));
        setSettings({ pipelineId: mode === 'single-pass' ? 'single-pass' : 'default', maxCandidates: 2, skipSecondPass: mode === 'skip' });
        sendRequest.mockResolvedValueOnce(JSON.stringify({ candidates: Array.from({ length: 6 }, (_, uid) => `Entry${uid}`) })).mockResolvedValueOnce('invalid');
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(result.selectedEntries.map(entry => entry.uid)).toEqual([0, 1]);
    });

    test('the relevance filter cannot introduce an entry it never received', async () => {
        books['Book A'].entries[2] = { uid: 2, comment: 'Unrelated', content: 'Not offered.' };
        setSettings({ pipelineId: 'default' });
        sendRequest.mockResolvedValueOnce('{"candidates":["Town"]}').mockResolvedValueOnce('{"selected":["Unrelated"]}');
        const result = await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        expect(sendRequest.mock.calls[1][1][1].content).not.toContain('Not offered.');
        expect(result.selectedEntries).toEqual([]);
    });

    test('untitled entries remain selectable and root-held entries expose their node ID', async () => {
        books['Book A'].entries[1] = { uid: 1, content: 'Untitled lore.', key: [] };
        sendRequest.mockResolvedValue('{"candidates":["Entry 1"]}');
        expect((await runSidecarRetrieval(writePrompt, promptTypes, promptRoles)).selectedEntries[0].uid).toBe(1);
        setSettings({ pipelineEnabled: false, sidecarEnabled: true });
        const root = getTree('Book A');
        root.entries = [1]; root.children = [];
        sendRequest.mockImplementation(async (_profile, messages) => {
            expect(messages[1].content).toContain(`id: ${root.id}`);
            return root.id;
        });
        expect((await runSidecarRetrieval(writePrompt, promptTypes, promptRoles)).selectedEntries[0].uid).toBe(1);
    });

    test('retrieval requests and final lore fit their available text budgets', async () => {
        context.getMaxContextTokens = () => 600;
        context.getMaxPromptTokens = () => 500;
        context.getTokenCountAsync = async text => text.length;
        expect(await getRetrievalOutputLimit([{ content: 'x'.repeat(300) }], 1000)).toBe(236);
        await expect(getRetrievalOutputLimit([{ content: 'x'.repeat(600) }], 1000)).rejects.toThrow('context limit');
        const entries = [200, 30, 30, 30].map((length, uid) => ({ uid, name: `E${uid}`, bookName: 'Book A', content: 'x'.repeat(length) }));
        const fitted = await fitRetrievalEntries(entries);
        expect(fitted.skipped.length).toBeGreaterThan(1);
        expect(await countRetrievalTokens(formatRetrievalContext(fitted.selected))).toBeLessThanOrEqual(fitted.budget);
        expect((await fitRetrievalEntries(entries, [{ content: 'native'.repeat(100) }])).selected).toEqual([]);
        chat[0].mes = 'history'.repeat(100);
        expect((await fitRetrievalEntries(entries)).selected).toEqual([]);
    });

    test('per-stage zero temperature reaches profile and main requests', async () => {
        await sidecarGenerateWithProfile('prompt', 'system', 'profile-a', 50, null, { temperature: 0 });
        expect(sendRequest.mock.calls[0][4]).toEqual({ temperature: 0 });
        sendRequest.mockRejectedValueOnce(new Error('offline'));
        await sidecarGenerateWithProfile('prompt', 'system', 'profile-a', 50, null, { temperature: 0 });
        expect(generateRaw).toHaveBeenLastCalledWith(expect.objectContaining({ temperature: 0 }));
    });

    test('the latest failure replaces an older successful diagnostic result', async () => {
        await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        sendRequest.mockRejectedValueOnce(new Error('offline'));
        generateRaw.mockRejectedValueOnce(new Error('offline'));
        await runSidecarRetrieval(writePrompt, promptTypes, promptRoles);
        const last = getFeedItems().find(item => item.type === 'pathfinder_retrieval_detail');
        expect(last.metadata.error).toBeTruthy();
        expect(last.selectedEntries).toEqual([]);
    });

    test('a partial model-built tree falls back to complete metadata coverage', async () => {
        books['Book A'].entries[2] = { uid: 2, comment: 'Forest', content: 'Forest lore.' };
        sendRequest.mockResolvedValue('{"name":"Partial","entries":[1],"children":[]}');
        const tree = await buildTreeWithLLM('Book A', books['Book A']);
        const collect = node => [...(node.entries ?? []), ...(node.children ?? []).flatMap(collect)];
        expect(new Set(collect(tree))).toEqual(new Set([1, 2]));
    });
});
