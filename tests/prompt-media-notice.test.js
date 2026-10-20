/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// prompt-media-ui.js is the page's image review. These tests load the real module against stand-ins for the app it imports and for the
// browser objects it uses, so the notice, its click, its throttle and the settings-changed signal are the real code.

const dictionary = new Map();
const lookups = [];
const translateText = (text, key = null) => { lookups.push([text, key]); return dictionary.get(key || text) ?? text; };
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => {
        const key = strings.reduce((text, part, index) => text + part + (index < values.length ? `\${${index}}` : ''), '');
        return translateText(key).replace(/\$\{(\d+)\}/g, (_, index) => values[index]);
    },
    translate: translateText,
}));

const state = { chatId: null, avatars: [{ avatar: 'nova.png' }], chid: 0, handle: 'alice', saved: true, group: null };
const chat = [];
const saveSettings = jest.fn(async () => state.saved);
const saveChatConditional = jest.fn(async () => true);
const refreshCurrentChatFromSaved = jest.fn(async () => {});
const power_user = {};
await jest.unstable_mockModule('../public/script.js', () => ({
    chat, characters: state.avatars, get this_chid() { return state.chid; }, getCurrentChatId: () => state.chatId,
    getRequestHeaders: () => ({}), saveSettings, saveChatConditional, refreshCurrentChatFromSaved,
}));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ get selected_group() { return state.group; } }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => state.handle }));
await jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ roleplayAccountStamp: () => ({ account: { accountId: 'a-1' } }) }));
const shownPanels = [];
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: { TEXT: 'text', CONFIRM: 'confirm' },
    Popup: class { constructor(panel, ...rest) { this.panel = panel; this.rest = rest; } async show() { shownPanels.push(this.panel); return true; } static show = { confirm: async () => true }; },
}));
const branch = { id: 'main', lifetimeSeed: 's', messages: [], neconyan_prompt_media: undefined };
const persistConversationStore = jest.fn();
const flushConversationStore = jest.fn(async () => true);
// Conversation: the thread that is open (null when Conversation is closed), the branches each thread has, and what the left rail's switch does.
const conversation = { open: null, personaId: 'user.png', branches: null, inactive: {}, groups: new Set(), switchResult: true, switched: [], afterSwitch: null };
const threadBranch = (avatar, groupId = '') => conversation.branches?.[`${avatar}|${groupId}`];
const selectConversationThread = jest.fn(async (avatar, options = {}) => {
    conversation.switched.push([avatar, options]);
    if (!conversation.switchResult) return false;
    conversation.open = { avatar, groupId: options.groupId ? String(options.groupId) : '' };
    conversation.afterSwitch?.();
    return true;
});
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getCurrentCharAvatar: () => conversation.open?.avatar ?? 'nova.png',
    // With a branchId it finds that branch, active or not; without one, the thread's active branch.
    getActiveConversationBranch: (avatar, options = {}) => {
        if (!conversation.branches) return state.branch === undefined ? branch : state.branch;
        const group = options.groupId ?? conversation.open?.groupId ?? '';
        const active = threadBranch(avatar, group) ?? null;
        if (!options.branchId) return active;
        return active?.id === options.branchId ? active : conversation.inactive[`${avatar}|${group}`]?.[options.branchId] ?? null;
    },
    getConversationPersonaId: () => conversation.personaId,
    isAvatarInConversationGroup: (avatar, groupId) => conversation.groups.has(String(groupId)),
    persistConversationStore,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/chrome.js', () => ({ selectConversationThread }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    isConversationActiveThread: (avatar, groupId, { personaId } = {}) => Boolean(conversation.open) && conversation.open.avatar === avatar
        && conversation.open.groupId === (groupId ? String(groupId) : '') && personaId === conversation.personaId,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ flushConversationStore }));
await jest.unstable_mockModule('../public/scripts/prompt-media-client.js', () => ({
    promptAttachmentHash: () => 'hash', generatedImagePromptPolicy: item => item,
}));

// A page object just big enough for the review dialogs.
function fakeNode(tag) {
    return {
        tag, children: [], attributes: {}, dataset: {}, style: {}, listeners: {}, textContent: '', className: '', hidden: false, disabled: false, checked: false,
        append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; }, setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }, querySelectorAll() { return []; },
        remove() {}, closest() { return null; },
    };
}
const body = { classList: { contains: name => body.classes.has(name) }, classes: new Set() };
globalThis.document = { body, createElement: fakeNode, querySelectorAll: () => [], getElementById: () => null };

const ui = await import('../public/scripts/prompt-media-ui.js');
// The page's own listener lives in prompt-media-client.js, which is on the startup path (its test: prompt-media-startup-listener.test.js).
// It hands each event's detail to this module's notice, which is what these tests drive.
const listenForRefusals = target => target.addEventListener('neconyan:image-input-refused', event => { ui.showImageChoiceNotice(event.detail); });

const toast = { find: selector => ({ attr: (name, value) => marks.push([selector, name, value]) }) };
const marks = [];
const toastr = { warning: jest.fn(() => toast), error: jest.fn(() => toast), success: jest.fn(() => toast), info: jest.fn(() => toast) };
let now = 1_000_000;
let events;

