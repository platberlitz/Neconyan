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
import { assertWorldInfoDepthHistory, buildRoleplaySavedHistory, insertRoleplayChatSystem, insertRoleplayPostHistory, insertWorldInfoAuthorNote, insertWorldInfoDepth, insertWorldInfoExamples, insertWorldInfoOutlets, isWorldInfoAuthorNoteActive } from './roleplay-prompt.js';
import { getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { getCounter } from '../mewmory/tokens.js';
import { fnv1a } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/state-impl.js';
import { worldInfoActivationActions } from './world-info-hook-policy.js';

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
        assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        if (!Array.isArray(request.worldInfo.hookPolicy?.pathfinder)
            || request.worldInfo.hookPolicy.pathfinder.length) {
            throw roleplayError('ROLEPLAY_INVALID', 'Enabled Pathfinder retrieval needs server-owned pre-scan execution.', 409);
        }
        worldInfo = readArtifact(directories, job.id, 'roleplay-world-info');
        if (!worldInfo) {
            worldInfo = await prepareRoleplayWorldInfo(base, request.worldInfo, { ...worldInfoHooks, macros: request.macros });
            writeArtifact(directories, job.id, 'roleplay-world-info', worldInfo);
        }
        if (!Array.isArray(worldInfo.hookEvents?.scanPasses)
            || worldInfo.hookEvents.scanPasses.length !== worldInfo.iterations
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
    const userName = request.userName ?? promptSource?.records[0]?.user_name ?? 'User';
    const hasToolHistory = Boolean(promptSource?.records.some(record => record.extra?.tool_invocations !== undefined));
    const namingMaterial = (source.locator.group && (request.serverPrompt || worldInfo?.activated.length)
        || request.worldInfo?.images?.length || hasToolHistory)
        ? promptBackend(directories, request.binding) : null;
    const toolControls = namingMaterial?.preset ?? namingMaterial?.active;
    if (hasToolHistory && (!request.serverPrompt || namingMaterial?.backend && namingMaterial.backend !== 'chat'
        || namingMaterial?.source !== 'custom' || toolControls?.function_calling !== true
        || !['', 'merge_tools', 'semi_tools', 'strict_tools'].includes(toolControls?.custom_prompt_post_processing ?? ''))) {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved tool calls need a bound tool-capable Chat Completion connection.', 409);
    }
    const media = request.worldInfo?.images ?? [];
    const imageDetail = namingMaterial?.preset?.inline_image_quality
        ?? namingMaterial?.active?.inline_image_quality ?? 'auto';
    if (media.length && (!request.serverPrompt || namingMaterial?.backend && namingMaterial.backend !== 'chat'
        || namingMaterial?.source !== 'custom' || (namingMaterial.preset?.media_inlining
            ?? namingMaterial.active?.media_inlining) !== true
        || !['low', 'auto', 'high'].includes(imageDetail))) {
        throw roleplayError('ROLEPLAY_INVALID', 'These saved Roleplay images need a bound vision connection.', 409);
    }
    const historyOptions = request.worldInfo && { reasoningInPrompt: request.worldInfo.reasoningInPrompt,
        reasoning: request.worldInfo.reasoning, regex: request.worldInfo.regex,
        attachments: request.worldInfo.attachments, images: media, imageDetail, mediaDisplay: request.worldInfo.mediaDisplay,
        toolHistory: hasToolHistory, toolSource: namingMaterial?.source, toolModel: namingMaterial?.profile?.model,
        characterName: request.characterName, group: source.locator.group, userName,
        namesBehavior: namingMaterial?.backend === 'chat'
            ? (namingMaterial.preset?.names_behavior ?? namingMaterial.active?.names_behavior ?? 0)
            : namingMaterial && (namingMaterial.backend !== 'text' || namingMaterial.instruct?.enabled || namingMaterial.kind === 'active')
                ? 'provider' : undefined };
    const savedHistory = promptSource ? buildRoleplaySavedHistory(promptSource.records, historyOptions) : null;
    const place = history => {
        let messages = history;
        const savedHistoryStart = request.serverPrompt ? 0 : request.historyStart;
        if (!worldInfo) return messages;
        const chatBackend = request.serverPrompt && (namingMaterial ?? promptBackend(directories, request.binding));
        const isChatPrompt = chatBackend && (!chatBackend.backend || chatBackend.backend === 'chat');
        if (worldInfo.hookEvents.actions.length) {
            throw roleplayError('ROLEPLAY_INVALID', 'This World Info entry needs a server Quick Reply action before generation.', 409);
        }
        if (worldInfo.activated.length) {
            if (!promptSource) assertWorldInfoDepthHistory(assertSource().records, request.messages, request.historyStart,
                historyOptions);
        }
        const hasOutlets = Object.keys(worldInfo.outletEntries).length > 0;
        if (isChatPrompt && hasOutlets) {
            throw roleplayError('ROLEPLAY_INVALID', 'Named World Info outlets need a bound Chat Completion prompt slot.', 409);
        }
        const storyLore = request.worldInfo.storyTemplate && (worldInfo.worldInfoBefore || worldInfo.worldInfoAfter);
        const storyNote = (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length)
            && request.worldInfo.authorNote?.position !== 1 && isWorldInfoAuthorNoteActive(request.worldInfo.authorNote);
        const hasStory = !isChatPrompt && Boolean(hasOutlets || storyLore || storyNote || (request.serverPrompt && request.worldInfo.storyTemplate));
        if (isChatPrompt) {
            messages = insertRoleplayChatSystem(messages, request.worldInfo, chatBackend, userName, request.characterName,
                worldInfo.worldInfoBefore, worldInfo.worldInfoAfter, effect);
        } else if (hasStory) {
            messages = insertWorldInfoOutlets(messages, worldInfo.outletEntries, request.worldInfo, savedHistoryStart,
                userName, request.characterName, worldInfo.worldInfoBefore, worldInfo.worldInfoAfter,
                Boolean(storyNote || request.serverPrompt));
        }
        const lore = hasStory || isChatPrompt
            ? '' : [worldInfo.worldInfoBefore, worldInfo.worldInfoAfter].filter(Boolean).join('\n');
        if (lore) messages.unshift({ role: 'system', content: lore });
        let historyStart = savedHistoryStart + messages.length - history.length;
        const controls = isChatPrompt && (chatBackend.preset ?? chatBackend.active);
        const exampleOrder = controls?.prompt_order?.find(value => String(value?.character_id) === '100001')?.order;
        const marker = controls?.prompts?.find(prompt => prompt.identifier === 'dialogueExamples');
        const trigger = effect === 'append' ? 'normal' : effect === 'replace' ? 'regenerate' : effect;
        const includeExamples = !isChatPrompt || (exampleOrder?.some(value => value.identifier === 'dialogueExamples'
            && value.enabled === true) && (!Array.isArray(marker?.injection_trigger)
            || !marker.injection_trigger.length || marker.injection_trigger.includes(trigger)));
        if (includeExamples && (worldInfo.EMEntries.length || request.serverPrompt && request.worldInfo.characterExamples)) {
            const beforeExamples = messages.length;
            messages = insertWorldInfoExamples(messages, worldInfo.EMEntries, request.worldInfo.characterExamples,
                historyStart, userName, request.characterName, request.groupNames || []);
            historyStart += messages.length - beforeExamples;
        }
        if (worldInfo.WIDepthEntries.length) {
            messages = insertWorldInfoDepth(messages, worldInfo.WIDepthEntries, historyStart);
        }
        if (worldInfo.ANBeforeEntries.length || worldInfo.ANAfterEntries.length) {
            messages = insertWorldInfoAuthorNote(messages, worldInfo.ANBeforeEntries, worldInfo.ANAfterEntries,
                request.worldInfo.authorNote, historyStart, hasStory || Boolean(isChatPrompt && messages[0]?.role === 'system'));
        }
        if (request.serverPrompt && (isChatPrompt || request.worldInfo.postHistory?.character || request.worldInfo.postHistory?.text)) {
            const material = chatBackend ?? promptBackend(directories, request.binding);
            messages = insertRoleplayPostHistory(messages, request.worldInfo.postHistory, material.backend ?? 'chat', effect,
                material, userName, request.characterName);
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
        const imageCost = image => {
            if (imageDetail === 'low' || imageDetail === 'auto' && image.width <= 512 && image.height <= 512) return 85;
            const scale = 2048 / Math.min(image.width, image.height);
            const finalScale = 768 / Math.min(Math.round(image.width * scale), Math.round(image.height * scale));
            return 85 + 170 * Math.ceil(Math.round(Math.round(image.width * scale) * finalScale) / 512)
                * Math.ceil(Math.round(Math.round(image.height * scale) * finalScale) / 512);
        };
        const tokens = async prompt => await count(prompt.map(message => [message.name, message.tool_call_id,
            message.tool_calls && JSON.stringify(message.tool_calls),
            Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
                : message.content].filter(Boolean).join('\n')).join('\n'))
            + prompt.reduce((sum, message) => sum + (Array.isArray(message.content)
                ? message.content.filter(part => part.type === 'image_url').reduce((cost, part) => {
                    const image = media.find(item => item.url === part.image_url.url);
                    if (!image) throw roleplayError('ROLEPLAY_INVALID', 'A saved Roleplay image is not bound to this prompt.', 409);
                    return cost + imageCost(image);
                }, 0) : 0), 0);
        let size = await tokens(messages);
        if (size > budget && savedHistory && savedHistory.length > 1) {
            // ponytail: search saved suffixes instead of rebuilding once per old message; the latest stays intact.
            const starts = savedHistory.map((message, index) => message.role === 'tool' ? null : index)
                .filter(index => index !== null && index > 0);
            let start = 0;
            let end = starts.length - 1;
            if (end < 0) throw roleplayError('ROLEPLAY_INVALID', 'Saved tool results cannot be sent without their calls.', 409);
            while (start < end) {
                const middle = Math.floor((start + end) / 2);
                const candidate = place(savedHistory.slice(starts[middle]));
                if (await tokens(candidate) <= budget) end = middle;
                else start = middle + 1;
            }
            messages = place(savedHistory.slice(starts[start]));
            size = await tokens(messages);
        }
        if (size > budget) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt exceeds the bound context budget.', 409);
        }
    }
    const loreScope = scope => !scope || scope === 'active' ? worldInfo.activeLore
        : scope === 'bound' ? worldInfo.boundLore : null;
    const loreInFlight = new Set();
    const loreLookup = (title, book) => worldInfo.boundLore.find(item => (!book || item.book === book)
        && ((String(item.entry.comment ?? '').trim()
            && String(item.entry.comment).trim().toLowerCase() === String(title).trim().toLowerCase())
            || String(item.entry.uid) === String(title).trim()));
    const loreContent = (item, resolve) => {
        if (!item) return '';
        const identity = `${item.book}::${item.entry.uid}`;
        if (loreInFlight.has(identity)) return item.content;
        loreInFlight.add(identity);
        try { return resolve(item.content); } finally { loreInFlight.delete(identity); }
    };
    const loreFields = {
        title: item => item.title, keys: item => (item.entry.key ?? []).join(', '),
        secondarykeys: item => (item.entry.keysecondary ?? []).join(', '),
        content: item => item.content, position: item => String(item.entry.position ?? ''),
        depth: item => String(item.entry.depth ?? ''), order: item => String(item.entry.order ?? ''),
        probability: item => String(item.entry.probability ?? ''), constant: item => item.entry.constant ? 'true' : 'false',
        enabled: item => item.entry.disable ? 'false' : 'true', uid: item => String(item.entry.uid),
    };
    const loreMacro = { unnamedArgs: [{ name: 'entry' }, { name: 'book', optional: true }],
        handler: ({ unnamedArgs: [title, book], resolve }) => loreContent(loreLookup(title, book), resolve) };
    const result = await generate({ context: base, jobContext: context, binding: request.binding, messages,
        maxTokens: request.maxTokens, userName, characterName: request.characterName,
        groupNames: request.groupNames || [], macroEnvironment: createMacroEnvironment(request.macros || {}, {}, {
            dynamicMacros: worldInfo && request.worldInfo.enhancedLoreMacros ? {
                lore: loreMacro,
                wi: loreMacro,
                lorekeys: { unnamedArgs: [{ name: 'entry' }, { name: 'book', optional: true }],
                    handler: ({ unnamedArgs: [title, book] }) => (loreLookup(title, book)?.entry.key ?? []).join(', ') },
                loreexists: { unnamedArgs: [{ name: 'entry' }, { name: 'book', optional: true }],
                    handler: ({ unnamedArgs: [title, book] }) => String(Boolean(loreLookup(title, book))) },
                lorefield: { unnamedArgs: [{ name: 'entry' }, { name: 'field' }, { name: 'book', optional: true }],
                    handler: ({ unnamedArgs: [title, field, book] }) => {
                        const item = loreLookup(title, book);
                        const name = String(field ?? '').trim().toLowerCase();
                        return item && Object.hasOwn(loreFields, name) ? loreFields[name](item) : '';
                    } },
                lorepick: { unnamedArgs: [{ name: 'book', optional: true }, { name: 'key', optional: true }],
                    handler: ({ unnamedArgs: [book, key], resolve }) => {
                        const candidates = worldInfo.boundLore.filter(item => !book || item.book === book)
                            .sort((a, b) => String(a.entry.uid).localeCompare(String(b.entry.uid), undefined, { numeric: true }));
                        if (!candidates.length) return '';
                        const seed = `${request.worldInfo.metadata.chat_id_hash ?? ''}:${String(book ?? '')}:${String(key ?? '')}`;
                        return loreContent(candidates[fnv1a(seed) % candidates.length], resolve);
                    } },
                loreactive: { unnamedArgs: [{ name: 'separator', optional: true }], handler: ({ unnamedArgs: [separator] }) =>
                    worldInfo.activeLore.map(entry => entry.title).join(separator || ', ') },
                lorebooks: { unnamedArgs: [{ name: 'separator', optional: true }], handler: ({ unnamedArgs: [separator] }) =>
                    [...new Set([...request.worldInfo.names.chat, ...request.worldInfo.names.character,
                        ...request.worldInfo.names.global])].join(separator || ', ') },
                loreentries: { unnamedArgs: [{ name: 'book', optional: true }, { name: 'separator', optional: true }],
                    handler: ({ unnamedArgs: [book, separator] }) => worldInfo.boundLore
                        .filter(entry => !book || entry.book === book).map(entry => entry.title).join(separator || ', ') },
                lorecount: { unnamedArgs: [{ name: 'scope', optional: true }], handler: ({ unnamedArgs: [scope] }) =>
                    loreScope(scope) ? String(loreScope(scope).length) : '' },
                loretokens: { unnamedArgs: [{ name: 'scope', optional: true }], handler: ({ unnamedArgs: [scope] }) =>
                    loreScope(scope) ? String(Math.ceil(loreScope(scope).map(entry => entry.content).join('\n').length / 4)) : '' },
            } : {},
        }),
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
        output.timedChatLength = request.worldInfo.savedChatLength ?? worldInfo.chatLength;
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
