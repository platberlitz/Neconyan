import { name1 } from '../../script.js';
import { getExtensionCapability } from './extension-capabilities.js';
import { getConversationAttachmentSummary } from './thread-store-utils.js';

function getConversationTtsText(message) {
    const displayText = String(message?.extra?.display_text || '').trim();
    if (displayText) {
        return displayText;
    }

    const messageText = String(message?.mes || '').trim();
    if (messageText) {
        return messageText;
    }

    return getConversationAttachmentSummary(message);
}

function getConversationTtsMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    const role = String(message.role || '').trim();
    if (role === 'system') {
        return null;
    }

    const text = getConversationTtsText(message);
    return {
        name: String(message.name || (role === 'user' ? name1 || 'User' : 'Character')).trim(),
        mes: text,
        is_user: role === 'user',
        is_system: role === 'system',
        extra: message.extra || {},
    };
}

export function beginConversationNarration() {
    return getExtensionCapability('tts')?.beginPlayback?.() ?? null;
}

export async function narrateConversationMessage(message, { isStillVisible = null, manual = false, force = false, token = null } = {}) {
    const ttsMessage = getConversationTtsMessage(message);
    if (!ttsMessage) {
        return false;
    }

    if (!ttsMessage.mes && !ttsMessage.extra?.display_text) {
        if (manual || force) {
            globalThis.toastr?.info?.('No text to narrate.');
        }
        return false;
    }

    const tts = getExtensionCapability('tts');
    if (!tts) {
        return false;
    }

    try {
        return await tts.narrateTtsMessage(ttsMessage, {
            manual,
            force,
            isStillVisible,
            propagateErrors: true,
            unrestrictedVoiceMap: true,
            token,
        });
    } catch (error) {
        console.warn('Conversation Mode: TTS narration failed', error);
        if (manual || force) {
            globalThis.toastr?.warning?.('TTS narration failed. Check the TTS extension settings.');
        }
        return false;
    }
}

/** Play server-prepared narration audio for a native completion record. */
export async function playConversationNarration(record, message, isStillVisible = null, token = null) {
    if (!record || record.status !== 'ready' || !record.job || !record.artifact) {
        return false;
    }

    const tts = getExtensionCapability('tts');
    if (!tts?.playPreparedAudio) {
        return false;
    }

    const parts = record.artifacts ?? [{ artifact: record.artifact }];
    if (!Array.isArray(parts) || !parts.length || parts.length > 256 || parts.some(part => typeof part?.artifact !== 'string' || !part.artifact)) return false;
    try {
        for (const part of parts) {
            if (token?.isCurrent?.() === false || typeof isStillVisible === 'function' && !isStillVisible()) return false;
            const url = `/api/jobs/${encodeURIComponent(record.job)}/audio/${encodeURIComponent(part.artifact)}`;
            if (!await tts.playPreparedAudio(url, { speaker: String(message?.name || 'Character'), isStillVisible, token,
                ...(record.playbackRate !== undefined ? { playbackRate: record.playbackRate } : {}) })) return false;
        }
        return true;
    } catch (error) {
        console.warn('Conversation Mode: prepared narration playback failed', error);
        return false;
    }
}
