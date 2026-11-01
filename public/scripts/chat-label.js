import { escapeRegex } from './util/escape-regex.js';

export const CHAT_LABEL_TITLE_LIMIT = 72;

const CHAT_LABEL_KEYS = Object.freeze(['title', 'label', 'name']);
const GENERIC_CHAT_LABELS = new Set(['chat', 'conversation', 'new chat', 'roleplay chat', 'untitled', 'untitled chat']);
const LABEL_PREFIX_PATTERN = /^[\s"'`*_]*(?:chat\s*)?(?:title|label|name)[\s"'`*_]*[:=-]\s*/i;
const EXPLICIT_LABEL_PATTERN = /^[\s"'`*_]*(?:chat\s*)?(?:title|label|name)[\s"'`*_]*[:=-]\s*\S/i;

function stripReasoningBlocks(value) {
    return value
        .replace(/<(?:think|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/(?:think|reasoning|analysis)>|$)/gi, '')
        .replace(/<\/(?:think|reasoning|analysis)>/gi, '')
        .trim();
}

function stripOuterCodeFence(value) {
    const match = value.match(/^```(?:json|text)?[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?```$/i);
    return match ? match[1].trim() : value;
}

function isMachineShapedText(value) {
    const text = value.trim();
    if (!text) {
        return false;
    }

    const unprefixedText = text.replace(LABEL_PREFIX_PATTERN, '').trim();
    if (unprefixedText !== text) {
        try {
            if (typeof JSON.parse(unprefixedText) !== 'string') {
                return true;
            }
        } catch {
            if (/^(?:\[|{)\s*(?:["'{]|\[)/.test(unprefixedText)) {
                return true;
            }
        }
    }

    if (/^\[object Object\]$/i.test(text) || /^\s*(?:\[|{|")/.test(text) || /```/.test(text)) {
        return true;
    }

    if (/^\s*(?:content|message|response)\s*[:=]/i.test(text)
        || /<\/?(?:content|title|label|name)\b[^>]*>/i.test(text)
        || /"[^"\r\n]+"\s*:/i.test(text)) {
        return true;
    }

    return text.split(/\r?\n/).some(line => /^\s*(?:\[|{)/.test(line));
}

function isMachineShapedJsonString(value) {
    const text = value.trim();
    if (/^\[object Object\]$/i.test(text)
        || /^\s*(?:content|message|response)\s*[:=]/i.test(text)
        || /<\/?(?:content|title|label|name)\b[^>]*>/i.test(text)
        || /"[^"\r\n]+"\s*:/i.test(text)) {
        return true;
    }

    try {
        const nestedValue = JSON.parse(text);
        return nestedValue !== null && typeof nestedValue === 'object';
    } catch {
        return /^(?:\[|{)\s*(?:["'{]|\[)/.test(text);
    }
}

function getLabelFromJson(value, displayName) {
    if (typeof value === 'string') {
        return isMachineShapedJsonString(value) ? '' : normalizeGeneratedChatLabel(value, displayName);
    }

    if (value === null || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        return '';
    }

    if (Object.values(value).some(item => item !== null && typeof item === 'object')) {
        return '';
    }

    const presentKeys = CHAT_LABEL_KEYS.filter(key => Object.prototype.hasOwnProperty.call(value, key));
    if (!presentKeys.length) {
        return '';
    }

    const label = presentKeys.map(key => value[key]).find(Boolean);
    return typeof label === 'string' ? normalizeGeneratedChatLabel(label, displayName) : '';
}

export function truncateChatLabelText(value, limit = CHAT_LABEL_TITLE_LIMIT) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length <= limit) {
        return text;
    }

    const clipped = text.slice(0, limit).trim();
    const wordBoundary = clipped.lastIndexOf(' ');
    return (wordBoundary > 24 ? clipped.slice(0, wordBoundary) : clipped).replace(/[._ -]+$/g, '').trim();
}

export function normalizeGeneratedChatLabel(value, displayName = '') {
    if (typeof value !== 'string') {
        return '';
    }

    const unprefixedValue = value.replace(LABEL_PREFIX_PATTERN, '').trim();
    if (/^\[object Object\]$/i.test(unprefixedValue)) {
        return '';
    }

    let title = stripOuterCodeFence(stripReasoningBlocks(value))
        .replace(LABEL_PREFIX_PATTERN, '')
        .replace(/\.(?:jsonl?|txt)$/i, '')
        .replace(/[\\/:*?"<>|{}\u005B\u005D]+/g, ' ')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, '')
        .replace(/[._ -]+$/g, '')
        .trim();

    const normalizedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
    if (normalizedDisplayName) {
        title = title.replace(new RegExp(`^${escapeRegex(normalizedDisplayName)}\\s*[-:]\\s*`, 'i'), '').trim();
    }

    title = truncateChatLabelText(title);
    return GENERIC_CHAT_LABELS.has(title.toLowerCase()) ? '' : title;
}

export function extractGeneratedChatLabel(responseText, displayName = '') {
    if (typeof responseText !== 'string') {
        return '';
    }

    const text = stripOuterCodeFence(stripReasoningBlocks(responseText));
    if (!text) {
        return '';
    }

    try {
        return getLabelFromJson(JSON.parse(text), displayName);
    } catch {
        if (isMachineShapedText(text)) {
            return '';
        }
    }

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const explicitLines = lines.filter(line => EXPLICIT_LABEL_PATTERN.test(line));
    if (explicitLines.length === 1) {
        return normalizeGeneratedChatLabel(explicitLines[0], displayName);
    }

    return lines.length === 1 ? normalizeGeneratedChatLabel(lines[0], displayName) : '';
}

// Only the short file-rename commit is serialised with saves and navigation.
// The model request never holds this promise.
let pendingChatNameCommit = null;

export function getPendingChatNameCommit() {
    return pendingChatNameCommit;
}

export function beginChatNameCommit() {
    let release;
    pendingChatNameCommit = new Promise(resolve => { release = resolve; });
    const commit = pendingChatNameCommit;
    return () => {
        if (pendingChatNameCommit === commit) pendingChatNameCommit = null;
        release();
    };
}

export const CHAT_AUTO_NAME_DEFAULT_THRESHOLD = 6;
export const CHAT_AUTO_NAME_MIN_THRESHOLD = 1;
export const CHAT_AUTO_NAME_MAX_THRESHOLD = 100;

/** The visible text of one message, without markup. */
export function getPlainChatLabelMessage(message) {
    const rawText = message?.extra?.display_text || message?.mes || '';
    return String(rawText)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeChatAutoNameThreshold(value) {
    const number = typeof value === 'string' && !value.trim() ? NaN : Number(value);
    if (!Number.isFinite(number)) {
        return CHAT_AUTO_NAME_DEFAULT_THRESHOLD;
    }
    return Math.min(CHAT_AUTO_NAME_MAX_THRESHOLD, Math.max(CHAT_AUTO_NAME_MIN_THRESHOLD, Math.round(number)));
}

/**
 * Counts the messages people can read in a chat, the greeting included.
 * Hidden and system messages do not count.
 */
export function getChatAutoNameProgress(messages) {
    let count = 0;
    let hasUserMessage = false;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object' || message.is_system || !getPlainChatLabelMessage(message)) {
            continue;
        }
        count++;
        hasUserMessage ||= Boolean(message.is_user);
    }
    return { count, hasUserMessage };
}

/** A chat is ready once it reaches the threshold and someone has written in it, so a lone greeting never counts. */
export function isChatReadyForAutoName(messages, threshold) {
    const { count, hasUserMessage } = getChatAutoNameProgress(messages);
    return hasUserMessage && count >= normalizeChatAutoNameThreshold(threshold);
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

/**
 * Names timestamp-named chats in the background once they are long enough and nothing else is running.
 * Every dependency is injected so the browser wiring stays thin and the timing rules are testable.
 *
 * getTarget() describes the open chat: { key, fileName, displayName, isGroup, generation, messages, manual }.
 * rename(target, { signal, canCommit }) asks the model and renames; it resolves { status } or throws.
 * A run that is cancelled before it commits is retried after the next activity; a failed or
 * unusable answer is not retried for that chat until the page reloads.
 */
export function createChatAutoNamer({
    isEnabled,
    getThreshold,
    getTarget,
    isDatedName,
    isIdle,
    hasConnection,
    isAgentWorkPending = () => false,
    waitForAgentWorkIdle = async () => true,
    rename,
    delayMs = 1500,
    idleRetryMs = 2000,
    maxIdleRetries = 30,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = id => clearTimeout(id),
    onError = error => console.warn('Could not name the chat automatically:', error),
} = {}) {
    const finished = new Set();
    let timer = null;
    let epoch = 0;
    let idleRetries = 0;
    let active = null;
    let waitingForAgents = false;
    let rerun = false;

    const signature = target => {
        const messages = Array.isArray(target?.messages) ? target.messages : [];
        const last = messages.at(-1);
        return JSON.stringify([target?.key, target?.fileName, target?.generation, messages.length, last?.mes ?? null, last?.swipe_id ?? null]);
    };

    const clearPending = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    const queue = (ms) => {
        clearPending();
        timer = setTimer(() => {
            timer = null;
            void run();
        }, ms);
    };

    const isEligible = (target) => Boolean(target?.key && target.fileName)
        && !target.manual
        && !finished.has(target.key)
        && isDatedName(target.fileName, target.displayName, target.isGroup)
        && isChatReadyForAutoName(target.messages, getThreshold());

    async function run() {
        if (!isEnabled()) return;
        if (active || waitingForAgents) {
            rerun = true;
            return;
        }
        const target = getTarget();
        if (!isEligible(target)) return;

        if (isAgentWorkPending()) {
            const startedEpoch = epoch;
            waitingForAgents = true;
            try {
                const idle = await waitForAgentWorkIdle({ isCancelled: () => startedEpoch !== epoch || !isEnabled() });
                if (idle && startedEpoch === epoch) rerun = true;
            } finally {
                waitingForAgents = false;
                if (rerun) {
                    rerun = false;
                    queue(0);
                }
            }
            return;
        }
        if (!isIdle()) {
            if (idleRetries++ < maxIdleRetries) queue(idleRetryMs);
            return;
        }
        if (!hasConnection()) return;

        const controller = new AbortController();
        const expected = signature(target);
        const attempt = { key: target.key, controller, committing: false, epoch };
        active = attempt;
        // Checked right before the rename is sent. Once it passes, only the rename itself can fail.
        const canCommit = () => {
            const current = controller.signal.aborted || attempt.epoch !== epoch || !isEnabled() || !isIdle() || isAgentWorkPending()
                ? null : getTarget();
            attempt.committing = Boolean(current && hasConnection() && isEligible(current) && signature(current) === expected);
            return attempt.committing;
        };

        try {
            await rename(target, { signal: controller.signal, canCommit });
            finished.add(target.key);
        } catch (error) {
            // Cancelled before the rename: the next message, reply or idle moment tries again.
            if (isAbortError(error) && !attempt.committing) return;
            finished.add(target.key);
            if (!isAbortError(error)) onError(error);
        } finally {
            if (active === attempt) active = null;
            if (rerun) {
                rerun = false;
                queue(delayMs);
            }
        }
    }

    return {
        /** Something happened in the chat; look again once things settle. */
        schedule() {
            idleRetries = 0;
            queue(delayMs);
        },
        /** Stop waiting and abandon an answer that has not been committed yet. */
        cancel() {
            epoch++;
            clearPending();
            rerun = false;
            if (active && !active.committing) {
                active.controller.abort(new DOMException('Automatic chat naming was cancelled.', 'AbortError'));
            }
        },
        /** This chat is settled; never name it again in this session. */
        markFinished(key) {
            if (key) finished.add(key);
        },
        isFinished(key) {
            return finished.has(key);
        },
        isRunning() {
            return Boolean(active);
        },
        /** True while this namer's own rename is being sent, so its own rename event is not mistaken for the user's. */
        isCommitting() {
            return Boolean(active?.committing);
        },
        runNow: run,
    };
}