beforeEach(() => {
    lookups.length = 0;
    dictionary.clear();
    marks.length = 0;
    shownPanels.length = 0;
    toastr.warning.mockClear(); toastr.error.mockClear(); toastr.success.mockClear(); toastr.info.mockClear();
    saveSettings.mockClear(); saveChatConditional.mockClear(); refreshCurrentChatFromSaved.mockClear();
    saveChatConditional.mockImplementation(async () => true);
    persistConversationStore.mockClear(); flushConversationStore.mockClear();
    state.chatId = null; state.handle = 'alice'; state.saved = true; state.group = null; delete state.branch;
    Object.assign(conversation, { open: null, personaId: 'user.png', branches: null, inactive: {}, switchResult: true, afterSwitch: null });
    conversation.groups.clear(); conversation.switched.length = 0; selectConversationThread.mockClear();
    delete power_user.neconyan_prompt_media;
    branch.neconyan_prompt_media = undefined; branch.messages = [];
    body.classes.clear();
    globalThis.toastr = toastr;
    // Each test is far past the previous one's throttle window, so a notice is never swallowed by an earlier test.
    now += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    events = [];
    globalThis.dispatchEvent = jest.fn(event => { events.push(event); return true; });
});

afterEach(() => {
    jest.restoreAllMocks();
    delete globalThis.toastr;
    delete globalThis.dispatchEvent;
});

const settingsEvents = () => events.filter(event => event.type === 'neconyan:image-input-settings-changed');
const action = 'Open Review chat images to choose what the model receives.';
const noticeTitle = 'Review needed before replying';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the notice for an image that needs a choice', () => {
    test('one warning: the title, the reason on line 1, what to do on line 2, final text', () => {
        expect(ui.showImageChoiceNotice({ reason: 'vision-unavailable', message: 'This chat\'s connection cannot receive images.' })).toBe(true);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.error).not.toHaveBeenCalled();
        const [message, title, options] = toastr.warning.mock.calls[0];
        expect(title).toBe(noticeTitle);
        expect(message).toBe(`<span data-i18n-ignore>This chat&#39;s connection cannot receive images.</span><br>${action}`);
        // The reason is the first line and the action line the only other one.
        expect(message.split('<br>')).toEqual(['<span data-i18n-ignore>This chat&#39;s connection cannot receive images.</span>', action]);
        expect(options).toMatchObject({ escapeHtml: false, timeOut: 12000 });
        expect(typeof options.onclick).toBe('function');
        // Marked in the same task as the toast is made, title and message both.
        expect(marks).toEqual([['.toast-message, .toast-title', 'data-i18n-ignore', '']]);
    });

    test('the title and the action line are the final wording, with the reason first and none of the old wording left', () => {
        const reason = 'A reply contains a quote that cannot be checked against its original message.';
        expect(ui.showImageChoiceNotice({ reason: 'mixed-reply-context', message: reason })).toBe(true);
        const [message, title] = toastr.warning.mock.calls[0];
        expect(title).toBe('Review needed before replying');
        expect(message).toBe(`<span data-i18n-ignore>${reason}</span><br>Open Review chat images to choose what the model receives.`);
        // The reason line is first and the action line second, in that order and nothing else between them.
        expect(message.indexOf(reason)).toBeLessThan(message.indexOf('Open Review chat images'));
        expect(message.split('<br>')).toHaveLength(2);
        // Neither string carries the old wording, which named choices that do not apply to a quote.
        for (const old of ['An image needs your choice', 'Show only', 'Use a description', 'a compatible copy']) {
            expect(message).not.toContain(old);
            expect(title).not.toContain(old);
        }
        // Both are looked up by their own English (t``), and neither is a reason lookup.
        expect(lookups).toContainEqual(['Review needed before replying', null]);
        expect(lookups).toContainEqual(['Open Review chat images to choose what the model receives.', null]);
    });

    test('the sentences go through t``, and the reason through the exact lookup, so a translation reaches the page', () => {
        dictionary.set(noticeTitle, 'É preciso rever antes de responder');
        dictionary.set(action, 'Abra Rever imagens do chat para escolher o que o modelo recebe.');
        dictionary.set('The file is too large.', 'O ficheiro é demasiado grande.');
        ui.showImageChoiceNotice({ message: 'The file is too large.' });
        const [message, title] = toastr.warning.mock.calls[0];
        expect(title).toBe('É preciso rever antes de responder');
        expect(message).toBe('<span data-i18n-ignore>O ficheiro é demasiado grande.</span><br>Abra Rever imagens do chat para escolher o que o modelo recebe.');
        expect(lookups).toContainEqual(['The file is too large.', null]);
    });

    test('a reason with markup is shown literally, and so is a title a translator wrote with markup', () => {
        dictionary.set(noticeTitle, 'Choice <b>needed</b>');
        ui.showImageChoiceNotice({ message: 'Bad <b>image</b> & <img src=x onerror=alert(1)>' });
        const [message, title, options] = toastr.warning.mock.calls[0];
        expect(message).not.toMatch(/<b>|<img/);
        expect(message).toContain('Bad &lt;b&gt;image&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;');
        expect(title).toBe('Choice &lt;b&gt;needed&lt;/b&gt;');
        expect(options.escapeHtml).toBe(false);
    });

    test('with no message it still gives the choice, as one line', () => {
        expect(ui.showImageChoiceNotice({})).toBe(true);
        expect(toastr.warning.mock.calls[0][0]).toBe(action);
        expect(ui.showImageChoiceNotice()).toBe(false);
    });

    test('clicking opens the review: the Roleplay dialog, or the Conversation dialog when Conversation is open', async () => {
        ui.showImageChoiceNotice({ message: 'First.' });
        toastr.warning.mock.calls[0][2].onclick();
        await settle();
        expect(shownPanels).toHaveLength(1);
        expect(shownPanels[0].id).toBe('prompt-media-review');
        expect(shownPanels[0].children[0].textContent).toBe('Chat images');
        // Conversation open.
        body.classes.add('neconyan-conversation-active');
        ui.showImageChoiceNotice({ message: 'Second.' });
        toastr.warning.mock.calls[1][2].onclick();
        await settle();
        expect(shownPanels).toHaveLength(2);
        expect(shownPanels[1].children[0].textContent).toBe('Conversation images');
        expect(toastr.error).not.toHaveBeenCalled();
        // A review that cannot open says why.
        state.branch = null;
        ui.showImageChoiceNotice({ message: 'Third.' });
        toastr.warning.mock.calls[2][2].onclick();
        await settle();
        expect(toastr.error).toHaveBeenCalledWith('Open a Conversation chat to review its images.');
    });

    test('one refusal shows one notice: the same reason again within a few seconds is not shown twice, a different one is', () => {
        expect(ui.showImageChoiceNotice({ message: 'Same.' })).toBe(true);
        now += 1000;
        expect(ui.showImageChoiceNotice({ message: 'Same.' })).toBe(false);
        expect(ui.showImageChoiceNotice({ message: '  Same.  ' })).toBe(false);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(ui.showImageChoiceNotice({ message: 'Different.' })).toBe(true);
        expect(toastr.warning).toHaveBeenCalledTimes(2);
        now += 5000;
        expect(ui.showImageChoiceNotice({ message: 'Different.' })).toBe(true);
        expect(toastr.warning).toHaveBeenCalledTimes(3);
    });

    test('the page listener builds the notice from the event detail, for every route that dispatches it', () => {
        const target = new EventTarget();
        listenForRefusals(target);
        for (const detail of [{ reason: 'invalid-policy', message: 'From a solo chat.' }, { message: 'From a group chat.' }, { message: 'From Conversation.' }]) {
            target.dispatchEvent(new CustomEvent('neconyan:image-input-refused', { detail }));
        }
        expect(toastr.warning.mock.calls.map(call => call[0].split('<br>')[0])).toEqual([
            '<span data-i18n-ignore>From a solo chat.</span>', '<span data-i18n-ignore>From a group chat.</span>', '<span data-i18n-ignore>From Conversation.</span>']);
        // An old-style event with no message still opens the same notice.
        target.dispatchEvent(new CustomEvent('neconyan:image-input-refused'));
        expect(toastr.warning).toHaveBeenCalledTimes(4);
        expect(toastr.warning.mock.calls[3][0]).toBe(action);
    });
});

