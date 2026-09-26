/**
 * Everything that talks to the Neconyan host. The context is resolved fresh
 * on every call: getContext() copies chatId/characterId/chatMetadata by value.
 */
import {
    CARD_KEY,
    CHAT_KEY,
    EXTRA_KEY,
    PROMPT_DIRECTION_KEY,
    PROMPT_RULES_KEY,
    SETTINGS_KEY,
    buildDirection,
    buildManuscript,
    buildRules,
    buildTransformPrompt,
    canRevertBlock,
    cleanTransformResult,
    contextWindow,
    countWords,
    extractReasonings,
    getCuts,
    normalizeSettings,
    resolveEnabled,
    textRevision,
} from './core.js';

/** extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM */
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const RULES_DEPTH = 1;
const DIRECTION_DEPTH = 0;

export function ctx() {
    return globalThis.SillyTavern.getContext();
}

export function toast(kind, message) {
    globalThis.toastr?.[kind]?.(message);
}

// ---------------------------------------------------------------- settings

/** Read-only: defaults are filled in on the returned copy, never written into settings.json (only updateSettings writes). */
export function getSettings() {
    return normalizeSettings(ctx().extensionSettings?.[SETTINGS_KEY]);
}

export function updateSettings(patch) {
    const context = ctx();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
        context.saveSettingsDebounced?.();
    }
    return next;
}

// ---------------------------------------------------------------- per chat / per card

export function hasChat() {
    const context = ctx();
    return Boolean(context.chatId) || (Array.isArray(context.chat) && context.chat.length > 0);
}

/** The chat as plain prose, its word count, and a file name built from the character (or group) and today's date. */
export function manuscript() {
    const context = ctx();
    const text = buildManuscript(context.chat);
    const who = context.groupId
        ? context.groups?.find((group) => group?.id === context.groupId)?.name
        : context.name2;
    const safeName = String(who || 'Story').replace(/[\\/:*?"<>|]+/gu, '').trim() || 'Story';
    const date = new Date().toISOString().slice(0, 10);
    return { text, words: countWords(text), fileName: `${safeName} - ${date}.txt` };
}

export function getChatFlag() {
    const value = ctx().chatMetadata?.[CHAT_KEY]?.enabled;
    return typeof value === 'boolean' ? value : undefined;
}

export async function setChatFlag(enabled) {
    const context = ctx();
    const meta = context.chatMetadata;
    if (!meta) {
        return false;
    }
    const current = meta[CHAT_KEY] && typeof meta[CHAT_KEY] === 'object' ? meta[CHAT_KEY] : {};
    const previous = meta[CHAT_KEY];
    const next = { ...current, enabled: Boolean(enabled) };
    meta[CHAT_KEY] = next;
    try {
        if (await context.saveMetadata({ throwOnError: true }) !== true) {
            throw new Error('Chat preference was not saved');
        }
    } catch (error) {
        if (meta[CHAT_KEY] === next) {
            if (previous === undefined) delete meta[CHAT_KEY];
            else meta[CHAT_KEY] = previous;
        }
        throw error;
    }
    return true;
}

export function currentCharacter() {
    const context = ctx();
    if (context.groupId) {
        return null;
    }
    const id = context.characterId;
    if (id === undefined || id === null || id === '') {
        return null;
    }
    return context.characters?.[id] ?? null;
}

export function getCardConfig() {
    const character = currentCharacter();
    const config = character?.data?.extensions?.[CARD_KEY];
    if (!config || typeof config !== 'object') {
        return character ? { default: undefined, instruction: '' } : null;
    }
    return {
        default: typeof config.default === 'boolean' ? config.default : undefined,
        instruction: typeof config.instruction === 'string' ? config.instruction : '',
    };
}

let cardWrite = Promise.resolve();

/**
 * The host persists card fields with a merge, so a key can only be cleared by
 * writing an explicit empty value: `default: null` means "no preference".
 */
export async function setCardConfig(patch, character = currentCharacter()) {
    if (!character) {
        return false;
    }
    const avatar = character.avatar;
    const changes = { ...patch };
    const write = cardWrite.catch(() => {}).then(async () => {
        const context = ctx();
        if (currentCharacter() !== character || character.avatar !== avatar) {
            throw new Error('The selected character changed. Your draft was not saved.');
        }
        const characterId = context.characterId;
        const stored = character.data?.extensions?.[CARD_KEY];
        const current = stored && typeof stored === 'object'
            ? { default: typeof stored.default === 'boolean' ? stored.default : undefined, instruction: typeof stored.instruction === 'string' ? stored.instruction : '' }
            : { default: undefined, instruction: '' };
        const merged = { ...current, ...changes };
        const next = {
            default: typeof merged.default === 'boolean' ? merged.default : null,
            instruction: typeof merged.instruction === 'string' ? merged.instruction.trim() : '',
        };
        if (await context.writeExtensionField(characterId, CARD_KEY, next, { throwOnError: true }) !== true) {
            throw new Error('Character preference was not saved');
        }
        return true;
    });
    cardWrite = write;
    return write;
}

export function isEnabled() {
    if (!hasChat()) {
        return false;
    }
    return resolveEnabled({
        chatFlag: getChatFlag(),
        cardDefault: getCardConfig()?.default,
        globalDefault: getSettings().defaultOn,
    });
}

// ---------------------------------------------------------------- prompt injections

export function setRules() {
    const settings = getSettings();
    const card = getCardConfig();
    const text = buildRules(card?.instruction || settings.rules, { lengthHint: settings.lengthHint });
    ctx().setExtensionPrompt(PROMPT_RULES_KEY, text, IN_CHAT, RULES_DEPTH, false, ROLE_SYSTEM);
}

export function clearRules() {
    ctx().setExtensionPrompt(PROMPT_RULES_KEY, '', IN_CHAT, RULES_DEPTH, false, ROLE_SYSTEM);
}

export function setDirection(text) {
    const value = buildDirection(text);
    ctx().setExtensionPrompt(PROMPT_DIRECTION_KEY, value, IN_CHAT, DIRECTION_DEPTH, false, ROLE_SYSTEM);
    return Boolean(value);
}

export function clearDirection() {
    ctx().setExtensionPrompt(PROMPT_DIRECTION_KEY, '', IN_CHAT, DIRECTION_DEPTH, false, ROLE_SYSTEM);
}

// ---------------------------------------------------------------- cuts (where the model's text starts in a block)

export function lastIndex() {
    const chat = ctx().chat;
    return Array.isArray(chat) ? chat.length - 1 : -1;
}

export function messageAt(index) {
    return ctx().chat?.[index] ?? null;
}

function storyExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    const existing = message.extra[EXTRA_KEY];
    if (!existing || typeof existing !== 'object') {
        message.extra[EXTRA_KEY] = {};
    }
    return message.extra[EXTRA_KEY];
}

function chatIdentity(context = ctx()) {
    return context.groupId
        ? `group:${context.groupId}:${context.chatId ?? ''}`
        : `character:${context.characterId ?? ''}:${context.chatId ?? ''}`;
}

function captureChat() {
    const context = ctx();
    return { context, chat: context.chat, key: chatIdentity(context) };
}

function isCurrentChat(action) {
    const context = ctx();
    return chatIdentity(context) === action.key && context.chat === action.chat;
}

function pushMessageCut(message) {
    if (!message) {
        return null;
    }
    const cut = String(message.mes ?? '').length;
    const cuts = getCuts(message);
    if (cuts.at(-1) !== cut) {
        setCuts(message, [...cuts, cut]);
    }
    return cut;
}

export function pushCut(index) {
    return pushMessageCut(messageAt(index));
}

export function dropCuts(index) {
    const message = messageAt(index);
    if (message) {
        setCuts(message, []);
    }
}

function setCuts(message, cuts) {
    if (cuts.length) {
        const state = { cuts: [...cuts], revision: textRevision(message.mes) };
        Object.assign(storyExtra(message), state);
    } else if (message.extra?.[EXTRA_KEY]) {
        delete message.extra[EXTRA_KEY].cuts;
        delete message.extra[EXTRA_KEY].revision;
        delete message.extra[EXTRA_KEY].continuations;
        if (!message.extra[EXTRA_KEY].reasonings?.length) {
            delete message.extra[EXTRA_KEY].reasonings;
        }
        if (Object.keys(message.extra[EXTRA_KEY]).length === 0) {
            delete message.extra[EXTRA_KEY];
        }
    }
    const swipeInfo = Array.isArray(message.swipe_info) && typeof message.swipe_id === 'number'
        ? message.swipe_info[message.swipe_id]
        : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra ??= {};
        if (message.extra?.[EXTRA_KEY]) {
            swipeInfo.extra[EXTRA_KEY] = structuredClone(message.extra[EXTRA_KEY]);
        } else {
            delete swipeInfo.extra[EXTRA_KEY];
        }
    }
}

