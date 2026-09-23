import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { registerHandler } from '../jobs/runner.js';
import { setJobResume } from '../jobs/store.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { runChatProfile } from './service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { applyRoleplayJobEffect } from '../roleplay-jobs.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { extractProviderReasoning, extractProviderReasoningSignature } from '../../public/scripts/generation-format.js';
import { assertRoleplayWorldInfoCurrent, prepareRoleplayWorldInfo } from './world-info.js';
import { assertWorldInfoDepthHistory, buildRoleplaySavedHistory, insertRoleplayPostHistory, insertWorldInfoAuthorNote, insertWorldInfoDepth, insertWorldInfoExamples, insertWorldInfoOutlets, isWorldInfoAuthorNoteActive } from './roleplay-prompt.js';
import { getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { getCounter } from '../mewmory/tokens.js';

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
    worldInfoHooks, contextLimit = getChatProfileContextLimit, promptBackend = resolveGenerationProfile } = {}) {
    const { job, directories, owner, signal } = context;
    const { roleplay, effect, source, request } = job.intent ?? {};
    const base = { owner, directories };
    const account = roleplay && { accountId: roleplay.accountId, dataEpoch: roleplay.dataEpoch };
    if (!account || !source || !request || typeof roleplay.operationKey !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'The accepted Roleplay request is missing.', 409);
    }
    const assertSource = () => {
        signal.throwIfAborted();
        return withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, source, { effect }));
    };
    const saved = readArtifact(directories, job.id, 'roleplay-output');
    if (saved) {
        const result = applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output: saved }, host);
        return { result };
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
    assertSource();
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
            || request.worldInfo.global?.trigger !== ({ append: 'normal', continue: 'continue', swipe: 'swipe', replace: 'regenerate' }[effect])) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info must belong to the admitted Roleplay source.', 409);
        }
        worldInfo = readArtifact(directories, job.id, 'roleplay-world-info');
        if (!worldInfo) {
            worldInfo = await prepareRoleplayWorldInfo(base, request.worldInfo, { ...worldInfoHooks, macros: request.macros });
            writeArtifact(directories, job.id, 'roleplay-world-info', worldInfo);
        }
        assertRoleplayWorldInfoCurrent(base, request.worldInfo);
    }
    if (request.serverPrompt && (!request.worldInfo || request.messages.length || request.historyStart !== undefined)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Server-owned prompts cannot include prepared browser messages.', 409);
    }
    const promptSource = request.serverPrompt ? assertSource() : null;
    const promptHash = promptSource && roleplayHash(promptSource.records);
    if (promptSource && (promptSource.records[0]?.character_name !== request.characterName
        || (request.userName && promptSource.records[0]?.user_name !== request.userName))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay speaker names differ from the accepted prompt.', 409);
    }
    const historyOptions = request.worldInfo && { reasoningInPrompt: request.worldInfo.reasoningInPrompt,
        reasoning: request.worldInfo.reasoning, regex: request.worldInfo.regex,
        characterName: request.characterName, group: source.locator.group };
    const savedHistory = promptSource ? buildRoleplaySavedHistory(promptSource.records, historyOptions) : null;
    const place = history => {
        let messages = history;
        const savedHistoryStart = request.serverPrompt ? 0 : request.historyStart;
        if (!worldInfo) return messages;
        if (worldInfo.activated.some(entry => entry.automationId)) {
            throw roleplayError('ROLEPLAY_INVALID', 'This World Info entry needs a server Quick Reply action before generation.', 409);
        }
        if (worldInfo.activated.length) {
            if (!promptSource) assertWorldInfoDepthHistory(assertSource().records, request.messages, request.historyStart,
                historyOptions);
        }
        const hasOutlets = Object.keys(worldInfo.outletEntries).length > 0;
        const storyLore = request.worldInfo.storyTemplate && (worldInfo.worldInfoBefore || worldInfo.worldInfoAfter);
        const storyNote = (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length)
            && request.worldInfo.authorNote?.position !== 1 && isWorldInfoAuthorNoteActive(request.worldInfo.authorNote);
        const hasStory = Boolean(hasOutlets || storyLore || storyNote || (request.serverPrompt && request.worldInfo.storyTemplate));
        if (hasStory) {
            messages = insertWorldInfoOutlets(messages, worldInfo.outletEntries, request.worldInfo, savedHistoryStart,
                request.userName || 'User', request.characterName, worldInfo.worldInfoBefore, worldInfo.worldInfoAfter,
                Boolean(storyNote || request.serverPrompt));
        }
        const lore = hasStory ? '' : [worldInfo.worldInfoBefore, worldInfo.worldInfoAfter].filter(Boolean).join('\n');
        if (lore) messages.unshift({ role: 'system', content: lore });
        let historyStart = savedHistoryStart + Number(Boolean(lore)) + Number(hasStory);
        if (worldInfo.EMEntries.length) {
            const beforeExamples = messages.length;
            messages = insertWorldInfoExamples(messages, worldInfo.EMEntries, request.worldInfo.characterExamples,
                historyStart, request.userName || 'User', request.characterName, request.groupNames || []);
            historyStart += messages.length - beforeExamples;
        }
        if (worldInfo.WIDepthEntries.length) {
            messages = insertWorldInfoDepth(messages, worldInfo.WIDepthEntries, historyStart);
        }
        if (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length) {
            messages = insertWorldInfoAuthorNote(messages, worldInfo.ANBeforeEntries, worldInfo.ANAfterEntries,
                request.worldInfo.authorNote, historyStart, hasStory);
        }
        if (request.serverPrompt && (request.worldInfo.postHistory?.character || request.worldInfo.postHistory?.text)) {
            const material = promptBackend(directories, request.binding);
            messages = insertRoleplayPostHistory(messages, request.worldInfo.postHistory, material.backend ?? 'chat', effect);
        }
        return messages;
    };
    let messages = place(savedHistory || structuredClone(request.messages));
    if (!messages.length && request.serverPrompt) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt has no content to send.', 409);
    }
    if (request.serverPrompt || worldInfo?.activated.length) {
        const { count } = await getCounter(request.worldInfo.tokenizer);
        const budget = contextLimit(directories, request.binding) - request.maxTokens;
        const tokens = prompt => count(prompt.map(message => message.content).join('\n'));
        let size = await tokens(messages);
        if (size > budget && savedHistory && savedHistory.length > 1) {
            // ponytail: search saved suffixes instead of rebuilding once per old message; the latest stays intact.
            let start = 1;
            let end = savedHistory.length - 1;
            while (start < end) {
                const middle = Math.floor((start + end) / 2);
                const candidate = place(savedHistory.slice(middle));
                if (await tokens(candidate) <= budget) end = middle;
                else start = middle + 1;
            }
            messages = place(savedHistory.slice(start));
            size = await tokens(messages);
        }
        if (size > budget) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt exceeds the bound context budget.', 409);
        }
    }
    const result = await generate({ context: base, jobContext: context, binding: request.binding, messages,
        maxTokens: request.maxTokens, userName: request.userName || 'User', characterName: request.characterName,
        groupNames: request.groupNames || [], macroEnvironment: createMacroEnvironment(request.macros || {}),
        rawOptions: request.rawOptions || {}, ephemeralStops: request.ephemeralStops || [],
        beforeDispatch: () => {
            const current = assertSource();
            if (promptHash && roleplayHash(current.records) !== promptHash) {
                throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay prompt history changed before dispatch.', 409);
            }
            if (worldInfo) assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        },
        modelOverride: request.modelOverride || '', overridePayload, stream: request.stream === true });
    const output = replyOutput(result, effect, request.characterName, result.generation);
    if (worldInfo) {
        output.timedWorldInfo = worldInfo.timedWorldInfo;
        output.timedBaseline = worldInfo.timedBaseline;
        output.timedChatLength = worldInfo.chatLength;
    }
    writeArtifact(directories, job.id, 'roleplay-output', output);
    // The provider result is durable before recovery may revisit the chat write.
    setJobResume(directories, job.id, 'roleplay-delivery');
    return { result: applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output }, host) };
}

export function registerRoleplayReplyJob(options = {}) {
    registerHandler('roleplay.reply', context => runRoleplayReplyJob(context, options));
}

registerRoleplayReplyJob();
