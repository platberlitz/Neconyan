import { createMacroEnvironment } from '../macros/index.js';
import { getCounter } from '../mewmory/tokens.js';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { markProviderSettled } from '../jobs/store.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { MAX_AGENT_FALLBACK_CONNECTIONS } from './agent-definition.js';
import { getChatProfileContextLimit } from './profiles.js';
import { runChatProfile } from './service.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_RECOVERY', message, 503);
const limited = result => ['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens'].includes(result.finishReason
    ?? result.response?.choices?.[0]?.finish_reason ?? result.response?.stop_reason ?? result.response?.candidates?.[0]?.finishReason);

const NO_FALLBACK_CODES = new Set(['ROLEPLAY_AGENT_RECOVERY', 'PROVIDER_OUTCOME_UNKNOWN']);

function canTryFallback(context, error) {
    return !context.signal?.aborted && error?.name !== 'AbortError' && !NO_FALLBACK_CODES.has(error?.code);
}

/**
 * Runs the Agent's own connection, then each saved fallback connection in order when the
 * previous one fails or returns nothing. Every attempt is its own saved step, and a failed
 * attempt is recorded so a restart continues with the next connection instead of repeating it.
 * Fallbacks never reuse the Agent's model override, which belongs to its own connection.
 */
export async function runAgentModelStep(context, options) {
    const primaryId = options.binding?.profileId ?? '';
    const fallbacks = (Array.isArray(options.fallbacks) ? options.fallbacks : [])
        .filter(item => item?.binding && item.binding.profileId !== primaryId).slice(0, MAX_AGENT_FALLBACK_CONNECTIONS);
    if (!fallbacks.length) return runSingleAgentModelStep(context, options);
    const lock = callback => withRoleplayAccount(options.base, options.account, callback);
    const attempts = [{ binding: options.binding, modelOverride: options.modelOverride ?? '', name: options.name, profileLabel: '' },
        ...fallbacks.map((item, index) => ({ binding: item.binding, modelOverride: '', name: `${options.name}:fallback:${index + 1}`,
            profileLabel: String(item.profileLabel || item.binding.profileId || '') }))];
    let lastError = null, emptyResult = null;
    for (const [index, attempt] of attempts.entries()) {
        const last = index === attempts.length - 1;
        const failedKey = `agent-model:${attempt.name}:failed`;
        const attemptIdentity = roleplayHash({ identity: options.identity, binding: attempt.binding, modelOverride: attempt.modelOverride, maxTokens: options.maxTokens ?? 8192 });
        const failed = lock(() => readArtifact(context.directories, context.job.id, failedKey));
        if (failed !== undefined && !last) {
            if (failed?.identity !== attemptIdentity) throw fail('The saved Agent fallback record is damaged.');
            lastError = Object.assign(new Error(String(failed.reason || 'The Agent connection failed.')), { status: failed.status });
            continue;
        }
        if (index > 0) options.assertCurrent();
        try {
            const result = await runSingleAgentModelStep(context, { ...options, ...attempt });
            const labelled = index > 0 ? { ...result, fallbackIndex: index, fallbackLabel: attempt.profileLabel } : result;
            if (labelled.text.trim() || labelled.lengthLimited || last) return labelled;
            emptyResult ??= labelled;
        } catch (error) {
            if (!canTryFallback(context, error)) throw error;
            if (last) {
                if (emptyResult) return emptyResult;
                throw error;
            }
            lastError = error;
            abandonAttempt(context, lock, attempt.name, attemptIdentity, error);
            console.warn(`[Agents] ${options.name} failed on connection ${attempt.binding?.profileId || 'main model'}; trying fallback ${index + 1}.`, error?.message ?? error);
        }
    }
    throw lastError ?? fail('Every Agent connection failed.');
}

/**
 * A failed attempt is never sent again. Its provider step, which may have no result if the
 * connection dropped, is closed as abandoned so the next connection may run.
 */
function abandonAttempt(context, lock, name, identity, error) {
    const key = `agent-model:${name}`;
    lock(() => {
        writeArtifact(context.directories, context.job.id, `${key}:failed`, { identity, reason: String(error?.message ?? error).slice(0, 2000),
            status: Number.isInteger(error?.status) ? error.status : null, failedAt: Date.now() });
        const reference = readArtifact(context.directories, context.job.id, `${key}:provider`);
        const step = reference?.identity === identity && /^provider:[a-f0-9]{64}$/.test(reference?.step) ? reference.step : '';
        if (step && readArtifact(context.directories, context.job.id, step) === undefined) {
            writeArtifact(context.directories, context.job.id, step, { abandoned: true, reason: 'fallback' });
        }
        if (step) markProviderSettled(context.directories, context.job.id, step);
    });
}

