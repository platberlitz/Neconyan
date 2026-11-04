import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Drives the real chat-list coalescing state machine from neconyan-tabs.js: concurrent
// listings for one avatar share one request, a chat-state change stops the sharing, and
// each caller still gets its own error handling.
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

const declarationNames = [
    'normalizeChatFileName',
    'formatChatPreview',
    'getChatSortTimestamp',
    'normalizeChatInfo',
    'sortChatFiles',
    'failChatFileListing',
    'requestCharacterChatFiles',
    'fetchCharacterChatFiles',
    'invalidateInFlightCharacterChatFileListings',
];

function buildContext() {
    const context = vm.createContext({
        console,
        fetch: () => Promise.resolve({ ok: true, json: async () => [] }),
        getAuthorizedRequestHeadersOrNull: async () => ({}),
        // formatChatPreview's helper; the test payload previews never reach the cap.
        clampText: (value, maxLength) => String(value ?? '').slice(0, maxLength),
    });
    for (const name of declarationNames) {
        const match = new RegExp(`^(async function|function) ${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\(`, 'm').exec(source);
        if (!match) throw new Error(`Missing declaration: ${name}`);
        const start = match.index;
        const end = source.indexOf('\n}\n', start);
        vm.runInContext(source.slice(start, end + 3), context);
    }
    const stateStart = source.indexOf('let characterChatFileListingGeneration = 0;');
    const invalidateStart = source.indexOf('function invalidateInFlightCharacterChatFileListings(');
    const invalidateEnd = source.indexOf('\n}\n', invalidateStart);
    vm.runInContext(source.slice(stateStart, invalidateEnd + 3), context);
    return context;
}

function chatContext(avatar) {
    return { character: { avatar }, context: null };
}

function respond(pending, payload) {
    pending.resolve({ ok: true, json: async () => payload });
}

describe('character chat file listing coalescing', () => {
    test('concurrent listings for one avatar share a single request', async () => {
        const context = buildContext();
        const pending = [];
        context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, body: JSON.parse(options.body) }));

        const first = context.fetchCharacterChatFiles(chatContext('Alice.png'));
        const second = context.fetchCharacterChatFiles(chatContext('Alice.png'));
        await new Promise(resolve => setImmediate(resolve));

        expect(pending).toHaveLength(1);
        expect(pending[0].body).toEqual({ avatar_url: 'Alice.png' });
        respond(pending[0], [{ file_name: 'a', chat_items: 1 }]);

        const [firstList, secondList] = await Promise.all([first, second]);
        expect(firstList).toEqual(secondList);
        expect(firstList).toHaveLength(1);
    });

    test('different avatars and a chat-state change never share a request', async () => {
        const context = buildContext();
        const pending = [];
        context.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, body: JSON.parse(options.body) }));

        const alice = context.fetchCharacterChatFiles(chatContext('Alice.png'));
        context.fetchCharacterChatFiles(chatContext('Bob.png'));
        await new Promise(resolve => setImmediate(resolve));
        expect(pending).toHaveLength(2);

        // A chat change invalidates in-flight sharing: a caller after the change starts
        // its own request even though Alice's original request is still unanswered.
        context.invalidateInFlightCharacterChatFileListings();
        const refreshed = context.fetchCharacterChatFiles(chatContext('Alice.png'));
        await new Promise(resolve => setImmediate(resolve));
        expect(pending).toHaveLength(3);
        expect(pending[2].body).toEqual({ avatar_url: 'Alice.png' });

        respond(pending[0], [{ file_name: 'stale-listing' }]);
        respond(pending[1], []);
        respond(pending[2], [{ file_name: 'fresh-listing' }]);
        expect((await alice).map(chat => chat.fileName)).toEqual(['stale-listing']);
        expect((await refreshed).map(chat => chat.fileName)).toEqual(['fresh-listing']);
    });

    test('a shared failure keeps the error handling of each caller separate', async () => {
        const context = buildContext();
        context.fetch = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });

        await expect(context.fetchCharacterChatFiles(chatContext('Alice.png'), { throwOnError: true })).rejects.toThrow('failed (500)');
        await expect(context.fetchCharacterChatFiles(chatContext('Alice.png'))).resolves.toEqual([]);
    });
});
