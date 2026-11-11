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

function finish(onChange) {
    if (!reading) return;
    clearInterval(reading.timer);
    reading = null;
    onChange?.();
}

export function stopReadAloud() {
    if (!reading) return;
    const { onChange } = reading;
    try { capability()?.stopPlayback(); } catch (error) { console.warn('[Scratchpad] Could not stop reading aloud', error); }
    finish(onChange);
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
    stopReadAloud();
    const started = await tts.narrateTtsMessage({ name: speaker, mes: text, is_user: false, is_system: false, extra: {} },
        { manual: true, force: true, propagateErrors: true, unrestrictedVoiceMap: true });
    if (!started) return 'unavailable';
    let idle = 0;
    const entry = { id: message.id, onChange, timer: 0 };
    entry.timer = setInterval(() => {
        if (reading !== entry) return clearInterval(entry.timer);
        // Two quiet checks in a row, so the gap between two spoken paragraphs is not taken for the end.
        idle = tts.isPlaying() ? 0 : idle + 1;
        if (idle >= 2) finish(onChange);
    }, POLL_MS);
    reading = entry;
    onChange?.();
    return 'started';
}
