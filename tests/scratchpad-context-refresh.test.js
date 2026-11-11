import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';
import { sameSourceBucket, sameSourceContext } from '../public/scripts/scratchpad/source.js';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const functions = ['activeSession', 'allAssistants', 'currentSettings', 'applyBucket', 'render', 'contextKey', 'renderContext', 'renderNotes', 'checkSource'];
const code = functions.map(name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0]).join('\n');
const defaults = { notes: [], picked: [], include: {}, assistantConnections: {}, depth: 15, maxTokens: 16000 };
const ref = id => ({ notebookId: 'book', noteId: id });

class Element {
    constructor(tag, attributes = {}, children = []) {
        this.tag = tag;
        this.attributes = attributes;
        this.children = [];
        this.parent = null;
        this.root = false;
        this.append(...children);
    }
    get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
    get childElementCount() { return this.children.length; }
    get textContent() { return [this.attributes.text || '', ...this.children.map(child => child.textContent)].join(' '); }
    append(...children) {
        for (const child of children.flat(Infinity).filter(Boolean)) {
            child.parent = this;
            this.children.push(child);
        }
    }
    replaceChildren(...children) {
        for (const child of this.children) child.parent = null;
        this.children = [];
        this.append(...children);
    }
    find(className) {
        return this.children.flatMap(child => [
            ...(child.attributes.class?.split(' ').includes(className) ? [child] : []), ...child.find(className),
        ]);
    }
}

function fixture() {
    const panel = new Element('div');
    panel.root = true;
    const requests = [];
    const scope = { kind: 'roleplay', key: 'chat' };
    const preset = { name: 'Lantern' };
    const app = { built: true, open: true, tab: 'context', source: scope, bucket: null, contextKey: '', ticket: 1,
        library: { assistants: [] }, el: { panels: { context: panel } } };
    const h = (tag, attributes, ...children) => new Element(tag, attributes, children);
    const runtime = vm.createContext({ app, structuredClone, DEFAULT_SETTINGS: defaults, ASSISTANTS: [],
        h, append: (element, children) => element.append(children), clear: element => element.replaceChildren(),
        t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
        renderHeader() {}, renderChat() {}, renderSessions() {}, syncDraft() {}, syncWatchers() {},
        rememberedConnections: () => ({}), connectionProfiles: () => [],
        checkbox: () => h('label'), presetCheckbox: () => h('label', { text: `Current preset: ${preset.name}` }),
        currentPresetName: () => preset.name, renderPicks: () => h('section'), renderLore: () => h('section'), renderPreview: () => h('section'),
        iconButton: (text, onclick) => h('button', { text, onclick }), wireSource: value => value,
        renderWebSearchSettings: () => h('section', { class: 'scratchpad-web-settings' }),
        renderContextSetups: () => h('section', { class: 'scratchpad-setups' }),
        sameSourceBucket, sameSourceContext, currentSource: () => app.source, stopWatchers() {},
        isCurrentSource: value => sameSourceContext(value, app.source),
        api: { readNotebookContext: (_source, sessionId) => new Promise((resolve, reject) => requests.push({ sessionId, resolve, reject })) },
    });
    vm.runInContext(code, runtime);
    const bucket = (notes, sessionId = 'one') => ({ source: scope, activeSessionId: sessionId, limits: { notes: 12 },
        sessions: [{ id: sessionId, assistant: 'miso', settings: { ...structuredClone(defaults), notes }, messages: [] }] });
    const apply = (notes, sessionId = 'one', options) => runtime.applyBucket(bucket(notes, sessionId), options);
    const rows = () => panel.find('scratchpad-note').map(row => row.textContent);
    const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
    const reply = (request, notes) => request.resolve({ notes: notes.map(reference => ({ reference, title: reference.noteId, nextOffset: null })) });
    return { app, panel, preset, requests, runtime, apply, rows, settle, reply };
}

