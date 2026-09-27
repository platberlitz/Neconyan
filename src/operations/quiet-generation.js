import path from 'node:path';
import { readArtifact, writeArtifact, isDefiniteProviderRefusal } from '../jobs/artifacts.js';
import { runChatProfile } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { capturePromptingContext, promptingMaterial } from '../labs/prompting-context.js';
import { promptingTokenCounter } from '../labs/prompting-suites.js';
import { promptingMemoryPreparation } from '../labs/prompting-memory.js';
import { computeLab } from '../labs/compute.js';
import { captureLabConnection } from '../labs/sources.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';

const PROMPT_LIMIT = 256 * 1024;

/**
 * Freeze a background prompt against the saved solo chat. The quiet instruction is added after the
 * native prompt as a system message for chat backends, or as a final user turn for text backends.
 */
export async function captureQuietGeneration(base, account, input = {}) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trim()) throw operationError('Write the background prompt first.', 400);
    if (Buffer.byteLength(prompt) > PROMPT_LIMIT) throw operationError('The background prompt is too long.', 413);
    const maxTokens = input.maxTokens ?? 300;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw operationError('The reply limit is invalid.', 400);
    const locator = input.locator;
    if (!locator || locator.group || typeof locator.avatar !== 'string' || typeof locator.chat !== 'string'
        || path.basename(locator.avatar) !== locator.avatar || path.basename(locator.chat) !== locator.chat) {
        throw operationError('Background prompts need an open solo chat.', 409);
    }
    const profileId = typeof input.profileId === 'string' ? input.profileId : '';
    const macros = { names: { user: 'User', char: '' }, variables: {}, extra: { chat: [], chatMetadata: {} } };
    await captureLabConnection(base, { profileId, acknowledgement: input.acknowledgement, maxTokens }, macros);
    const context = capturePromptingContext(base, account, { characterAvatar: locator.avatar, connectionProfileId: profileId || undefined },
        { maxTokens, locator: { group: false, avatar: locator.avatar, chat: locator.chat } });
    return { account, context, prompt, maxTokens };
}

export async function runQuietGeneration(context, plan, { generate = runChatProfile } = {}) {
    const saved = readArtifact(context.directories, context.job.id, 'quiet-reply');
    if (saved !== undefined) return saved;
    let capture = readArtifact(context.directories, context.job.id, 'quiet-capture');
    const text = plan.context.environment?.apiType === 'tc';
    if (capture === undefined) {
        const material = promptingMaterial(context.directories, plan.context);
        const tokenCount = await promptingTokenCounter(context, plan.context, material);
        capture = await computeLab('prompting.capture', { context: plan.context, material, scene: [],
            userMessage: text ? plan.prompt : '' }, context.signal,
        { tokenCount, prepareMemory: promptingMemoryPreparation(context, plan.context, tokenCount.tokenizer) });
        writeArtifact(context.directories, context.job.id, 'quiet-capture', capture);
    }
    await context.progress({ stage: 'Writing the background reply', completed: 0, total: 1 });
    const messages = capture.messages ? [...capture.messages, { role: 'system', content: plan.prompt }]
        : [{ role: 'user', content: capture.combinedPrompt }];
    let reply;
    try {
        reply = await generate({ context: { owner: context.owner, directories: context.directories }, jobContext: context,
            binding: plan.context.binding, messages, maxTokens: plan.maxTokens, signal: context.signal, stepNamespace: 'quiet',
            macroEnvironment: createMacroEnvironment(plan.context.macros), userName: plan.context.macros.names.user,
            characterName: plan.context.macros.names.char, rawOptions: { includePreset: true, includeInstruct: !capture.combinedPrompt },
            beforeDispatch: () => withOperation(context, () => {}) });
    } catch (error) {
        if (isDefiniteProviderRefusal(error.status)) error.operationRefused = true;
        throw error;
    }
    const result = { text: typeof reply === 'string' ? reply : String(reply?.text ?? '') };
    if (!result.text.trim()) throw Object.assign(operationError('The model returned an empty reply.', 422), { operationRefused: true });
    writeArtifact(context.directories, context.job.id, 'quiet-reply', result);
    await context.progress({ stage: 'Background reply saved', completed: 1, total: 1 });
    return result;
}

registerOperation('quiet-generation', {
    label: 'Write a background reply',
    capture: captureQuietGeneration,
    run: runQuietGeneration,
});
