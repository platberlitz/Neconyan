import { describe, expect, test } from '@jest/globals';
import { foldMessageInboxLines } from '../public/scripts/extensions/in-chat-agents/companion/message-inbox-feed.js';

describe('Message Inbox lines', () => {
    test('keeps a wrapped letter inside its letter line', () => {
        expect(foldMessageInboxLines([
            'letter-start|Wax seal|by courier',
            'letter-text|Kaveh|dawn|Do not touch the blueprints.',
            '',
            'I mean it this time.',
            'letter-text|Alhaitham|noon|Noted.',
            'letter-end',
            'after the card',
        ].join('\n')).split('\n')).toEqual([
            'letter-start|Wax seal|by courier',
            'letter-text|Kaveh|dawn|Do not touch the blueprints.<br>I mean it this time.',
            'letter-text|Alhaitham|noon|Noted.',
            'letter-end',
            'after the card',
        ]);
    });

    test('leaves one-line messages and phone-none alone', () => {
        const phone = 'phone-start|Kaveh|just now\nphone-text|Kaveh|1m|where are you\n\nphone-end';
        expect(foldMessageInboxLines(phone)).toBe(phone);
        expect(foldMessageInboxLines('phone-none')).toBe('phone-none');
    });
});
