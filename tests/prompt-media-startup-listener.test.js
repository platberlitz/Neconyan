/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// prompt-media-client.js is on the page's startup path; the review window (prompt-media-ui.js) loads on first use. A refusal that arrives
// before the window has ever been opened must still show the notice, so the client registers the listener at startup and loads the
// window when a refusal comes in. These tests load the real client against stand-ins for the app it imports, and a stand-in review window
// whose factory runs only when something imports it.

const windowLoads = jest.fn();
const showImageChoiceNotice = jest.fn(() => true);
const showPromptMediaReview = jest.fn(async () => {});
const setAccountChoice = jest.fn(async () => {});
await jest.unstable_mockModule('../public/scripts/prompt-media-ui.js', () => {
    windowLoads();
    return { showImageChoiceNotice, showPromptMediaReview, setAccountChoice };
});
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ conversationState: {} }));
await jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ roleplayAccountStamp: () => ({ account: { accountId: 'a-1' } }) }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
await jest.unstable_mockModule('../public/lib.js', () => ({ sha256: value => `hash:${value}` }));
await jest.unstable_mockModule('../public/script.js', () => ({ chat_metadata: {}, main_api: 'openai', getRequestHeaders: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
await jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: {} }));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
    translate: text => text,
}));

const { initPromptMediaControls } = await import('../public/scripts/prompt-media-client.js');

const settle = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const REFUSED = 'neconyan:image-input-refused';
let target;
let shownToasts;

beforeEach(() => {
    target = new EventTarget();
    globalThis.addEventListener = target.addEventListener.bind(target);
    globalThis.document = { getElementById: () => null };
    shownToasts = [];
    const shown = { find: () => ({ attr: () => {} }) };
    globalThis.toastr = { error: jest.fn(message => { shownToasts.push(['error', message]); return shown; }), warning: jest.fn(() => shown) };
    showImageChoiceNotice.mockClear();
    showPromptMediaReview.mockClear();
});
afterEach(() => {
    delete globalThis.addEventListener;
    delete globalThis.document;
    delete globalThis.toastr;
});

describe('the refusal listener is registered at startup, before the review window has ever loaded', () => {
    test('registering it does not load the review window', () => {
        expect(windowLoads).not.toHaveBeenCalled();
        initPromptMediaControls();
        expect(windowLoads).not.toHaveBeenCalled();
    });

    test('a refusal that arrives first loads the window and shows the notice with the event detail', async () => {
        initPromptMediaControls();
        const detail = { reason: 'invalid-policy', message: 'This chat\'s connection cannot receive images.', origin: { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'chat-a', avatar: 'nova.png' } } };
        target.dispatchEvent(new CustomEvent(REFUSED, { detail }));
        await settle();
        expect(windowLoads).toHaveBeenCalledTimes(1);
        expect(showImageChoiceNotice).toHaveBeenCalledTimes(1);
        expect(showImageChoiceNotice).toHaveBeenCalledWith(detail);
        expect(globalThis.toastr.warning).not.toHaveBeenCalled();
    });

    test('later refusals reuse the loaded window, and an old-style event with no detail still reaches the notice', async () => {
        initPromptMediaControls();
        target.dispatchEvent(new CustomEvent(REFUSED, { detail: { message: 'One.' } }));
        target.dispatchEvent(new CustomEvent(REFUSED));
        await settle();
        expect(windowLoads).toHaveBeenCalledTimes(1);
        expect(showImageChoiceNotice.mock.calls.map(call => call[0])).toEqual([{ message: 'One.' }, null]);
    });

    test('the review button opens the window on its first click, not at startup', async () => {
        const button = new EventTarget();
        globalThis.document = { getElementById: id => id === 'prompt-images-review' ? Object.assign(button, { dataset: {} }) : null };
        initPromptMediaControls();
        button.dispatchEvent(new Event('click'));
        await settle();
        expect(showPromptMediaReview).toHaveBeenCalledTimes(1);
    });
});
