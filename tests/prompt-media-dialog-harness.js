/* global globalThis */
import { readFileSync } from 'node:fs';
import { assembleLocaleData, tableForKey } from '../public/scripts/locale-assembly.js';
import { elements, installDocument, settle } from './prompt-media-dom-stub.js';

// Loads the real public/scripts/prompt-media-ui.js and prompt-media-labels.js against stand-ins for the app they import and for the
// browser objects they use. The lookup stand-ins read the same two tables the page's translate() reads (a scoped key from the scoped
// table, any other key from the matching dictionary), so a test can use the real pt-pt files as the page assembles them.

const readJson = file => JSON.parse(readFileSync(new URL(`../public/locales/${file}`, import.meta.url), 'utf8'));
/** The dictionary and scoped table the page builds for a language, from the real base, supplement and catalogue files. */
export const assembled = language => assembleLocaleData({ base: readJson(`${language}.json`), supplement: readJson(`neconyan/${language}.json`), catalogue: readJson('neconyan/en.json') });

export async function loadDialog(jest) {
    const env = {
        dictionary: {}, scoped: {}, lookups: [], chatId: null, handle: 'alice', saved: true, group: null, chid: 0, avatars: [{ avatar: 'Group.png' }],
        branch: undefined, confirmResult: 1, popupResult: true, shownPanels: [], confirmations: [], popups: [], events: [], toasts: [], marks: [],
        requests: [], routes: {}, power_user: {}, chat: [], workerPosts: [],
    };
    // The page's own translate() and t``, over the tables above.
    const translate = (text, key = null) => {
        env.lookups.push([text, key]);
        const lookupKey = key || text;
        return tableForKey(lookupKey, env.dictionary, env.scoped)?.[lookupKey] || text;
    };
    const t = (strings, ...values) => {
        const key = strings.reduce((text, part, index) => text + part + (values[index] !== undefined ? `\${${index}}` : ''), '');
        return translate(key).replace(/\$\{(\d+)\}/g, (_, index) => values[index]);
    };
    env.use = language => { ({ dictionary: env.dictionary, scoped: env.scoped } = language ? assembled(language) : { dictionary: {}, scoped: {} }); };
    env.translate = translate;

    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t, translate }));
    const saveSettings = jest.fn(async () => env.saved), saveChatConditional = jest.fn(async () => true), refreshCurrentChatFromSaved = jest.fn(async () => {});
    await jest.unstable_mockModule('../public/script.js', () => ({
        chat: env.chat, characters: env.avatars, get this_chid() { return env.chid; }, getCurrentChatId: () => env.chatId,
        getRequestHeaders: () => ({}), saveSettings, saveChatConditional, refreshCurrentChatFromSaved,
    }));
    await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: env.power_user }));
    await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ get selected_group() { return env.group; } }));
    await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => env.handle }));
    await jest.unstable_mockModule('../public/scripts/roleplay-save-chain.js', () => ({ roleplayAccountStamp: () => ({ account: { accountId: 'a-1' } }) }));
    await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
        POPUP_TYPE: { TEXT: 'text', CONFIRM: 'confirm' },
        Popup: class {
            constructor(content, type, input, options = {}) { this.content = content; this.type = type; this.options = options; env.popups.push(this); }
            async show() { env.shownPanels.push(this.content); return env.popupResult; }
            static show = { confirm: async (header, content) => { env.confirmations.push({ header, content }); return env.confirmResult; } };
        },
    }));
    env.branchData = { id: 'main', lifetimeSeed: 's', messages: [], neconyan_prompt_media: undefined };
    const persistConversationStore = jest.fn(), flushConversationStore = jest.fn(async () => true);
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
        getCurrentCharAvatar: () => 'nova.png', getActiveConversationBranch: () => env.branch === undefined ? env.branchData : env.branch, persistConversationStore,
    }));
    await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ flushConversationStore }));
    await jest.unstable_mockModule('../public/scripts/prompt-media-client.js', () => ({
        promptAttachmentHash: value => JSON.stringify(value), generatedImagePromptPolicy: (item, mode) => ({ neconyan_prompt: { version: 1, mode } }),
    }));
    Object.assign(env, { saveSettings, saveChatConditional, refreshCurrentChatFromSaved, persistConversationStore, flushConversationStore });

    env.page = installDocument();
    const toastr = Object.fromEntries(['success', 'info', 'warning', 'error'].map(kind => [kind, jest.fn(message => {
        env.toasts.push([kind, message]);
        return { find: selector => ({ attr: (name, value) => env.marks.push({ kind, message, selector, name, value }) }) };
    })]));
    globalThis.toastr = toastr; env.toastr = toastr;
    globalThis.dispatchEvent = event => { env.events.push(event); return true; };
    globalThis.location = { origin: 'http://localhost' };
    // The Roleplay image routes. A route returns its JSON, or { failure: { status, body } } for a refusal.
    globalThis.fetch = async (url, options) => {
        const action = String(url).split('/api/roleplay/images/')[1];
        const body = JSON.parse(options.body);
        env.requests.push({ action, body });
        const result = await (env.routes[action] ?? (() => ({})))(body);
        if (result?.failure) return { ok: false, status: result.failure.status ?? 409, json: async () => result.failure.body };
        return { ok: true, json: async () => result, blob: async () => new Blob([JSON.stringify(result)]) };
    };
    // The conversion worker: it answers with what a test sets, as the real one answers its caller.
    globalThis.Worker = class {
        constructor() { env.worker = this; }
        postMessage() { queueMicrotask(() => this.onmessage?.({ data: env.workerAnswer })); }
        terminate() {}
    };

    env.ui = await import('../public/scripts/prompt-media-ui.js');
    env.labels = await import('../public/scripts/prompt-media-labels.js');
    env.reset = () => {
        env.lookups.length = 0; env.shownPanels.length = 0; env.confirmations.length = 0; env.popups.length = 0; env.events.length = 0; env.toasts.length = 0;
        env.marks.length = 0; env.requests.length = 0; env.routes = {}; env.chatId = null; env.handle = 'alice'; env.saved = true; env.group = null; delete env.branch;
        env.confirmResult = 1; env.popupResult = true; env.dictionary = {}; env.scoped = {}; env.branchData.messages = []; env.branchData.neconyan_prompt_media = undefined;
        for (const key of Object.keys(env.power_user)) delete env.power_user[key];
        env.page = installDocument();
    };
    /**
     * Opens the Roleplay dialog on a chat and returns its pieces once the first list has been built. showPromptMediaReview takes only the
     * origin of a refusal, so the chat is made the open one first (and no chat is open when target is null).
     */
    env.open = async target => {
        env.chatId = target ? target.chat : null;
        env.group = target?.group ? 'group-1' : null;
        if (target && !target.group) env.avatars.splice(0, env.avatars.length, { avatar: target.avatar });
        await env.ui.showPromptMediaReview();
        await settle();
        const panel = env.shownPanels[0];
        return { panel, content: panel.children.at(-1), navigation: panel.children.at(-2), status: elements(panel, node => node.attributes.role === 'status')[0] };
    };
    return env;
}

export const scanIssue = (overrides = {}) => ({
    index: 0, swipe: null, mediaIndex: 0, identity: 'id-0', status: 'saved-reference', mode: 'include', hasPromptCopy: false, title: '', descriptionAvailable: false,
    sources: { 'media-title': false, 'message-title': false }, actions: ['display-only', 'caption', 'include', 'detach'], ...overrides,
});
export const scanResult = (issues, target = { group: false, chat: 'Review', avatar: 'Group.png' }, overrides = {}) => ({
    observation: { locator: target }, total: issues.length, listed: issues.length, limited: false, offset: 0, chatPreference: null, issues, next: null, ...overrides,
});