/** The host mirrors `mes` into the active swipe after every reply; keep that true after our own edits. */
function syncSwipe(message) {
    if (Array.isArray(message.swipes) && message.swipe_id !== undefined && message.swipe_id !== null) {
        message.swipes[message.swipe_id] = message.mes;
    }
    const info = message.swipe_info?.[message.swipe_id];
    if (info) {
        info.extra = structuredClone(message.extra ?? {});
        for (const field of ['send_date', 'gen_started', 'gen_finished']) {
            if (Object.hasOwn(message, field)) info[field] = message[field];
            else delete info[field];
        }
    }
}

export function getMessageReasonings(message) {
    return extractReasonings(message, EXTRA_KEY);
}

export function recordContinuationReasoning(message, { cut = 0, prevReasoning = null, prevDuration = null } = {}) {
    if (!message || typeof message !== 'object') {
        return;
    }
    const raw = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : '';
    const current = (prevReasoning && raw.startsWith(prevReasoning) ? raw.slice(prevReasoning.length) : raw).trim();
    const hasPrev = typeof prevReasoning === 'string' && Boolean(prevReasoning.trim());
    if (!current && !hasPrev) {
        return;
    }
    const extra = storyExtra(message);
    extra.reasonings ??= [];

    if (extra.reasonings.length === 0 && hasPrev) {
        extra.reasonings.push({
            cut: 0,
            text: prevReasoning.trim(),
            duration: typeof prevDuration === 'number' ? prevDuration : (Number(prevDuration) || null),
        });
    }

    if (!current) {
        return;
    }

    const last = extra.reasonings.at(-1);
    if (last && last.cut === cut && last.text === current) {
        return;
    }

    extra.reasonings.push({
        cut,
        text: current,
        duration: typeof message.extra?.reasoning_duration === 'number' ? message.extra.reasoning_duration : (Number(message.extra?.reasoning_duration) || null),
    });

    const swipeInfo = Array.isArray(message.swipe_info) && typeof message.swipe_id === 'number'
        ? message.swipe_info[message.swipe_id]
        : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra ??= {};
        swipeInfo.extra[EXTRA_KEY] = structuredClone(extra);
    }
}

