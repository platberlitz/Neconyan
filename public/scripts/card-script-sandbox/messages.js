import { DEFAULT_LIMITS } from './allowlist.js';
import { CARD_SCRIPT_PROTOCOL_VERSION, MAX_CARD_DOCUMENT_LENGTH } from './policy.js';

export const MESSAGE_TYPE = 'neconyan-card-script:slash';
export const MESSAGE_VERSION = 1;
export const RESIZE_MESSAGE_TYPE = 'neconyan-card-script:resize';
export const READY_MESSAGE_TYPE = 'neconyan-card-script:ready';
export const BOOTSTRAP_MESSAGE_TYPE = 'neconyan-card-script:bootstrap';
export const INIT_MESSAGE_TYPE = 'neconyan-card-script:init';

export function validateBootstrapMessage(data) {
    const envelope = validateEnvelope(data, BOOTSTRAP_MESSAGE_TYPE);
    if (!envelope.ok) return envelope;
    if (data.protocol !== CARD_SCRIPT_PROTOCOL_VERSION || !['protected', 'unsupported', 'android-bridge'].includes(data.protection)) return { ok: false, reason: 'bad_bootstrap' };
    return { ok: true, value: { ...envelope.value, protocol: data.protocol, protection: data.protection } };
}

export function validateInitMessage(data) {
    const envelope = validateEnvelope(data, INIT_MESSAGE_TYPE);
    if (!envelope.ok) return envelope;
    if (data.protocol !== CARD_SCRIPT_PROTOCOL_VERSION || typeof data.document !== 'string' || !data.document.length || data.document.length > MAX_CARD_DOCUMENT_LENGTH || typeof data.cardNonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.cardNonce) || typeof data.title !== 'string' || data.title.length > 256 || typeof data.allowUnprotected !== 'boolean') return { ok: false, reason: 'bad_init' };
    return { ok: true, value: { ...envelope.value, protocol: data.protocol, document: data.document, cardNonce: data.cardNonce, title: data.title, allowUnprotected: data.allowUnprotected } };
}

export function validateSlashRequestMessage(data, { maxCommandLength = DEFAULT_LIMITS.maxCommandLength } = {}) {
    const envelope = validateEnvelope(data, MESSAGE_TYPE);
    if (!envelope.ok) return envelope;

    if (typeof data.command !== 'string') return { ok: false, reason: 'bad_command' };
    if (data.command.length > maxCommandLength) return { ok: false, reason: 'command_too_long' };
    return { ok: true, value: { ...envelope.value, command: data.command } };
}

export function validateResizeMessage(data) {
    const envelope = validateEnvelope(data, RESIZE_MESSAGE_TYPE);
    if (!envelope.ok) return envelope;
    if (typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 0) {
        return { ok: false, reason: 'bad_height' };
    }
    return { ok: true, value: { ...envelope.value, height: data.height } };
}

export function validateReadyMessage(data) {
    return validateEnvelope(data, READY_MESSAGE_TYPE);
}

function validateEnvelope(data, type) {
    if (!isPlainRecord(data)) {
        return { ok: false, reason: 'not_object' };
    }

    if (data.type !== type) {
        return { ok: false, reason: 'wrong_type' };
    }

    if (data.version !== MESSAGE_VERSION) {
        return { ok: false, reason: 'wrong_version' };
    }

    if (!Number.isSafeInteger(data.messageId) || data.messageId < 0) {
        return { ok: false, reason: 'bad_message_id' };
    }

    if (typeof data.nonce !== 'string' || data.nonce.trim() === '' || data.nonce.length > 128) {
        return { ok: false, reason: 'bad_nonce' };
    }

    return {
        ok: true,
        value: {
            type: data.type,
            version: data.version,
            messageId: data.messageId,
            nonce: data.nonce,
        },
    };
}

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
