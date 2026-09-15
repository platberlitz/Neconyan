import { CAVEAT, SECTION_LABEL } from './constants.js';
import { countTokens, ctxOf, displayTokenCounts, getContext } from './host.js';
import { canonicalOutbound, contentToText, messagesToText } from './message-content.js';

/**
 * Captures the prompt Neconyan would send, without sending it.
 *
 * Everything here observes and copies. Listeners never write back to a payload:
 * assigning to data.chat, data.prompt or data.chatChanged would make the Lab a
 * participant in the prompt it is supposed to be measuring.
 */

/** Text-completion pieces worth reporting, in the order they are assembled. */
const TC_SECTION_KEYS = [
    'worldInfoBefore',
    'description',
    'personality',
    'scenario',
    'persona',
    'storyString',
    'worldInfoAfter',
    'beforeScenarioAnchor',
    'afterScenarioAnchor',
    'mesExmString',
    'mesSendString',
    'main',
    'jailbreak',
    'naiPreamble',
];

let captureActive = false;

function sectionLabel(id) {
    return SECTION_LABEL[id] ?? id;
}

/** structuredClone refuses class instances and functions; fall back to JSON. */
function safeClone(value) {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return null;
        }
    }
}

function cloneMessages(messages) {
    if (!Array.isArray(messages)) {
        return null;
    }
    const cloned = safeClone(messages);
    return Array.isArray(cloned) ? cloned : null;
}

/**
 * Pulls the activated lorebook entries out of one WORLDINFO_SCAN_DONE pass.
 * The payload holds live entry objects and a timed-effects instance, so only
 * the identifying fields are copied out.
 */
function extractWorldInfoPass(payload) {
    const activated = payload?.activated?.entries;
    const entries = activated instanceof Set ? [...activated] : (Array.isArray(activated) ? activated : []);
    return entries
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => ({
            world: String(entry.world ?? ''),
            uid: entry.uid ?? null,
            comment: String(entry.comment ?? ''),
            keys: Array.isArray(entry.key) ? entry.key.map(key => String(key)) : [],
            position: entry.position ?? null,
            depth: entry.depth ?? null,
            order: entry.order ?? null,
        }));
}

/**
 * Collects the unresolved text behind each prompt section.
 *
 * A captured prompt holds the result of a macro, not the macro itself, so the
 * assembled text cannot say why a value moves. The preset's own prompts and the
 * character card still carry the macro syntax, which is what makes it possible
 * to name the macro responsible for a prompt that will not cache.
 */
export function collectSourceTexts(context) {
    const sources = {};
    for (const prompt of context?.chatCompletionSettings?.prompts ?? []) {
        if (prompt?.identifier && typeof prompt.content === 'string') {
            sources[prompt.identifier] = prompt.content;
        }
    }
    try {
        const fields = context?.getCharacterCardFields?.() ?? {};
        const map = {
            charDescription: fields.description,
            charPersonality: fields.personality,
            scenario: fields.scenario,
            personaDescription: fields.persona,
            dialogueExamples: fields.mesExamples,
            jailbreak: fields.jailbreak,
        };
        for (const [id, value] of Object.entries(map)) {
            if (typeof value === 'string' && value) {
                sources[id] = `${sources[id] ?? ''}\n${value}`.trim();
            }
        }
    } catch {
        // Card fields are a bonus; a failure here must not stop a capture.
    }
    return sources;
}

/** Joins a MessageCollection (or single Message) down to plain text. */
function nodeText(node) {
    if (!node) {
        return '';
    }
    if (typeof node.flatten === 'function' && Array.isArray(node.collection)) {
        return node.flatten()
            .map(message => contentToText(message?.content))
            .filter(Boolean)
            .join('\n');
    }
    return contentToText(node.content);
}

/**
 * Reads the assembled chat-completion prompt back out of the prompt manager,
 * which holds the collection tree from the most recent assembly.
 */
