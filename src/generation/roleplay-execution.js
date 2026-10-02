import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';
import { supportsChatImages, supportsChatTools, supportsChatSignatures } from '../../public/scripts/chat-input-capabilities.js';
import { prepareRoleplayCapabilities } from './roleplay-capabilities.js';
import { getChatImageTokenCost } from '../../public/scripts/chat-prompt-tokens.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { registerHandler } from '../jobs/runner.js';
import { getJob, setJobResume } from '../jobs/store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { runChatProfile } from './service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { applyRoleplayJobEffect, assertRoleplayCandidateOwner, completeRoleplayCandidateJob, readRoleplayJobResult } from '../roleplay-jobs.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { extractProviderReasoning, extractProviderReasoningSignature } from '../../public/scripts/generation-format.js';
import { assertRoleplayWorldInfoCurrent, prepareRoleplayWorldInfo } from './world-info.js';
import { assertWorldInfoDepthHistory, roleplayEffectTrigger, roleplayMacroCapabilities, savedRoleplayMacroSnapshot, selectRoleplayPromptRecords, prepareRoleplayHistoryContent, buildRoleplaySavedHistory, insertWorldInfoAuthorNote, insertWorldInfoDepth, insertWorldInfoExamples, insertWorldInfoOutlets, isWorldInfoAuthorNoteActive } from './roleplay-prompt.js';
import { getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { getCounter } from '../mewmory/tokens.js';
import { createRoleplayLoreMacros } from './roleplay-lore-macros.js';
import { assembleRoleplayChatPrompt } from './roleplay-chat-prompt.js';
import { prepareMewmoryPrompt } from '../mewmory/prepare.js';
import { recallInBackground } from '../mewmory/retrieval.js';
import { loadCurrentStateSync } from '../mewmory/sources.js';
import { mutateState, normalizeLocator, readChat } from '../mewmory/store.js';
import { generationFingerprint } from '../mewmory/context.js';
import { readConfig } from '../mewmory/models.js';
import { createRoleplayChatCounter, createRoleplayTextCounter } from './roleplay-budget.js';
import { createRoleplayTextPrompt } from './roleplay-text-prompt.js';
import { readRoleplayPromptContributions } from './roleplay-contributions.js';
import { inject_ids } from '../../public/scripts/constants.js';
import { worldInfoActivationActions } from './world-info-hook-policy.js';
import { runBoundPathfinderRetrieval } from './pathfinder-retrieval.js';
import { prepareRoleplayInputTranslation, translateIncomingRoleplayOutput } from './roleplay-translation.js';
import { prepareRoleplayQuickReplies } from './roleplay-quick-replies.js';
import { roleplayPromptContentHash } from './roleplay-prompt-proof.js';
import { generateSavedSpeech } from './speech-jobs.js';
import { prepareRoleplayCaptions } from './roleplay-captions.js';
import { applyCaptionRecords } from './caption-records.js';
import { prepareRoleplayAgentContributions, runRoleplayAgentInterceptors, runRoleplayAgentPostprocessing, roleplayAgentOutputBaseline } from './roleplay-agent-processing.js';
import { runRoleplayCompanions } from './roleplay-companions.js';
import { createProviderScope } from '../jobs/artifacts.js';
import { stageBoundModelToolCalls } from './roleplay-tool-dispatch.js';
import { publishRoleplayPreview } from './roleplay-preview.js';
import { applyRoleplayVectorFiles, prepareRoleplayVectors } from './roleplay-vectors.js';
import { prepareRoleplayNoteContext } from '../notebooks/context.js';

const MAX_REPLY_BYTES = 256 * 1024;
const REQUEST_OVERRIDES = new Set(['temperature', 'top_p', 'top_k', 'min_p', 'seed', 'frequency_penalty',
    'presence_penalty', 'repetition_penalty', 'stop', 'stopping_strings']);

function requestOverrides(request) {
    const overrides = request.overridePayload ?? {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.entries(overrides).some(([key, value]) => !REQUEST_OVERRIDES.has(key)
            || (['stop', 'stopping_strings'].includes(key) ? !Array.isArray(value) || value.length > 32
                || value.some(item => typeof item !== 'string' || item.length > 256)
                : typeof value !== 'number' || !Number.isFinite(value)))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Use saved connection settings for unsupported request controls or authentication.', 400);
    }
    return overrides;
}

function replyOutput(result, effect, name, material) {
    const text = result?.text;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_REPLY_BYTES) {
        throw roleplayError('ROLEPLAY_INVALID', 'The generated Roleplay reply is empty or too large.', 502);
    }
    const response = result.response;
    const controls = { mainApi: material?.backend === 'text' ? 'textgenerationwebui' : 'openai',
        textGenType: material?.source, chatCompletionSource: material?.source,
        showThoughts: material?.backend === 'text' || material?.showThoughts };
    const reasoning = material ? extractProviderReasoning(response, controls) : response?.choices?.[0]?.message?.reasoning_content
        ?? response?.choices?.[0]?.message?.reasoning ?? response?.thinking
        ?? response?.content?.filter?.(part => part.type === 'thinking').map(part => part.thinking).join('\n\n');
    if (typeof reasoning === 'string' && Buffer.byteLength(reasoning) > MAX_REPLY_BYTES) {
        throw roleplayError('ROLEPLAY_INVALID', 'The generated Roleplay reasoning is too large.', 502);
    }
    const signature = material && extractProviderReasoningSignature(response, controls);
    if (typeof signature === 'string' && Buffer.byteLength(signature) > MAX_REPLY_BYTES) {
        throw roleplayError('ROLEPLAY_INVALID', 'The generated Roleplay signature is too large.', 502);
    }
    const extra = { ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}), ...(signature ? { reasoning_signature: signature } : {}) };
    if (effect === 'append') return { message: { name, is_user: false, mes: text, extra } };
    if (effect === 'replace') return { messages: [{ name, is_user: false, mes: text, extra }] };
    return { text, extra };
}

