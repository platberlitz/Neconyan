/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// The page's listener for 'neconyan:image-input-refused' lives in prompt-media-client.js, which is on the startup path. The notice itself
// is in the review window (prompt-media-ui.js), which is fetched when the first refusal comes in. These tests hold that fetch open (or make
// it fail) and check what the listener does meanwhile: every refusal keeps the chat, account and branch it was raised with, refusals that
// arrive before the window has loaded are shown in the order they were raised, and a failed load does not lose the ones after it.
// Each test loads the real client afresh, against stand-ins for the app it imports and a review window that loads when the test says.

let makeReviewWindow;
await jest.unstable_mockModule('../public/scripts/prompt-media-ui.js', () => makeReviewWindow());
let currentAccount = 'alice';
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState: {} }));
await jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ roleplayAccountStamp: () => ({ account: { accountId: 'a-1' } }) }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => currentAccount }));
await jest.unstable_mockModule('../public/lib.js', () => ({ sha256: value => `hash:${value}` }));
await jest.unstable_mockModule('../public/script.js', () => ({ chat_metadata: {}, main_api: 'openai', getRequestHeaders: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
    translate: text => text,
}));

const REFUSED = 'neconyan:image-input-refused';
const settle = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const roleplayOrigin = (account, chat) => ({ workspace: 'roleplay', account, locator: { group: false, chat, avatar: 'nova.png' } });
const conversationOrigin = (account, branchId) => ({ workspace: 'conversation', account, avatar: 'nova.png', groupId: '', personaId: 'user-default', branchId, lifetimeSeed: 'seed-1', createdAt: '1760000000000' });

let target;
let shown;
let windowLoads;
let toastr;

/** Loads the real client with a review window that stays unloaded until `open()` (or fails when `fail()` is called). */
async function loadClient() {
    shown = [];
    windowLoads = 0;
    let release;
    let reject;
    const gate = new Promise((resolve, rejectGate) => { release = resolve; reject = rejectGate; });
    // A browser fetches a module once however many import() calls ask for it, so the stand-in does the same.
    let loading = null;
    makeReviewWindow = () => (loading ??= (async () => {
        windowLoads += 1;
        await gate;
        return { showImageChoiceNotice: detail => { shown.push({ detail, accountNow: currentAccount }); return true; }, showPromptMediaReview: async () => {}, setAccountChoice: async () => {} };
    })());
    jest.resetModules();
    const client = await import('../public/scripts/prompt-media-client.js');
    client.initPromptMediaControls();
    return { open: release, fail: reject };
}

beforeEach(() => {
    currentAccount = 'alice';
    target = new EventTarget();
    globalThis.addEventListener = target.addEventListener.bind(target);
    globalThis.document = { getElementById: () => null };
    toastr = { error: jest.fn(() => ({ find: () => ({ attr: () => {} }) })), warning: jest.fn() };
    globalThis.toastr = toastr;
});
afterEach(() => {
    delete globalThis.addEventListener;
    delete globalThis.document;
    delete globalThis.toastr;
});

const raise = detail => target.dispatchEvent(new CustomEvent(REFUSED, { detail }));

describe('refusals that arrive before the review window has loaded', () => {
    test('two refusals from two different origins are both shown once it has loaded, each with its own origin, in the order they were raised', async () => {
        const window = await loadClient();
        const first = { message: 'This chat\'s connection cannot receive images.', origin: roleplayOrigin('alice', 'chat-a') };
        const second = { message: 'This chat\'s connection cannot receive images.', origin: conversationOrigin('alice', 'branch-7') };
        raise(first);
        raise(second);
        await settle();
        expect(windowLoads).toBe(1);
        expect(shown).toEqual([]);
        window.open();
        await settle();
        expect(windowLoads).toBe(1);
        expect(shown.map(row => row.detail)).toEqual([first, second]);
        expect(shown[0].detail.origin.workspace).toBe('roleplay');
        expect(shown[0].detail.origin.locator.chat).toBe('chat-a');
        expect(shown[1].detail.origin.workspace).toBe('conversation');
        expect(shown[1].detail.origin.branchId).toBe('branch-7');
        expect(toastr.error).not.toHaveBeenCalled();
    });

    test('a refusal raised under account A still carries A after the import, even if the current account changed meanwhile', async () => {
        const window = await loadClient();
        raise({ message: 'An image changed after its choice was saved.', origin: roleplayOrigin('alice', 'chat-a') });
        currentAccount = 'bob';
        window.open();
        await settle();
        expect(shown).toHaveLength(1);
        expect(shown[0].accountNow).toBe('bob');
        expect(shown[0].detail.origin.account).toBe('alice');
    });

    test('the origin is the one the refusal was raised with, even if the raiser changes the event\'s data before the window loads', async () => {
        const window = await loadClient();
        const detail = { message: 'Reason.', origin: conversationOrigin('alice', 'branch-1') };
        raise(detail);
        detail.origin.account = 'bob';
        detail.origin.branchId = 'branch-2';
        detail.message = 'Changed.';
        window.open();
        await settle();
        expect(shown[0].detail).toEqual({ message: 'Reason.', origin: conversationOrigin('alice', 'branch-1') });
    });

    test('refusals after the window has loaded reuse it, and an event with no detail still reaches the notice', async () => {
        const window = await loadClient();
        raise({ message: 'One.', origin: roleplayOrigin('alice', 'chat-a') });
        window.open();
        await settle();
        raise({ message: 'Two.', origin: roleplayOrigin('alice', 'chat-b') });
        target.dispatchEvent(new CustomEvent(REFUSED));
        await settle();
        expect(windowLoads).toBe(1);
        expect(shown.map(row => row.detail?.message ?? null)).toEqual(['One.', 'Two.', null]);
    });
});

describe('a review window that cannot be loaded', () => {
    test('is reported as an error toast, not thrown, and the refusals after it are still attempted', async () => {
        const window = await loadClient();
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            expect(() => { raise({ message: 'One.' }); raise({ message: 'Two.' }); }).not.toThrow();
            window.fail(new Error('Failed to fetch dynamically imported module'));
            await settle();
            expect(shown).toEqual([]);
            expect(toastr.error.mock.calls.map(call => call[0])).toEqual(['Failed to fetch dynamically imported module', 'Failed to fetch dynamically imported module']);
            expect(unhandled).not.toHaveBeenCalled();
        } finally { process.off('unhandledRejection', unhandled); }
    });
});
