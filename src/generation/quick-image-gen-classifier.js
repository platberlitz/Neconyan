import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { createMacroEnvironment } from '../macros/index.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { getChatProfileContextLimit } from './profiles.js';
import { runChatProfile } from './service.js';
import { runQuickImageTextStep } from './quick-image-gen-text.js';

const invalid = (message, code = 'QIG_CLASSIFIER_INVALID') => { throw roleplayError(code, message, 409); };
const recovery = message => { throw roleplayError('QIG_RESULT_RECOVERY', message, 503); };

function classifierInstruction(draft) {
    const concepts = draft.llm.map((filter, index) => `${index + 1}. "${filter.name || '(unnamed)'}": ${filter.description}`);
    return 'Given the following scene, identify which concepts are present.\n'
        + 'Reply ONLY with the numbers of matching concepts, comma-separated. If none match, reply "none".\n\n'
        + `Scene:\n${draft.scene.slice(0, 2000)}\n\nConcepts:\n${concepts.join('\n')}`;
}

function selectedIndices(text, count) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) invalid('The saved image filter classification has no valid text.');
    const result = text.trim();
    if (/^none[.!]?$/i.test(result)) return [];
    if (!/^\d+(?:\s*[,\n]\s*\d+)*\s*[.!]?$/.test(result)) {
        invalid('The saved image filter classification did not provide numbered concepts.');
    }
    const numbers = result.match(/\d+/g).map(Number);
    if (numbers.some(value => !Number.isSafeInteger(value) || value < 1 || value > count)) {
        invalid('The saved image filter classification named an unknown concept.');
    }
    return [...new Set(numbers.map(value => value - 1))].sort((a, b) => a - b);
}

/** A separate saved model input/result prevents an unknown paid classifier outcome from becoming 'no match'. */
export async function classifySavedImageFilters(context, { base, snapshot, effectId, draft, assertSourceLocked,
    generate = runChatProfile } = {}) {
    if (!draft.llm.length) return [];
    if (snapshot.quickImageGenTextAI) {
        const result = await runQuickImageTextStep(context, { base, account: draft.account, snapshot, effectId,
            stage: 'filter-classifier', instruction: classifierInstruction(draft), beforeDispatch: assertSourceLocked,
            generate });
        return selectedIndices(result.text, draft.llm.length).map(index => draft.llm[index]);
    }
    const { directories, job } = context;
    const binding = snapshot.quickImageGenLLMBinding || snapshot.binding;
    if (!binding?.fingerprint) invalid('The saved image classifier has no bound connection.', 'QIG_CLASSIFIER_BINDING');
    const { count } = await getCounter(snapshot.tokenizer);
    const messages = [{ role: 'user', content: classifierInstruction(draft) }];
    const limit = getChatProfileContextLimit(directories, binding) ?? 8192;
    const maxTokens = Math.min(256, limit - await count(messages[0].content) - 64);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) invalid('The image classifier exceeds its bound connection context.');
    const input = { identity: draft.hash, binding, messages, maxTokens, account: draft.account };
    const name = `input:quick-image:${effectId}:filter-classifier`;
    const resultName = `quick-image:${effectId}:filter-classifier-result`;
    const withAccount = operation => withRoleplayAccount(base, draft.account, operation);
    const saved = withAccount(() => readArtifact(directories, job.id, name));
    if (saved !== undefined && roleplayHash(saved) !== roleplayHash(input)) recovery('The saved image classifier input changed.');
    if (saved === undefined) withAccount(() => writeArtifact(directories, job.id, name, input));
    const complete = withAccount(() => readArtifact(directories, job.id, resultName));
    if (complete !== undefined) {
        const { hash, ...value } = complete ?? {};
        if (value.identity !== draft.hash || hash !== roleplayHash(value)
            || !Array.isArray(value.selected) || value.selected.some(index =>
            !Number.isSafeInteger(index) || index < 0 || index >= draft.llm.length)) {
            recovery('The saved image classification needs recovery.');
        }
        return complete.selected.map(index => draft.llm[index]);
    }
    if (unresolvedProviderStep(directories, job.id)) {
        recovery('The previous paid image classification outcome is unknown and cannot be repeated.');
    }
    const response = await generate({ context: base, jobContext: context, binding, messages, maxTokens,
        signal: context.signal, stream: false, userName: snapshot.macros.names.user,
        characterName: snapshot.macros.names.char,
        macroEnvironment: createMacroEnvironment(snapshot.macros, {}, { readOnly: true }),
        rawOptions: binding.kind === 'profile' && binding.backend === 'text' ? {} : { cacheScope: 'auxiliary' },
        beforeDispatch: () => withAccount(assertSourceLocked),
        onProviderStep: step => {
            if (getJob(directories, job.id)?.resume === step && readArtifact(directories, job.id, step) === undefined) {
                recovery('The previous paid image classification outcome is unknown and cannot be repeated.');
            }
        },
    });
    const result = { identity: draft.hash, selected: selectedIndices(response?.text, draft.llm.length) };
    const completed = { ...result, hash: roleplayHash(result) };
    withAccount(() => writeArtifact(directories, job.id, resultName, completed));
    return completed.selected.map(index => draft.llm[index]);
}
