import { describe, expect, test } from '@jest/globals';
import { normalizeChatroomGeneratedLine, parseChatroomFeed } from '../public/scripts/extensions/in-chat-agents/companion/chatroom-feed.js';

describe('Chatroom reply fields', () => {
    const message = 'the bed slat creaked "low" like it also remembers. even the furniture is a flashback device in this fic. the FURNITURE';
    const prefix = 'chatroom-reply|gravel_voice_truther|comment|18|';

    test.each([
        `Replying-to|fullerton_library|${message}`,
        `Replying_To|@fullerton_library|${message}`,
        ` replying to | @fullerton_library | ${message}`,
        `Replying-to|fullerton_library/${message}`,
    ])('recovers a labelled target without leaking it into the post: %s', fields => {
        const source = prefix + fields;
        const expected = `${prefix}fullerton_library|${message}`;
        expect(normalizeChatroomGeneratedLine(source)).toBe(expected);
        expect(normalizeChatroomGeneratedLine(expected)).toBe(expected);
        expect(parseChatroomFeed(source).rows).toEqual([expected]);
    });

    test.each([
        ['fullerton_library|See https://example.com/a/b', 'fullerton_library|See https://example.com/a/b'],
        ['@fullerton_library|one|two/three', 'fullerton_library|one/two/three'],
        ['Replying-to|A reply without a recoverable handle.', 'Replying-to|A reply without a recoverable handle.'],
        ['Replying-to|https://example.com/a/b', 'Replying-to|https://example.com/a/b'],
        ['Replying-to|words with spaces/body', 'Replying-to|words with spaces/body'],
        ['Replying-to|fullerton_library/', 'Replying-to|fullerton_library/'],
    ])('preserves ordinary targets and ambiguous message text: %s', (fields, expected) => {
        expect(normalizeChatroomGeneratedLine(prefix + fields)).toBe(prefix + expected);
    });
});