export function readChatCompletionSections(host, promptManager) {
    const root = promptManager?.messages;
    if (!root || typeof root.getCollection !== 'function') {
        return { sections: [], tokenTable: { total: 0, perSection: {} } };
    }

    const displayCounts = displayTokenCounts(host, root);
    const handlerCounts = promptManager?.tokenHandler?.counts ?? {};
    const sections = [];
    let total = 0;

    for (const node of root.getCollection()) {
        const id = String(node?.identifier ?? '');
        if (!id) {
            continue;
        }
        const tokens = Number(
            displayCounts[id]
            ?? handlerCounts[id]
            ?? (typeof node.getTokens === 'function' ? node.getTokens() : 0),
        ) || 0;
        const content = nodeText(node);
        if (!content && !tokens) {
            continue;
        }
        sections.push({ id, label: sectionLabel(id), content, tokens });
        total += tokens;
    }

    const perSection = {};
    for (const section of sections) {
        perSection[section.id] = Number(perSection[section.id] ?? 0) + section.tokens;
    }
    return { sections, tokenTable: { total, perSection } };
}

/**
 * Builds the text-completion section list. The pieces arrive already separated
 * on GENERATE_BEFORE_COMBINE_PROMPTS, so each one is counted individually.
 */
export async function readTextCompletionSections(beforeCombine, finalPrompt = null) {
    if (!beforeCombine) {
        if (typeof finalPrompt === 'string') {
            const total = await countTokens(finalPrompt);
            return {
                sections: [],
                tokenTable: { total: total ?? 0, perSection: {} },
                estimated: total === null,
            };
        }
        return { sections: [], tokenTable: { total: 0, perSection: {} }, estimated: false };
    }
    const sections = [];
    let total = 0;
    let estimated = false;

    for (const key of TC_SECTION_KEYS) {
        const content = beforeCombine[key];
        if (typeof content !== 'string' || !content) {
            continue;
        }
        const counted = await countTokens(content);
        if (counted === null) {
            estimated = true;
        }
        const tokens = counted ?? Math.ceil(content.length / 4);
        sections.push({ id: key, label: sectionLabel(key), content, tokens });
        total += tokens;
    }

    const perSection = {};
    for (const section of sections) {
        perSection[section.id] = Number(perSection[section.id] ?? 0) + section.tokens;
    }
    let totalCounted = null;
    if (typeof finalPrompt === 'string') {
        totalCounted = await countTokens(finalPrompt);
    }
    if (totalCounted !== null) {
        total = totalCounted;
    } else {
        // Section token counts do not include the tokenizer's join/separator
        // behavior, so a summed total is explicitly an estimate.
        estimated = true;
    }
    return { sections, tokenTable: { total, perSection }, estimated };
}

function dispatchInput(textarea) {
    const EventConstructor = textarea?.ownerDocument?.defaultView?.Event ?? globalThis.Event;
    if (typeof textarea?.dispatchEvent === 'function' && typeof EventConstructor === 'function') {
        textarea.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    }
}

async function withClearedTextarea(run) {
    const textarea = globalThis.document?.querySelector?.('#send_textarea') ?? null;
    if (!textarea || typeof textarea.value !== 'string') {
        return run();
    }
    const original = textarea.value;
    const originalReadOnly = textarea.readOnly;
    const selection = Number.isInteger(textarea.selectionStart) && Number.isInteger(textarea.selectionEnd)
        ? [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]
        : null;
    textarea.readOnly = true;
    try {
        textarea.value = '';
        dispatchInput(textarea);
        return await run();
    } finally {
        let restored = false;
        try {
            if (textarea.value === '') {
                textarea.value = original;
                restored = true;
            }
        } finally {
            textarea.readOnly = originalReadOnly;
        }
        if (restored) {
            try {
                textarea.setSelectionRange?.(...selection);
            } catch {
                // Selection restoration is best-effort on host textarea stand-ins.
            }
            dispatchInput(textarea);
        }
    }
}