function hasCutMetadata(message) {
    const state = message?.extra?.[EXTRA_KEY];
    return Boolean(state && (Object.hasOwn(state, 'cuts') || Object.hasOwn(state, 'revision')));
}

function restoreMessage(message, snapshot, expected = message) {
    for (const key of new Set([...Object.keys(snapshot), ...Object.keys(expected)])) {
        if (sameMessage(message[key], expected[key])) {
            if (Object.hasOwn(snapshot, key)) Object.defineProperty(message, key, { value: structuredClone(snapshot[key]), writable: true, enumerable: true, configurable: true });
            else delete message[key];
        } else if (Object.hasOwn(message, key) && message[key] && typeof message[key] === 'object'
            && (snapshot[key] === undefined || (snapshot[key] && typeof snapshot[key] === 'object'))
            && (expected[key] === undefined || (expected[key] && typeof expected[key] === 'object'))
            && (!Array.isArray(message[key]) || (Array.isArray(snapshot[key]) && Array.isArray(expected[key])))) {
            restoreMessage(message[key], snapshot[key] ?? {}, expected[key] ?? {});
        }
    }
    if (Array.isArray(message) && Array.isArray(snapshot)) {
        while (message.length > snapshot.length && !Object.hasOwn(message, message.length - 1)) message.length--;
    }
}

/** Persist changed metadata only. Prose is recovered from the cut; Story arrays retain just their old lengths. */
function metadataUndo(before = {}, after = {}) {
    const changes = (old = {}, next = {}, skip = []) => [...new Set([...Object.keys(old), ...Object.keys(next)])]
        .filter(key => !skip.includes(key) && !sameMessage(old[key], next[key]))
        .map(key => {
            // Accumulated reasoning (or display text) already contains its previous value.
            if (typeof old[key] === 'string' && typeof next[key] === 'string' && next[key].startsWith(old[key])) {
                return [key, old[key].length, textRevision(old[key])];
            }
            return old[key] === undefined ? [key] : [key, structuredClone(old[key])];
        });
    const story = before.extra?.[EXTRA_KEY];
    const arrays = ['cuts', 'reasonings', 'continuations'];
    return {
        fields: changes(before, after, ['mes', 'swipes', 'swipe_info', 'extra']),
        extra: changes(before.extra, after.extra, [EXTRA_KEY]),
        extraPresent: Object.hasOwn(before, 'extra'),
        story: story ? {
            fields: changes(story, after.extra?.[EXTRA_KEY], arrays),
            lengths: Object.fromEntries(arrays.filter(key => Array.isArray(story[key])).map(key => [key, story[key].length])),
        } : null,
    };
}

function restoreMetadata(message, state) {
    message.extra ??= {};
    const story = state.story ? storyExtra(message) : null;
    for (const [target, changes] of [[message, state.fields], [message.extra, state.extra], [story, state.story?.fields ?? []]]) {
        if (!Array.isArray(changes)) throw new Error('The continuation metadata is invalid');
        for (const change of changes) {
            if (!Array.isArray(change) || change.length < 1 || change.length > 3 || typeof change[0] !== 'string'
                || ['__proto__', 'prototype', 'constructor'].includes(change[0])
                || (target === message && ['mes', 'swipes', 'swipe_info', 'extra'].includes(change[0]))
                || (target === message.extra && change[0] === EXTRA_KEY)
                || (target === story && ['cuts', 'reasonings', 'continuations'].includes(change[0]))) {
                throw new Error('The continuation metadata is invalid');
            }
            if (change.length === 1) delete target[change[0]];
            else if (change.length === 3) {
                const prefix = String(target[change[0]] ?? '').slice(0, change[1]);
                if (textRevision(prefix) !== change[2]) throw new Error('The continuation metadata changed');
                target[change[0]] = prefix;
            } else target[change[0]] = structuredClone(change[1]);
        }
    }
    if (story) {
        for (const key of ['cuts', 'reasonings', 'continuations']) {
            if (Object.hasOwn(state.story.lengths, key)) {
                const length = state.story.lengths[key];
                if (!Number.isInteger(length) || length < 0 || length > (story[key]?.length ?? 0)) {
                    throw new Error('The continuation history is invalid');
                }
                story[key] = (story[key] ?? []).slice(0, length);
            } else delete story[key];
        }
    } else {
        delete message.extra[EXTRA_KEY];
    }
    if (!state.extraPresent && Object.keys(message.extra).length === 0) delete message.extra;
}

function sameMessage(message, snapshot) {
    return JSON.stringify(message) === JSON.stringify(snapshot);
}

async function saveChat(action, options = {}) {
    if (!isCurrentChat(action)) throw new Error('The chat changed before it could be saved');
    if (await action.context.saveChat({ throwOnError: true, ...options }) !== true) {
        throw new Error('The story was not saved');
    }
}

async function saveRollback(action, options = {}) {
    try {
        await saveChat(action, options);
    } catch {
        // Leave recovery available if the server cannot acknowledge the restored state either.
    }
}

async function renderMessage(action, index, message) {
    if (isCurrentChat(action) && action.chat[index] === message) {
        try {
            await action.context.updateMessageBlock(index, message);
            action.context.swipe?.refresh?.();
        } catch (error) {
            console.warn('[Story Mode] could not refresh the restored block', error);
        }
    }
}

// ---------------------------------------------------------------- edit snapshots

const editSnapshots = new Map();

/** Remember a block's text when its editor opens; an unchanged close keeps its cuts. */
export function noteEditOpened(index) {
    const message = messageAt(index);
    if (message) {
        editSnapshots.set(Number(index), String(message.mes ?? ''));
    }
}

