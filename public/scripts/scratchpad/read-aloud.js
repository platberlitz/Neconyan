import { getExtensionCapability } from '../neconyan-conversation/extension-capabilities.js';
import { splitReply } from './proposals.js';

const POLL_MS = 400;

let reading = null;

function capability() {
    const tts = getExtensionCapability('tts');
    return typeof tts?.narrateTtsMessage === 'function' && typeof tts.stopPlayback === 'function' && typeof tts.isPlaying === 'function' ? tts : null;
}

/** Text worth hearing: change cards, code blocks, citation marks and link addresses are left out. */
export function spokenText(text) {
    return splitReply(String(text ?? '')).filter(part => part.type === 'text').map(part => part.text).join('')
        .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/gm, '')
        .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
        .replace(/\[\d{1,3}\]/g, '')
        .replace(/\bhttps?:\/\/\S+/g, '')
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/`/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([.,;:!?])/g, '$1')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function canReadAloud() {
    return Boolean(capability());
}

export function isReadingAloud(messageId) {
    return Boolean(reading) && reading.id === messageId;
}

function finish(reason = 'finished') {
    const entry = reading;
    if (!entry) return;
    clearInterval(entry.timer);
    reading = null;
    entry.onChange?.();
    entry.settle?.(reason);
}

export function stopReadAloud() {
    if (!reading) return;
    try { capability()?.stopPlayback(); } catch (error) { console.warn('[Scratchpad] Could not stop reading aloud', error); }
    finish('stopped');
}

async function begin(tts, message, text, speaker, onChange, settle) {
    stopReadAloud();
    const started = await tts.narrateTtsMessage({ name: speaker, mes: text, is_user: false, is_system: false, extra: {} },
        { manual: true, force: true, propagateErrors: true, unrestrictedVoiceMap: true });
    if (!started) return false;
    let idle = 0;
    const entry = { id: message.id, onChange, settle, timer: 0 };
    entry.timer = setInterval(() => {
        if (reading !== entry) return clearInterval(entry.timer);
        // Two quiet checks in a row, so the gap between two spoken paragraphs is not taken for the end.
        idle = tts.isPlaying() ? 0 : idle + 1;
        if (idle >= 2) finish();
    }, POLL_MS);
    reading = entry;
    onChange?.();
    return true;
}

/**
 * Starts reading a reply with the text to speech voice, or stops it when that reply is already being read.
 * Resolves to 'started', 'stopped', 'empty' (nothing to say) or 'unavailable' (text to speech declined; it explains why itself).
 */
export async function toggleReadAloud(message, speaker, onChange) {
    const tts = capability();
    if (!tts) return 'unavailable';
    if (isReadingAloud(message.id)) {
        stopReadAloud();
        return 'stopped';
    }
    const text = spokenText(message.text);
    if (!text) return 'empty';
    return await begin(tts, message, text, speaker, onChange) ? 'started' : 'unavailable';
}

/**
 * Reads one reply aloud and resolves once it is over: 'finished' when the voice ran out, 'stopped' when it was
 * stopped or the signal aborted, 'empty' when there was nothing to say and 'unavailable' when text to speech is off or declined.
 */
export async function speakReply(message, speaker, { onChange, signal } = {}) {
    const tts = capability();
    if (!tts) return 'unavailable';
    if (signal?.aborted) return 'stopped';
    const text = spokenText(message?.text);
    if (!text) return 'empty';
    let settle = null;
    const done = new Promise(resolve => { settle = resolve; });
    const abort = () => { if (reading?.settle === settle) stopReadAloud(); else settle('stopped'); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        if (!await begin(tts, message, text, speaker, onChange, settle)) return 'unavailable';
        if (signal?.aborted) stopReadAloud();
        return await done;
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

/** Reads several replies one after another, as a Round Table or Compare turn gives them. Stops early when one is stopped or text to speech gives up. */
export async function speakReplies(replies, { onChange, signal } = {}) {
    let result = 'empty';
    for (const { message, speaker } of replies ?? []) {
        if (signal?.aborted) return 'stopped';
        const outcome = await speakReply(message, speaker, { onChange, signal });
        if (outcome === 'stopped' || outcome === 'unavailable') return outcome;
        if (outcome === 'finished') result = 'finished';
    }
    return signal?.aborted ? 'stopped' : result;
}