async function beginGenerationIsolation(context, ownedSignal) {
    if (captureActive) {
        throw new Error('Prompting Lab is already building a prompt. Wait for it to finish and try again.');
    }
    captureActive = true;

    // Unit tests have no page or competing send controls. The real host always
    // has document.body, so missing host locking APIs there must fail closed.
    if (!globalThis.document?.body) {
        return {
            overlapped: () => false,
            release() { captureActive = false; },
        };
    }

    try {
        const source = context?.eventSource;
        const started = context?.eventTypes?.GENERATION_STARTED;
        const afterCommands = context?.eventTypes?.GENERATION_AFTER_COMMANDS;
        if (!started
            || !afterCommands
            || typeof source?.makeFirst !== 'function'
            || typeof source?.removeListener !== 'function'
            || typeof context?.deactivateSendButtons !== 'function'
            || typeof context?.activateSendButtons !== 'function') {
            throw new Error('Prompting Lab cannot safely isolate its test message because this Neconyan build does not expose the generation lock APIs.');
        }
        if (context.streamingProcessor
            || globalThis.document.body.dataset?.generating === 'true') {
            throw new Error('A Neconyan generation is already running. Stop it before building a test prompt.');
        }

        let unblock;
        const blocked = new Promise(resolve => { unblock = resolve; });
        let overlapped = false;
        const guard = (_type, options, dryRun) => {
            if (dryRun === true && options?.signal === ownedSignal) {
                return undefined;
            }
            overlapped = true;
            return blocked;
        };
        for (const eventType of [started, afterCommands]) {
            source.makeFirst(eventType, guard);
        }
        try {
            context.deactivateSendButtons();
        } catch (error) {
            for (const eventType of [started, afterCommands]) {
                source.removeListener(eventType, guard);
            }
            throw error;
        }

        let released = false;
        return {
            overlapped: () => overlapped,
            release() {
                if (released) {
                    return;
                }
                released = true;
                for (const eventType of [started, afterCommands]) {
                    source.removeListener(eventType, guard);
                }
                try {
                    context.activateSendButtons({ emitGenerationEnded: false });
                } finally {
                    captureActive = false;
                    unblock();
                }
            },
        };
    } catch (error) {
        captureActive = false;
        throw error;
    }
}

function mutableMacroState(context) {
    const slots = [];
    const remember = (parent, key, store) => {
        if (!parent || typeof parent !== 'object') {
            return;
        }
        const exists = Object.hasOwn(parent, key);
        slots.push({ parent, key, store, exists, value: exists ? safeClone(parent[key]) : undefined });
    };
    remember(context?.chatMetadata, 'variables', 'metadata');
    remember(context?.chatMetadata, 'MacroEnhanced', 'metadata');
    if (context?.extensionSettings?.variables && typeof context.extensionSettings.variables === 'object') {
        remember(context.extensionSettings.variables, 'global', 'settings');
    } else {
        remember(context?.extensionSettings, 'variables', 'settings');
    }
    return slots;
}

function restoreMutableState(slots) {
    const changed = { metadata: false, settings: false };
    for (const { parent, key, store, exists, value } of slots) {
        const currentExists = Object.hasOwn(parent, key);
        let same = currentExists === exists;
        if (same && exists) {
            try {
                same = JSON.stringify(parent[key]) === JSON.stringify(value);
            } catch {
                same = false;
            }
        }
        changed[store] ||= !same;
        if (exists) {
            parent[key] = value;
        } else {
            delete parent[key];
        }
    }
    return changed;
}

async function persistMutableState(context, changed) {
    let persisted = true;
    if (changed.metadata) {
        if (typeof context?.saveMetadata === 'function') {
            try {
                const confirmed = await context.saveMetadata();
                if (confirmed !== true) {
                    // Current Neconyan catches metadata save failures and
                    // returns no status, so completion alone is not proof.
                    persisted = false;
                }
            } catch {
                persisted = false;
            }
        } else {
            persisted = false;
        }
    }
    if (changed.settings) {
        if (typeof context?.saveSettings === 'function') {
            try {
                await context.saveSettings();
            } catch {
                persisted = false;
            }
        } else if (typeof context?.saveSettingsDebounced === 'function') {
            try {
                context.saveSettingsDebounced();
            } finally {
                // The extension context exposes no completion/error signal for
                // this queued save, so persistence cannot be certified.
                persisted = false;
            }
        } else {
            persisted = false;
        }
    }
    return persisted;
}

/** Mirrors the host's current Message -> outbound object conversion for metrics. */
function promptManagerOutboundMessages(promptManager) {
    const flat = promptManager?.messages?.flatten?.();
    if (!Array.isArray(flat) || flat.some(message => message && !message.role)) {
        return null;
    }
    return flat
        .filter(message => message && (message.content || message.tool_calls))
        .map(message => ({
            role: message.role,
            content: safeClone(message.content),
            ...(message.name ? { name: message.name } : {}),
            ...(message.tool_calls ? { tool_calls: safeClone(message.tool_calls) } : {}),
            ...(message.role === 'tool' ? { tool_call_id: message.identifier } : {}),
            ...(message.signature ? { signature: message.signature } : {}),
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        }));
}