export function onMessageEdited(index) {
    const id = Number(index);
    const snapshot = editSnapshots.get(id);
    editSnapshots.delete(id);
    const message = messageAt(id);
    if (!message) {
        return false;
    }
    if (snapshot !== undefined && snapshot === String(message.mes ?? '')) {
        return false;
    }
    dropCuts(id);
    return true;
}

// ---------------------------------------------------------------- generation lifecycle

let inflight = null;
const hooks = { beforeGeneration: null, afterGeneration: null, busyChanged: null };

export function setHooks(partial) {
    Object.assign(hooks, partial);
}

export function isInflight() {
    return inflight !== null;
}

export function resetInflight() {
    inflight = null;
    refreshBusy();
}

/**
 * The host's own generating markers are the truth. GENERATION_ENDED is not a
 * reliable terminal: on the mobile shell it never arrived after a streamed
 * continue (verified live 2026-08-22), so a flag set on GENERATION_STARTED would stick.
 */
function hostGenerating() {
    if (typeof document === 'undefined') {
        return false;
    }
    return document.body?.dataset?.generating === 'true'
        || Boolean(document.getElementById?.('send_form')?.classList?.contains('sb-generating-controls'));
}

export function refreshBusy() {
    hooks.busyChanged?.(isBusy());
}

export function onGenerationStarted(type, _options, dryRun = false) {
    if (dryRun || type === 'quiet') {
        return;
    }
    if (!inflight) {
        clearRedo();
    }
    refreshBusy();
}

/** MESSAGE_SENT: the host just added the composer text as a user block; record where the model's text will start. */
export function onMessageSent(index) {
    const action = inflight;
    if (!action?.expectCut || !isCurrentChat(action)) {
        return;
    }
    const candidate = Number(index);
    const id = Number.isInteger(candidate) && action.chat?.[candidate] ? candidate : action.chat.length - 1;
    const message = action.chat?.[id];
    if (id !== action.expectedIndex || !message?.is_user) {
        return;
    }
    action.expectCut = false;
    action.mesid = id;
    action.message = message;
    action.before = structuredClone(message);
    pushMessageCut(message);
}

async function finalize(action) {
    mutating++;
    try {
        const { message, before } = action;
        if (!before || action.chat[action.mesid] !== message) {
            return;
        }
        if (!isCurrentChat(action)) {
            retainRecovery({ kind: 'snapshot', chat: action.chat, chatKey: action.key, index: action.mesid,
                message, before: structuredClone(message), after: action.rollback ?? before });
            return;
        }
        if (action.recovery) action.recovery.finalized = true;
        const prefix = String(before.mes ?? '');
        const rollback = action.rollback ?? before;
        const text = String(message.mes ?? '');
        const useful = action.swipe
            ? message.swipe_id >= (before.swipes?.length ?? 1) && text.trim() && text !== '...'
            : text.startsWith(prefix) && text.slice(prefix.length).trim();
        if (!action.swipe && !text.startsWith(prefix)) {
            action.error ??= new Error('The host changed the original text. The original block was restored.');
        }
        if (useful && !action.swipe) {
            recordContinuationReasoning(message, {
                cut: prefix.length,
                prevReasoning: before.extra?.reasoning,
                prevDuration: before.extra?.reasoning_duration,
            });
            setCuts(message, [...getCuts(before).filter(cut => cut < prefix.length), prefix.length]);
            syncSwipe(message);
            const state = {
                cut: prefix.length, revision: textRevision(prefix), message: metadataUndo(before, message),
                swipeId: message.swipe_id ?? null,
                swipe: metadataUndo(before.swipe_info?.[before.swipe_id], message.swipe_info?.[message.swipe_id]),
                hadSwipes: Array.isArray(before.swipes), hadSwipeInfo: Array.isArray(before.swipe_info),
            };
            storyExtra(message).continuations = [
                ...(before.extra?.[EXTRA_KEY]?.continuations ?? []),
                state,
            ];
            syncSwipe(message);
        } else if (useful && message.extra?.[EXTRA_KEY]) {
            delete message.extra[EXTRA_KEY].reasonings;
            syncSwipe(message);
        }
        // Record recovery before a save or a rollback can yield to host callbacks.
        const recovery = Object.assign(action.recovery ?? {}, {
            kind: 'snapshot', chat: action.chat, chatKey: action.key, index: action.mesid,
            message, before: rollback, after: useful ? structuredClone(message) : rollback,
        });
        const stack = redoStack(action.key);
        if (!stack.includes(recovery)) stack.push(recovery);
        if (!useful || action.error) restoreMessage(message, rollback);
        const attempted = structuredClone(message);
        try {
            await saveChat(action);
            action.success = Boolean(useful && !action.error && isCurrentChat(action) && action.chat[action.mesid] === message);
            dropRecovery(recovery);
        } catch (error) {
            action.error = error;
            retainRecovery(recovery, attempted);
            if (action.chat[action.mesid] === message) {
                restoreMessage(message, rollback, attempted);
                await saveRollback(action);
            }
        }
        await renderMessage(action, action.mesid, message);
    } catch (error) {
        action.error = error;
    } finally {
        mutating--;
        if (inflight === action) {
            inflight = null;
            if (action.success && isCurrentChat(action)) clearDirection();
        }
        if (isCurrentChat(action) && !action.success) {
            toast(action.error ? 'error' : 'info', action.error
                ? 'Story Mode could not complete the change. Check the story before trying again.'
                : 'No passage was added. Your direction is unchanged.');
        }
        hooks.afterGeneration?.(action);
    }
}