// The notice opens the review for the chat that was refused (detail.origin), not the chat that is open when the person clicks.
describe('clicking the notice opens the review for the chat that was refused', () => {
    const sentenceGone = 'The chat or branch this notice refers to could not be opened, so its image review is not available.';
    const sentenceBranch = 'This notice refers to a different branch. Switch back to that branch to review the image.';
    const sentenceAccount = 'This notice belongs to another account. Switch back to that account to review the image.';
    const roleplayOrigin = (chat, avatar = 'nova.png', account = 'alice') => ({ workspace: 'roleplay', account, locator: { group: false, chat, avatar } });
    const conversationOrigin = (extra = {}) => ({ workspace: 'conversation', account: 'alice', avatar: 'ava.png', groupId: '', personaId: 'user.png', branchId: 'main',
        lifetimeSeed: 'seed-a', createdAt: '111', ...extra });
    const requests = [];
    let scanAnswer;
    const click = async origin => {
        ui.showImageChoiceNotice({ message: 'Refused ' + toastr.warning.mock.calls.length + '.', origin });
        toastr.warning.mock.calls.at(-1)[2].onclick();
        await settle(); await settle();
    };
    const dialog = () => shownPanels.at(-1);
    const dialogTitle = () => dialog()?.children[0].textContent;
    const scanned = () => requests.filter(([action]) => action === 'scan').map(([, body]) => body.locator);
    // The panel ends with the navigation row and then the content the first read filled.
    const navigation = () => dialog().children.at(-2);
    const navigationButtons = () => navigation().children.map(node => node.textContent);
    const goneShown = () => toastr.info.mock.calls.filter(([text]) => text === sentenceGone).length;

    beforeEach(() => {
        requests.length = 0;
        scanAnswer = body => ({ ok: true, json: async () => ({ observation: { locator: body.locator }, total: 0, limited: false, issues: [], chatPreference: undefined, next: null }) });
        globalThis.fetch = jest.fn(async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push([url.split('/').pop(), body]);
            return scanAnswer(body);
        });
        // Conversation stands: two threads (ava.png, bea.png) with a branch each, in a world with two characters.
        state.avatars.splice(0, state.avatars.length, { avatar: 'nova.png' }, { avatar: 'ava.png' }, { avatar: 'bea.png' });
        conversation.branches = {
            'ava.png|': { id: 'main', lifetimeSeed: 'seed-a', createdAt: 111, messages: [] },
            'bea.png|': { id: 'main', lifetimeSeed: 'seed-b', createdAt: 222, messages: [] },
            'ava.png|g-1': { id: 'br_1', lifetimeSeed: 'seed-g', createdAt: 333, messages: [] },
        };
    });
    afterEach(() => { delete globalThis.fetch; state.avatars.splice(0, state.avatars.length, { avatar: 'nova.png' }); });

    describe('a Roleplay origin', () => {
        test('opens the Roleplay dialog on that chat while another chat is open, and Current chat still goes to the open one', async () => {
            state.chatId = 'chat-b.jsonl';
            await click(roleplayOrigin('chat-a'));
            expect(shownPanels).toHaveLength(1);
            expect(dialogTitle()).toBe('Chat images');
            expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
            expect(navigationButtons()).toEqual(['Current chat', 'Choose chats', 'Change history']);
            // The view is the origin chat's: its name is the heading.
            expect(dialog().children.at(-1).children[0].textContent).toBe('chat-a');
            const current = navigation().children[0];
            await current.listeners.click[0]();
            await settle();
            expect(scanned().at(-1)).toEqual({ group: false, chat: 'chat-b', avatar: 'nova.png' });
            expect(goneShown()).toBe(0);
        });

        test('opens the Roleplay dialog, not the Conversation one, while Conversation is active', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'ava.png', groupId: '' };
            await click(roleplayOrigin('chat-a'));
            expect(shownPanels).toHaveLength(1);
            expect(dialogTitle()).toBe('Chat images');
            expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
            expect(selectConversationThread).not.toHaveBeenCalled();
        });

        test('has no Current chat button when no chat is open', async () => {
            state.chatId = null;
            await click(roleplayOrigin('chat-a'));
            expect(dialogTitle()).toBe('Chat images');
            expect(navigationButtons()).toEqual(['Choose chats', 'Change history']);
            expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
        });

        test('opens a group chat on its own locator, never saves for the refusal origin, and still saves for Current chat', async () => {
            state.chatId = 'chat-b.jsonl';
            await click({ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'Group one' } });
            expect(scanned()).toEqual([{ group: true, chat: 'Group one' }]);
            expect(shownPanels).toHaveLength(1);
            expect(saveChatConditional).not.toHaveBeenCalled();
            // A refused save would stop the review before its first read, so this proves the origin open does not attempt one.
            saveChatConditional.mockImplementation(async () => false);
            state.chatId = 'chat-a.jsonl';
            await click(roleplayOrigin('chat-a'));
            expect(saveChatConditional).not.toHaveBeenCalled();
            expect(shownPanels).toHaveLength(2);
            expect(dialogTitle()).toBe('Chat images');
            expect(scanned().at(-1)).toEqual({ group: false, chat: 'chat-a', avatar: 'nova.png' });
            // Current chat is an explicit navigation, so it still saves first.
            saveChatConditional.mockImplementation(async () => true);
            const current = navigation().children[0];
            await current.listeners.click[0]();
            await settle();
            expect(saveChatConditional).toHaveBeenCalledTimes(1);
            expect(scanned().at(-1)).toEqual({ group: false, chat: 'chat-a', avatar: 'nova.png' });
        });

        test('a chat the server cannot read gets the explanation and no dialog', async () => {
            scanAnswer = () => ({ ok: false, status: 409, json: async () => ({ error: 'This chat needs ordinary chat recovery before its images can be reviewed.', code: 'ROLEPLAY_IMAGE_RECOVERY' }) });
            await click(roleplayOrigin('deleted-chat'));
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledTimes(1);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('a chat folder that is gone (the server answers ENOENT) and a character that is gone get the unavailable explanation, with no dialog', async () => {
            scanAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'ENOENT: no such file or directory', code: 'ENOENT' }) });
            await click(roleplayOrigin('chat-a'));
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
            expect(toastr.error).not.toHaveBeenCalled();
            // A solo chat whose character is no longer in the page is explained without asking the server.
            requests.length = 0;
            await click(roleplayOrigin('chat-a', 'removed.png'));
            expect(requests).toEqual([]);
            expect(toastr.info).toHaveBeenCalledTimes(2);
            expect(shownPanels).toHaveLength(0);
        });

        test('any other failure of the first read is reported as before, with no explanation and no dialog', async () => {
            scanAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'The store is busy.', code: null }) });
            await click(roleplayOrigin('chat-a'));
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).not.toHaveBeenCalled();
            expect(toastr.error).toHaveBeenCalledWith('The store is busy.');
            globalThis.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
            await click(roleplayOrigin('chat-a'));
            expect(toastr.error).toHaveBeenLastCalledWith('Failed to fetch');
            expect(toastr.info).not.toHaveBeenCalled();
        });

        test('a message added to the origin chat after the refusal does not make it unavailable: the click still opens its review', async () => {
            // The chat is identified by its file, not by what is in it: its content grows, the answer to the first read says so, and the dialog still opens.
            state.chatId = 'chat-b.jsonl';
            scanAnswer = body => ({ ok: true, json: async () => ({ observation: { locator: body.locator }, total: 7, limited: false, chatPreference: { version: 1, images: 'display-only' },
                issues: [{ index: 8, swipe: null, mediaIndex: 0, identity: 'new', status: 'saved-reference', mode: 'include', actions: ['display-only', 'caption', 'include', 'detach'], title: '' }], next: null }) });
            await click(roleplayOrigin('chat-a'));
            expect(shownPanels).toHaveLength(1);
            expect(dialogTitle()).toBe('Chat images');
            expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
            expect(toastr.info).not.toHaveBeenCalled();
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('a message added to the chat that is open, which is the origin, does not make it unavailable either', async () => {
            state.chatId = 'chat-a.jsonl';
            chat.push({ name: 'Nova', mes: 'A message that arrived after the refusal.' });
            try {
                await click(roleplayOrigin('chat-a'));
                expect(dialogTitle()).toBe('Chat images');
                expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
                expect(toastr.info).not.toHaveBeenCalled();
            } finally { chat.length = 0; }
        });

        test('a locator that names no chat is explained', async () => {
            await click({ workspace: 'roleplay', account: 'alice', locator: {} });
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
        });
    });

    describe('a Conversation origin', () => {
        test('while another thread is open, switches to the origin thread by the rail\'s own path and then opens its dialog', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'bea.png', groupId: '' };
            await click(conversationOrigin());
            expect(selectConversationThread).toHaveBeenCalledTimes(1);
            expect(selectConversationThread).toHaveBeenCalledWith('ava.png', { groupId: null, showToast: false });
            expect(conversation.open).toEqual({ avatar: 'ava.png', groupId: '' });
            expect(shownPanels).toHaveLength(1);
            expect(dialogTitle()).toBe('Conversation images');
            expect(toastr.info).not.toHaveBeenCalled();
        });

        test('while a Roleplay chat is open (Conversation closed and not yet drawn), switches and opens the Conversation dialog', async () => {
            state.chatId = 'chat-b.jsonl';
            await click(conversationOrigin());
            expect(selectConversationThread).toHaveBeenCalledWith('ava.png', { groupId: null, showToast: false });
            expect(dialogTitle()).toBe('Conversation images');
            expect(scanned()).toEqual([]);
        });

        test('opens a group thread by its group id', async () => {
            conversation.groups.add('g-1');
            await click(conversationOrigin({ groupId: 'g-1', branchId: 'br_1', lifetimeSeed: 'seed-g', createdAt: '333' }));
            expect(selectConversationThread).toHaveBeenCalledWith('ava.png', { groupId: 'g-1', showToast: false });
            expect(dialogTitle()).toBe('Conversation images');
        });

        test('when the origin is the open thread and its branch is still active, opens the dialog without switching', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'ava.png', groupId: '' };
            await click(conversationOrigin());
            expect(selectConversationThread).not.toHaveBeenCalled();
            expect(dialogTitle()).toBe('Conversation images');
        });

        test.each([
            ['the origin branch no longer exists (another branch is active, and it is not that one)', { branchId: 'br_other' }],
            ['the branch was reset and has a new lifetimeSeed (the id was reused, the branch is a different one)', { lifetimeSeed: 'seed-old' }],
            ['the branch was reset and has a new createdAt (a job record has no lifetimeSeed)', { lifetimeSeed: undefined, createdAt: '999' }],
            ['the character is gone', { avatar: 'gone.png' }],
            ['the person changed persona', { personaId: 'other-persona.png' }],
            ['the group is gone', { groupId: 'g-gone' }],
        ])('%s: the unavailable explanation, no dialog, and no switch', async (_name, change) => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'bea.png', groupId: '' };
            await click(conversationOrigin(change));
            expect(shownPanels).toHaveLength(0);
            expect(selectConversationThread).not.toHaveBeenCalled();
            expect(conversation.open).toEqual({ avatar: 'bea.png', groupId: '' });
            expect(toastr.info).toHaveBeenCalledTimes(1);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
        });

        describe('a branch that still exists but is not the active one', () => {
            const anotherBranchIsActive = (avatar = 'ava.png') => {
                conversation.inactive[`${avatar}|`] = { main: conversation.branches[`${avatar}|`] };
                conversation.branches[`${avatar}|`] = { id: 'br_new', lifetimeSeed: 'seed-n', createdAt: 444, messages: [] };
            };

            test('gets its own explanation, no dialog and no switch, while another thread is open', async () => {
                body.classes.add('neconyan-conversation-active');
                conversation.open = { avatar: 'bea.png', groupId: '' };
                anotherBranchIsActive();
                await click(conversationOrigin());
                expect(shownPanels).toHaveLength(0);
                expect(selectConversationThread).not.toHaveBeenCalled();
                expect(conversation.open).toEqual({ avatar: 'bea.png', groupId: '' });
                expect(toastr.info).toHaveBeenCalledTimes(1);
                expect(toastr.info).toHaveBeenCalledWith(sentenceBranch);
                expect(toastr.error).not.toHaveBeenCalled();
            });

            test('the same when its thread is the open one, and it is not said to be unavailable', async () => {
                body.classes.add('neconyan-conversation-active');
                conversation.open = { avatar: 'ava.png', groupId: '' };
                anotherBranchIsActive();
                await click(conversationOrigin());
                expect(shownPanels).toHaveLength(0);
                expect(selectConversationThread).not.toHaveBeenCalled();
                expect(toastr.info.mock.calls.map(call => call[0])).toEqual([sentenceBranch]);
            });

            test('is found by its createdAt alone when the origin knows no lifetimeSeed (a job record)', async () => {
                anotherBranchIsActive();
                await click(conversationOrigin({ lifetimeSeed: undefined }));
                expect(toastr.info).toHaveBeenCalledWith(sentenceBranch);
                toastr.info.mockClear();
                // A branch with the same id but another createdAt is a different branch: the origin is gone.
                await click(conversationOrigin({ lifetimeSeed: undefined, createdAt: '999' }));
                expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
                expect(shownPanels).toHaveLength(0);
            });

            test('the same id with another lifetimeSeed is a different branch, so the origin is missing, not inactive', async () => {
                anotherBranchIsActive();
                await click(conversationOrigin({ lifetimeSeed: 'seed-old' }));
                expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
                expect(shownPanels).toHaveLength(0);
            });

            test('a branch that was deleted, with another one active, is missing: the unavailable explanation', async () => {
                conversation.branches['ava.png|'] = { id: 'br_new', lifetimeSeed: 'seed-n', createdAt: 444, messages: [] };
                await click(conversationOrigin());
                expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
                expect(toastr.info).not.toHaveBeenCalledWith(sentenceBranch);
                expect(shownPanels).toHaveLength(0);
                expect(selectConversationThread).not.toHaveBeenCalled();
            });

            test('a branch that is made inactive while the rail opens its thread gets the branch explanation, and a missing character the unavailable one', async () => {
                conversation.afterSwitch = () => anotherBranchIsActive();
                await click(conversationOrigin());
                expect(selectConversationThread).toHaveBeenCalledTimes(1);
                expect(shownPanels).toHaveLength(0);
                expect(toastr.info).toHaveBeenCalledWith(sentenceBranch);
                toastr.info.mockClear();
                await click(conversationOrigin({ avatar: 'gone.png' }));
                expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
                expect(shownPanels).toHaveLength(0);
            });
        });

        test('a message added to the origin branch after the refusal, an edit, a rename or a new unread count does not make it unavailable', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'bea.png', groupId: '' };
            const origin = conversationOrigin();
            Object.assign(conversation.branches['ava.png|'], { name: 'Renamed chat', unread: 3, updatedAt: 99999, preview: 'A newer preview',
                messages: [{ id: 'm1', role: 'user', mes: 'First, edited afterwards.' }, { id: 'm2', role: 'assistant', mes: 'Arrived after the refusal.' }] });
            await click(origin);
            expect(selectConversationThread).toHaveBeenCalledWith('ava.png', { groupId: null, showToast: false });
            expect(dialogTitle()).toBe('Conversation images');
            expect(toastr.info).not.toHaveBeenCalled();
            expect(toastr.error).not.toHaveBeenCalled();
        });

        test('the same when the origin thread is already open and a message arrives in it', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'ava.png', groupId: '' };
            conversation.branches['ava.png|'].messages.push({ id: 'm9', role: 'assistant', mes: 'Another message.' });
            await click(conversationOrigin());
            expect(selectConversationThread).not.toHaveBeenCalled();
            expect(dialogTitle()).toBe('Conversation images');
            expect(toastr.info).not.toHaveBeenCalled();
        });

        test('a branch that is the same one by its createdAt alone is accepted when the origin knows no lifetimeSeed', async () => {
            await click(conversationOrigin({ lifetimeSeed: undefined }));
            expect(dialogTitle()).toBe('Conversation images');
            expect(toastr.info).not.toHaveBeenCalled();
        });

        test('when the rail\'s path refuses, the explanation and no dialog; the open thread is left as it was', async () => {
            body.classes.add('neconyan-conversation-active');
            conversation.open = { avatar: 'bea.png', groupId: '' };
            conversation.switchResult = false;
            await click(conversationOrigin());
            expect(selectConversationThread).toHaveBeenCalledTimes(1);
            expect(shownPanels).toHaveLength(0);
            expect(conversation.open).toEqual({ avatar: 'bea.png', groupId: '' });
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
        });

        test('when the thread the rail opened is not the origin, or its branch changed on the way, the explanation and no dialog', async () => {
            conversation.afterSwitch = () => { conversation.open = { avatar: 'bea.png', groupId: '' }; };
            await click(conversationOrigin());
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
            toastr.info.mockClear();
            conversation.open = null;
            conversation.afterSwitch = () => { conversation.branches['ava.png|'] = { id: 'main', lifetimeSeed: 'seed-new', createdAt: 111, messages: [] }; };
            await click(conversationOrigin());
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledWith(sentenceGone);
        });
    });

    describe('another account', () => {
        test.each([
            ['Roleplay', roleplayOrigin('chat-a', 'nova.png', 'bob')],
            ['Conversation', { workspace: 'conversation', account: 'bob', avatar: 'ava.png', groupId: '', personaId: 'user.png', branchId: 'main', lifetimeSeed: 'seed-a', createdAt: '111' }],
        ])('a %s notice from another account gets the explanation, no dialog, no switch and no request', async (_name, origin) => {
            await click(origin);
            expect(shownPanels).toHaveLength(0);
            expect(selectConversationThread).not.toHaveBeenCalled();
            expect(requests).toEqual([]);
            expect(toastr.info).toHaveBeenCalledTimes(1);
            expect(toastr.info).toHaveBeenCalledWith(sentenceAccount);
        });

        test('the account is checked when the person clicks, so a notice raised before a switch of account is explained after it', async () => {
            ui.showImageChoiceNotice({ message: 'Late.', origin: roleplayOrigin('chat-a') });
            state.handle = 'bob';
            toastr.warning.mock.calls.at(-1)[2].onclick();
            await settle();
            expect(shownPanels).toHaveLength(0);
            expect(toastr.info).toHaveBeenCalledWith(sentenceAccount);
        });
    });

    describe('the explanations', () => {
        test('are toasts built with t on their exact keys, final text, and reach the page in the translated language', async () => {
            dictionary.set(sentenceGone, 'O chat deste aviso mudou ou já não existe.');
            dictionary.set(sentenceAccount, 'Este aviso é de outra conta.');
            dictionary.set(sentenceBranch, 'Este aviso refere-se a outro ramo.');
            await click(conversationOrigin({ avatar: 'gone.png' }));
            await click(roleplayOrigin('chat-a', 'nova.png', 'bob'));
            conversation.inactive['ava.png|'] = { main: conversation.branches['ava.png|'] };
            conversation.branches['ava.png|'] = { id: 'br_new', lifetimeSeed: 'seed-n', createdAt: 444, messages: [] };
            await click(conversationOrigin());
            expect(toastr.info.mock.calls.map(call => call[0])).toEqual(['O chat deste aviso mudou ou já não existe.', 'Este aviso é de outra conta.', 'Este aviso refere-se a outro ramo.']);
            expect(lookups).toContainEqual([sentenceGone, null]);
            expect(lookups).toContainEqual([sentenceAccount, null]);
            expect(lookups).toContainEqual([sentenceBranch, null]);
            // Each of the three notices and each of the three explanations marks its text final, title and message together.
            expect(marks.filter(([selector]) => selector === '.toast-message, .toast-title').length).toBe(6);
        });

        test('no dialog opens for either, and the error toast stays unused', async () => {
            await click(conversationOrigin({ avatar: 'gone.png' }));
            await click(roleplayOrigin('chat-a', 'nova.png', 'bob'));
            expect(shownPanels).toHaveLength(0);
            expect(toastr.error).not.toHaveBeenCalled();
        });
    });

    describe('an event with no origin', () => {
        test('opens the review for whatever is open, as before', async () => {
            state.chatId = 'chat-b.jsonl';
            await click(undefined);
            expect(dialogTitle()).toBe('Chat images');
            expect(scanned()).toEqual([{ group: false, chat: 'chat-b', avatar: 'nova.png' }]);
            body.classes.add('neconyan-conversation-active');
            conversation.branches['nova.png|'] = { id: 'main', lifetimeSeed: 's', createdAt: 1, messages: [] };
            await click({ workspace: 'elsewhere' });
            expect(dialogTitle()).toBe('Conversation images');
            expect(toastr.info).not.toHaveBeenCalled();
        });
    });

    describe('the throttle', () => {
        const shown = (reason, origin) => ui.showImageChoiceNotice({ message: reason, origin });

        test('treats the same reason from two different origins as two notices', () => {
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-b'))).toBe(true);
            expect(shown('Same reason.', conversationOrigin())).toBe(true);
            expect(shown('Same reason.', conversationOrigin({ avatar: 'bea.png' }))).toBe(true);
            expect(shown('Same reason.', conversationOrigin({ branchId: 'br_2' }))).toBe(true);
            expect(shown('Same reason.', conversationOrigin({ groupId: 'g-1' }))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-a', 'nova.png', 'bob'))).toBe(true);
            expect(shown('Same reason.', undefined)).toBe(true);
            expect(toastr.warning).toHaveBeenCalledTimes(8);
        });

        test('still shows one notice for one refusal: the same reason from the same origin within the window, however the other fields differ', () => {
            expect(shown('Same reason.', conversationOrigin())).toBe(true);
            now += 1000;
            expect(shown('Same reason.', conversationOrigin())).toBe(false);
            expect(shown('Same reason.', conversationOrigin({ lifetimeSeed: undefined, createdAt: '999' }))).toBe(false);
            expect(shown('  Same reason.  ', conversationOrigin())).toBe(false);
            expect(toastr.warning).toHaveBeenCalledTimes(1);
            expect(shown('Another reason.', conversationOrigin())).toBe(true);
        });

        test('remembers each origin, so a refusal from A, then B, then A again is still one notice for A', () => {
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-b'))).toBe(true);
            now += 1000;
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(false);
            expect(shown('Same reason.', roleplayOrigin('chat-b'))).toBe(false);
            now += 4000;
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-b'))).toBe(true);
            expect(toastr.warning).toHaveBeenCalledTimes(4);
        });

        test('two refusals with the same reason from two chats both show a notice, and each notice opens its own chat', async () => {
            const sameReason = 'An image changed after its choice was saved. Choose again for it in Review chat images.';
            const target = new EventTarget();
            listenForRefusals(target);
            const refuse = origin => target.dispatchEvent(new CustomEvent('neconyan:image-input-refused', { detail: { message: sameReason, origin } }));
            // A solo chat and a group chat, a second apart.
            refuse(roleplayOrigin('chat-a'));
            now += 1000;
            refuse({ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'Group one' } });
            expect(toastr.warning).toHaveBeenCalledTimes(2);
            // The same reason from the same chat again is still one notice.
            now += 1000;
            refuse(roleplayOrigin('chat-a'));
            refuse({ workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'Group one' } });
            expect(toastr.warning).toHaveBeenCalledTimes(2);
            state.chatId = 'unrelated-chat.jsonl';
            for (const index of [1, 0]) { toastr.warning.mock.calls[index][2].onclick(); await settle(); await settle(); }
            expect(scanned()).toEqual([{ group: true, chat: 'Group one' }, { group: false, chat: 'chat-a', avatar: 'nova.png' }]);
            expect(shownPanels).toHaveLength(2);
        });

        test('a second chat of the same character is a different origin: the chat is part of the identity', () => {
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-a-2'))).toBe(true);
            expect(shown('Same reason.', roleplayOrigin('chat-a'))).toBe(false);
            expect(toastr.warning).toHaveBeenCalledTimes(2);
        });

        test('the page listener carries the origin of the event into the notice\'s click', async () => {
            const target = new EventTarget();
            listenForRefusals(target);
            state.chatId = 'chat-b.jsonl';
            target.dispatchEvent(new CustomEvent('neconyan:image-input-refused', { detail: { message: 'From the listener.', origin: roleplayOrigin('chat-a') } }));
            toastr.warning.mock.calls.at(-1)[2].onclick();
            await settle(); await settle();
            expect(scanned()).toEqual([{ group: false, chat: 'chat-a', avatar: 'nova.png' }]);
        });
    });
});

