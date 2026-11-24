import { randomUUID } from 'node:crypto';
import { fail, hash, list, object, sourceEligible, sourceRead, text } from './core.js';
import { generationFingerprint } from './context.js';
import { readConfig } from './models.js';
import { processingVersion } from './processing.js';
import { recall } from './retrieval.js';
import { loadCurrentState } from './sources.js';
import { memoryEnabled, mutateState, normalizeLocator, readChatShared } from './store.js';
import { getCounter } from './tokens.js';
import { readViewers, viewerState } from './viewers.js';
import { readGroupSceneRules } from '../../public/scripts/group-chat-visibility.js';
import { messageHistoryPlan } from '../../public/scripts/mewmory/history-policy.js';
import { wrapMewmoryContext } from '../../public/scripts/mewmory/prompt-proof.js';

export async function prepareMewmoryPrompt(directories, body, signal, {
    // The shared chat read is the one loadState just used; this function only reads what it returns.
    loadState = loadCurrentState, mutate = mutateState, readSource = readChatShared, scheduleBackground = true, readConfiguration = readConfig,
    deterministicMarker = false, isEnabled = loadState === loadCurrentState ? memoryEnabled : null,
} = {}) {
    const locator = normalizeLocator(body.locator);
    signal?.throwIfAborted();
    const state = isEnabled && !isEnabled(directories, locator) ? null : await loadState(directories, locator);
    if (!state?.enabled) {
        if (body.mewmoryWaitSnapshot) fail('Mewmory was turned off while waiting. Retry this reply.', 409);
        return { enabled: false, excludedIndices: [], npcText: '', memoryText: '' };
    }
    if (body.historyOmitted) {
        // The client only skips history when its last view said memory was off.
        // If a change landed since, ask for the history instead of rejecting.
        return { enabled: true, needsHistory: true };
    }
    const config = readConfiguration(directories);
    if (body.mewmoryCatchUpOverride !== undefined && body.mewmoryCatchUpOverride !== 'reply') fail('Choose a valid memory catch-up option.');
    const snapshot = generationFingerprint(state, config);
    const viewers = readViewers(body.viewers, fail);
    const source = readSource(directories, locator);
    // A group speaker recalls only memories built from lines they heard.
    const view = viewerState(state, viewers, readGroupSceneRules(source.metadata));
    if (body.integrity && source.metadata.integrity !== body.integrity) {
        fail('This chat changed in another tab. Reload the chat, then send again.', 409);
    }
    const offset = state.inheritedTimeline?.length || 0;
    const counter = await getCounter(config.writerTokenizer, body.tokenizer || {});
    let previous = -1;
    const history = list(body.history, 'Prompt history', 100000).map(item => {
        object(item, 'History item');
        if (!Number.isInteger(item.index) || item.index <= previous || item.index >= source.messages.length) fail('The chat history arrived in the wrong order. Reload the chat and send again.');
        previous = item.index;
        const content = text(item.text, 'History text', 2000000, true);
        return { index: item.index, text: content, tokens: counter.count(content) + 4 };
    });
    const asOf = history.length ? history.at(-1).index + offset : offset - 1;
    const startForWindow = target => {
        let tokens = 0;
        let index = history.length;
        while (index > 0) {
            const next = history[index - 1].tokens;
            if (index < history.length && tokens + next > target) break;
            tokens += next;
            index--;
        }
        return index;
    };
    const policy = processingVersion(config);
    const excludedIndices = [];
    let desiredStart = 0;
    let waitingForPreservation = false;
    let excludedMessages = 0;
    let excludedToolRows = 0;
    let desiredIndices = [];
    // A message read under older settings, or before a card or lorebook entry
    // changed, still has its memories, so it stays out of the prompt until the
    // author chooses to re-read it.
    const isPreserved = index => {
        const ref = state.timeline[index + offset];
        if (ref && view?.heldRefs.has(ref.id)) return false;
        return Boolean(ref && (!sourceEligible(state, ref) || sourceRead(state.checkpoints, ref)));
    };
    if (config.excludeHistory && config.historyMode === 'messages') {
        const ordinary = history.filter(item => {
            const message = source.messages[item.index];
            return !message?.is_system && !message?.extra?.nn_generation_failed;
        }).map(item => item.index);
        const selection = messageHistoryPlan(ordinary, config.recentMessages, config.historyBatchMessages, isPreserved);
        desiredIndices = ordinary.slice(0, selection.target);
        excludedIndices.push(...selection.excluded);
        excludedMessages = selection.excluded.length;
        desiredStart = selection.target;
        waitingForPreservation = selection.waitingForPreservation;
        const boundary = ordinary[selection.excluded.length];
        if (boundary !== undefined) {
            for (const item of history) {
                const message = source.messages[item.index];
                if (item.index < boundary && message?.is_system && message.extra?.tool_invocations) {
                    excludedIndices.push(item.index);
                    excludedToolRows++;
                }
            }
        }
        for (const item of history) {
            if (source.messages[item.index]?.extra?.nn_generation_failed) excludedIndices.push(item.index);
        }
    } else {
        desiredStart = config.excludeHistory ? startForWindow(config.historyWindow) : 0;
        desiredIndices = history.slice(0, desiredStart).map(item => item.index);
        for (const item of history.slice(0, desiredStart)) {
            if (!isPreserved(item.index)) break;
            excludedIndices.push(item.index);
        }
        excludedMessages = excludedIndices.length;
        waitingForPreservation = excludedMessages < desiredStart;
    }
    if (body.mewmoryWaitSnapshot && (!config.excludeHistory || config.historyCatchUp !== 'wait' || body.mewmoryCatchUpOverride === 'reply')) {
        fail('Mewmory settings changed while waiting. Retry this reply.', 409);
    }
    if (config.excludeHistory && config.historyCatchUp === 'wait' && body.mewmoryCatchUpOverride !== 'reply') {
        const requiredRefs = desiredIndices.map(index => state.timeline[index + offset]);
        if (requiredRefs.some(ref => !ref)) fail('Mewmory cannot identify an older message. Reload the chat and retry this reply.', 409);
        const eligibleRefs = requiredRefs.filter(ref => sourceEligible(state, ref));
        const waitSnapshot = { fingerprint: snapshot, requiredRefs: eligibleRefs, policy,
            history: hash(history.map(({ index, text }) => [index, text])), branchId: state.branchId };
        if (body.mewmoryWaitSnapshot && hash(body.mewmoryWaitSnapshot) !== hash(waitSnapshot)) {
            fail('The chat or Mewmory settings changed while waiting. Retry this reply.', 409);
        }
        if (waitingForPreservation) {
            return { enabled: true, waiting: true, waitSnapshot,
                pending: eligibleRefs.filter(ref => !sourceRead(state.checkpoints, ref)).length,
                processing: state.processing || null, extractorEnabled: Boolean(config.roles.extractor.enabled) };
        }
    }
    excludedIndices.sort((left, right) => left - right);
    const excluded = new Set(excludedIndices);
    const retained = history.filter(item => !excluded.has(item.index)).flatMap(item => {
        const ref = state.timeline[item.index + offset];
        return ref ? [{ ref, text: item.text }] : [];
    });
    const historyUsage = {
        originalTokens: history.reduce((sum, item) => sum + item.tokens, 0),
        retainedTokens: history.filter(item => !excluded.has(item.index)).reduce((sum, item) => sum + item.tokens, 0),
        target: config.historyMode === 'messages' ? config.recentMessages : config.historyWindow,
        mode: config.historyMode || 'tokens', retainedMessages: history.filter(item => !excluded.has(item.index)
            && !source.messages[item.index]?.is_system && !source.messages[item.index]?.extra?.nn_generation_failed).length,
        excludedMessages, excludedToolRows, removalBatchMessages: config.historyBatchMessages,
        waitingForPreservation,
    };
    const nonce = deterministicMarker ? hash([state.branchId, body.history, config.revision]).slice(0, 32) : randomUUID();
    const marker = { open: '[Mewmory context ' + nonce + ' begin]', close: '[Mewmory context ' + nonce + ' end]' };
    // Each preparation owns one preview, even when two concurrent preparations share a fingerprint.
    const previewId = randomUUID();
    // Reuse the state loaded above, let recall write the preview and its history usage together,
    // and skip recall's pre-commit source sync because the final check below reads the chat again.
    const context = await recall(directories, locator, {
        asOf, tokenizer: body.tokenizer || {}, signal, local: true, retained, marker,
        state, precommitSync: false, previewHistory: historyUsage, previewId, viewer: view,
    }, { loadState, mutate, scheduleBackground, readConfiguration });
    if (!context.enabled) fail('Mewmory was turned off while this reply was being prepared. Retry this reply.', 409);
    if (!context.suppression) fail('Mewmory could not finish preparing its memory context. Retry this reply.', 409);
    context.memoryText = wrapMewmoryContext(context.memoryText, marker);
    context.suppression.fallbackMemoryText = wrapMewmoryContext(context.suppression.fallbackMemoryText, marker);
    // Recall has already committed a preview beside its history. If the final source check
    // rejects this preparation, remove exactly that preview so a stale pick is not left on screen.
    const rejectPreparation = message => {
        try {
            mutate(directories, locator, current => {
                if (current.preview?.previewId === previewId) current.preview = null;
            });
        } catch {
            // Keep the original 409; the final check is the safety boundary, not this cleanup.
        }
        fail(message, 409);
    };
    const currentState = await loadState(directories, locator);
    if (!currentState.enabled) rejectPreparation('Mewmory was turned off while this reply was being prepared. Retry this reply.');
    if (generationFingerprint(currentState, readConfiguration(directories)) !== snapshot) {
        rejectPreparation('The chat, Mewmory settings, or a memory you edited changed while the reply was being prepared. Reload and send again.');
    }
    return {
        ...context, excludedIndices,
        history: historyUsage,
    };
}