function imageJobFixture({ markers = [], card } = {}) {
    const observers = [];
    const reload = jest.fn(async () => {});
    const approveImagePrompt = jest.fn();
    const app = {
        open: true, foldedThinking: new Set(), openSwipes: new Set(), watchers: new Map(), previews: new Map(), imageWatchers: new Map(),
        imageJobs: new Map(), imageJobSignatures: new Map(), imageAutoReviews: new Set(markers),
        bucket: { sessions: [{ messages: [{ role: 'assistant', state: 'done', images: { 0: { state: 'pending', jobId: 'image-job' } } }] }] },
    };
    const runtime = vm.createContext({ app, reload, updateStream: jest.fn(),
        TERMINAL: new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']),
        imageReviewCard: () => card, approveImagePrompt,
        observeJob: (id, options) => { observers.push({ id, options }); return () => {}; }, api: { watchReply: () => () => {} } });
    vm.runInContext(source.match(/^function syncWatchers\([\s\S]*?^}/m)[0], runtime);
    runtime.syncWatchers();
    return { app, observers, reload, approveImagePrompt };
}

describe('Scratchpad Context refresh lifecycle', () => {
    test('both Home visibility events check the live source after visibility changes, only while open', () => {
        const listeners = new Map();
        const tasks = [];
        const checkSource = jest.fn();
        const app = { open: true };
        const runtime = vm.createContext({ app, checkSource, queueMicrotask: task => tasks.push(task),
            globalThis: { addEventListener: (name, listener) => listeners.set(name, listener) } });
        vm.runInContext(source.match(/^function wireHomeSourceEvents\([\s\S]*?^}/m)[0], runtime);
        runtime.wireHomeSourceEvents();
        expect([...listeners.keys()]).toEqual(['neconyan:navigate-home', 'neconyan:home-hidden']);
        for (const listener of listeners.values()) listener();
        expect(checkSource).not.toHaveBeenCalled();
        for (const task of tasks.splice(0)) task();
        expect(checkSource).toHaveBeenCalledTimes(2);
        app.open = false;
        for (const listener of listeners.values()) listener();
        for (const task of tasks) task();
        expect(checkSource).toHaveBeenCalledTimes(2);
    });
    test('an unchanged image job poll does not redraw the thread', async () => {
        const { observers, reload } = imageJobFixture();
        expect(observers).toHaveLength(1);
        // onSnapshot fires on every poll; only onUpdate and onDone may redraw.
        expect(observers[0].options.onSnapshot).toBeUndefined();
        const job = { id: 'image-job', state: 'running', stage: 'generating' };
        await observers[0].options.onUpdate(job);
        expect(reload).toHaveBeenCalledTimes(1);
        await observers[0].options.onUpdate({ ...job });
        expect(reload).toHaveBeenCalledTimes(1);
        await observers[0].options.onUpdate({ ...job, stage: 'approval', result: { approval: { id: 'a1' } } });
        expect(reload).toHaveBeenCalledTimes(2);
        await observers[0].options.onDone({ ...job, state: 'completed' });
        expect(reload).toHaveBeenCalledTimes(3);
    });
    test('a requested prompt review opens when its approval appears, and only once', async () => {
        const card = { session: { id: 'session' }, message: { id: 'reply' }, part: { index: 0 } };
        const { app, observers, approveImagePrompt } = imageJobFixture({ markers: ['image-job'], card });
        await observers[0].options.onUpdate({ id: 'image-job', state: 'running', stage: 'generating' });
        expect(approveImagePrompt).not.toHaveBeenCalled();
        expect(app.imageAutoReviews.has('image-job')).toBe(true);
        const waiting = { id: 'image-job', state: 'waiting', stage: 'approval', result: { approval: { id: 'a1' } } };
        await observers[0].options.onUpdate(waiting);
        expect(approveImagePrompt).toHaveBeenCalledTimes(1);
        expect(approveImagePrompt).toHaveBeenCalledWith(card.session, card.message, card.part);
        expect(app.imageAutoReviews.has('image-job')).toBe(false);
        await observers[0].options.onUpdate({ ...waiting });
        expect(approveImagePrompt).toHaveBeenCalledTimes(1);
    });
    test('an approval this client never asked to review stays manual', async () => {
        const card = { session: { id: 'session' }, message: { id: 'reply' }, part: { index: 0 } };
        const { observers, approveImagePrompt } = imageJobFixture({ card });
        await observers[0].options.onUpdate({ id: 'image-job', state: 'waiting', stage: 'approval', result: { approval: { id: 'a1' } } });
        expect(approveImagePrompt).not.toHaveBeenCalled();
        const inactive = imageJobFixture({ markers: ['image-job'], card: null });
        await inactive.observers[0].options.onUpdate({ id: 'image-job', state: 'waiting', stage: 'approval', result: { approval: { id: 'a1' } } });
        expect(inactive.approveImagePrompt).not.toHaveBeenCalled();
        expect(inactive.app.imageAutoReviews.has('image-job')).toBe(true);
    });
    test('rapid General/chat/General switching restores drafts and ignores a delayed chat bucket', async () => {
        const general = { kind: 'general', key: 'general', personaId: 'User.png' };
        const chat = { kind: 'roleplay', key: 'chat' };
        const bucket = (source, id) => ({ source, activeSessionId: id, sessions: [{ id, messages: [] }] });
        const app = { source: general, bucket: bucket(general, 'general-session'), ticket: 0, contextKey: '', tab: 'chat', openSwipes: new Set(),
            openMenus: new Set(), openMenusSessionId: '', drafts: new Map(), attachments: [{ name: 'general.txt' }], attachmentDrafts: new Map(),
            draftOwner: 'first', draftKey: JSON.stringify(['general', 'general', 'general-session']), el: { composer: { value: 'GENERAL-DRAFT' } } };
        let owner = 'first';
        let live = general;
        const requests = [];
        const runtime = vm.createContext({ app, sameSourceBucket, sameSourceContext, PICK_PAGE: 30,
            currentSource: () => live, getCurrentUserHandle: () => owner, stopWatchers() {}, syncWatchers() {}, closeComposeMenu() {}, reportError: error => { throw error; },
            t: parts => parts.join(''), api: { readBucket: source => new Promise(resolve => requests.push({ source, resolve })) }, wireSource: value => value,
            render() { runtime.syncDraft(); },
        });
        const names = ['activeSession', 'syncDraft', 'applyBucket', 'checkSource', 'reload'];
        vm.runInContext(names.map(name => source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0]).join('\n'), runtime);
        live = chat;
        runtime.checkSource();
        expect(app.el.composer.value).toBe('');
        expect(app.attachments).toEqual([]);
        live = general;
        runtime.checkSource();
        requests[0].resolve({ bucket: bucket(chat, 'chat-session') });
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(app.bucket).toBeNull();
        requests[1].resolve({ bucket: bucket(general, 'general-session') });
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(app.el.composer.value).toBe('GENERAL-DRAFT');
        expect(app.attachments).toEqual([{ name: 'general.txt' }]);
        expect(app.bucket.source.kind).toBe('general');
        live = { ...general, avatar: 'Nova.png', personaId: 'Other.png' };
        runtime.checkSource();
        expect(app.el.composer.value).toBe('GENERAL-DRAFT');
        expect(app.bucket.activeSessionId).toBe('general-session');
        expect(app.source).toBe(live);
        owner = 'second';
        runtime.syncDraft({ carry: true });
        expect(app.attachments).toEqual([]);
        expect(app.el.composer.value).toBe('');
        expect(app.attachmentDrafts.size).toBe(0);
        expect(app.drafts.size).toBe(0);
    });
    test('General card and persona changes redraw context without replacing its list or draft, rejecting delayed old notes', async () => {
        const f = fixture();
        f.app.source = { kind: 'general', key: 'general', avatar: 'Nova.png', personaId: 'User.png' };
        f.runtime.applyBucket({ source: f.app.source, activeSessionId: 'one', limits: { notes: 12 }, sessions: [{ id: 'one', settings: { ...defaults, notes: [ref('old')] }, messages: [] }] });
        const bucket = f.app.bucket;
        const stale = f.requests[0];
        const original = f.panel.children[1];
        f.app.source = { ...f.app.source, avatar: 'Kit.png', personaId: 'Other.png' };
        f.runtime.render();
        expect(f.panel.children[1]).not.toBe(original);
        expect(f.app.bucket).toBe(bucket);
        expect(f.panel.textContent).toContain('No story chat is open');
        expect(f.panel.textContent).not.toContain('Current preset:');
        f.reply(f.requests[1], [ref('current')]);
        f.reply(stale, [ref('obsolete')]);
        await f.settle();
        expect(f.panel.textContent).toContain('current');
        expect(f.panel.textContent).not.toContain('obsolete');
    });
    test.each(['session first', 'notes first'])('redraws changed shared notes with %s', async order => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        if (order === 'notes first') { f.reply(stale, [ref('old')]); await f.settle(); }
        f.apply([ref('old'), ref('new')]);
        expect(f.requests).toHaveLength(2);
        f.reply(f.requests[1], [ref('old'), ref('new')]);
        await f.settle();
        if (order === 'session first') { f.reply(stale, [ref('obsolete')]); await f.settle(); }
        expect(f.rows()).toHaveLength(2);
        expect(f.panel.textContent).toContain('new');
        expect(f.panel.textContent).not.toContain('obsolete');
        expect(f.panel.textContent).not.toContain('Checking shared notes');
        expect(f.app.bucket.sessions[0].settings.notes).toEqual([ref('old'), ref('new')]);
    });

    test.each(['resolve', 'reject'])('ignores a stale note %s after switching sessions', async result => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        f.apply([ref('current')], 'two');
        f.reply(f.requests[1], [ref('current')]);
        await f.settle();
        if (result === 'resolve') f.reply(stale, [ref('obsolete')]);
        else stale.reject(new Error('Obsolete oversize error'));
        await f.settle();
        expect(f.rows()).toHaveLength(1);
        expect(f.panel.textContent).toContain('current');
        expect(f.panel.textContent).not.toContain('Obsolete');
        expect(f.panel.textContent).not.toContain('obsolete');
        expect(f.app.bucket.activeSessionId).toBe('two');
    });

    test('redraws same-length replacements and pages, but preserves unchanged Context controls', () => {
        const f = fixture();
        f.apply([ref('old')]);
        const originalPanel = f.panel.children[1];
        f.apply([ref('old')]);
        expect(f.requests).toHaveLength(1);
        expect(f.panel.children[1]).toBe(originalPanel);
        f.apply([ref('new')]);
        expect(f.requests).toHaveLength(2);
        f.apply([{ ...ref('new'), offset: 24000 }]);
        expect(f.requests).toHaveLength(3);
    });

    test('redraws the Current preset label when the chat switches presets', () => {
        const f = fixture();
        f.apply([]);
        const originalPanel = f.panel.children[1];
        expect(f.panel.textContent).toContain('Current preset: Lantern');
        f.runtime.render();
        expect(f.panel.children[1]).toBe(originalPanel);
        f.preset.name = 'Ember';
        f.runtime.render();
        expect(f.panel.children[1]).not.toBe(originalPanel);
        expect(f.panel.textContent).toContain('Current preset: Ember');
        expect(f.panel.textContent).not.toContain('Lantern');
    });

    test('redraws empty and populated lists and rejects an outdated bucket ticket', async () => {
        const f = fixture();
        f.apply([]);
        f.apply([ref('new')]);
        expect(f.requests).toHaveLength(1);
        const stale = f.requests[0];
        f.apply([ref('obsolete')], 'one', { ticket: 0 });
        expect(f.requests).toHaveLength(1);
        f.apply([]);
        f.reply(stale, [ref('obsolete')]);
        await f.settle();
        expect(f.rows()).toEqual([]);
        expect(f.panel.textContent).toContain('No saved notes are shared');
        expect(f.panel.textContent).not.toContain('obsolete');
    });

    test('keeps current oversize references removable and rejects a stale error after recovery', async () => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        f.apply([ref('old'), { ...ref('temporary'), grantId: 'grant' }]);
        f.requests[1].reject(new Error('Share fewer notes or choose a section before sending.'));
        await f.settle();
        expect(f.rows()).toHaveLength(2);
        expect(f.panel.textContent).toContain('Remove');
        expect(f.panel.textContent).toContain('Stop sharing');
        stale.reject(new Error('Obsolete error'));
        await f.settle();
        expect(f.panel.textContent).not.toContain('Obsolete error');
        f.apply([ref('old')]);
        f.reply(f.requests[2], [ref('old')]);
        await f.settle();
        expect(f.rows()).toHaveLength(1);
        expect(f.panel.find('scratchpad-error')).toHaveLength(0);
    });

    test('preserves open message menus across same-session settings saves without carrying them to closed or other sessions', async () => {
        const list = new Element('div');
        list.root = true;
        list.scrollHeight = 100;
        list.scrollTop = 100;
        list.clientHeight = 100;
        list.querySelectorAll = selector => selector === '.scratchpad-message-menu' ? list.find('scratchpad-message-menu') : [];
        const scope = { kind: 'roleplay', key: 'chat' };
        const messages = [
            { id: 'user-1', role: 'user', text: 'Now explain the next step.' },
            { id: 'reply-1', role: 'assistant', state: 'done', assistant: 'taro', text: 'random-taro answers in one reply.' },
        ];
        const session = (id = 'one', participants = ['taro']) => ({
            id,
            assistant: 'miso',
            settings: { ...structuredClone(defaults), roundTable: true, randomReply: true, participants },
            messages: structuredClone(messages),
        });
        const bucket = (sessions = [session()], activeSessionId = sessions[0]?.id ?? '') => ({ source: scope, activeSessionId, sessions });
        const app = {
            built: true,
            open: true,
            tab: 'chat',
            assistant: 'miso',
            source: scope,
            bucket: bucket(),
            ticket: 1,
            sending: false,
            editing: '',
            contextKey: '',
            pickLimit: 30,
            openSwipes: new Set(),
            openMenus: new Set(),
            openMenusSessionId: '',
            foldedThinking: new Set(),
            previews: new Map(),
            queue: Promise.resolve(),
            library: { assistants: [] },
            el: { root: {}, messages: list, summary: new Element('div'), composer: { value: '' } },
        };
        const updates = [];
        const node = (tag, attributes = {}, ...children) => {
            const element = new Element(tag, attributes, children);
            element.listeners = new Map();
            element.open = Boolean(attributes.open);
            element.dataset = { ...(attributes.dataset ?? {}) };
            element.addEventListener = (type, listener) => element.listeners.set(type, listener);
            element.querySelector = selector => selector === 'summary' ? element.children[0] : null;
            element.closest = selector => {
                for (let cur = element; cur; cur = cur.parent) {
                    if (selector === '[data-message-id]' && cur.dataset?.messageId) return cur;
                }
                return null;
            };
            return element;
        };
        const runtime = vm.createContext({
            app,
            structuredClone,
            DEFAULT_SETTINGS: defaults,
            ASSISTANTS: [{ id: 'miso', name: 'Miso' }, { id: 'taro', name: 'Taro' }],
            PICK_PAGE: 30,
            h: node,
            append: (element, children) => element.append(children),
            clear: element => element.replaceChildren(),
            t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
            sameSourceBucket,
            sameSourceContext,
            isCurrentSource: value => sameSourceContext(value, app.source),
            currentSource: () => app.source,
            wireSource: value => value,
            sourceUserName: () => 'User',
            assistantInfo: id => ({ id, name: id }),
            assistantPortrait: id => `${id}.png`,
            sessionAssistants: current => current?.settings.roundTable ? current.settings.participants : ['miso'],
            randomReplyEnabled: () => true,
            pendingReply: () => null,
            contextSummary: () => 'Reading the latest 15 messages',
            updateMessageTokenCounts() {},
            renderReply: (_session, message) => node('div', { class: 'scratchpad-reply', text: message.text }),
            renderWebSearchSources: () => null,
            renderWebPages: () => null,
            renderReplySwipes: () => null,
            installReplySwipeGesture() {},
            renderAttachments: () => [],
            closeComposeMenu() {},
            renderMessageActions: () => node('div', { class: 'scratchpad-message-actions' }, node('button', { title: 'Try again' })),
            renderHeader() {},
            renderOverview() {},
            renderComposer() {},
            renderContext() {},
            renderSessions() {},
            syncDraft() {},
            syncWatchers() {},
            stopWatchers() {},
            stopReadAloud() {},
            roundToDiscuss: () => [],
            setNotebookSource() {},
            applyLayout() {},
            clearInterval() {},
            scrollMessages() {},
            iconButton: (text, onclick, options = {}) => node('button', { text, onclick, title: options.title }),
            reportError: error => { throw error; },
            api: {
                updateSession: (_source, sessionId, changes) => new Promise(resolve => updates.push({ sessionId, changes, resolve })),
            },
        });
        const messageFns = ['activeSession', 'currentSettings', 'nearBottom', 'applyBucket', 'render', 'renderChat', 'renderMessages', 'renderMessage', 'requireScope', 'change', 'updateSettings', 'checkSource', 'hideScratchpad'];
        vm.runInContext(messageFns.map(name => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '')).join('\n'), runtime);

        const menus = () => list.find('scratchpad-message-menu');
        runtime.renderMessages();
        expect(menus().map(menu => menu.open)).toEqual([false, false]);

        const firstReplyMenu = menus()[1];
        firstReplyMenu.open = true;
        firstReplyMenu.attributes.ontoggle({ currentTarget: firstReplyMenu });
        expect(app.openMenus.has('reply-1')).toBe(true);

        const pendingSave = runtime.updateSettings({ participants: ['taro', 'miso'] });
        await Promise.resolve();
        expect(updates).toHaveLength(1);
        updates[0].resolve({ bucket: bucket([session('one', ['taro', 'miso'])]) });
        await pendingSave;
        expect(menus()[1]).not.toBe(firstReplyMenu);
        expect(menus().map(menu => menu.open)).toEqual([false, true]);

        // A delayed toggle event from a detached old menu must not mutate openMenus after rerender.
        expect(firstReplyMenu.isConnected).toBe(false);
        firstReplyMenu.open = false;
        firstReplyMenu.attributes.ontoggle({ currentTarget: firstReplyMenu });
        expect(app.openMenus.has('reply-1')).toBe(true);
        runtime.applyBucket(bucket([session('one', ['taro', 'miso'])]));
        expect(menus().map(menu => menu.open)).toEqual([false, true]);

        // A synchronous DOM open/close before the deferred toggle event fires is captured by same-session rerender.
        menus()[0].open = true;
        menus()[1].open = false;
        runtime.applyBucket(bucket([session('one', ['taro'])]));
        expect(menus().map(menu => menu.open)).toEqual([true, false]);
        menus()[0].open = false;
        menus()[0].attributes.ontoggle({ currentTarget: menus()[0] });

        // Closing the menu by toggling or pressing Escape prevents a later rerender from reopening it.
        menus()[1].open = false;
        menus()[1].attributes.ontoggle({ currentTarget: menus()[1] });
        runtime.applyBucket(bucket([session('one', ['miso'])]));
        expect(menus().map(menu => menu.open)).toEqual([false, false]);

        menus()[1].open = true;
        menus()[1].attributes.ontoggle({ currentTarget: menus()[1] });
        let focused = false;
        menus()[1].children[0].focus = () => { focused = true; };
        menus()[1].listeners.get('keydown')({ key: 'Escape', stopPropagation() {} });
        expect(focused).toBe(true);
        runtime.applyBucket(bucket([session('one', ['taro'])]));
        expect(menus().map(menu => menu.open)).toEqual([false, false]);

        // Switching sessions, deleted messages, or closing Scratchpad drops open-menu state.
        menus()[1].open = true;
        menus()[1].attributes.ontoggle({ currentTarget: menus()[1] });
        runtime.applyBucket(bucket([session('one'), session('two')], 'two'));
        expect(menus().map(menu => menu.open)).toEqual([false, false]);
        runtime.applyBucket(bucket([session('one'), session('two')], 'one'));
        expect(menus().map(menu => menu.open)).toEqual([false, false]);

        menus()[1].open = true;
        menus()[1].attributes.ontoggle({ currentTarget: menus()[1] });
        runtime.applyBucket(bucket([{ ...session('one'), messages: [messages[0]] }]));
        expect(app.openMenus.has('reply-1')).toBe(false);

        menus()[0].open = true;
        menus()[0].attributes.ontoggle({ currentTarget: menus()[0] });
        runtime.hideScratchpad();
        expect(app.openMenus.size).toBe(0);
    });
});