export async function finishOpenEdit() {
    if (typeof document === 'undefined') {
        return true;
    }
    const textarea = document.getElementById('curEditTextarea');
    const done = textarea?.closest('.mes')?.querySelector('.mes_edit_done');
    if (!textarea || !done) {
        return true;
    }
    done.click();
    const deadline = Date.now() + 2000;
    while (document.getElementById('curEditTextarea') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const closed = !document.getElementById('curEditTextarea');
    if (!closed) {
        toast('info', 'Finish the open edit before changing the story.');
    }
    return closed;
}

// A synchronous lock so two quick taps on Continue/Retry/Undo/Redo cannot both start.
let busy = false;
let transformBusy = false;
let transformRequest = null;
let mutating = 0;

export function setTransformBusy(value) {
    transformBusy = Boolean(value);
    refreshBusy();
}

function hostSwiping() {
    return ctx().swipe?.state?.() === 'swiping';
}

export function isBusy() {
    return busy || transformBusy || transformRequest !== null || isInflight() || hostGenerating() || hostSwiping();
}

async function locked(action) {
    if (isBusy()) {
        return false;
    }
    busy = true;
    hooks.busyChanged?.(true);
    try {
        return await action();
    } catch (error) {
        console.error('[Story Mode] action failed', error);
        toast('error', 'The story change could not be saved. Your recovery has been retained.');
        return false;
    } finally {
        busy = false;
        hooks.busyChanged?.(isBusy());
    }
}

function composer() {
    return typeof document !== 'undefined' ? document.getElementById?.('send_textarea') ?? null : null;
}

function composerHasText(fallback) {
    const textarea = composer();
    return textarea ? String(textarea.value ?? '').length > 0 : Boolean(fallback);
}

/**
 * Continue the manuscript. With text in the composer the host adds it as the
 * user's block first (Generate consumes the textarea for type 'continue') and
 * then continues that block; with an empty composer it extends the last block.
 */
async function continueUnlocked({ hasText: hasTextHint = false, direction = '', preserveRedo = false, target = null } = {}) {
    if (isInflight()) {
        return false;
    }
    const action = { ...captureChat(), direction, success: false, expectCut: false, expectedIndex: -1, mesid: -1, message: null };
    inflight = action;
    let started = false;
    try {
        if (!await finishOpenEdit() || !isCurrentChat(action)) {
            return false;
        }
        const { context, chat } = action;
        if (context.generationSupportsRequestControls !== true || hostSwiping()) return false;
        const hasText = target ? false : composerHasText(hasTextHint);
        const last = chat.length - 1;
        if (target && (chat !== target.chat || chat[last] !== target.message || !sameMessage(chat[last], target.before))) return false;
        action.rollback = target?.after;
        action.recovery = target;
        if (last < 0 && !hasText) {
            toast('info', 'Write something first, then continue.');
            return false;
        }
        if (hasText && context.groupId) {
            toast('info', 'Send that text first in group chats, then use Continue.');
            return false;
        }
        if (!hasText && context.chat[last]?.is_system) {
            toast('info', 'The last block is hidden from the model. Unhide it or write something first.');
            return false;
        }
        if (!preserveRedo) {
            clearRedo();
        }
        action.expectCut = hasText;
        action.expectedIndex = hasText ? chat.length : -1;
        action.mesid = hasText ? -1 : last;
        if (direction) {
            setDirection(direction);
        } else {
            clearDirection();
        }
        if (!hasText) {
            action.message = chat[last];
            action.before = structuredClone(action.message);
            pushMessageCut(action.message);
        }
        started = true;
        hooks.beforeGeneration?.();
        const outcome = await context.generate('continue', {
            suppressAutoContinue: true,
            suppressUserMessage: Boolean(target),
            maxOutputTokens: getSettings().maxTokens,
        });
        if (outcome?.native) {
            action.native = true;
            await finalizeNative(action, outcome);
        }
    } catch (error) {
        if (error?.name !== 'AbortError') {
            action.error = error;
            console.error('[Story Mode] continue failed', error);
        }
    } finally {
        if (started && !action.native) {
            await finalize(action);
        } else if (inflight === action) {
            inflight = null;
        }
    }
    return action.success;
}

/**
 * The durable server path. The passage is already saved: the server proved where it
 * joined the block it continued and reloaded the chat, so the cut comes from the
 * saved result instead of a local guess. Only Story Mode's own undo bookkeeping is
 * left to record, and it is written after the durable passage, never before it.
 */
async function finalizeNative(action, outcome) {
    mutating++;
    try {
        const { context } = action;
        const cut = Number(outcome?.result?.named?.cut);
        action.chat = context.chat;
        const message = action.chat[action.mesid];
        if (!message) {
            action.error = new Error('The saved passage is no longer in this chat.');
            return;
        }
        if (action.recovery) action.recovery.finalized = true;
        if (!Number.isSafeInteger(cut) || cut <= 0 || cut > String(message.mes ?? '').length) {
            action.error = new Error('The saved passage did not report where it was added.');
            return;
        }
        const prefix = String(action.before?.mes ?? '');
        if (prefix && !String(message.mes ?? '').startsWith(prefix)) {
            action.error = new Error('The saved passage does not continue the block it answered.');
        }
        if (!action.error) {
            recordContinuationReasoning(message, {
                cut,
                prevReasoning: action.before?.extra?.reasoning,
                prevDuration: action.before?.extra?.reasoning_duration,
            });
            setCuts(message, [...getCuts(action.before ?? {}).filter(entry => entry < cut), cut]);
            syncSwipe(message);
            const state = {
                cut, revision: textRevision(String(message.mes).slice(0, cut)), message: metadataUndo(action.before, message),
                swipeId: message.swipe_id ?? null,
                swipe: metadataUndo(action.before?.swipes?.[action.before?.swipe_id], message.swipe_info?.[message.swipe_id]),
                hadSwipes: Array.isArray(action.before?.swipes), hadSwipeInfo: Array.isArray(action.before?.swipe_info),
            };
            storyExtra(message).continuations = [...(action.before?.extra?.[EXTRA_KEY]?.continuations ?? []), state];
            syncSwipe(message);
        }
        const recovery = Object.assign(action.recovery ?? {}, {
            kind: 'snapshot', chat: action.chat, chatKey: action.key, index: action.mesid,
            message, before: action.rollback ?? action.before, after: structuredClone(message),
        });
        const stack = redoStack(action.key);
        if (!stack.includes(recovery)) stack.push(recovery);
        try {
            await saveChat(action);
            action.success = !action.error;
            dropRecovery(recovery);
        } catch (error) {
            action.error = error;
            retainRecovery(recovery, structuredClone(message));
        }
        await renderMessage(action, action.mesid, message);
    } catch (error) {
        action.error = error;
    } finally {
        mutating--;
        if (inflight === action) {
            inflight = null;
            if (action.success && chatIdentity(ctx()) === action.key) clearDirection();
        }
        if (chatIdentity(ctx()) === action.key && !action.success) {
            toast(action.error ? 'error' : 'info', action.error
                ? 'Story Mode could not complete the change. Check the story before trying again.'
                : 'No passage was added. Your direction is unchanged.');
        }
        hooks.afterGeneration?.(action);
    }
}

export function continueStory(options) {
    return locked(() => continueUnlocked(options));
}

// ---------------------------------------------------------------- retry / undo / redo

const redoByChat = new Map();

function redoStack(key = chatIdentity()) {
    if (!redoByChat.has(key)) {
        redoByChat.set(key, []);
    }
    return redoByChat.get(key);
}

export function clearRedo({ discardFailures = false } = {}) {
    for (const [key, stack] of redoByChat) {
        const retained = discardFailures ? [] : stack.filter(entry => entry.failed);
        if (retained.length) redoByChat.set(key, retained);
        else redoByChat.delete(key);
    }
}

function retainRecovery(entry, attempted = entry.before) {
    entry.failed = true;
    entry.attempted ??= structuredClone(attempted);
    const stack = redoStack(entry.chatKey);
    if (!stack.includes(entry)) stack.push(entry);
}

function dropRecovery(entry) {
    const stack = redoByChat.get(entry.chatKey);
    const index = stack?.indexOf(entry) ?? -1;
    if (index >= 0) stack.splice(index, 1);
}

function recoveryBase(entry, message) {
    return [entry.before, entry.attempted, entry.after].find(snapshot => snapshot && (sameMessage(message, snapshot)
        || (entry.failed && message && ['mes', 'is_user', 'is_system', 'swipe_id'].every(key => message[key] === snapshot[key]))));
}

export function canRedo() {
    return redoStack().length > 0;
}

export function canUndo() {
    return canRevertBlock(messageAt(lastIndex()));
}

function redoMatches(entry, chat, key) {
    if (!entry || (!entry.failed && entry.chat !== chat) || entry.chatKey !== key) {
        return false;
    }
    if (entry.kind === 'snapshot') {
        return (entry.failed || entry.index === chat.length - 1) && Boolean(recoveryBase(entry, chat[entry.index]));
    }
    if (entry.kind === 'message') {
        const previous = chat.at(-1);
        return entry.previous === null
            ? chat.length === 0
            : chat.length === entry.index
                && String(previous?.mes ?? '') === entry.previous.text
                && Boolean(previous?.is_user) === entry.previous.isUser
                && Boolean(previous?.is_system) === entry.previous.isSystem;
    }
    return false;
}

export function clearRedoIfDiverged() {
    if (mutating) return false;
    const context = ctx();
    const key = chatIdentity(context);
    const stack = redoByChat.get(key);
    if (stack?.length && !redoMatches(stack.at(-1), context.chat, key)) {
        const retained = stack.filter(entry => entry.failed);
        if (retained.length) redoByChat.set(key, retained);
        else redoByChat.delete(key);
        return true;
    }
    return false;
}

async function truncateLastContinuation(action) {
    const { chat } = action;
    const index = chat.length - 1;
    const message = chat[index];
    if (!message) {
        return null;
    }
    const cuts = getCuts(message);
    if (!cuts.length) {
        return null;
    }
    const cut = cuts.pop();
    const text = String(message.mes ?? '');
    if (cut >= text.length) {
        return null;
    }
    const after = structuredClone(message);
    const history = message.extra?.[EXTRA_KEY]?.continuations ?? [];
    if (!Array.isArray(history)) throw new Error('The continuation history is invalid');
    const recorded = history.at(-1);
    let before;
    if (history.length) {
        if (recorded?.cut !== cut || recorded.revision !== textRevision(text.slice(0, cut))
            || !Array.isArray(recorded.message?.fields) || !Array.isArray(recorded.swipe?.fields)) {
            throw new Error('The continuation snapshot does not match the original text');
        }
        before = structuredClone(message);
        before.mes = text.slice(0, cut);
        restoreMetadata(before, recorded.message);
        if (recorded.swipeId !== null) {
            if (before.swipes) before.swipes[recorded.swipeId] = before.mes;
            const info = before.swipe_info?.[recorded.swipeId];
            if (info) restoreMetadata(info, recorded.swipe);
        }
        if (!recorded.hadSwipes && before.swipes?.length === 1) delete before.swipes;
        if (!recorded.hadSwipeInfo && before.swipe_info?.length === 1) delete before.swipe_info;
    } else {
        // Shipped cuts lack snapshots. Their revision validates the text; recover available reasoning only.
        before = structuredClone(message);
        before.mes = text.slice(0, cut);
        const reasonings = before.extra?.[EXTRA_KEY]?.reasonings;
        const kept = Array.isArray(reasonings) ? reasonings.filter(reasoning => reasoning.cut < cut) : [];
        if (Array.isArray(reasonings)) {
            storyExtra(before).reasonings = kept;
        }
        if (kept.length) {
            before.extra.reasoning = kept.at(-1).text;
            before.extra.reasoning_duration = kept.at(-1).duration;
        } else {
            delete before.extra.reasoning;
            delete before.extra.reasoning_duration;
        }
        delete before.extra.reasoning_signature;
        delete before.extra.reasoning_tokens;
        setCuts(before, cuts);
        syncSwipe(before);
    }
    const entry = { kind: 'snapshot', chat, chatKey: action.key, index, message, before, after };
    redoStack(action.key).push(entry);
    mutating++;
    try {
        restoreMessage(message, before);
        await saveChat(action);
    } catch (error) {
        retainRecovery(entry, before);
        if (chat[index] === message) {
            restoreMessage(message, after, before);
            await saveRollback(action);
        }
        throw error;
    } finally {
        try { await renderMessage(action, index, message); } finally { mutating--; }
    }
    return entry;
}

export function undo() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action) || hostSwiping()) {
            return false;
        }
        const { context, chat } = action;
        const index = chat.length - 1;
        const message = chat[index];
        if (!message) {
            return false;
        }
        if (getCuts(message).length) {
            const removed = await truncateLastContinuation(action);
            return Boolean(removed);
        }
        if (hasCutMetadata(message)) {
            toast('info', 'This block changed since its continuation was recorded, so it cannot be undone safely.');
            return false;
        }
        if (!message.is_user && !message.is_system) {
            const copy = structuredClone(message);
            const previous = index > 0 ? {
                text: String(chat[index - 1]?.mes ?? ''),
                isUser: Boolean(chat[index - 1]?.is_user),
                isSystem: Boolean(chat[index - 1]?.is_system),
            } : null;
            const entry = { kind: 'message', chat, chatKey: action.key, index, previous, message: copy };
            redoStack(action.key).push(entry);
            mutating++;
            try {
                await context.deleteLastMessage();
                await saveChat(action, { allowShrink: true });
            } catch (error) {
                retainRecovery(entry);
                if (redoMatches(entry, chat, action.key)) {
                    chat.push(message);
                    Object.assign(entry, { kind: 'snapshot', message, before: copy, after: copy });
                    await saveRollback(action);
                    if (isCurrentChat(action)) context.addOneMessage(message);
                }
                throw error;
            } finally {
                mutating--;
                if (isCurrentChat(action)) context.swipe?.refresh?.();
            }
            return true;
        }
        toast('info', 'Nothing to undo: the last block is yours. Tap it to edit.');
        return false;
    });
}

