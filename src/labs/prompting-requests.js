import path from 'node:path';
import { readRoleplayFile } from '../roleplay-store.js';
import { roleplayEntityContent } from '../generation/roleplay-source.js';
import { captureProfilePresetBinding } from '../generation/profiles.js';
import { runChatProfile } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { createProviderScope, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { buildAnalysisMessages, buildExperimentMessages } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/experiment.js';
import { captureLabChat, captureLabConnection, readLabSettings } from './sources.js';
import { labError, withLabRecord } from './store.js';

function promptValue(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length && value.every(message => message && ['system', 'user', 'assistant'].includes(message.role)
        && typeof message.content === 'string')) return structuredClone(value);
    throw labError('Choose a non-empty captured prompt.', 400);
}

function characterValue(base, avatar) {
    if (!avatar) return null;
    if (typeof avatar !== 'string' || path.basename(avatar) !== avatar) throw labError('Choose a saved character.', 400);
    const file = readRoleplayFile(path.join(base.directories.characters, avatar), 16 * 1024 * 1024);
    if (!file) throw labError('The selected experiment character no longer exists.');
    const card = roleplayEntityContent('character', avatar, file.bytes).data;
    const data = card.data ?? card;
    return { avatar, name: String(data.name || avatar), description: String(data.description || ''),
        personality: String(data.personality || ''), scenario: String(data.scenario || ''), firstMessage: String(data.first_mes || ''),
        greetings: [data.first_mes, ...(data.alternate_greetings || [])].filter(value => typeof value === 'string' && value.trim()) };
}

/** Capture every request in a comparison before accepting its one parent job. */
export async function capturePromptingRequests(base, account, input) {
    if (!['send', 'compare', 'experiment', 'analysis'].includes(input.operation)) throw labError('Choose a Prompting Lab operation.', 400);
    const maxTokens = input.maxTokens ?? (input.operation === 'analysis' ? 800 : 300);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw labError('Choose a reply limit between 1 and 32768 tokens.', 400);
    const settings = readLabSettings(base);
    const character = characterValue(base, input.characterAvatar);
    const macros = input.locator ? captureLabChat(base, account, input.locator).macros : {
        names: { user: settings.username || settings.name1 || 'User', char: character?.name || 'Character' },
        character: character ? { ...character, persona: '' } : {}, variables: { global: settings.extension_settings?.variables?.global || {}, local: {} },
        extra: { chat: [], chatMetadata: {} },
    };
    let requests;
    if (input.operation === 'experiment') {
        if (['promptA', 'promptB', 'scenario'].some(key => typeof (input[key] ?? '') !== 'string')
            || !['system', 'user', 'assistant'].includes(input.role ?? 'system')
            || input.greeting != null && typeof input.greeting !== 'string') throw labError('The experiment text is invalid.', 400);
        requests = ['A', 'B'].map(key => ({ key, prompt: input[`prompt${key}`] || '', profileId: input.profileId,
            messages: buildExperimentMessages({ prompt: input[`prompt${key}`], role: input.role, character, scenario: input.scenario, greeting: input.greeting }) }));
    } else if (input.operation === 'analysis') {
        const details = Object.fromEntries(['promptA', 'promptB', 'replyA', 'replyB', 'scenario', 'characterName'].map(key => [key, String(input.details?.[key] || '')]));
        requests = [{ profileId: input.profileId, messages: buildAnalysisMessages(details) }];
    } else {
        const ids = input.operation === 'compare' ? input.profileIds : [input.profileId];
        if (!Array.isArray(ids) || ids.length !== (input.operation === 'compare' ? 2 : 1) || new Set(ids).size !== ids.length) throw labError('Choose two distinct connection profiles.', 400);
        requests = ids.map(profileId => ({ profileId, messages: promptValue(input.prompt) }));
    }
    requests = await Promise.all(requests.map(async request => {
        if (typeof request.profileId !== 'string' || !request.profileId) throw labError('Choose a saved connection profile.', 400);
        let { binding } = await captureLabConnection(base, { profileId: request.profileId, maxTokens }, macros);
        binding = captureProfilePresetBinding(base.directories, binding, input.presetName);
        const includePreset = input.includePreset ?? true;
        const includeInstruct = input.includeInstruct ?? true;
        if (typeof includePreset !== 'boolean' || typeof includeInstruct !== 'boolean') throw labError('The preset selection is invalid.', 400);
        return { ...request, binding, rawOptions: { includePreset, includeInstruct } };
    }));
    const display = { operation: input.operation, profileId: input.profileId ?? null, characterName: character?.name ?? '',
        scenario: input.scenario ?? '', promptA: input.promptA ?? '', promptB: input.promptB ?? '' };
    return { operation: input.operation, maxTokens, character, macros, requests, display };
}

export async function runPromptingRequests(context, plan, { generate = runChatProfile } = {}) {
    const scoped = { ...context, providerScope: createProviderScope(context) };
    let completed = 0;
    const results = await Promise.allSettled(plan.requests.map(async (request, index) => {
        const name = `prompting-reply:${index}`;
        let result = readArtifact(context.directories, context.job.id, name);
        if (result === undefined) {
            const messages = typeof request.messages === 'string' ? [{ role: 'user', content: request.messages }] : request.messages;
            const startedAt = Date.now();
            try {
                const reply = await generate({ context: { directories: context.directories, owner: context.owner }, binding: request.binding, messages,
                    maxTokens: plan.maxTokens, signal: context.signal, jobContext: scoped, stepNamespace: name,
                    macroEnvironment: createMacroEnvironment(plan.macros), userName: plan.macros.names.user,
                    characterName: plan.macros.names.char, rawOptions: request.rawOptions,
                    beforeDispatch: () => withLabRecord(context, () => {}) });
                const text = typeof reply === 'string' ? reply : String(reply?.text ?? '');
                result = { profileId: request.profileId, text, error: text.trim() ? null : 'The model returned an empty reply.', durationMs: Date.now() - startedAt };
            } catch (error) {
                context.signal.throwIfAborted();
                const saved = getJob(context.directories, context.job.id);
                if (saved?.recoverability === 'unknown-outcome' || saved?.resume?.providerStep || error.code === 'PROVIDER_OUTCOME_UNKNOWN'
                    || !Number.isInteger(error.status) || error.status >= 500 && ![503, 529].includes(error.status)) throw error;
                result = { profileId: request.profileId, text: '', error: error.message, durationMs: Date.now() - startedAt };
            }
            if (request.key) Object.assign(result, { key: request.key, prompt: request.prompt, messages });
            writeArtifact(context.directories, context.job.id, name, result);
        }
        await context.progress({ stage: 'Comparing prompts', completed: ++completed, total: plan.requests.length });
        return result;
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const replies = results.map(result => result.value);
    return ['send', 'analysis'].includes(plan.operation) ? replies[0] : replies;
}