/**
 * Listens for one prompt assembly. Listeners are attached only for the length
 * of a capture, so a user's own generations are never observed.
 */
export function createCaptureSession(hostRef = getContext, ownedSignal = null) {
    const context = ctxOf(hostRef);
    const source = context?.eventSource;
    const events = context?.eventTypes;
    const attached = [];
    let ownedGeneration = null;

    const state = {
        started: false,
        dryRun: null,
        generateData: null,
        ccMessages: null,
        beforeCombine: null,
        combinedPrompt: null,
        useSysPrompt: null,
        useTools: null,
        prefillString: '',
        promptNames: null,
        wiPasses: [],
        cacheScope: null,
    };

    function listen(eventType, handler) {
        if (!eventType || !source) {
            return;
        }
        // makeLast so anything that rewrites the prompt has already run and the
        // Lab records what Neconyan would really send.
        const add = typeof source.makeLast === 'function' ? source.makeLast.bind(source) : source.on.bind(source);
        add(eventType, handler);
        attached.push({ eventType, handler });
    }

    const onGenerationStarted = (type, options, dryRun) => {
        if (dryRun !== true || options?.signal !== ownedSignal) {
            ownedGeneration = false;
            return;
        }
        ownedGeneration = true;
        state.started = true;
        state.dryRun = Boolean(dryRun);
        state.cacheScope = options?.cacheScope ?? (type === 'quiet' ? 'auxiliary' : 'main');
    };

    const onAfterData = (generateData, dryRun) => {
        if (ownedGeneration === false) {
            return;
        }
        if (dryRun !== undefined) {
            state.dryRun = Boolean(dryRun);
        }
        state.cacheScope = generateData?.cacheScope ?? state.cacheScope;
        if (typeof generateData?.use_sysprompt === 'boolean') {
            state.useSysPrompt = generateData.use_sysprompt;
        }
        if (typeof generateData?.use_tools === 'boolean') {
            state.useTools = generateData.use_tools;
        } else if (Array.isArray(generateData?.tools)) {
            state.useTools = generateData.tools.length > 0;
        }
        if (typeof generateData?.assistant_prefill === 'string') {
            state.prefillString = generateData.assistant_prefill;
        }
        if (generateData?.char_name || generateData?.user_name || Array.isArray(generateData?.group_names)) {
            state.promptNames = {
                charName: String(generateData.char_name ?? ''),
                userName: String(generateData.user_name ?? ''),
                groupNames: Array.isArray(generateData.group_names)
                    ? generateData.group_names.map(String)
                    : [],
            };
        }
        if (Array.isArray(generateData?.prompt)) {
            state.generateData = { messages: cloneMessages(generateData.prompt) };
        } else if (typeof generateData?.prompt === 'string') {
            state.generateData = { prompt: generateData.prompt };
        }
    };

    const onChatCompletionReady = (data) => {
        if (ownedGeneration === false) {
            return;
        }
        state.ccMessages = cloneMessages(data?.chat);
    };

    const onBeforeCombine = (data) => {
        if (ownedGeneration === false) {
            return;
        }
        // The negative-prompt pass for CFG re-emits this event with no dry-run
        // flag of its own. Only the first pass is the prompt being measured.
        if (state.beforeCombine) {
            return;
        }
        const copy = {};
        for (const [key, value] of Object.entries(data ?? {})) {
            if (typeof value === 'string') {
                copy[key] = value;
            }
        }
        state.beforeCombine = copy;
    };

    const onAfterCombine = (data) => {
        if (ownedGeneration === false) {
            return;
        }
        if (typeof data?.prompt === 'string' && state.combinedPrompt === null) {
            state.combinedPrompt = data.prompt;
        }
    };

    const onWorldInfoScanDone = (payload) => {
        if (ownedGeneration === false) {
            return;
        }
        // An empty pass is still a pass: a scan that activated nothing is a
        // definite answer, not a missing measurement. Dropping it would make
        // "entry activates" checks unanswerable instead of failed.
        state.wiPasses.push(extractWorldInfoPass(payload));
    };

    return {
        attach() {
            listen(events?.GENERATION_STARTED, onGenerationStarted);
            listen(events?.GENERATION_AFTER_COMMANDS, onGenerationStarted);
            listen(events?.GENERATE_AFTER_DATA, onAfterData);
            listen(events?.CHAT_COMPLETION_PROMPT_READY, onChatCompletionReady);
            listen(events?.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforeCombine);
            listen(events?.GENERATE_AFTER_COMBINE_PROMPTS, onAfterCombine);
            listen(events?.WORLDINFO_SCAN_DONE, onWorldInfoScanDone);
        },
        detach() {
            while (attached.length) {
                const { eventType, handler } = attached.pop();
                source?.removeListener?.(eventType, handler);
            }
        },
        getState() {
            return state;
        },
    };
}