describe('the account choice announces that a setting changed', () => {
    test('saving it announces once; a save that fails restores the old value and still announces', async () => {
        power_user.neconyan_prompt_media = { version: 1, images: 'include' };
        await ui.setAccountChoice(true);
        expect(power_user.neconyan_prompt_media).toEqual({ version: 1, images: 'display-only' });
        expect(settingsEvents()).toHaveLength(1);
        state.saved = false;
        await expect(ui.setAccountChoice(false)).rejects.toThrow('Your setting was not saved. Try again.');
        expect(power_user.neconyan_prompt_media).toEqual({ version: 1, images: 'display-only' });
        expect(settingsEvents()).toHaveLength(2);
        delete power_user.neconyan_prompt_media;
        await expect(ui.setAccountChoice(true)).rejects.toThrow();
        expect(power_user.neconyan_prompt_media).toBeUndefined();
        expect(settingsEvents()).toHaveLength(3);
    });

    test('switching accounts while it saves is reported, and announced', async () => {
        saveSettings.mockImplementationOnce(async () => { state.handle = 'bob'; return true; });
        await expect(ui.setAccountChoice(true)).rejects.toThrow('You switched accounts, so the setting was not saved.');
        expect(settingsEvents()).toHaveLength(1);
    });
});

describe('the Conversation dialog announces a saved branch choice', () => {
    test('toggling the branch checkbox announces once after the save has been written', async () => {
        body.classes.add('neconyan-conversation-active');
        await ui.showPromptMediaReview();
        const panel = shownPanels[0];
        const rows = panel.children.filter(child => child.tag === 'label');
        const branchRow = rows.find(row => row.children[1]?.textContent === 'Don\'t send this branch\'s images to the model');
        expect(branchRow).toBeTruthy();
        const input = branchRow.children[0];
        input.checked = true;
        events.length = 0;
        await input.listeners.change[0]();
        expect(branch.neconyan_prompt_media).toEqual({ version: 1, images: 'display-only' });
        expect(flushConversationStore).toHaveBeenCalledTimes(2);
        expect(settingsEvents()).toHaveLength(1);
        expect(toastr.success).toHaveBeenCalledWith('Choice saved.');
        // A save that does not reach the server restores the branch and announces nothing.
        flushConversationStore.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        input.checked = false;
        events.length = 0;
        await input.listeners.change[0]();
        expect(settingsEvents()).toHaveLength(0);
        expect(branch.neconyan_prompt_media).toEqual({ version: 1, images: 'display-only' });
        expect(toastr.error).toHaveBeenCalledWith('Your choice was not saved. Try again.');
    });

    test('the account checkbox in the Conversation dialog goes through the same announcement', async () => {
        body.classes.add('neconyan-conversation-active');
        await ui.showPromptMediaReview();
        const accountRow = shownPanels[0].children.find(child => child.tag === 'label' && child.children[1]?.textContent === 'Don\'t send chat images to the model');
        accountRow.children[0].checked = true;
        events.length = 0;
        await accountRow.children[0].listeners.change[0]();
        expect(settingsEvents()).toHaveLength(1);
    });
});

