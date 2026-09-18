/* eslint-disable playwright/no-standalone-expect -- Jest table-driven unit tests. */
import { jest, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const names = ['assertEditorRequest', 'refineLLMCall', 'generateTrackerKitWithAI', 'generateCompanionKitWithAI', 'buildResetAgentFromTemplate'];
const code = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(node => node.declaration ?? node).filter(node => names.includes(node.id?.name))
    .map(node => source.slice(node.start, node.end)).join('\n');

function runtime() {
    const request = jest.fn(async () => ({ output: 'Revised instructions' }));
    const context = vm.createContext({
        DOMException, structuredClone, console, requestPromptTransform: request,
        getAgentGenerationCancelRevision: () => 1, DEFAULT_AGENT_MAX_TOKENS: 64000,
        getGlobalSettings: () => ({ helperPrefillMessages: '' }), appendHelperPrefillMessages: messages => messages,
        buildTrackerFallbackKit: () => ({ usedFallback: true }), buildCompanionFallbackKit: () => ({ usedFallback: true }),
        extractJsonObject: text => text, normalizeTrackerKitResponse: value => value, normalizeCompanionKitResponse: value => value,
        buildAgentFromTemplate: template => structuredClone(template),
    });
    vm.runInContext(code, context);
    return { context, request };
}

test('editor requests use only their prepared task and retain model, profile and ownership controls', async () => {
    const { context, request } = runtime();
    const options = { signal: new AbortController().signal, isCurrent: () => true, cancelRevision: 1, modelOverride: 'chosen-model', execution: 'companion' };
    expect(await context.refineLLMCall('Instructions', 'Draft', 'chosen-profile', options)).toBe('Revised instructions');
    expect(request).toHaveBeenCalledWith(
        { category: 'custom', connectionProfile: 'chosen-profile', modelOverride: 'chosen-model', execution: 'companion' },
        [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Draft' }], 64000, options,
    );
});

test.each(['closed', 'edited', 'stopped'])('a %s editor cannot accept a delayed response', async reason => {
    const { context, request } = runtime();
    let current = true;
    const controller = new AbortController();
    const options = { isCurrent: () => current, signal: controller.signal, cancelRevision: 1 };
    request.mockImplementationOnce(async () => {
        if (reason === 'closed') current = false;
        if (reason === 'edited') controller.abort();
        if (reason === 'stopped') context.getAgentGenerationCancelRevision = () => 2;
        return { output: 'Obsolete instructions' };
    });
    await expect(context.refineLLMCall('Task', 'Draft', '', options)).rejects.toHaveProperty('name', 'AbortError');
});

test.each(['generateTrackerKitWithAI', 'generateCompanionKitWithAI'])('%s does not disguise a provider failure as a starter kit', async name => {
    const { context, request } = runtime();
    request.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(context[name]({ agentName: 'Notes', requestOptions: {} })).rejects.toThrow('Provider unavailable');
    request.mockRejectedValueOnce(new DOMException('Stopped', 'AbortError'));
    await expect(context[name]({ agentName: 'Notes', requestOptions: {} })).rejects.toHaveProperty('name', 'AbortError');
});

test.each([{ output: '', expected: 'no output' }, { output: 'Half a result', lengthLimited: true, expected: 'output limit' }])('invalid editor output is rejected: $expected', async response => {
    const { context, request } = runtime();
    request.mockResolvedValueOnce(response);
    await expect(context.refineLLMCall('Task', 'Draft')).rejects.toThrow(response.expected);
});

test('reset restores all template defaults and keeps the explicitly preserved choices', () => {
    const { context } = runtime();
    const original = { id: 'copy', version: 1, enabled: true, favorite: true, phaseLocked: true, connectionProfile: 'saved', modelOverride: 'model', settings: { objective: 'Keep this' }, conditions: { probability: 0 }, preProcess: { enabled: true }, customField: 'keep' };
    const template = { id: 'tpl-new', version: 2, conditions: { probability: 100 }, preProcess: { enabled: false }, companion: { trigger: 'auto' } };
    const result = context.buildResetAgentFromTemplate(original, template);
    expect(result).toEqual({ ...original, ...template, id: 'copy', phaseLocked: false });
    expect(original.conditions.probability).toBe(0);
    expect(result.settings).not.toBe(original.settings);
});