export function redo() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action) || hostSwiping()) {
            return false;
        }
        const { context, chat } = action;
        const stack = redoStack(action.key);
        const entry = stack.at(-1);
        if (!entry) {
            return false;
        }
        if (!redoMatches(entry, chat, action.key)) {
            toast('info', 'The story changed since the undo, so there is nothing safe to put back.');
            return false;
        }
        mutating++;
        let before;
        let attempted;
        try {
            if (entry.kind === 'snapshot') {
                entry.message = chat[entry.index];
                before = structuredClone(entry.message);
                restoreMessage(entry.message, entry.after, recoveryBase(entry, entry.message));
            } else {
                chat.push(entry.message);
            }
            attempted = structuredClone(entry.message);
            await saveChat(action);
            dropRecovery(entry);
            if (entry.kind === 'message' && isCurrentChat(action)) context.addOneMessage(entry.message);
            return true;
        } catch (error) {
            retainRecovery(entry, attempted);
            if (entry.kind === 'snapshot' && chat[entry.index] === entry.message) {
                restoreMessage(entry.message, before, attempted);
                await saveRollback(action);
            } else if (entry.kind === 'message' && chat[entry.index] === entry.message) {
                if (chat.length === entry.index + 1 && sameMessage(entry.message, attempted)) {
                    chat.pop();
                    await saveRollback(action, { allowShrink: true });
                } else {
                    const preserved = structuredClone(entry.message);
                    Object.assign(entry, { kind: 'snapshot', before: preserved, after: preserved });
                }
            }
            throw error;
        } finally {
            try { await renderMessage(action, entry.index, entry.message); } finally { mutating--; }
        }
    });
}

