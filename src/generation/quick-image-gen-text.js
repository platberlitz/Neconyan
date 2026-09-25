import { buildTextAIRequestMessages } from '../../public/scripts/extensions/quick-image-gen/lib/prompt-pipeline.js';
import { isGeneratedImageMessage } from '../../public/scripts/extensions/quick-image-gen/lib/client-orchestration.js';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { createMacroEnvironment } from '../macros/index.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { captureChatProfile, captureProfilePresetBinding, getChatProfileContextLimit } from './profiles.js';
import { runChatProfile } from './service.js';
import { imageSceneMessage } from './quick-image-gen-scene.js';

const fail = (message, code = 'QIG_TEXT_INVALID') => roleplayError(code, message, 409);
const bounded = (value, max, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > max) throw fail('A saved Text AI limit is invalid.');
    return number;
};

/** The caller holds the account lock while capturing the deliberate auxiliary connection. */
export function captureQuickImageTextSettings(directories, settings, mainBinding, records, throughIndex = null) {
    const override = settings.llmOverrideEnabled === true;
    let binding = mainBinding;
    if (override) {
        if (!settings.llmOverrideProfileId) throw fail('Choose the saved separate image Text AI profile.');
        binding = { kind: 'profile', ...captureChatProfile(directories, settings.llmOverrideProfileId) };
        binding = captureProfilePresetBinding(directories, binding, settings.llmOverridePreset || '');
    }
    if (!binding?.fingerprint) throw fail('The image Text AI needs an accepted connection.', 'QIG_CLASSIFIER_BINDING');
    const role = settings.llmRequestRole ?? 'default';
    if (!['default', 'user', 'system'].includes(role)) throw fail('The image Text AI request role is invalid.');
    const depth = override ? bounded(settings.llmOverrideChatDepth, 1000, 0) : 0;
    const maxTokens = override ? bounded(settings.llmOverrideMaxTokens, 64000, 500) || 500 : 1024;
    const selected = records.slice(1, throughIndex === null ? undefined : throughIndex + 2);
    const history = depth ? selected.filter(record => record && !record.is_system && !isGeneratedImageMessage(record))
        .map(record => ({ role: record.is_user ? 'user' : 'assistant', content: `${record.name || (record.is_user ? 'User' : 'Character')}: ${imageSceneMessage(record)}` }))
        .filter(record => record.content.split(': ').slice(1).join(': ').trim()).slice(-depth) : [];
    if (typeof (settings.llmPrefill ?? '') !== 'string' || Buffer.byteLength(settings.llmPrefill || '') > 64 * 1024) throw fail('The image Text AI prefill is invalid.');
    return { binding, role, history, maxTokens, prefill: settings.llmPrefill || '', override };
}

/** Save each standalone model pass and its provider key before any paid request. */
export async function runQuickImageTextStep(context, { base, account, effectId, stage, instruction, snapshot,
    textAI = snapshot.quickImageGenTextAI, prefill = '', beforeDispatch, generate = runChatProfile } = {}) {
    if (!textAI?.binding?.fingerprint || !/^[a-z-]{1,40}$/.test(stage) || !effectId || effectId.length > 128
        || typeof instruction !== 'string' || !instruction.trim()) throw fail('The accepted image Text AI step is incomplete.');
    const withAccount = operation => withRoleplayAccount(base, account, operation);
    const name = `quick-image-text:${effectId}:${stage}`;
    const identity = roleplayHash({ effectId, stage, instruction, textAI, prefill, macros: snapshot.macros, account });
    const checked = (saved, expected) => {
        const { hash, ...data } = saved ?? {};
        if (hash !== roleplayHash(data) || data.identity !== expected) throw fail('The saved image Text AI evidence changed.', 'QIG_RESULT_RECOVERY');
        return data;
    };
    const completed = withAccount(() => readArtifact(context.directories, context.job.id, `${name}:result`));
    if (completed !== undefined) {
        const data = checked(completed, identity);
        if (typeof data.text !== 'string' || !data.text.trim() || Buffer.byteLength(data.text) > 256 * 1024) throw fail('The saved image Text AI result is invalid.', 'QIG_RESULT_RECOVERY');
        return data;
    }
    let input = withAccount(() => readArtifact(context.directories, context.job.id, `input:${name}`));
    if (input !== undefined) input = checked(input, identity);
    else {
        withAccount(lease => beforeDispatch?.(lease));
        const environment = createMacroEnvironment(snapshot.macros, {}, { readOnly: true });
        const resolve = text => environment.evaluate(text, { strictCapabilities: true });
        const resolvedPrefill = resolve(prefill);
        const messages = buildTextAIRequestMessages(instruction, { role: textAI.role,
            history: textAI.history.map(message => ({ ...message, content: resolve(message.content) })), prefill: resolvedPrefill });
        const { count } = await getCounter(snapshot.tokenizer);
        const available = withAccount(() => getChatProfileContextLimit(context.directories, textAI.binding)) ?? 8192;
        const maxTokens = Math.min(textAI.maxTokens, available - await count(JSON.stringify(messages)) - 64);
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw fail('The image Text AI request exceeds the saved connection context.');
        input = { identity, messages, maxTokens, prefill: resolvedPrefill, binding: textAI.binding };
        if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) throw fail('The saved image Text AI input is too large.');
        withAccount(lease => {
            beforeDispatch?.(lease);
            writeArtifact(context.directories, context.job.id, `input:${name}`, { ...input, hash: roleplayHash(input) });
        });
    }
    const reference = withAccount(() => readArtifact(context.directories, context.job.id, `${name}:provider`));
    let response;
    if (reference !== undefined) {
        if (reference.identity !== identity || !/^provider:[a-f0-9]{64}$/.test(reference.step)) throw fail('The saved image Text AI provider reference is invalid.', 'QIG_RESULT_RECOVERY');
        response = withAccount(() => readArtifact(context.directories, context.job.id, reference.step));
    }
    if (response === undefined) {
        if (unresolvedProviderStep(context.directories, context.job.id)) throw fail('The previous image Text AI outcome is unknown; it cannot be repeated.', 'QIG_RESULT_RECOVERY');
        response = await generate({ context: base, jobContext: context, binding: input.binding, messages: input.messages,
            maxTokens: input.maxTokens, signal: context.signal, stream: false,
            userName: snapshot.macros.names.user, characterName: snapshot.macros.names.char,
            macroEnvironment: createMacroEnvironment(snapshot.macros, {}, { readOnly: true }),
            rawOptions: input.binding.backend && input.binding.backend !== 'chat' ? {} : { cacheScope: 'auxiliary' },
            beforeDispatch: () => withAccount(lease => beforeDispatch?.(lease)),
            onProviderStep: step => withAccount(() => {
                if (!/^provider:[a-f0-9]{64}$/.test(step) || reference && reference.step !== step) throw fail('The image Text AI provider step changed.', 'QIG_RESULT_RECOVERY');
                if (unresolvedProviderStep(context.directories, context.job.id)) throw fail('The previous image Text AI result is unknown.', 'QIG_RESULT_RECOVERY');
                writeArtifact(context.directories, context.job.id, `${name}:provider`, { identity, step });
            }),
        });
    }
    if (typeof response?.text !== 'string' || !response.text.trim() || Buffer.byteLength(response.text) > 256 * 1024) throw fail('The image Text AI returned no usable text.');
    const result = { identity, text: response.text, prefill: input.prefill };
    withAccount(() => writeArtifact(context.directories, context.job.id, `${name}:result`, { ...result, hash: roleplayHash(result) }));
    return result;
}