/** A private worker for a fully admitted, paused Roleplay job; browser cutover is a later stage. */
export async function runRoleplayReplyJob(context, { generate = runChatProfile, host = roleplayNativeHost,
    worldInfoHooks, modelCatalogue, contextLimit = getChatProfileContextLimit, promptBackend = resolveGenerationProfile,
    generatePathfinder, translationFetch, captionFetch, localCaption, captionWait, speechDependencies, generateAgent, agentRandom } = {}) {
    const { job, directories, owner, signal } = context;
    const { roleplay, effect, source, request } = job.intent ?? {};
    const base = { owner, directories };
    const account = roleplay && { accountId: roleplay.accountId, dataEpoch: roleplay.dataEpoch };
    if (!account || !source || !request || typeof roleplay.operationKey !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'The accepted Roleplay request is missing.', 409);
    }
    const completedReceipt = readRoleplayJobResult(base, account, {
        operationKey: roleplay.operationKey, jobId: job.id, effect, source, request,
    });
    if (completedReceipt !== null) return { result: completedReceipt };
    if (job.type === 'roleplay.candidate' && (request.workflowCandidate?.version !== 1 || !request.serverPrompt)) {
        throw roleplayError('ROLEPLAY_INVALID', 'A workflow candidate requires a bound native Roleplay request.', 409);
    }
    if (job.type === 'roleplay.candidate') {
        assertRoleplayCandidateOwner(base, account, { operationKey: roleplay.operationKey, jobId: job.id });
    }
    const assertSource = () => {
        signal.throwIfAborted();
        return withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, source, { effect }));
    };
    const finish = async (result, selection) => {
        const saveCandidate = (kind, contents) => {
            const reference = readArtifact(directories, job.id, 'roleplay-main-provider');
            const providerResult = reference?.step && readArtifact(directories, job.id, reference.step);
            if (!providerResult || roleplayHash(providerResult) !== roleplayHash(result)) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The candidate needs its saved provider result.', 503);
            }
            const value = { intentHash: roleplayHash(job.intent), kind, providerHash: roleplayHash(result), ...contents };
            const saved = readArtifact(directories, job.id, 'roleplay-candidate');
            if (saved !== undefined) {
                const { hash, ...savedValue } = saved;
                if (hash !== roleplayHash(savedValue) || roleplayHash(savedValue) !== roleplayHash(value)) {
                    throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The candidate result changed after it was saved.', 503);
                }
            }
            if (saved === undefined) writeArtifact(directories, job.id, 'roleplay-candidate', { ...value, hash: roleplayHash(value) });
            return { result: completeRoleplayCandidateJob(base, account, { operationKey: roleplay.operationKey, jobId: job.id }) };
        };
        if (job.type === 'roleplay.candidate' && (result?.response?.choices?.[0]?.message?.tool_calls?.length
            || result?.response?.content?.some?.(part => part.type === 'tool_use')
            || result?.response?.output?.some?.(part => part.type === 'function_call')
            || result?.response?.candidates?.some?.(candidate => candidate.content?.parts?.some(part => part.functionCall)))) {
            const staged = stageBoundModelToolCalls(context);
            return saveCandidate('tool-turn', { callsHash: staged.hash });
        }
        if (result?.response?.choices?.[0]?.message?.tool_calls?.length
                || result?.response?.content?.some?.(part => part.type === 'tool_use')
                || result?.response?.output?.some?.(part => part.type === 'function_call')
                || result?.response?.candidates?.some?.(candidate => candidate.content?.parts?.some(part => part.functionCall))) {
            throw roleplayError('ROLEPLAY_TOOLS_PENDING', 'The saved provider result needs the native tool workflow before a reply can be written.', 409);
        }
        const output = replyOutput(result, effect, request.characterName, result.generation);
        publishRoleplayPreview(context, { text: result.text, reasoning: output.extra?.reasoning ?? output.message?.extra?.reasoning ?? '', stage: 'agents' });
        if (request.worldInfo?.captions?.persist) {
            const { hash, ...captions } = readArtifact(directories, job.id, 'roleplay-captions') ?? {};
            if (hash !== roleplayHash(captions) || !Array.isArray(captions.results)) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved caption completion needs recovery.', 503);
            }
            output.captions = captions.results;
        }
        if (request.worldInfo?.inputTranslation) {
            const { hash, ...translation } = readArtifact(directories, job.id, 'roleplay-input-translation') ?? {};
            if (hash !== roleplayHash(translation) || typeof translation.text !== 'string' || typeof translation.displayText !== 'string') {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved user translation needs recovery.', 503);
            }
            output.inputTranslation = { ...request.worldInfo.inputTranslation.item, text: translation.text, displayText: translation.displayText };
        }
        if (request.worldInfo?.hookPolicy?.quickReply?.enabled) {
            const selection = readArtifact(directories, job.id, 'roleplay-world-info');
            if (selection?.hookEvents?.actions?.length) {
                const receipt = readArtifact(directories, job.id, 'roleplay-quick-replies');
                const { hash, ...data } = receipt ?? {};
                if (hash !== roleplayHash(data) || !Array.isArray(data.changes) || !Array.isArray(data.actions)) {
                    throw roleplayError('ROLEPLAY_QUICK_REPLY_RECOVERY', 'The saved Quick Reply actions need recovery.', 503);
                }
                output.quickReply = { actions: data.actions, changes: data.changes, hash };
            }
        }
        if (request.worldInfo?.agents) {
            const current = assertSource();
            let records = selectRoleplayPromptRecords(current.records, source, effect);
            if (output.captions) records = applyCaptionRecords(records, request.worldInfo.captions.items, output.captions);
            if (output.inputTranslation) {
                records = structuredClone(records);
                const record = records[output.inputTranslation.index + 1];
                record.mes = output.inputTranslation.text;
                record.extra = { ...record.extra, display_text: output.inputTranslation.displayText };
            }
            const message = output.message ?? output.messages?.[0] ?? output;
            const value = effect === 'continue' ? String(current.records[source.message.index + 1].mes ?? '') + output.text : message.mes ?? output.text;
            const baseData = { intentHash: roleplayHash(job.intent), recordsHash: roleplayHash(records), value };
            const baseProof = { ...baseData, hash: roleplayHash(baseData) };
            withRoleplayAccount(base, account, () => {
                const previous = readArtifact(directories, job.id, 'roleplay-agent-output-base');
                if (previous !== undefined && roleplayHash(previous) !== roleplayHash(baseProof)) throw roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The saved Agent response source changed.', 409);
                if (previous === undefined) writeArtifact(directories, job.id, 'roleplay-agent-output-base', baseProof);
            });
            const options = { base, snapshot: request.worldInfo, records, metadataRecords: current.records, binding: request.binding,
                macros: savedRoleplayMacroSnapshot(request.worldInfo, records), generationType: request.worldInfo.global.trigger,
                assistantName: request.characterName, assertCurrent: () => { assertSource(); assertRoleplayWorldInfoCurrent(base, request.worldInfo); }, generate: generateAgent };
            const intercepted = await runRoleplayAgentInterceptors(context, { ...options, value, timing: 'post-main-generation', format: 'text' });
            if (intercepted.waiting) {
                publishRoleplayPreview(context, { stage: 'review' });
                return { waiting: true, approval: intercepted.approval };
            }
            const pre = readArtifact(directories, job.id, 'roleplay-agents-pre');
            let post, companions;
            if (request.worldInfo.agents.concurrentCompanions) {
                const shared = { ...context, providerScope: createProviderScope(context) };
                const settled = await Promise.allSettled([
                    runRoleplayAgentPostprocessing(shared, { ...options, value: intercepted.value }).then(post => {
                        publishRoleplayPreview(context, { text: post.text, stage: 'companions' });
                        return post;
                    }),
                    runRoleplayCompanions(shared, { ...options, effect, value: roleplayAgentOutputBaseline(intercepted.value, pre) }),
                ]);
                const failure = settled.find(item => item.status === 'rejected');
                if (failure) throw failure.reason;
                [post, companions] = settled.map(item => item.value);
            } else {
                post = await runRoleplayAgentPostprocessing(context, { ...options, value: intercepted.value });
                publishRoleplayPreview(context, { text: post.text, stage: 'companions' });
                companions = await runRoleplayCompanions(context, { ...options, effect, value: post.text });
            }
            if (effect === 'continue') output.continuedText = post.text;
            else if (message.mes !== undefined) message.mes = post.text;
            else output.text = post.text;
            message.extra = { ...message.extra, ...post.extra };
            if (Object.keys(companions.results).length) message.extra.inChatAgentCompanionResults = companions.results;
            const preIntercept = readArtifact(directories, job.id, 'roleplay-agent-intercepts:pre-generation');
            if (preIntercept?.runs?.length || intercepted.runs.length) message.extra.inChatAgentPreGenerationInterceptHistory = [...(preIntercept?.runs ?? []), ...intercepted.runs];
            output.agentProof = { pre: pre.hash, base: baseProof.hash, intercepts: intercepted.hash, post: post.hash, companions: companions.hash };
        }
        if (request.worldInfo?.translation) {
            publishRoleplayPreview(context, { stage: 'translating' });
            await translateIncomingRoleplayOutput(context, { base, snapshot: request.worldInfo,
                effect: { type: effect }, output, assertSource, fetchImpl: translationFetch ?? fetch });
        }
        if (request.worldInfo?.speech) {
            publishRoleplayPreview(context, { stage: 'speech' });
            const speechRecords = assertSource().records;
            const message = output.message ?? output.messages?.[0] ?? output;
            const text = effect === 'continue' ? output.continuedText ?? String(speechRecords[source.message.index + 1].mes ?? '') + output.text : message.mes ?? output.text;
            const narration = await generateSavedSpeech(context, { effectId: 'roleplay', policy: request.worldInfo.speech, account,
                text, displayText: message.extra?.display_text || '', speaker: { name: request.characterName, avatar: request.worldInfo.avatar },
                snapshot: { macros: savedRoleplayMacroSnapshot(request.worldInfo, selectRoleplayPromptRecords(speechRecords, source, effect)) },
                assertSourceLocked: lease => assertRoleplaySourceLocked(lease, source, { effect }),
            }, speechDependencies);
            if (narration) message.extra = { ...message.extra, server_narration: narration };
        }
        if (selection && roleplayHash({ sticky: {}, cooldown: {}, ...request.worldInfo.metadata.timedWorldInfo }) !== roleplayHash(selection.timedWorldInfo)) {
            output.timedWorldInfo = selection.timedWorldInfo;
            output.timedBaseline = selection.timedBaseline;
            output.timedChatLength = request.worldInfo.savedChatLength ?? selection.chatLength;
        }
        publishRoleplayPreview(context, { text: output.continuedText ?? output.text ?? output.message?.mes ?? output.messages?.[0]?.mes, stage: 'saving' });
        if (job.type === 'roleplay.candidate') return saveCandidate('text', { output });
        writeArtifact(directories, job.id, 'roleplay-output', output);
        setJobResume(directories, job.id, 'roleplay-delivery');
        signal.throwIfAborted();
        return { result: applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output }, host) };
    };
    const saved = readArtifact(directories, job.id, 'roleplay-output');
    if (saved !== undefined) {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay result needs recovery.', 503);
        }
        const result = applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output: saved }, host);
        return { result };
    }
    const providerReference = readArtifact(directories, job.id, 'roleplay-main-provider');
    if (providerReference !== undefined) {
        if (!providerReference || providerReference.intentHash !== roleplayHash(job.intent)
            || !/^provider:[a-f0-9]{64}$/.test(providerReference.step)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay provider reference needs recovery.', 503);
        }
        const completed = readArtifact(directories, job.id, providerReference.step);
        const result = request.binding?.backend === 'horde' && completed?.id
            ? readArtifact(directories, job.id, 'horde-result:' + providerReference.step.slice(9)) : completed;
        if (result !== undefined && typeof result?.text === 'string') {
            const prompt = request.serverPrompt && readArtifact(directories, job.id, 'roleplay-prompt');
            const selection = request.worldInfo && readArtifact(directories, job.id, 'roleplay-world-info');
            const retrieval = request.worldInfo?.pathfinder && readArtifact(directories, job.id, 'roleplay-pathfinder');
            const { hash: retrievalHash, ...retrievalData } = retrieval ?? {};
            const captions = request.worldInfo?.captions && readArtifact(directories, job.id, 'roleplay-captions');
            const { hash: captionsHash, ...captionsData } = captions ?? {};
            const inputTranslation = request.worldInfo?.inputTranslation && readArtifact(directories, job.id, 'roleplay-input-translation');
            const { hash: inputTranslationHash, ...inputTranslationData } = inputTranslation ?? {};
            const agentPre = request.worldInfo?.agents && readArtifact(directories, job.id, 'roleplay-agents-pre');
            const { hash: agentsHash, ...agentsData } = agentPre ?? {};
            const agentIntercept = request.worldInfo?.agents && readArtifact(directories, job.id, 'roleplay-agent-intercepts:pre-generation');
            const { hash: agentInterceptHash, ...agentInterceptData } = agentIntercept ?? {};
            const quickReply = request.worldInfo?.hookPolicy?.quickReply?.enabled && readArtifact(directories, job.id, 'roleplay-quick-replies');
            const { hash: quickReplyHash, ...quickReplyData } = quickReply ?? {};
            const vectors = request.worldInfo?.vectors && readArtifact(directories, job.id, 'roleplay-vectors');
            const { hash: vectorsHash, ...vectorsData } = vectors ?? {};
            if (request.serverPrompt && (!prompt || prompt.hash !== providerReference.promptHash
                || prompt.hash !== roleplayPromptContentHash(prompt, request.worldInfo, { quickReply: Boolean(quickReply) }))
                || quickReply && (quickReplyHash !== roleplayHash(quickReplyData) || prompt.quickReplyHash !== quickReplyHash)
                || request.worldInfo?.vectors && (!vectors || vectorsHash !== roleplayHash(vectorsData) || prompt.vectorsHash !== vectorsHash)
                || request.worldInfo?.pathfinder && (!retrieval || retrievalHash !== roleplayHash(retrievalData)
                    || prompt.pathfinderHash !== retrievalHash)
                || request.worldInfo?.captions && (!captions || captionsHash !== roleplayHash(captionsData)
                    || prompt.captionsHash !== captionsHash)
                || request.worldInfo?.inputTranslation && (!inputTranslation || inputTranslationHash !== roleplayHash(inputTranslationData)
                    || prompt.inputTranslationHash !== inputTranslationHash)
                || request.worldInfo?.agents && (!agentPre || agentsHash !== roleplayHash(agentsData) || prompt.agentsHash !== agentsHash
                    || !agentIntercept || agentInterceptHash !== roleplayHash(agentInterceptData) || prompt.agentInterceptHash !== agentInterceptHash)
                || request.worldInfo && (!selection || providerReference.worldInfoHash !== roleplayHash(selection))) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The completed Roleplay request has missing prompt evidence.', 503);
            }
            return finish(result, selection);
        }
        if (completed === undefined && getJob(directories, job.id)?.resume === providerReference.step) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The previous provider outcome is unknown. It cannot be repeated automatically.', 503);
        }
    }
    if (!request.binding || !Array.isArray(request.messages) || !Number.isSafeInteger(request.maxTokens)
        || request.maxTokens < 1 || request.maxTokens > 64000 || typeof request.characterName !== 'string'
        || !request.characterName || (request.stream !== undefined && typeof request.stream !== 'boolean')
        || (request.serverPrompt !== undefined && typeof request.serverPrompt !== 'boolean')
        || (request.modelOverride !== undefined && (typeof request.modelOverride !== 'string' || request.modelOverride.length > 256))
        || Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) {
        throw roleplayError('ROLEPLAY_INVALID', 'The accepted Roleplay generation input is invalid.', 400);
    }
    const overridePayload = requestOverrides(request);
    publishRoleplayPreview(context, { text: '', reasoning: '', stage: 'preparing' });
    const initialSource = assertSource();
    let initialRecords = request.serverPrompt ? selectRoleplayPromptRecords(initialSource.records, source, effect) : initialSource.records;
    let captions;
    let inputTranslation;
    let agentPre;
    let quickReply;
    let vectors;
    if (request.serverPrompt && initialRecords.length !== initialSource.records.length && request.worldInfo?.serverPrompt !== true) {
        throw roleplayError('ROLEPLAY_INVALID', 'Capture server prompt inputs for the selected saved message or range.', 409);
    }
    let contributions = request.serverPrompt ? readRoleplayPromptContributions(context) : { extensions: [], history: [] };
    const boundNativeTools = Boolean(request.serverPrompt && request.worldInfo?.nativeBindingVersion);
    const acceptedTools = boundNativeTools ? request.worldInfo?.tools?.definitions ?? [] : contributions.tools ?? [];
    if (boundNativeTools && contributions.tools?.length
        && roleplayHash(contributions.tools) !== roleplayHash(acceptedTools)) {
        throw roleplayError('ROLEPLAY_TOOL_INVALID', 'Browser-supplied tools are not bound native actions.', 409);
    }
    const functionTools = effect === 'continue' ? [] : acceptedTools;
    const toolBudget = functionTools.length ? [{ role: 'user', content: JSON.stringify({ tools: functionTools, tool_choice: 'auto' }) }] : [];
    let scanContributions = contributions.extensions.filter(prompt => prompt.scan).map(prompt => prompt.content);
    const boundMaterial = request.serverPrompt ? promptBackend(directories, request.binding) : null;
    if (boundMaterial) boundMaterial.power = { ...request.worldInfo?.promptSettings, ...boundMaterial.power };
    let characterScope = {};
    const boundMacroSnapshot = snapshot => ({ ...snapshot,
        system: { ...snapshot.system, model: request.modelOverride || boundMaterial?.profile?.model || '' },
        extra: { ...snapshot.extra, ...characterScope, ...(boundMaterial && { powerUser: { ...boundMaterial.power,
            instruct: boundMaterial.instruct ?? boundMaterial.power?.instruct, context: boundMaterial.context ?? boundMaterial.power?.context },
        mainApi: !boundMaterial.backend || boundMaterial.backend === 'chat' ? 'openai'
            : boundMaterial.backend === 'text' ? 'textgenerationwebui' : boundMaterial.backend }) } });
    let acceptedMacros = request.macros || {};
    let preparedHistory;
    let worldInfo;
    if (request.worldInfo) {
        const limit = contextLimit(directories, request.binding);
        if (!Number.isSafeInteger(limit) || limit <= request.maxTokens
            || !Number.isSafeInteger(request.worldInfo.maxContext)
            || request.worldInfo.maxContext < 1 || request.worldInfo.maxContext > limit - request.maxTokens) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info exceeds the bound connection prompt budget.', 409);
        }
        if (request.worldInfo.account?.accountId !== account.accountId
            || request.worldInfo.account?.dataEpoch !== account.dataEpoch
            || roleplayHash(request.worldInfo.source) !== roleplayHash(source)
            || (!source.locator.group && request.worldInfo.avatar !== source.locator.avatar)
            || request.worldInfo.global?.trigger !== roleplayEffectTrigger(effect)) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info must belong to the admitted Roleplay source.', 409);
        }
        assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        if (request.serverPrompt) characterScope = withRoleplayAccount(base, account, lease => {
            assertRoleplaySourceLocked(lease, source, { effect });
            const character = readRoleplayEntityLocked(lease, 'character', request.worldInfo.avatar);
            if (roleplayHash({ instanceId: character.instanceId, revision: character.revision, rawHash: character.rawHash })
                !== roleplayHash(request.worldInfo.character)) {
                throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The captured Roleplay character changed.', 409);
            }
            // Output transformations need the same protected speaker as the prompt,
            // including when replaying an already accepted request.
            return { characterAvatar: request.worldInfo.avatar, character: character.data?.data ?? character.data };
        });
        if (request.serverPrompt) acceptedMacros = boundMacroSnapshot(savedRoleplayMacroSnapshot(request.worldInfo, initialRecords));
        if (!Array.isArray(request.worldInfo.hookPolicy?.pathfinder)
            || request.worldInfo.hookPolicy.pathfinder.length && (!request.serverPrompt || !request.worldInfo.pathfinder)) {
            throw roleplayError('ROLEPLAY_INVALID', 'Enabled Pathfinder retrieval needs server-owned pre-scan execution.', 409);
        }
        if (!Array.isArray(request.worldInfo.hookPolicy.scanContributors)
            || request.worldInfo.hookPolicy.scanContributors.some(item => item.kind === 'vectors'
                ? !request.serverPrompt || !request.worldInfo.vectors : item.kind !== 'agent' || !request.serverPrompt || !request.worldInfo.agents)) {
            throw roleplayError('ROLEPLAY_INVALID', 'Enabled vector or Agent scan contributions need server-owned preparation.', 409);
        }
        if (request.serverPrompt) {
            if (request.worldInfo.captions) {
                captions = await prepareRoleplayCaptions(context, { base, snapshot: request.worldInfo, records: initialRecords,
                    macros: acceptedMacros, assertCurrent: () => { assertSource(); assertRoleplayWorldInfoCurrent(base, request.worldInfo); },
                    fetchImpl: captionFetch, localCaption, wait: captionWait });
                initialRecords = captions.records;
                acceptedMacros = boundMacroSnapshot(savedRoleplayMacroSnapshot(request.worldInfo, initialRecords));
            }
            if (request.worldInfo.inputTranslation) {
                inputTranslation = await prepareRoleplayInputTranslation(context, { base, snapshot: request.worldInfo,
                    records: initialRecords, assertSource, fetchImpl: translationFetch ?? fetch });
                initialRecords = inputTranslation.records;
                acceptedMacros = boundMacroSnapshot(savedRoleplayMacroSnapshot(request.worldInfo, initialRecords));
            }
            if (request.worldInfo.vectors) {
                vectors = await prepareRoleplayVectors(context, { snapshot: request.worldInfo, source, records: initialRecords,
                    macros: acceptedMacros, binding: request.binding, maxTokens: request.maxTokens, contextLimit: limit });
                if (vectors.waiting) return vectors;
                const keys = new Set(contributions.extensions.map(item => item.key));
                const additions = vectors.projection.extensions.map(item => ({ key: item.key, content: item.value,
                    position: item.position, depth: item.depth, role: ['system', 'user', 'assistant'][item.role], scan: item.scan }));
                if (additions.some(item => keys.has(item.key))) throw roleplayError('ROLEPLAY_INVALID', 'A vector prompt conflicts with an existing contributor.', 409);
                contributions = { ...contributions, extensions: [...contributions.extensions, ...additions] };
                scanContributions = contributions.extensions.filter(item => item.scan).map(item => item.content);
                initialRecords = applyRoleplayVectorFiles(initialRecords, vectors.projection);
                acceptedMacros = boundMacroSnapshot(savedRoleplayMacroSnapshot(request.worldInfo, initialRecords));
            }
            if (request.worldInfo.agents) {
                agentPre = prepareRoleplayAgentContributions(context, { base, snapshot: request.worldInfo, records: initialRecords,
                    policyRecords: initialSource.records, macros: acceptedMacros, generationType: request.worldInfo.global.trigger, random: agentRandom,
                    assertCurrent: () => { assertSource(); assertRoleplayWorldInfoCurrent(base, request.worldInfo); } });
                const keys = new Set(contributions.extensions.map(item => item.key));
                if (agentPre.extensions.some(item => keys.has(item.key))) throw roleplayError('ROLEPLAY_INVALID', 'An Agent prompt key conflicts with an existing contributor.', 409);
                contributions = { ...contributions, extensions: [...contributions.extensions, ...agentPre.extensions] };
                scanContributions = contributions.extensions.filter(prompt => prompt.scan).map(prompt => prompt.content);
            }
            const noteContext = prepareRoleplayNoteContext({ directories, job, base, account, source, snapshot: request.worldInfo,
                records: initialRecords, limit, maxTokens: request.maxTokens });
            if (noteContext) {
                if (contributions.extensions.some(item => item.key === noteContext.key)) {
                    throw roleplayError('ROLEPLAY_INVALID', 'A notebook prompt conflicts with an existing contributor.', 409);
                }
                contributions = { ...contributions, extensions: [...contributions.extensions, noteContext] };
            }
            const identity = roleplayHash({ snapshot: request.worldInfo, records: initialRecords, contributions });
            preparedHistory = readArtifact(directories, job.id, 'roleplay-history-input');
            if (preparedHistory === undefined) {
                if (readArtifact(directories, job.id, 'roleplay-world-info') !== undefined) {
                    throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved scan has lost its prepared history evidence.', 503);
                }
                const environment = createMacroEnvironment(acceptedMacros, roleplayMacroCapabilities(request.worldInfo, boundMaterial,
                    request.maxTokens, limit, () => environment));
                const historySnapshot = vectors ? { ...request.worldInfo, attachments: request.worldInfo.attachments
                    .filter(item => !vectors.projection.files.some(file => file.index === item.index)) } : request.worldInfo;
                const { content, reasoning, global, characterExamples, authorNote, depthPrompt, depthPrompts, worldInfoContent, companionHostIndex } = prepareRoleplayHistoryContent(initialRecords, historySnapshot, environment, agentPre?.history);
                const scanContent = worldInfoContent ?? content;
                const promptChat = initialRecords.slice(1).flatMap((record, index) => vectors?.projection.removed.some(item => item.index === index) || record.is_system && index !== companionHostIndex
                    || !scanContent[index].trim() && !record.extra?.media?.length ? [] : [
                        request.worldInfo.settings.world_info_include_names ? `${record.name}: ${scanContent[index]}` : scanContent[index],
                    ]).reverse();
                const data = { identity, content, reasoning, global, characterExamples, authorNote, depthPrompt, ...(depthPrompts ? { depthPrompts } : {}),
                    ...(worldInfoContent ? { worldInfoContent } : {}), ...(companionHostIndex !== undefined ? { companionHostIndex } : {}), promptChat, macroState: environment.captureState() };
                preparedHistory = { ...data, hash: roleplayHash(data) };
                writeArtifact(directories, job.id, 'roleplay-history-input', preparedHistory);
            }
            const { hash, ...data } = preparedHistory ?? {};
            if (data.identity !== identity || !Array.isArray(data.content) || data.content.length !== initialRecords.length - 1
                || data.content.some(value => typeof value !== 'string') || !Array.isArray(data.promptChat)
                || data.promptChat.some(value => typeof value !== 'string') || !data.global || !data.macroState || hash !== roleplayHash(data)) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The prepared Roleplay history needs recovery.', 503);
            }
            acceptedMacros = { ...boundMacroSnapshot(savedRoleplayMacroSnapshot({ ...request.worldInfo, global: data.global, characterExamples: data.characterExamples }, initialRecords)), variables: data.macroState.variables,
                extra: { ...acceptedMacros.extra, chatMetadata: data.macroState.chatMetadata, bannedWords: data.macroState.bannedWords } };
        }
        worldInfo = readArtifact(directories, job.id, 'roleplay-world-info');
        if (worldInfo === undefined) {
            worldInfo = await prepareRoleplayWorldInfo(base, request.worldInfo, { ...worldInfoHooks, macros: acceptedMacros,
                promptChat: preparedHistory?.promptChat, promptGlobal: preparedHistory?.global, promptInjections: scanContributions,
                vectorEntries: vectors?.projection.worldInfo ?? [] });
            writeArtifact(directories, job.id, 'roleplay-world-info', worldInfo);
        }
        if (!worldInfo || typeof worldInfo !== 'object' || Array.isArray(worldInfo)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved World Info scan needs recovery.', 503);
        }
        const passes = worldInfo.hookEvents?.scanPasses;
        if (worldInfo.snapshotHash !== roleplayHash(request.worldInfo)
            || preparedHistory && worldInfo.promptChatHash !== roleplayHash(preparedHistory.promptChat)
            || preparedHistory && worldInfo.promptGlobalHash !== roleplayHash(preparedHistory.global)
            || scanContributions.length && worldInfo.promptInjectionsHash !== roleplayHash(scanContributions)
            || vectors && worldInfo.vectorEntriesHash !== roleplayHash(vectors.projection.worldInfo)
            || !Array.isArray(passes) || passes.length !== worldInfo.iterations
            || !Array.isArray(worldInfo.draws)
            || passes.some((pass, index) => pass?.state?.loopCount !== index + 1
                || pass.state.current !== (index ? passes[index - 1]?.state?.next : 1)
                || ![0, 1, 2, 3].includes(pass.state.next)
                || !Number.isSafeInteger(pass.drawCount)
                || pass.drawCount < (index ? passes[index - 1].drawCount : 0)
                || pass.drawCount > worldInfo.draws.length
                || !Array.isArray(pass.all) || !Array.isArray(pass.successful) || !Array.isArray(pass.activated)
                || pass.successful.some(entry => !pass.all.some(candidate => roleplayHash(candidate) === roleplayHash(entry)))
                || roleplayHash(pass.activated) !== roleplayHash([
                    ...(index ? passes[index - 1].activated : []), ...pass.successful,
                ]))
            || (passes.length && passes.at(-1).drawCount !== worldInfo.draws.length)
            || roleplayHash((passes.at(-1)?.activated ?? []).map(({ world, uid, hash }) => [world, uid, hash]).sort())
                !== roleplayHash(worldInfo.activated.map(({ world, uid, hash }) => [world, uid, hash]).sort())
            || !worldInfo.hookEvents.entriesLoaded || !worldInfo.hookEvents.entriesLoaded.bookHashes
            || roleplayHash(worldInfo.hookEvents.entriesLoaded.bookHashes) !== roleplayHash(request.worldInfo.bookHashes)
            || roleplayHash(worldInfo.hookEvents.activated) !== roleplayHash(worldInfo.activated.length ? worldInfo.activated : null)
            || !Array.isArray(worldInfo.hookEvents.actions)
            || roleplayHash(worldInfo.hookEvents.actions)
                !== roleplayHash(worldInfoActivationActions(request.worldInfo.hookPolicy, worldInfo.activated))
            || !Array.isArray(worldInfo.activeLore) || !Array.isArray(worldInfo.boundLore)
            || request.worldInfo.enhancedLoreMacros && worldInfo.boundLore.some(entry => typeof entry.book !== 'string'
                || !entry.entry || typeof entry.entry !== 'object')) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'This saved World Info scan predates its server macro result.', 503);
        }
        assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        if (worldInfo.hookEvents.actions.length) {
            if (!request.serverPrompt) throw roleplayError('ROLEPLAY_INVALID', 'This World Info entry needs a native Quick Reply action.', 409);
            quickReply = prepareRoleplayQuickReplies(context, { base, snapshot: request.worldInfo, source, worldInfo });
            acceptedMacros = { ...acceptedMacros, variables: { ...acceptedMacros.variables, local: structuredClone(quickReply.local) },
                extra: { ...acceptedMacros.extra, chatMetadata: { ...acceptedMacros.extra?.chatMetadata,
                    variables: structuredClone(quickReply.local) } } };
        }
        if (request.worldInfo.pathfinder && contributions.extensions.some(prompt =>
            ['pathfinder_sidecar_retrieval', 'pathfinder_pipeline_retrieval'].includes(prompt.key))) {
            throw roleplayError('ROLEPLAY_INVALID', 'A saved contributor cannot replace a Pathfinder prompt.', 409);
        }
    }
    if (request.serverPrompt && (!request.worldInfo || request.messages.length || request.historyStart !== undefined)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Server-owned prompts cannot include prepared browser messages.', 409);
    }
    if (request.serverPrompt && ['systemPrompt', 'prefill', 'instructOverride', 'quietToLoud']
        .some(key => Object.hasOwn(request.rawOptions ?? {}, key))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Server-owned Roleplay prompts need saved context controls instead of raw prompt overrides.', 409);
    }
    const promptSource = request.serverPrompt ? assertSource() : null;
    const promptHash = promptSource && roleplayHash(promptSource.records);
    if (promptSource && (request.worldInfo.speakerNames.character !== request.characterName
        || (request.userName && request.worldInfo.speakerNames.user !== request.userName))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay speaker names differ from the accepted prompt.', 409);
    }
    const userName = request.userName ?? request.worldInfo?.speakerNames?.user ?? promptSource?.records[0]?.user_name ?? 'User';
    const groupNames = request.serverPrompt ? request.worldInfo.groupNames : request.groupNames || [];
    const hasToolHistory = Boolean(request.serverPrompt && initialRecords.some(record => record.extra?.tool_invocations !== undefined)
        || contributions.history.some(message => message.tool_calls || message.role === 'tool'));
    const namingMaterial = boundMaterial ?? (source.locator.group && worldInfo?.activated.length
        ? promptBackend(directories, request.binding) : null);
    const chatInput = namingMaterial && (!namingMaterial.backend || namingMaterial.backend === 'chat');
    let media = request.worldInfo?.images ?? [];
    const capabilities = request.serverPrompt && chatInput && (hasToolHistory || functionTools.length || media.length
        || namingMaterial.source === 'openrouter' && (request.modelOverride || namingMaterial.profile?.model))
        ? await prepareRoleplayCapabilities(context, namingMaterial, request.binding,
            { modelOverride: request.modelOverride, fetchModels: modelCatalogue }) : null;
    const toolControls = capabilities?.settings ?? mergeChatPresetSettings(namingMaterial?.active, namingMaterial?.preset);
    if ((hasToolHistory || functionTools.length) && (!request.serverPrompt || !chatInput
        || !supportsChatTools(toolControls, request.modelOverride || namingMaterial.profile?.model, { model_list: capabilities.models }))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved tool calls need a bound tool-capable Chat Completion connection.', 409);
    }
    const imageDetail = toolControls.inline_image_quality ?? 'auto';
    if (media.length && (!request.serverPrompt || !chatInput || !supportsChatImages(toolControls, { model_list: capabilities?.models ?? [] }))) {
        if (media.some((image, imageIndex) => !image.captioned && (!captions
            || !request.worldInfo.captions.items.some(item => item.imageIndex === imageIndex)))) {
            throw roleplayError('ROLEPLAY_INVALID', 'These saved Roleplay images need a bound vision connection or saved captions.', 409);
        }
        media = media.map(image => ({ ...image, captionOnly: true }));
    }
    if (media.length && !['low', 'auto', 'high'].includes(imageDetail)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved image detail setting is invalid.', 409);
    }
    const historyOptions = request.worldInfo && { reasoningInPrompt: request.worldInfo.reasoningInPrompt,
        reasoning: request.worldInfo.reasoning, regex: request.worldInfo.regex,
        attachments: request.worldInfo.attachments.filter(item => !vectors?.projection.files.some(file => file.index === item.index)), images: media, imageDetail, mediaDisplay: request.worldInfo.mediaDisplay,
        preparedContent: preparedHistory?.content,
        companionHostIndex: preparedHistory?.companionHostIndex,
        toolHistory: hasToolHistory, toolSource: namingMaterial?.source, toolModel: namingMaterial?.profile?.model,
        signaturePolicy: request.serverPrompt ? { source: namingMaterial.source,
            model: request.modelOverride || namingMaterial.profile?.model, include: chatInput && supportsChatSignatures(toolControls),
            reasoning: chatInput && namingMaterial.source === 'openrouter' && (toolControls.show_thoughts || toolControls.auto_append_reasoning_tags)
                ? toolControls.tool_reasoning_mode : 'disabled' } : undefined,
        characterName: request.characterName, group: source.locator.group, userName,
        namesBehavior: chatInput ? (toolControls.names_behavior ?? 0)
            : namingMaterial ? 'provider' : undefined };
    const promptMaterial = namingMaterial && request.modelOverride ? { ...namingMaterial, profile: { ...namingMaterial.profile, model: request.modelOverride } } : namingMaterial;
    const countChat = request.serverPrompt && (!promptMaterial.backend || promptMaterial.backend === 'chat')
        ? await createRoleplayChatCounter(request.modelOverride ? { ...promptMaterial,
            profile: { ...promptMaterial.profile, model: request.modelOverride } } : promptMaterial,
        { images: media, models: capabilities?.models ?? [], fallbackTokenizer: request.worldInfo.tokenizer }) : null;
    if (request.serverPrompt && (!Number.isSafeInteger(Number(promptMaterial.power?.token_padding ?? 0))
        || Number(promptMaterial.power?.token_padding ?? 0) < 0)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved prompt token padding is invalid.', 409);
    }
    const countText = request.serverPrompt && !countChat ? await createRoleplayTextCounter(base, promptMaterial,
        { tokenizer: request.worldInfo.tokenizer, signal, modelOverride: request.modelOverride }) : null;
    const memoryAccess = operation => withRoleplayAccount(base, account, lease => {
        signal.throwIfAborted();
        assertRoleplaySourceLocked(lease, source, { effect });
        return operation();
    });
    let memory;
    let promptRecords = promptSource ? (captions || inputTranslation || vectors ? structuredClone(initialRecords) : selectRoleplayPromptRecords(promptSource.records, source, effect)) : null;
    if (request.serverPrompt) {
        const locator = promptSource.locator;
        const normalised = normalizeLocator(locator);
        if (normalised.chat !== locator.chat || normalised.group !== locator.group
            || !locator.group && normalised.avatar !== locator.avatar) {
            throw roleplayError('ROLEPLAY_INVALID', 'This protected chat name cannot identify its Mewmory store exactly.', 409);
        }
        memory = readArtifact(directories, job.id, 'roleplay-mewmory');
        if (memory === undefined) {
            memory = await prepareMewmoryPrompt(directories, { locator,
                tokenizer: (countChat ?? countText).tokenizer,
                history: promptRecords.slice(1).flatMap((record, index) => record.is_system && !record.extra?.tool_invocations
                    ? [] : [{ index, text: `${record.name || ''}: ${preparedHistory?.content[index] ?? record.mes ?? ''}` }]),
            }, signal, {
                loadState: (directories, locator) => memoryAccess(() => loadCurrentStateSync(directories, locator)),
                mutate: (directories, locator, operation) => memoryAccess(() => mutateState(directories, locator, operation)),
                readSource: (directories, locator) => memoryAccess(() => readChat(directories, locator)),
                scheduleBackground: false,
            });
            writeArtifact(directories, job.id, 'roleplay-mewmory', memory);
            // The reply uses the last picked memories; the Recall selector refreshes them alongside it.
            if (memory.enabled) recallInBackground(directories, normalised, {
                asOf: memory.inspection.asOf, tokenizer: (countChat ?? countText).tokenizer,
            });
        }
        if (!memory || typeof memory.enabled !== 'boolean' || !Array.isArray(memory.excludedIndices)
            || memory.excludedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= promptRecords.length - 1)
            || typeof memory.npcText !== 'string' || typeof memory.memoryText !== 'string'
            || memory.enabled && typeof memory.validationFingerprint !== 'string') {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay memory context needs recovery.', 503);
        }
        const retainedIndices = new Map();
        promptRecords = [promptRecords[0], ...promptRecords.slice(1).filter((record, index) => {
            if (memory.excludedIndices.includes(index) || vectors?.projection.removed.some(item => item.index === index)) return false;
            retainedIndices.set(index, retainedIndices.size);
            return true;
        })];
        for (const key of ['attachments', 'images']) historyOptions[key] = historyOptions[key]
            .filter(item => retainedIndices.has(item.index)).map(item => ({ ...item, index: retainedIndices.get(item.index) }));
        historyOptions.preparedContent = historyOptions.preparedContent.filter((_value, index) => retainedIndices.has(index));
    }
    const assertMemory = () => {
        if (!request.serverPrompt) return;
        const current = memoryAccess(() => loadCurrentStateSync(directories, promptSource.locator));
        if (current.enabled !== memory.enabled || memory.enabled
            && generationFingerprint(current, readConfig(directories)) !== memory.validationFingerprint) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Mewmory changed after this prompt was prepared.', 409);
        }
    };
    assertMemory();
    const sourceHistory = promptSource ? buildRoleplaySavedHistory(promptRecords, historyOptions) : null;
    const savedHistory = sourceHistory ? [...sourceHistory, ...contributions.history] : null;
    const retrieval = request.worldInfo?.pathfinder && await runBoundPathfinderRetrieval(context, {
        base, snapshot: request.worldInfo, records: initialRecords, preparedHistory, worldInfo,
        contributions, mainBinding: request.binding, macroSnapshot: acceptedMacros, generate: generatePathfinder,
        assertBeforeDispatch: assertSource,
    });
    const promptExtensions = retrieval?.prompt ? [...contributions.extensions, retrieval.prompt] : contributions.extensions;
    const contributedMessages = new Set(contributions.history);
    const preparedPrompt = request.serverPrompt ? readArtifact(directories, job.id, request.worldInfo?.agents ? 'roleplay-base-prompt' : 'roleplay-prompt') : undefined;
    let preparedText = preparedPrompt?.preparedText;
    let cfgValues = preparedPrompt?.cfgValues;
    let textPrompt;
    const macroSnapshot = { ...acceptedMacros,
        system: { ...acceptedMacros.system, ...(promptMaterial && { model: request.modelOverride || promptMaterial.profile?.model || '' }) },
        variables: preparedPrompt?.macroState?.variables ?? acceptedMacros.variables,
        extra: { ...acceptedMacros.extra,
            ...(worldInfo && { extensionPrompts: Object.fromEntries(Object.entries(worldInfo.outletEntries)
                .map(([key, values]) => [inject_ids.CUSTOM_WI_OUTLET(key), { value: values.join('\n') }])) }),
            ...(promptMaterial && { powerUser: { ...promptMaterial.power, instruct: promptMaterial.instruct ?? promptMaterial.power?.instruct,
                context: promptMaterial.context ?? promptMaterial.power?.context },
            mainApi: !promptMaterial.backend || promptMaterial.backend === 'chat' ? 'openai'
                : promptMaterial.backend === 'text' ? 'textgenerationwebui' : promptMaterial.backend === 'horde' ? 'koboldhorde' : promptMaterial.backend }),
            chatMetadata: preparedPrompt?.macroState?.chatMetadata ?? acceptedMacros.extra?.chatMetadata,
            bannedWords: preparedPrompt?.macroState?.bannedWords ?? [] },
    };
    const macroEnvironment = createMacroEnvironment(macroSnapshot, request.serverPrompt
        ? roleplayMacroCapabilities(request.worldInfo, promptMaterial, request.maxTokens, contextLimit(directories, request.binding), () => macroEnvironment) : {}, {
        dynamicMacros: worldInfo && request.worldInfo.enhancedLoreMacros ? createRoleplayLoreMacros(worldInfo, request.worldInfo) : {},
    });
    // A trimming pass reuses resolved strings; it must not reroll prompt macros.
    const resolvedStrings = [];
    const resolvedHistory = new WeakMap();
    const substituteHistory = message => {
        if (contributedMessages.has(message)) return message;
        if (!resolvedHistory.has(message)) {
            const evaluate = content => macroEnvironment.evaluate(content, {
                legacy: !request.worldInfo.experimentalMacroEngine, strictCapabilities: true,
            });
            const content = message.role === 'tool' || message.tool_calls ? message.content
                : Array.isArray(message.content) ? message.content.map(part => part.type === 'text'
                    ? { ...part, text: evaluate(part.text) } : part) : evaluate(message.content);
            resolvedHistory.set(message, { ...message, ...(content !== undefined && { content }) });
        }
        return resolvedHistory.get(message);
    };
    let resolvedIndex = 0;
    const substitute = (value, original) => {
        const index = resolvedIndex++;
        if (!resolvedStrings[index]) resolvedStrings[index] = { value, original, result: macroEnvironment.evaluate(value, {
            legacy: !request.worldInfo.experimentalMacroEngine, strictCapabilities: true, original,
        }) };
        if (resolvedStrings[index].value !== value || resolvedStrings[index].original !== original) {
            throw roleplayError('ROLEPLAY_INVALID', 'Prompt trimming changed the saved prompt expansion order.', 409);
        }
        return resolvedStrings[index].result;
    };
    let exampleCount = 0;
    const place = async (history, exampleLimit = Infinity) => {
        resolvedIndex = 0;
        let messages = history;
        const savedHistoryStart = request.serverPrompt ? 0 : request.historyStart;
        if (!worldInfo) return messages;
        const chatBackend = request.serverPrompt && promptMaterial;
        const isChatPrompt = chatBackend && (!chatBackend.backend || chatBackend.backend === 'chat');
        if (worldInfo.hookEvents.actions.length && !quickReply) throw roleplayError('ROLEPLAY_INVALID', 'The activated Quick Reply actions were not saved.', 409);
        if (worldInfo.activated.length) {
            if (!promptSource) assertWorldInfoDepthHistory(assertSource().records, request.messages, request.historyStart,
                historyOptions);
        }
        const hasOutlets = Object.keys(worldInfo.outletEntries).length > 0;
        if (isChatPrompt) {
            const assembled = await assembleRoleplayChatPrompt(history, { ...request.worldInfo, global: preparedHistory.global, characterExamples: preparedHistory.characterExamples,
                authorNote: preparedHistory.authorNote, depthPrompt: preparedHistory.depthPrompt,
                ...(preparedHistory.depthPrompts ? { depthPrompts: preparedHistory.depthPrompts } : {}) }, chatBackend, worldInfo, {
                userName, characterName: request.characterName, groupNames, effect, substitute, substituteHistory, memory, exampleLimit,
                contributions: promptExtensions, records: initialRecords,
            });
            exampleCount = assembled.exampleCount;
            return assembled.messages;
        }
        if (request.serverPrompt) {
            textPrompt ??= createRoleplayTextPrompt(savedHistory, { ...request.worldInfo, global: preparedHistory.global, characterExamples: preparedHistory.characterExamples,
                authorNote: preparedHistory.authorNote, depthPrompt: preparedHistory.depthPrompt,
                ...(preparedHistory.depthPrompts ? { depthPrompts: preparedHistory.depthPrompts } : {}) }, promptMaterial, worldInfo, {
                userName, characterName: request.characterName, groupNames, effect, substitute, substituteHistory, memory,
                contributions: promptExtensions, records: initialRecords,
            });
            exampleCount = textPrompt.exampleCount;
            preparedText = textPrompt.render(history, exampleLimit);
            cfgValues = textPrompt.guidance && { guidanceScale: textPrompt.guidance,
                ...(textPrompt.hasNegative ? { negativePrompt: textPrompt.render(history, exampleLimit, true) } : {}) };
            return history;
        }
        const storyLore = request.worldInfo.storyTemplate && (worldInfo.worldInfoBefore || worldInfo.worldInfoAfter);
        const storyNote = (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length)
            && request.worldInfo.authorNote?.position !== 1 && isWorldInfoAuthorNoteActive(request.worldInfo.authorNote);
        const hasStory = Boolean(hasOutlets || storyLore || storyNote);
        if (hasStory) {
            messages = insertWorldInfoOutlets(messages, worldInfo.outletEntries, request.worldInfo, savedHistoryStart,
                userName, request.characterName, worldInfo.worldInfoBefore, worldInfo.worldInfoAfter, Boolean(storyNote));
        }
        const lore = hasStory ? '' : [worldInfo.worldInfoBefore, worldInfo.worldInfoAfter].filter(Boolean).join('\n');
        if (lore) messages.unshift({ role: 'system', content: lore });
        let historyStart = savedHistoryStart + messages.length - history.length;
        if (worldInfo.EMEntries.length) {
            const beforeExamples = messages.length;
            messages = insertWorldInfoExamples(messages, worldInfo.EMEntries, request.worldInfo.characterExamples,
                historyStart, userName, request.characterName, groupNames);
            historyStart += messages.length - beforeExamples;
        }
        if (worldInfo.WIDepthEntries.length) {
            messages = insertWorldInfoDepth(messages, worldInfo.WIDepthEntries, historyStart);
        }
        if (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length) {
            messages = insertWorldInfoAuthorNote(messages, worldInfo.ANBeforeEntries, worldInfo.ANAfterEntries,
                request.worldInfo.authorNote, historyStart, hasStory);
        }
        return messages;
    };
    const promptIdentity = request.serverPrompt && roleplayHash({ history: promptHash, worldInfo: request.worldInfo,
        binding: request.binding, maxTokens: request.maxTokens, effect, memory, contributions,
        ...(retrieval ? { pathfinderHash: retrieval.hash } : {}), ...(captions ? { captionsHash: captions.hash } : {}),
        ...(inputTranslation ? { inputTranslationHash: inputTranslation.hash } : {}), ...(agentPre ? { agentsHash: agentPre.hash } : {}),
        ...(vectors ? { vectorsHash: vectors.hash } : {}),
        ...(quickReply ? { quickReplyHash: quickReply.hash } : {}) });
    if (preparedPrompt !== undefined && (!preparedPrompt || preparedPrompt.identity !== promptIdentity
        || !Array.isArray(preparedPrompt.messages) || !preparedPrompt.macroState
         || countText && typeof preparedText !== 'string'
         || preparedPrompt.hash !== roleplayHash({ messages: preparedPrompt.messages, macroState: preparedPrompt.macroState,
             ...(preparedText !== undefined ? { preparedText } : {}), ...(cfgValues ? { cfgValues } : {}),
             ...(retrieval ? { pathfinderHash: retrieval.hash } : {}), ...(captions ? { captionsHash: captions.hash } : {}),
             ...(inputTranslation ? { inputTranslationHash: inputTranslation.hash } : {}), ...(agentPre ? { agentsHash: agentPre.hash } : {}),
             ...(vectors ? { vectorsHash: vectors.hash } : {}),
             ...(quickReply ? { quickReplyHash: quickReply.hash } : {}) }))) {
        throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay prompt needs recovery.', 503);
    }
    const optionalExamples = Boolean(request.serverPrompt && !request.worldInfo.pinExamples);
    let selectedHistory = savedHistory || structuredClone(request.messages);
    const initialExamples = optionalExamples ? 0 : Infinity;
    let messages = preparedPrompt?.messages ?? await place(selectedHistory, initialExamples);
    if (!messages.length && !preparedText?.trim() && request.serverPrompt) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt has no content to send.', 409);
    }
    if (request.serverPrompt || worldInfo?.activated.length) {
        const { count } = await getCounter(request.worldInfo.tokenizer);
        const budget = contextLimit(directories, request.binding) - request.maxTokens - (countText ? Number(promptMaterial.power?.token_padding ?? 0) : 0);
        const imageCost = image => getChatImageTokenCost(image, imageDetail);
        const tokens = countText ? async () => Math.max(await countText(preparedText), cfgValues?.negativePrompt ? await countText(cfgValues.negativePrompt) : 0) : countChat ? prompt => countChat([...prompt, ...toolBudget])
            : (async prompt => await count(prompt.map(message => [message.name, message.tool_call_id,
                message.tool_calls && JSON.stringify(message.tool_calls),
                Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
                    : message.content].filter(Boolean).join('\n')).join('\n'))
            + prompt.reduce((sum, message) => sum + (Array.isArray(message.content)
                ? message.content.filter(part => part.type === 'image_url').reduce((cost, part) => {
                    const image = media.find(item => item.url === part.image_url.url);
                    if (!image) throw roleplayError('ROLEPLAY_INVALID', 'A saved Roleplay image is not bound to this prompt.', 409);
                    return cost + imageCost(image);
                }, 0) : 0), 0));
        let size = await tokens(messages);
        if (size > budget && !preparedPrompt && !memory?.enabled && savedHistory && savedHistory.length > 1) {
            // ponytail: search saved suffixes instead of rebuilding once per old message; the latest stays intact.
            const starts = savedHistory.map((message, index) => message.role === 'tool' ? null : index)
                .filter(index => index !== null && index > 0 && index < sourceHistory.length);
            let start = 0;
            let end = starts.length - 1;
            if (end < 0) throw roleplayError('ROLEPLAY_INVALID', 'The saved prompt history cannot fit without discarding required context.', 409);
            while (start < end) {
                const middle = Math.floor((start + end) / 2);
                const candidate = await place(savedHistory.slice(starts[middle]), initialExamples);
                if (await tokens(candidate) <= budget) end = middle;
                else start = middle + 1;
            }
            selectedHistory = savedHistory.slice(starts[start]);
            messages = await place(selectedHistory, initialExamples);
            size = await tokens(messages);
        }
        if (size > budget) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt exceeds the bound context budget.', 409);
        }
        if (optionalExamples && !preparedPrompt) {
            for (let limit = 1; limit <= exampleCount; limit++) {
                const previousText = preparedText;
                const previousCfg = cfgValues;
                const candidate = await place(selectedHistory, limit);
                if (await tokens(candidate) > budget) { preparedText = previousText; cfgValues = previousCfg; break; }
                messages = candidate;
            }
        }
    }
    if (request.serverPrompt && !preparedPrompt) {
        const saved = { messages, macroState: macroEnvironment.captureState(), ...(preparedText !== undefined ? { preparedText } : {}),
            ...(cfgValues ? { cfgValues } : {}), ...(retrieval ? { pathfinderHash: retrieval.hash } : {}),
            ...(captions ? { captionsHash: captions.hash } : {}), ...(inputTranslation ? { inputTranslationHash: inputTranslation.hash } : {}),
            ...(vectors ? { vectorsHash: vectors.hash } : {}),
            ...(agentPre ? { agentsHash: agentPre.hash } : {}), ...(quickReply ? { quickReplyHash: quickReply.hash } : {}) };
        writeArtifact(directories, job.id, request.worldInfo?.agents ? 'roleplay-base-prompt' : 'roleplay-prompt', { identity: promptIdentity, hash: roleplayHash(saved), ...saved });
    }
    const beforeDispatch = () => {
        const current = assertSource();
        if (promptHash && roleplayHash(current.records) !== promptHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay prompt history changed before dispatch.', 409);
        }
        if (worldInfo) assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        assertMemory();
    };
    if (request.worldInfo?.agents) {
        const intercepted = await runRoleplayAgentInterceptors(context, { base, snapshot: request.worldInfo, binding: request.binding,
            macros: acceptedMacros, generationType: request.worldInfo.global.trigger, assistantName: request.characterName,
            assertCurrent: beforeDispatch, generate: generateAgent, timing: 'pre-generation', format: countText ? 'text' : 'chat',
            value: countText ? preparedText : messages });
        if (countText) preparedText = intercepted.value;
        else messages = intercepted.value;
        const { count } = await getCounter(request.worldInfo.tokenizer);
        const budget = contextLimit(directories, request.binding) - request.maxTokens - (countText ? Number(promptMaterial.power?.token_padding ?? 0) : 0);
        const size = countText ? Math.max(await countText(preparedText), cfgValues?.negativePrompt ? await countText(cfgValues.negativePrompt) : 0)
            : await (countChat ? countChat([...messages, ...toolBudget]) : count(JSON.stringify([...messages, ...toolBudget])));
        if (size > budget) throw roleplayError('ROLEPLAY_INVALID', 'The Agent-modified prompt exceeds the bound context budget.', 409);
        const basePrompt = readArtifact(directories, job.id, 'roleplay-base-prompt');
        const final = { messages, macroState: basePrompt.macroState, ...(preparedText !== undefined ? { preparedText } : {}),
            ...(cfgValues ? { cfgValues } : {}), ...(retrieval ? { pathfinderHash: retrieval.hash } : {}), ...(captions ? { captionsHash: captions.hash } : {}),
            ...(inputTranslation ? { inputTranslationHash: inputTranslation.hash } : {}),
            ...(vectors ? { vectorsHash: vectors.hash } : {}),
            ...(quickReply ? { quickReplyHash: quickReply.hash } : {}), agentsHash: agentPre.hash, agentInterceptHash: intercepted.hash };
        const prepared = { identity: promptIdentity, ...final, hash: roleplayHash(final) };
        const previous = readArtifact(directories, job.id, 'roleplay-prompt');
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(prepared)) throw roleplayError('ROLEPLAY_AGENT_RECOVERY', 'The saved Agent-modified prompt changed.', 409);
        if (previous === undefined) writeArtifact(directories, job.id, 'roleplay-prompt', prepared);
    }
    publishRoleplayPreview(context, { stage: 'generating' });
    const result = await generate({ context: base, jobContext: context, binding: request.binding, messages,
        onStream: value => publishRoleplayPreview(context, { ...value, stage: 'generating' }),
        maxTokens: request.maxTokens, userName, characterName: request.characterName,
        generationType: request.serverPrompt ? request.worldInfo.global.trigger : 'quiet',
        groupNames, macroEnvironment, preparedText, cfgValues, preparedMessages: Boolean(request.serverPrompt && countChat), functionTools,
        rawOptions: request.rawOptions || {}, ephemeralStops: request.ephemeralStops || [],
        onProviderStep: step => {
            const reference = { intentHash: roleplayHash(job.intent), step,
                promptHash: request.serverPrompt ? readArtifact(directories, job.id, 'roleplay-prompt').hash : null,
                worldInfoHash: worldInfo ? roleplayHash(worldInfo) : null };
            if (providerReference && roleplayHash(providerReference) !== roleplayHash(reference)) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'This job already owns a different provider request.', 503);
            }
            if (!providerReference) writeArtifact(directories, job.id, 'roleplay-main-provider', reference);
        },
        validatePrompt: request.serverPrompt ? async payload => {
            const budget = contextLimit(directories, request.binding) - request.maxTokens - (countText ? Number(promptMaterial.power?.token_padding ?? 0) : 0);
            const { count } = await getCounter(request.worldInfo.tokenizer);
            let size;
            if (countChat && Array.isArray(payload.messages)) {
                size = await countChat([...payload.messages, ...(payload.assistant_prefill ? [{ role: 'assistant', content: payload.assistant_prefill }] : []), ...(payload.tools
                    ? [{ role: 'user', content: JSON.stringify({ tools: payload.tools, tool_choice: payload.tool_choice }) }] : [])]);
            } else {
                const text = payload.prompt ?? payload.input;
                if (typeof text !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'The formatted Roleplay prompt is invalid.', 409);
                size = Math.max(await (countText ?? count)(text), payload.negative_prompt ? await (countText ?? count)(payload.negative_prompt) : 0);
            }
            if (size > budget) throw roleplayError('ROLEPLAY_INVALID', 'The formatted Roleplay request exceeds its bound context budget.', 409);
            beforeDispatch();
        } : undefined,
        beforeDispatch,
        modelOverride: request.modelOverride || '', overridePayload, stream: request.stream === true && !functionTools.length });
    return finish(result, worldInfo);
}

export function registerRoleplayReplyJob(options = {}) {
    registerHandler('roleplay.reply', context => runRoleplayReplyJob(context, options));
    registerHandler('roleplay.candidate', context => runRoleplayReplyJob(context, options));
}

registerRoleplayReplyJob();
