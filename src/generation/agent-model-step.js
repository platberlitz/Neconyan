import { createMacroEnvironment } from '../macros/index.js';
import { getCounter } from '../mewmory/tokens.js';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { getChatProfileContextLimit } from './profiles.js';
import { runChatProfile } from './service.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_RECOVERY', message, 503);
const limited = result => ['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens'].includes(result.finishReason
    ?? result.response?.choices?.[0]?.finish_reason ?? result.response?.stop_reason ?? result.response?.candidates?.[0]?.finishReason);

/** A single saved model call, including its exact expanded input. It never substitutes or retries a connection. */
export async function runAgentModelStep(context, { base, account, name, identity, binding, modelOverride = '', maxTokens = 8192,
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