/**
 * Adds the test case's example message to the chat for the length of one
 * assembly, then takes it out again.
 *
 * A real send pushes the user's message into the chat before the prompt is
 * built, so lorebook scanning and history both see it. Doing the same here is
 * what makes a test faithful. A dry run never reaches the code that saves a
 * chat, so nothing is written to disk; the message is removed by identity in a
 * finally block so an error cannot leave it behind.
 */
export async function withTransientUserMessage(hostRef, messageText, run) {
    return withTransientMessages(hostRef, [{ role: 'user', text: messageText }], run);
}

/**
 * The same trick for a whole exchange: a scene comparison replays several turns
 * of user messages and model replies, and each later turn has to be built with
 * the ones before it in the chat, exactly as a real conversation would.
 *
 * Entries are `{role: 'user'|'assistant', text}`. Empty ones are ignored, and
 * every entry added is removed again by identity, newest first.
 */
export async function withTransientMessages(hostRef, entries, run) {
    const context = ctxOf(hostRef);
    const usable = (entries ?? [])
        .map(entry => ({ role: entry?.role === 'assistant' ? 'assistant' : 'user', text: String(entry?.text ?? '') }))
        .filter(entry => entry.text);
    if (!usable.length || !Array.isArray(context?.chat)) {
        return run();
    }

    const added = usable.map((entry) => {
        const isUser = entry.role === 'user';
        return {
            name: (isUser ? context.name1 : context.name2) ?? (isUser ? 'You' : 'Assistant'),
            is_user: isUser,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: entry.text,
            extra: {},
        };
    });
    context.chat.push(...added);
    try {
        return await run();
    } finally {
        for (const entry of [...added].reverse()) {
            const index = context.chat.indexOf(entry);
            if (index !== -1) {
                context.chat.splice(index, 1);
            }
        }
    }
}

/**
 * Runs one dry-run assembly and returns everything observed.
 * @returns {Promise<object>} capture result with sections, tokens and caveats.
 */