describe('the Roleplay dialog announces a saved chat choice', () => {
    test('toggling the chat checkbox announces after the chat has been saved and read back', async () => {
        state.chatId = 'chat-1.jsonl';
        state.group = null;
        const responses = [];
        globalThis.fetch = jest.fn(async (url, options) => {
            const request = JSON.parse(options.body);
            responses.push([url.split('/').pop(), request]);
            const locator = request.locator ?? { group: false, chat: 'chat-1', avatar: 'nova.png' };
            return { ok: true, json: async () => ({ observation: { locator }, total: 0, limited: false, issues: [], chatPreference: undefined, next: null }), blob: async () => new Blob([]) };
        });
        await ui.showPromptMediaReview();
        await settle();
        await settle();
        const panel = shownPanels[0];
        // The chat checkbox is built by showChat once the scan has answered.
        const content = panel.children.at(-1);
        const chatRow = content.children.find(child => child.tag === 'label' && child.children[1]?.textContent === 'Don\'t send this chat\'s images to the model');
        expect(chatRow).toBeTruthy();
        events.length = 0;
        chatRow.children[0].checked = true;
        await chatRow.children[0].listeners.change[0]();
        await settle();
        expect(responses.map(([action]) => action)).toContain('apply');
        const applied = responses.find(([action]) => action === 'apply')[1];
        expect(applied.chatPreference).toEqual({ version: 1, images: 'display-only' });
        expect(refreshCurrentChatFromSaved).toHaveBeenCalled();
        expect(settingsEvents()).toHaveLength(1);
        delete globalThis.fetch;
    });
});
