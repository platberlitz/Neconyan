import { runChatProfile } from '../generation/service.js';
import { isDefiniteProviderRefusal, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { createMacroEnvironment } from '../macros/index.js';
import { captureLabConnection, readLabSettings } from '../labs/sources.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';

const TEXT_LIMIT = 256 * 1024;

function boundedText(value, name) {
    const text = typeof value === 'string' ? value : '';
    if (Buffer.byteLength(text) > TEXT_LIMIT) throw operationError(`The ${name} is too long.`, 413);
    return text;
}

/** Freeze a raw prompt with the saved or acknowledged connection before any provider call. */
export async function captureRawGeneration(base, account, input = {}) {
    const prompt = boundedText(input.prompt, 'prompt');
    const systemPrompt = boundedText(input.systemPrompt, 'system prompt');
    if (!prompt.trim() && !systemPrompt.trim()) throw operationError('Write a prompt first.', 400);
    const maxTokens = input.maxTokens === undefined || input.maxTokens === null ? 300 : Number(input.maxTokens);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
        throw operationError('Choose a reply length between 1 and 32768 tokens.', 400);
    }
    const saved = readLabSettings(base);
    const macros = { names: { user: String(saved.name1 || 'User'), char: '' }, variables: {}, extra: { chat: [], chatMetadata: {} } };
    const { binding } = await captureLabConnection(base, { profileId: typeof input.profileId === 'string' ? input.profileId : '',
        acknowledgement: input.acknowledgement, maxTokens }, macros);
    const messages = [
        ...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }] : []),
        ...(prompt.trim() ? [{ role: 'user', content: prompt }] : []),
    ];
    return { account, binding, macros, maxTokens, messages };
}

export async function runRawGeneration(context, plan, { generate = runChatProfile } = {}) {
    const saved = readArtifact(context.directories, context.job.id, 'raw-reply');
    if (saved !== undefined) return saved;
    await context.progress({ stage: 'Writing a background reply', completed: 0, total: 1 });
    let response;
    try {
        response = await generate({ context: { directories: context.directories, owner: context.owner }, jobContext: context,
            binding: plan.binding, messages: plan.messages, maxTokens: plan.maxTokens,
            macroEnvironment: createMacroEnvironment(plan.macros), userName: plan.macros.names.user, characterName: '',
            signal: context.signal, stepNamespace: 'raw', beforeDispatch: () => withOperation(context, () => {}) });
    } catch (error) {
        if (isDefiniteProviderRefusal(error?.status)) error.operationRefused = true;
        throw error;
    }
    const text = String(typeof response === 'string' ? response : response?.text ?? '').trim();
    if (!text) throw Object.assign(operationError('The model returned an empty reply.', 422), { operationRefused: true });
    const result = { text };
    writeArtifact(context.directories, context.job.id, 'raw-reply', result);
    await context.progress({ stage: 'Writing a background reply', completed: 1, total: 1 });
    return result;
}

registerOperation('raw-generation', {
    label: 'Write a background reply',
    capture: captureRawGeneration,
    run: runRawGeneration,
});