/** A single saved model call, including its exact expanded input. It never substitutes or retries a connection. */
async function runSingleAgentModelStep(context, { base, account, name, identity, binding, modelOverride = '', maxTokens = 8192,
    macros, tokenizer, fallbackContext = 8192, buildMessages, assertCurrent, generate = runChatProfile }) {
    const lock = callback => withRoleplayAccount(base, account, callback);
    const read = key => lock(() => readArtifact(context.directories, context.job.id, key));
    const save = (key, value) => lock(() => writeArtifact(context.directories, context.job.id, key, value));
    const key = `agent-model:${name}`;
    const inputIdentity = roleplayHash({ identity, binding, modelOverride, maxTokens });
    let completed = read(`${key}:result`);
    if (completed !== undefined) {
        const { hash, ...data } = completed ?? {};
        if (hash !== roleplayHash(data) || data.identity !== inputIdentity || typeof data.text !== 'string') throw fail('The saved Agent result is damaged.');
        return completed;
    }
    let input = read(`${key}:input`);
    if (input === undefined) {
        assertCurrent();
        const environment = createMacroEnvironment(macros, {}, { readOnly: true });
        const messages = buildMessages(environment);
        if (!Array.isArray(messages) || !messages.length || Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw fail('The Agent request is empty or too large.');
        const limit = lock(() => getChatProfileContextLimit(context.directories, binding)) ?? fallbackContext;
        const counter = await getCounter(tokenizer);
        const tokens = messages.reduce((sum, message) => sum + counter.count(JSON.stringify(message)) + 4, 16);
        const outputTokens = Math.min(maxTokens, limit - tokens - 64);
        if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) throw roleplayError('ROLEPLAY_AGENT_BUDGET', 'The complete Agent input does not fit its saved model context.', 409);
        const data = { identity: inputIdentity, messages, maxTokens: outputTokens, macroState: environment.captureState() };
        input = { ...data, hash: roleplayHash(data) };
        save(`${key}:input`, input);
    }
    const { hash: inputHash, ...inputData } = input ?? {};
    if (inputHash !== roleplayHash(inputData) || inputData.identity !== inputIdentity || !Array.isArray(inputData.messages)) throw fail('The saved Agent input is damaged.');
    const reference = read(`${key}:provider`);
    let response;
    if (reference !== undefined) {
        if (reference?.identity !== inputIdentity || !/^provider:[a-f0-9]{64}$/.test(reference?.step)) throw fail('The saved Agent provider reference is damaged.');
        response = read(reference.step);
    }
    if (response === undefined) {
        if (unresolvedProviderStep(context.directories, context.job.id, { scope: context.providerScope, currentStep: reference?.step })) throw fail('An uncertain provider result cannot be repeated automatically.');
        assertCurrent();
        response = await generate({ context: base, jobContext: context, binding, modelOverride, messages: input.messages, stepNamespace: key,
            maxTokens: input.maxTokens, signal: context.signal, stream: false, userName: macros.names?.user ?? 'User',
            characterName: macros.names?.char ?? 'Assistant', macroEnvironment: createMacroEnvironment(macros, {}, { readOnly: true }),
            rawOptions: binding.backend && binding.backend !== 'chat' ? {} : { cacheScope: 'auxiliary' },
            beforeDispatch: assertCurrent, onProviderStep: step => {
                if (!/^provider:[a-f0-9]{64}$/.test(step)) throw fail('The Agent provider supplied no durable request identity.');
                const next = { identity: inputIdentity, step };
                if (reference !== undefined && roleplayHash(reference) !== roleplayHash(next)) throw fail('The saved Agent provider identity changed.');
                if (unresolvedProviderStep(context.directories, context.job.id, { scope: context.providerScope, currentStep: step })) throw fail('An uncertain Agent result cannot be repeated automatically.');
                save(`${key}:provider`, next);
            } });
    }
    if (typeof response?.text !== 'string' || Buffer.byteLength(response.text) > 256 * 1024) throw fail('The Agent returned no valid bounded text result.');
    const result = { identity: inputIdentity, inputHash, text: response.text, lengthLimited: limited(response), macroState: input.macroState,
        profileId: binding.profileId ?? '', model: modelOverride || response.generation?.model || '', completedAt: Date.now() };
    completed = { ...result, hash: roleplayHash(result) };
    save(`${key}:result`, completed);
    return completed;
}
