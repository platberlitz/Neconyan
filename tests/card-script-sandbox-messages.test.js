import { describe, expect, test } from '@jest/globals';
import {
    MESSAGE_TYPE,
    MESSAGE_VERSION,
    validateSlashRequestMessage,
    RESIZE_MESSAGE_TYPE,
    READY_MESSAGE_TYPE,
    validateResizeMessage,
    validateReadyMessage,
} from '../public/scripts/card-script-sandbox/messages.js';

const canonicalMessage = Object.freeze({
    type: MESSAGE_TYPE,
    version: MESSAGE_VERSION,
    messageId: 5,
    nonce: 'nonce-5',
    command: '/echo hello',
});

const nonObjectPayloads = [
    null,
    undefined,
    '/echo hello',
    1,
    [],
    new Date(),
];

const badMessageIds = [
    undefined,
    '5',
    1.5,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
];

const badNonces = [
    undefined,
    123,
    '',
    '   ',
    'a'.repeat(129),
];

const badCommands = [
    undefined,
    123,
    null,
];

describe('card script sandbox message validation', () => {
    test('ready and resize accept only their known authenticated envelopes', () => {
        expect(validateReadyMessage({ ...canonicalMessage, type: READY_MESSAGE_TYPE }).ok).toBe(true);
        expect(validateResizeMessage({ ...canonicalMessage, type: RESIZE_MESSAGE_TYPE, height: 0 }).ok).toBe(true);
        for (const height of [NaN, Infinity, -1, '12', undefined]) expect(validateResizeMessage({ ...canonicalMessage, type: RESIZE_MESSAGE_TYPE, height }).ok).toBe(false);
        expect(validateResizeMessage({ ...canonicalMessage, height: 12 }).ok).toBe(false);
    });
    test('accepts the canonical slash request shape', () => {
        expect(validateSlashRequestMessage(canonicalMessage)).toEqual({
            ok: true,
            value: canonicalMessage,
        });
    });

    test('rejects non-object payloads', () => {
        for (const data of nonObjectPayloads) {
            expect(validateSlashRequestMessage(data)).toEqual({ ok: false, reason: 'not_object' });
        }
    });

    test('rejects wrong type and version values', () => {
        expect(validateSlashRequestMessage({ ...canonicalMessage, type: 'other' })).toEqual({
            ok: false,
            reason: 'wrong_type',
        });
        expect(validateSlashRequestMessage({ ...canonicalMessage, version: 2 })).toEqual({
            ok: false,
            reason: 'wrong_version',
        });
    });

    test('rejects bad messageId values', () => {
        for (const messageId of badMessageIds) {
            expect(validateSlashRequestMessage({ ...canonicalMessage, messageId })).toEqual({
                ok: false,
                reason: 'bad_message_id',
            });
        }
    });

    test('rejects bad nonce values', () => {
        for (const nonce of badNonces) {
            expect(validateSlashRequestMessage({ ...canonicalMessage, nonce })).toEqual({
                ok: false,
                reason: 'bad_nonce',
            });
        }
    });

    test('rejects non-string commands', () => {
        for (const command of badCommands) {
            expect(validateSlashRequestMessage({ ...canonicalMessage, command })).toEqual({
                ok: false,
                reason: 'bad_command',
            });
        }
    });

    test('rejects oversized commands', () => {
        expect(validateSlashRequestMessage({ ...canonicalMessage, command: 'abcd' }, { maxCommandLength: 3 })).toEqual({
            ok: false,
            reason: 'command_too_long',
        });
    });
});