export async function captureOnce({ userMessage = '', scene = null, context = getContext, host = null, signal = null } = {}) {
    const hostRef = context;
    const initial = ctxOf(hostRef);
    if (typeof initial?.generate !== 'function') {
        throw new Error('Prompting Lab cannot build a prompt because Neconyan\'s generate function is unavailable. Reload Neconyan and try again.');
    }

    // A test case injects one message; a scene comparison injects the exchange
    // so far. Both are removed again once the prompt has been built.
    const entries = Array.isArray(scene) && scene.length
        ? scene
        : [{ role: 'user', text: userMessage }];

    const captureController = new AbortController();
    const relayAbort = () => captureController.abort(signal?.reason);
    if (signal?.aborted) {
        relayAbort();
    } else {
        signal?.addEventListener?.('abort', relayAbort, { once: true });
    }

    let isolation = null;
    let session = null;
    let macroState = null;
    let result = null;
    let localMacroStateRestored = false;
    let macroRollbackPersisted = true;
    try {
        isolation = await beginGenerationIsolation(initial, captureController.signal);
        session = createCaptureSession(hostRef, captureController.signal);
        macroState = mutableMacroState(initial);
        session.attach();
        await withClearedTextarea(() => withTransientMessages(
            hostRef,
            entries,
            () => ctxOf(hostRef).generate('normal', { signal: captureController.signal }, true),
        ));
        if (isolation.overlapped()) {
            throw new Error('Another Neconyan generation overlapped this prompt build. The test capture was discarded before that generation continued.');
        }

        const state = session.getState();
        const caveats = [
            CAVEAT.NO_INTERCEPTORS,
            CAVEAT.LIVE_CHAT_DRY_RUN,
            CAVEAT.MACRO_SANDBOX_UNAVAILABLE,
        ];
        // Read after assembly: a connection profile may have changed the API,
        // and the context copies mainApi by value.
        const live = ctxOf(hostRef);
        const apiType = live.mainApi === 'openai' ? 'cc' : 'tc';

        const messages = state.ccMessages ?? state.generateData?.messages ?? null;
        const combinedPrompt = state.generateData?.prompt ?? state.combinedPrompt ?? null;

        let sections = [];
        let tokenTable = { total: 0, perSection: {} };
        let metricsComplete = true;

        if (apiType === 'cc') {
            const read = readChatCompletionSections(host, live.promptManager);
            sections = read.sections;
            tokenTable = read.tokenTable;
            const assembledMessages = promptManagerOutboundMessages(live.promptManager);
            let sectionMetricsMatch = false;
            try {
                sectionMetricsMatch = canonicalOutbound({ messages: assembledMessages })
                    === canonicalOutbound({ messages });
            } catch {
                sectionMetricsMatch = false;
            }
            if (!sectionMetricsMatch) {
                metricsComplete = false;
                caveats.push(CAVEAT.FINAL_METRICS_INCOMPLETE);
                const content = messagesToText(messages);
                if (content) {
                    sections.push({
                        id: 'finalInterceptors',
                        label: sectionLabel('finalInterceptors'),
                        content,
                        tokens: 0,
                    });
                    tokenTable.perSection.finalInterceptors = 0;
                }
            }
        } else {
            const read = await readTextCompletionSections(state.beforeCombine, combinedPrompt);
            sections = read.sections;
            tokenTable = read.tokenTable;
            if (read.estimated) {
                caveats.push(CAVEAT.TOKENIZER_FALLBACK);
            }
        }
        tokenTable.metricsComplete = metricsComplete;

        if (!(Array.isArray(messages) && messages.length)
            && !(typeof combinedPrompt === 'string' && combinedPrompt.length)) {
            throw new Error('Prompting Lab did not receive a prompt from Neconyan. Check that a character is selected and that the connection settings are complete.');
        }

        result = {
            apiType,
            messages,
            combinedPrompt,
            sections,
            tokenTable,
            wiPasses: state.wiPasses,
            cacheScope: state.cacheScope ?? 'main',
            sourceTexts: collectSourceTexts(live),
            caveats,
            metricsComplete,
            capabilities: {
                finalPromptExact: false,
                syntheticMessagesIsolated: false,
                macroStateSandboxed: false,
                localMacroStateRestored: false,
                macroRollbackPersisted: false,
            },
            // GENERATE_AFTER_DATA has omitted metadata on older hosts. These
            // live values are authoritative after profile application.
            useSysPrompt: state.useSysPrompt
                ?? live?.chatCompletionSettings?.use_sysprompt
                ?? true,
            useTools: state.useTools
                ?? live?.isToolCallingSupported?.()
                ?? true,
            prefillString: state.prefillString
                || String(live?.chatCompletionSettings?.assistant_prefill ?? ''),
            promptNames: state.promptNames ?? {
                charName: String(live?.name2 ?? ''),
                userName: String(live?.name1 ?? ''),
                groupNames: [],
            },
        };
    } finally {
        try {
            if (macroState) {
                const changed = restoreMutableState(macroState);
                localMacroStateRestored = true;
                macroRollbackPersisted = await persistMutableState(initial, changed);
            }
        } finally {
            try {
                session?.detach();
            } finally {
                try {
                    isolation?.release();
                } finally {
                    signal?.removeEventListener?.('abort', relayAbort);
                }
            }
        }
    }

    if (isolation?.overlapped()) {
        throw new Error('Another Neconyan generation overlapped this prompt build. The test capture was discarded before that generation continued.');
    }
    if (!macroRollbackPersisted) {
        result.caveats.push(CAVEAT.MACRO_ROLLBACK_UNCONFIRMED);
    }
    result.capabilities.localMacroStateRestored = localMacroStateRestored;
    result.capabilities.macroRollbackPersisted = macroRollbackPersisted;
    return result;
}