export function retry() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action) || hostSwiping()) {
            return false;
        }
        const { context, chat } = action;
        const index = chat.length - 1;
        const message = chat[index];
        if (!message) {
            return false;
        }
        if (context.generationSupportsRequestControls !== true) return false;
        if (getCuts(message).length) {
            const removed = await truncateLastContinuation(action);
            if (!removed) return false;
            const result = isCurrentChat(action) && await continueUnlocked({ preserveRedo: true, target: removed });
            if (result) {
                clearRedo();
            } else if (!removed.finalized && chat[index] === message && sameMessage(message, removed.before)) {
                mutating++;
                try {
                    restoreMessage(message, removed.after);
                    removed.before = structuredClone(removed.after);
                    await saveChat(action);
                    dropRecovery(removed);
                } catch (error) {
                    retainRecovery(removed);
                    throw error;
                } finally {
                    try { await renderMessage(action, index, message); } finally { mutating--; }
                }
            }
            return result;
        }
        if (hasCutMetadata(message)) {
            toast('info', 'This block changed since its continuation was recorded, so it cannot be retried safely.');
            return false;
        }
        if (!message.is_user && !message.is_system) {
            if (context.swipe?.isAllowed?.() === false) {
                toast('info', 'Swipes are off or a generation is still running.');
                return false;
            }
            if (typeof context.swipe?.to !== 'function') return false;
            Object.assign(action, { message, mesid: index, before: structuredClone(message), direction: '', swipe: true, success: false });
            inflight = action;
            mutating++;
            try {
                hooks.beforeGeneration?.();
                await context.swipe.to(null, 'right', {
                    source: 'story-mode', message, forceSwipeId: message.swipes?.length ?? 1,
                    generationOptions: { suppressAutoContinue: true, suppressUserMessage: true, maxOutputTokens: getSettings().maxTokens },
                });
            } catch (error) {
                if (error?.name !== 'AbortError') action.error = error;
            } finally {
                try { await finalize(action); } finally { mutating--; }
            }
            if (action.success) clearRedo();
            return action.success;
        }
        toast('info', 'Nothing to retry yet: the last block is yours.');
        return false;
    });
}

