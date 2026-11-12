import { describe, expect, test } from '@jest/globals';
import { foldChatroomGreentextLines, mergeChatroomReplyFeed, normalizeChatroomGeneratedLine, parseChatroomFeed } from '../public/scripts/extensions/in-chat-agents/companion/chatroom-feed.js';

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

describe('Chatroom board posts', () => {
    test('turns a leading quote link into a reply to that post number', () => {
        expect(normalizeChatroomGeneratedLine('chatroom|Anonymous|No.84920117|18|>>84920113 fake and gay'))
            .toBe('chatroom-reply|Anonymous|No.84920117|18|84920113|fake and gay');
        expect(normalizeChatroomGeneratedLine('chatroom-reply|Anonymous|No.84920118|42|>>84920113|>>84920113 checked'))
            .toBe('chatroom-reply|Anonymous|No.84920118|42|84920113|checked');
        expect(normalizeChatroomGeneratedLine('chatroom|Anonymous|No.84920119|42|>>84920113'))
            .toBe('chatroom|Anonymous|No.84920119|42|>>84920113');
    });

    test('folds a multi-line greentext story into the post it belongs to', () => {
        const folded = foldChatroomGreentextLines([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anonymous|No.84920113|18|>be me',
            '>exchange student',
            '>go to the ruin alone',
            'chatroom|Anonymous|No.84920114|42|bait',
            '>implying',
            'chatroom-end',
        ].join('\n'));

        expect(folded.split('\n')).toEqual([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anonymous|No.84920113|18|>be me<br>>exchange student<br>>go to the ruin alone',
            'chatroom|Anonymous|No.84920114|42|bait<br><span class="chatroom-greentext">>implying</span>',
            'chatroom-end',
        ]);
    });

    test('keeps a greentext line with no post to join', () => {
        expect(foldChatroomGreentextLines('chatroom-style|mixed\n>orphan')).toBe('chatroom-style|mixed\n>orphan');
    });

    test('keeps the comment under a greentext story inside the same post', () => {
        const folded = foldChatroomGreentextLines([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anonymous|No.89412004|18|>be sleep-deprived poetlet',
            '>toes curling in oxfords.jpg',
            '',
            'is she gonna make it bros?',
            'chatroom|Anonymous|No.89412028|42|"approximately forty percent more ambient noise"',
            'holy autism',
            'chatroom-reply|Anonymous|No.89412029|42|89412028|>implying',
            'kek',
            'chatroom-end',
            'trailing note',
        ].join('\n'));

        expect(folded.split('\n')).toEqual([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anonymous|No.89412004|18|<span class="chatroom-greentext">>be sleep-deprived poetlet</span><br><span class="chatroom-greentext">>toes curling in oxfords.jpg</span><br>is she gonna make it bros?',
            'chatroom|Anonymous|No.89412028|42|"approximately forty percent more ambient noise"<br>holy autism',
            'chatroom-reply|Anonymous|No.89412029|42|89412028|<span class="chatroom-greentext">>implying</span><br>kek',
            'chatroom-end',
            'trailing note',
        ]);
    });

    test('keeps a lone green reply coloured and a blank line between posts', () => {
        expect(foldChatroomGreentextLines('chatroom-reply|Anon|No.2|18|1|>mfw\n\nchatroom|Anon|No.3|18|hi'))
            .toBe('chatroom-reply|Anon|No.2|18|1|<span class="chatroom-greentext">>mfw</span>\n\nchatroom|Anon|No.3|18|hi');
    });

    test('turns a post that lost its chatroom prefix back into a post', () => {
        expect(normalizeChatroomGeneratedLine('Anonymous|No.89412030|18|holy autism'))
            .toBe('chatroom|Anonymous|No.89412030|18|holy autism');
        expect(normalizeChatroomGeneratedLine('>be me|lol|1|x')).toBe('>be me|lol|1|x');
        expect(normalizeChatroomGeneratedLine('is she gonna make it bros?')).toBe('is she gonna make it bros?');
    });

    test('carries a post comment through the saved feed and reply merge', () => {
        const previous = 'chatroom-style|thread-board/4chan\nchatroom|Anonymous|No.1|18|>be me\nis she gonna make it bros?\nchatroom-end\nnot part of the feed';
        expect(parseChatroomFeed(previous).rows).toEqual([
            'chatroom|Anonymous|No.1|18|>be me',
            'is she gonna make it bros?',
        ]);
        const merged = mergeChatroomReplyFeed({
            previousContent: previous,
            replyContent: 'chatroom-style|thread-board/4chan\nchatroom|Anonymous|No.2|42|yes\nbelieve',
            viewerName: 'Anon',
            viewerText: 'will she?',
        });
        expect(merged.split('\n')).toEqual([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anonymous|No.1|18|>be me',
            'is she gonna make it bros?',
            'chatroom-you|Anon|will she?',
            'chatroom|Anonymous|No.2|42|yes',
            'believe',
            'chatroom-end',
        ]);
    });
});
