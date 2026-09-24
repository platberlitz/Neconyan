import { getChatImageTokenCost } from '../../public/scripts/chat-prompt-tokens.js';
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
import { assertWorldInfoDepthHistory, savedRoleplayMacroSnapshot, buildRoleplaySavedHistory, insertRoleplayChatSystem, insertRoleplayPostHistory, insertWorldInfoAuthorNote, insertWorldInfoDepth, insertWorldInfoExamples, insertWorldInfoOutlets, isWorldInfoAuthorNoteActive } from './roleplay-prompt.js';
import { getChatProfileContextLimit, resolveGenerationProfile } from './profiles.js';
import { getCounter } from '../mewmory/tokens.js';
import { fnv1a } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/state-impl.js';
import { assembleRoleplayChatPrompt } from './roleplay-chat-prompt.js';
import { prepareMewmoryPrompt } from '../mewmory/prepare.js';
import { loadCurrentStateSync } from '../mewmory/sources.js';
import { mutateState, normalizeLocator, readChat } from '../mewmory/store.js';
import { generationFingerprint } from '../mewmory/context.js';
import { readConfig } from '../mewmory/models.js';
import { createRoleplayChatCounter, createRoleplayTextCounter } from './roleplay-budget.js';
import { createRoleplayTextPrompt } from './roleplay-text-prompt.js';
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
    if (saved !== undefined) {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay result needs recovery.', 503);
        }
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
    const initialSource = assertSource();
    let acceptedMacros = request.macros || {};
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
        if (request.serverPrompt) acceptedMacros = savedRoleplayMacroSnapshot(request.worldInfo, initialSource.records);
        if (!Array.isArray(request.worldInfo.hookPolicy?.pathfinder)
            || request.worldInfo.hookPolicy.pathfinder.length) {
            throw roleplayError('ROLEPLAY_INVALID', 'Enabled Pathfinder retrieval needs server-owned pre-scan execution.', 409);
        }
        if (!Array.isArray(request.worldInfo.hookPolicy.scanContributors)
            || request.worldInfo.hookPolicy.scanContributors.length) {
            throw roleplayError('ROLEPLAY_INVALID', 'Enabled vector or Agent scan contributions need server-owned preparation.', 409);
        }
        worldInfo = readArtifact(directories, job.id, 'roleplay-world-info');
        if (worldInfo === undefined) {
            worldInfo = await prepareRoleplayWorldInfo(base, request.worldInfo, { ...worldInfoHooks, macros: acceptedMacros });
            writeArtifact(directories, job.id, 'roleplay-world-info', worldInfo);
        }
        if (!worldInfo || typeof worldInfo !== 'object' || Array.isArray(worldInfo)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved World Info scan needs recovery.', 503);
        }
        const passes = worldInfo.hookEvents?.scanPasses;
        if (worldInfo.snapshotHash !== roleplayHash(request.worldInfo)
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
    const promptMaterial = request.serverPrompt ? namingMaterial ?? promptBackend(directories, request.binding) : namingMaterial;
    const countChat = request.serverPrompt && (!promptMaterial.backend || promptMaterial.backend === 'chat')
        ? await createRoleplayChatCounter(request.modelOverride ? { ...promptMaterial,
            profile: { ...promptMaterial.profile, model: request.modelOverride } } : promptMaterial,
        { images: media, fallbackTokenizer: request.worldInfo.tokenizer }) : null;
    const countText = request.serverPrompt && !countChat ? await createRoleplayTextCounter(base, promptMaterial,
        { tokenizer: request.worldInfo.tokenizer, signal, modelOverride: request.modelOverride }) : null;
    const memoryAccess = operation => withRoleplayAccount(base, account, lease => {
        signal.throwIfAborted();
        assertRoleplaySourceLocked(lease, source, { effect });
        return operation();
    });
    let memory;
    let promptRecords = promptSource?.records;
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
                tokenizer: { tokenizerKey: request.worldInfo.tokenizer },
                history: promptRecords.slice(1).flatMap((record, index) => record.is_system && !record.extra?.tool_invocations
                    ? [] : [{ index, text: `${record.name || ''}: ${record.mes || ''}` }]),
            }, signal, {
                loadState: (directories, locator) => memoryAccess(() => loadCurrentStateSync(directories, locator)),
                mutate: (directories, locator, operation) => memoryAccess(() => mutateState(directories, locator, operation)),
                readSource: (directories, locator) => memoryAccess(() => readChat(directories, locator)),
                scheduleBackground: false,
            });
            writeArtifact(directories, job.id, 'roleplay-mewmory', memory);
        }
        if (!memory || typeof memory.enabled !== 'boolean' || !Array.isArray(memory.excludedIndices)
            || memory.excludedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= promptRecords.length - 1)
            || typeof memory.npcText !== 'string' || typeof memory.memoryText !== 'string'
            || memory.enabled && typeof memory.validationFingerprint !== 'string') {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved Roleplay memory context needs recovery.', 503);
        }
        const retainedIndices = new Map();
        promptRecords = [promptRecords[0], ...promptRecords.slice(1).filter((record, index) => {
            if (memory.excludedIndices.includes(index)) return false;
            retainedIndices.set(index, retainedIndices.size);
            return true;
        })];
        for (const key of ['attachments', 'images']) historyOptions[key] = historyOptions[key]
            .filter(item => retainedIndices.has(item.index)).map(item => ({ ...item, index: retainedIndices.get(item.index) }));
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
    const savedHistory = promptSource ? buildRoleplaySavedHistory(promptRecords, historyOptions) : null;
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
    const preparedPrompt = request.serverPrompt ? readArtifact(directories, job.id, 'roleplay-prompt') : undefined;
    let preparedText = preparedPrompt?.preparedText;
    let textPrompt;
    const macroSnapshot = { ...acceptedMacros,
        system: { ...acceptedMacros.system, ...(promptMaterial && { model: request.modelOverride || promptMaterial.profile?.model || '' }) },
        variables: preparedPrompt?.macroState?.variables ?? acceptedMacros.variables,
        extra: { ...acceptedMacros.extra,
            ...(promptMaterial && { powerUser: { ...promptMaterial.power, instruct: promptMaterial.instruct ?? promptMaterial.power?.instruct,
                context: promptMaterial.context ?? promptMaterial.power?.context },
            mainApi: !promptMaterial.backend || promptMaterial.backend === 'chat' ? 'openai'
                : promptMaterial.backend === 'text' ? 'textgenerationwebui' : promptMaterial.backend === 'horde' ? 'koboldhorde' : promptMaterial.backend }),
            chatMetadata: preparedPrompt?.macroState?.chatMetadata ?? acceptedMacros.extra?.chatMetadata,
            bannedWords: preparedPrompt?.macroState?.bannedWords ?? [] },
    };
    const macroEnvironment = createMacroEnvironment(macroSnapshot, request.serverPrompt ? {
        getMaxResponseTokens: () => request.maxTokens,
        getMaxContextTokens: () => contextLimit(directories, request.binding),
        getMaxPromptTokens: () => contextLimit(directories, request.binding) - request.maxTokens,
    } : {}, {
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
    });
    // A trimming pass reuses resolved strings; it must not reroll prompt macros.
    const resolvedStrings = [];
    const resolvedHistory = new WeakMap();
    const substituteHistory = message => {
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
        if (isChatPrompt) {
            const assembled = await assembleRoleplayChatPrompt(history, request.worldInfo, chatBackend, worldInfo, {
                userName, characterName: request.characterName, groupNames, effect, substitute, substituteHistory, memory, exampleLimit,
            });
            exampleCount = assembled.exampleCount;
            return assembled.messages;
        }
        if (request.serverPrompt) {
            textPrompt ??= createRoleplayTextPrompt(savedHistory, request.worldInfo, promptMaterial, worldInfo, {
                userName, characterName: request.characterName, groupNames, effect, substitute, substituteHistory, memory,
            });
            exampleCount = textPrompt.exampleCount;
            preparedText = textPrompt.render(history, exampleLimit);
            return history;
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
                historyStart, userName, request.characterName, groupNames);
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
        if (memory?.enabled) messages.push(...[memory.npcText, memory.memoryText].filter(Boolean)
            .map(content => ({ role: 'system', content })));
        return messages;
    };
    const promptIdentity = request.serverPrompt && roleplayHash({ history: promptHash, worldInfo: request.worldInfo,
        binding: request.binding, maxTokens: request.maxTokens, effect, memory });
    if (preparedPrompt !== undefined && (!preparedPrompt || preparedPrompt.identity !== promptIdentity
        || !Array.isArray(preparedPrompt.messages) || !preparedPrompt.macroState
        || countText && typeof preparedText !== 'string'
        || preparedPrompt.hash !== roleplayHash({ messages: preparedPrompt.messages, macroState: preparedPrompt.macroState,
            ...(preparedText !== undefined ? { preparedText } : {}) }))) {
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
        const budget = contextLimit(directories, request.binding) - request.maxTokens;
        const imageCost = image => getChatImageTokenCost(image, imageDetail);
        const tokens = countText ? () => countText(preparedText) : countChat ?? (async prompt => await count(prompt.map(message => [message.name, message.tool_call_id,
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
                .filter(index => index !== null && index > 0);
            let start = 0;
            let end = starts.length - 1;
            if (end < 0) throw roleplayError('ROLEPLAY_INVALID', 'Saved tool results cannot be sent without their calls.', 409);
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
                const candidate = await place(selectedHistory, limit);
                if (await tokens(candidate) > budget) { preparedText = previousText; break; }
                messages = candidate;
            }
        }
    }
    if (request.serverPrompt && !preparedPrompt) {
        const saved = { messages, macroState: macroEnvironment.captureState(), ...(preparedText !== undefined ? { preparedText } : {}) };
        writeArtifact(directories, job.id, 'roleplay-prompt', { identity: promptIdentity, hash: roleplayHash(saved), ...saved });
    }
    const beforeDispatch = () => {
        const current = assertSource();
        if (promptHash && roleplayHash(current.records) !== promptHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Roleplay prompt history changed before dispatch.', 409);
        }
        if (worldInfo) assertRoleplayWorldInfoCurrent(base, request.worldInfo);
        assertMemory();
    };
    const result = await generate({ context: base, jobContext: context, binding: request.binding, messages,
        maxTokens: request.maxTokens, userName, characterName: request.characterName,
        groupNames, macroEnvironment, preparedText,
        rawOptions: request.rawOptions || {}, ephemeralStops: request.ephemeralStops || [],
        validatePrompt: request.serverPrompt ? async payload => {
            const budget = contextLimit(directories, request.binding) - request.maxTokens;
            const { count } = await getCounter(request.worldInfo.tokenizer);
            let size;
            if (countChat && Array.isArray(payload.messages)) {
                size = await countChat([...payload.messages, ...(payload.tools
                    ? [{ role: 'user', content: JSON.stringify({ tools: payload.tools, tool_choice: payload.tool_choice }) }] : [])]);
            } else {
                const text = payload.prompt ?? payload.input;
                if (typeof text !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'The formatted Roleplay prompt is invalid.', 409);
                size = await (countText ?? count)(text);
            }
            if (size > budget) throw roleplayError('ROLEPLAY_INVALID', 'The formatted Roleplay request exceeds its bound context budget.', 409);
            beforeDispatch();
        } : undefined,
        beforeDispatch,
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