// ---------------------------------------------------------------- in-chat agents gate

let agentStore = null;
let agentStoreLoad = null;

export function loadAgentStore() {
    agentStoreLoad ??= import('/scripts/extensions/in-chat-agents/agent-store.js')
        .then((mod) => {
            agentStore = ['getAgents', 'getEnabledAgents', 'setRuntimeAgentFilter', 'isAgentRuntimeAllowed'].every(key => typeof mod?.[key] === 'function') ? mod : null;
            return agentStore;
        })
        .catch(() => {
            agentStore = null;
            return null;
        });
    return agentStoreLoad;
}

export function hasAgentStore() {
    return agentStore !== null;
}

/** Every agent the user has, for the settings list; null when In-Chat Agents is not available. */
export function listAgents(store = agentStore) {
    if (!store) {
        return null;
    }
    return store.getAgents().map((agent) => ({
        id: String(agent.id ?? ''),
        name: String(agent.name ?? '').trim() || 'Unnamed agent',
        enabled: typeof store.isAgentEnabledForCurrentScope === 'function' ? Boolean(store.isAgentEnabledForCurrentScope(agent)) : Boolean(agent.enabled),
        paused: !storyAgentAllowed(agent),
    })).filter((agent) => agent.id);
}

function storyAgentAllowed(agent) {
    const settings = getSettings();
    return !settings.agentGate || !isEnabled() || settings.allowedAgents.includes(String(agent.id));
}

/** Runtime-only: the predicate reads current settings even for queued or timer-driven calls. */
export function applyAgentGate(store = agentStore) {
    if (!store) {
        return [];
    }
    store.setRuntimeAgentFilter(SETTINGS_KEY, storyAgentAllowed);
    return listAgents(store).filter(agent => agent.enabled && agent.paused).map(agent => agent.id);
}

/** Removes only our runtime restriction, leaving all stored choices untouched. */
export function releaseAgentGate(store = agentStore) {
    store?.setRuntimeAgentFilter(SETTINGS_KEY, null);
}

// ---------------------------------------------------------------- selection transforms

export async function runTransform({ kind, instruction = '', value, start, end, signal }) {
    // The UI owns transformBusy across its dialog and request. Do not reject that reservation.
    if (busy || isInflight() || hostGenerating() || hostSwiping() || transformRequest) return '';
    signal?.throwIfAborted();
    const context = ctx();
    const window = contextWindow(value, start, end);
    if (!window.selection.trim()) {
        return '';
    }
    const request = {};
    transformRequest = request;
    const release = () => {
        if (transformRequest === request) {
            transformRequest = null;
            refreshBusy();
        }
    };
    signal?.addEventListener('abort', release, { once: true });
    refreshBusy();
    try {
        const { systemPrompt, prompt, responseLength } = buildTransformPrompt(kind, { ...window, instruction });
        const raw = getSettings().transformsUseFullContext
            ? await context.generateQuietPrompt({ quietPrompt: `${systemPrompt}\n\n${prompt}`, skipWIAN: true, responseLength, signal, preserveReasoningBudget: true })
            : await context.generateRaw({ systemPrompt, prompt, responseLength, signal, preserveReasoningBudget: true });
        signal?.throwIfAborted();
        const result = cleanTransformResult(raw, window.selection);
        if (!result) return '';
        const leading = window.selection.match(/^\s*/u)?.[0] ?? '';
        const trailing = window.selection.match(/\s*$/u)?.[0] ?? '';
        return `${leading}${result}${trailing}`;
    } finally {
        signal?.removeEventListener('abort', release);
        release();
    }
}

// ---------------------------------------------------------------- slash command

let commandsRegistered = false;

export function registerCommands({ onToggle }) {
    if (commandsRegistered) {
        return true;
    }
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument) {
        return false;
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'story',
        callback: (_named, unnamed) => onToggle(String(unnamed ?? '')),
        returns: 'on or off',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'on, off or toggle',
                typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
                isRequired: false,
                enumList: ['on', 'off', 'toggle'],
            }),
        ],
        helpString: 'Turns Story Mode on or off for the current chat. With no argument it toggles.',
    }));
    commandsRegistered = true;
    return true;
}
