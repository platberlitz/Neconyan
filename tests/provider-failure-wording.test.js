import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { PROVIDER_UNREACHABLE_MESSAGES } from '../src/generation/provider-reach.js';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

let wording;
let notice;
beforeAll(async () => {
    // roleplayReplyNotice logs every raw error on purpose.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    wording = await import('../public/scripts/provider-failure-wording.js');
    notice = await import('../public/scripts/roleplay-reply-notice.js');
});

describe('AI provider failure wording', () => {
    test('a bare connection message from the provider says the provider link failed, not Neconyan', () => {
        for (const raw of ['Connection error.', 'connection error', 'Error: fetch failed', 'terminated', 'EOF', 'unexpected EOF',
            'socket hang up', 'Bad Gateway', 'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
            'read tcp 10.0.0.2:443: connection reset by peer']) {
            const shown = wording.providerFailureText(raw);
            expect(shown).toContain('The connection to the AI provider failed');
            expect(shown).toContain('Neconyan itself is still connected');
            expect(shown).toContain(raw.trim());
        }
    });

    test('other provider messages pass through unchanged', () => {
        for (const raw of ['Invalid API key.', 'The model `gpt-9` does not exist', 'Rate limit reached. Try again in 20s.', 'A connection error was reported in the logs for request 1234 while the account was being upgraded, and so on']) {
            expect(wording.providerFailureText(raw)).toBe(raw);
        }
        expect(wording.isProviderConnectionText('x'.repeat(301) + ' connection reset by peer')).toBe(false);
        expect(wording.providerFailureText(undefined)).toBe('');
    });

    test('the server\'s provider-unreachable reply is shown in plain words for each reason', () => {
        for (const [reason, english] of Object.entries(PROVIDER_UNREACHABLE_MESSAGES)) {
            expect(wording.providerFailureText(english, { code: wording.PROVIDER_UNREACHABLE, reason })).toBe(english);
            // A reply job keeps only the message text, which still maps to the same wording.
            expect(wording.providerFailureText(english)).toBe(english);
        }
        expect(wording.providerFailureText('fetch failed', { code: 'provider_unreachable', reason: 'refused' })).toBe(PROVIDER_UNREACHABLE_MESSAGES.refused);
        expect(wording.providerFailureText('fetch failed', { code: 'provider_unreachable' })).toBe(PROVIDER_UNREACHABLE_MESSAGES.unknown);
    });
});

describe('roleplay reply notices', () => {
    test('a reply job that ended with a provider connection message says which connection failed', () => {
        const ended = notice.roleplayReplyNotice(Object.assign(new Error('Connection error.'), { code: 'JOB_FAILED' }), 'failed');
        expect(ended.title).toBe('Reply failed');
        expect(ended.message).toContain('The connection to the AI provider failed');
        const unreachable = notice.roleplayReplyNotice({ message: 'fetch failed', body: { error: { code: 'provider_unreachable', reason: 'timeout' } } }, 'failed');
        expect(unreachable.message).toBe(PROVIDER_UNREACHABLE_MESSAGES.timeout);
    });

    test('the browser failing to reach Neconyan keeps its own message', () => {
        const ended = notice.roleplayReplyNotice(new TypeError('Failed to fetch'), 'interrupted');
        expect(ended.message).toBe('Failed to fetch');
        expect(notice.roleplayReplyNotice(new Error('Invalid API key.'), 'failed').message).toBe('Invalid API key.');
    });
});
