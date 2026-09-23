import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';
import { bindRoleplayAccount, roleplayAccountStamp, rememberRoleplayRead } from '../public/scripts/roleplay-save-chain.js';
import { renderMessagesInBatches } from '../public/scripts/chat-render-lifecycle/render-batch.js';

const groupSource = fs.readFileSync(new URL('../public/scripts/group-chats.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const extract = (source, names) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => names.includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

for (const lifecycle of [false, true]) for (const peek of [false, true]) {
    test(`${lifecycle ? 'lifecycle' : 'legacy'} initial renderer ${peek ? 'survives a group member peek' : 'stops after a superseding group load'}`, async () => {
        const owner = randomUUID();
        const account = { accountId: randomUUID(), dataEpoch: 1 };
        bindRoleplayAccount(owner, account);
        const groups = ['A', 'B'].map(id => ({ id, chat_id: id, chats: [id], members: [] }));
        let generation = 0;
        let rows = [];
        let release;
        let reached;
        let held = false;
        const gate = new Promise(resolve => { release = resolve; });
        const paused = new Promise(resolve => { reached = resolve; });
        const documentRef = { createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node); } }) };
        const chain = { removeClass() { return this; }, filter() { return this; }, nextAll() { return this; },
            addBack() { return this; }, remove() { rows = []; return this; } };
        const no = () => {};
        const scroll = jest.fn();
        const tags = jest.fn();
        const runtime = vm.createContext({
            console: { info: no, warn: no, error: no }, performance, groups, selected_group: 'A', chat: [], chat_metadata: {}, this_chid: undefined,
            roleplayAccountStamp, rememberRoleplayRead, getCurrentUserHandle: () => owner,
            getChatGeneration: () => generation, incrementChatGeneration: () => generation++,
            validateGroup: async () => {}, unshallowGroupMembers: async () => {}, loadItemizedPrompts: async () => {},
            loadGroupChat: async id => ({ records: [{ chat_metadata: { tainted: true, integrity: id } },
                ...Array.from({ length: 17 }, (_, i) => ({ mes: id + i }))],
            evidence: { account, source: { instanceId: randomUUID(), revision: 1, rawHash: 'a'.repeat(64) } } }),
            chatElement: { 0: { appendChild: fragment => rows.push(...fragment.children) }, find: () => chain },
            ensureMessageMediaIsArray: no, updateChatMetadata: value => { runtime.chat_metadata = value; },
            eventSource: { emit: async () => {} }, event_types: {}, getCurrentChatId: () => runtime.selected_group,
            toastr: { error: no }, t: strings => strings.join(''), power_user: {},
            getChatRenderWindowSize: () => 50, getChatRenderWindowStartIndex: () => 0,
            removeRenderedChatMessages: () => { rows = []; }, beginChatLoadBottomLock: no,
            syncChatHistoryWindowControls: no, requestAnimationFrame: callback => queueMicrotask(callback),
            scrollLoadedChatToBottomThroughLifecycle: scroll, delay: async () => {}, debounce_timeout: { short: 0 }, scrollOnMediaLoad: scroll,
            getRenderedChatMessageWindow: () => ({ renderedMessageCount: rows.length, firstMessageId: rows[0]?.id, lastMessageId: rows.at(-1)?.id }),
            unobserveChatMessageResize: no, applyCharacterTagsToMessageDivs: tags, refreshSwipeButtons: no, applyStylePins: no, updateEditArrowClasses: no,
            shouldBatchMobileChatRendering: () => true, MOBILE_CHAT_RENDER_BATCH_SIZE: 8,
            isChatRenderLifecycleRolloutEnabled: () => lifecycle, CHAT_RENDER_LIFECYCLE_ROUTE: { REDISPLAY_BATCH: 'batch' },
            updateMessageElement: (message, { messageId }) => [{ text: message.mes, id: messageId, classList: { add: no } }],
            document: documentRef, lodash: { range: (a, b) => Array.from({ length: b - a }, (_, i) => a + i) },
            renderMessagesInBatches: options => renderMessagesInBatches({ ...options, documentRef }),
            waitForNextFrame: async () => { if (!held && runtime.selected_group === 'A') { held = true; reached(); await gate; } },
        });
        vm.runInContext(extract(groupSource, ['getGroupChat']) + '\n'
            + extract(coreSource, ['captureChatRenderValidity', 'printMessages', 'redisplayChat', 'renderRedisplayChatMessagesLegacy',
                'renderRedisplayChatMessagesThroughLifecycle', 'renderRedisplayChatMessages', 'getMobileChatRenderBatchSize']), runtime);
        const old = runtime.getGroupChat('A');
        await paused;
        if (peek) runtime.this_chid = 1;
        else {
            runtime.selected_group = 'B';
            await runtime.getGroupChat('B');
        }
        const BScroll = scroll.mock.calls.length;
        const BTags = tags.mock.calls.length;
        release();
        await old;
        expect(rows).toHaveLength(17);
        expect(rows.every(row => row.text.startsWith(peek ? 'A' : 'B'))).toBe(true);
        expect(new Set(rows.map(row => row.id)).size).toBe(17);
        expect(runtime.chat[0].mes).toBe(peek ? 'A0' : 'B0');
        expect(runtime.chat_metadata.integrity).toBe(peek ? 'A' : 'B');
        expect(scroll.mock.calls.length > BScroll).toBe(peek);
        expect(tags.mock.calls.length > BTags).toBe(peek);
    });
}

for (const switchDuringReceived of [false, true]) {
    test(`group greeting events ${switchDuringReceived ? 'stop on another chat' : 'complete on the same chat'}`, async () => {
        const owner = randomUUID();
        const account = { accountId: randomUUID(), dataEpoch: 1 };
        bindRoleplayAccount(owner, account);
        let generation = 0;
        let release;
        let reached;
        const gate = new Promise(resolve => { release = resolve; });
        const paused = new Promise(resolve => { reached = resolve; });
        const events = [];
        const runtime = vm.createContext({
            console, groups: ['A', 'B'].map(id => ({ id, chat_id: id, chats: [id], members: [] })),
            selected_group: 'A', chat: [], chat_metadata: {}, roleplayAccountStamp, rememberRoleplayRead,
            getCurrentUserHandle: () => owner, getChatGeneration: () => generation, incrementChatGeneration: () => generation++,
            validateGroup: async () => {}, unshallowGroupMembers: async () => {}, loadItemizedPrompts: async () => {},
            loadGroupChat: async id => id === 'A' ? { records: [], evidence: { account, vacancy: 0 } }
                : { records: [{ chat_metadata: { tainted: true } }, { mes: 'Existing B text' }],
                    evidence: { account, source: { instanceId: randomUUID(), revision: 1, rawHash: 'a'.repeat(64) } } },
            chatElement: { find: () => ({ remove() {} }) }, ensureMessageMediaIsArray() {}, printMessages: async () => {},
            updateChatMetadata: metadata => { runtime.chat_metadata = metadata; },
            addFreshGroupGreeting: () => { runtime.chat.push({ mes: 'Fresh A greeting' }); return 0; },
            saveGroupChat: async () => true,
            event_types: { CHAT_CHANGED: 'changed', GROUP_CHAT_CREATED: 'created', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
            eventSource: { emit: async (event, messageId) => {
                events.push({ event, selected: runtime.selected_group, messageId, text: runtime.chat[messageId]?.mes });
                if (event === 'received' && runtime.selected_group === 'A') { reached(); await gate; }
            } },
            getCurrentChatId: () => runtime.selected_group, toastr: { error() {} }, t: strings => strings.join(''),
        });
        vm.runInContext(extract(groupSource, ['getGroupChat', 'captureGroupGreetingValidity', 'emitGroupGreetingMessageEvents']), runtime);
        const first = runtime.getGroupChat('A');
        await paused;
        if (switchDuringReceived) {
            runtime.selected_group = 'B';
            await runtime.getGroupChat('B');
        }
        release();
        await first;
        expect(events.filter(item => item.event === 'rendered')).toEqual(switchDuringReceived ? []
            : [{ event: 'rendered', selected: 'A', messageId: 0, text: 'Fresh A greeting' }]);
        expect(runtime.chat[0].mes).toBe(switchDuringReceived ? 'Existing B text' : 'Fresh A greeting');
    });
}

for (const switchDuringSave of [false, true]) {
    test(`selected greeting ${switchDuringSave ? 'stops after a chat switch' : 'renders while current'}`, async () => {
        const owner = randomUUID();
        bindRoleplayAccount(owner, { accountId: randomUUID(), dataEpoch: 1 });
        let generation = 1;
        let release;
        let reached;
        const gate = new Promise(resolve => { release = resolve; });
        const paused = new Promise(resolve => { reached = resolve; });
        const print = jest.fn(async () => {});
        const events = [];
        const runtime = vm.createContext({
            groups: [{ id: 'A', chat_id: 'A' }, { id: 'B', chat_id: 'B' }], selected_group: 'A',
            selectedGroupSpeakerAvatar: 'Nova.png', chat: [], roleplayAccountStamp,
            getCurrentUserHandle: () => owner, getChatGeneration: () => generation,
            getGroupEnabledMembers: () => ['Nova.png'], buildGroupGreetingMessage: () => ({ mes: 'A greeting' }),
            saveGroupChat: async () => { reached(); await gate; return true; }, printMessages: print,
            event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
            eventSource: { emit: async event => { events.push(event); } },
            toastr: { warning() {} }, t: strings => strings.join(''),
        });
        vm.runInContext(extract(groupSource, ['captureGroupGreetingValidity', 'emitGroupGreetingMessageEvents', 'addSelectedGroupGreeting']), runtime);
        const add = runtime.addSelectedGroupGreeting();
        await paused;
        if (switchDuringSave) {
            runtime.selected_group = 'B';
            runtime.chat.splice(0, runtime.chat.length, { mes: 'B message' });
            generation++;
        }
        release();
        await add;
        expect(print).toHaveBeenCalledTimes(switchDuringSave ? 0 : 1);
        expect(events).toEqual(switchDuringSave ? [] : ['received', 'rendered']);
    });
}

function createHistoryRuntime(lifecycle, direction = 'newer', group = true) {
    const no = () => {};
    const effects = { prune: jest.fn(), controls: jest.fn(), tags: jest.fn(), swipes: jest.fn(), style: jest.fn(), edit: jest.fn(),
        anchor: jest.fn(), settle: jest.fn(async () => {}), events: [] };
    const gates = new Map();
    class Element {
        constructor(id = null, text = '') { this.id = id; this.text = text; this.classList = { add: no }; }
        setAttribute() {}
        removeAttribute() {}
        remove() {}
    }
    const button = new Element();
    const documentRef = { createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node); } }) };
    let rows = direction === 'older' ? Array.from({ length: 8 }, (_, offset) => new Element(offset + 9, `A${offset + 9}`))
        : [new Element(0, 'A0')];
    const chatNode = new Element();
    chatNode.appendChild = fragment => rows.push(...fragment.children);
    chatNode.insertBefore = (fragment, reference) => { const index = rows.indexOf(reference); rows.splice(index < 0 ? 0 : index, 0, ...fragment.children); };
    chatNode.firstChild = rows[0];
    const runtime = vm.createContext({
        console: { info: no, debug: no }, performance, generation: 1, owner: 'owner', chatId: 'Shared', accountStamp: {},
        groups: ['A', 'B', 'C'].map(id => ({ id, chat_id: id })), selected_group: group ? 'A' : null,
        this_chid: group ? undefined : 0, chat: Array.from({ length: 17 }, (_, id) => ({ mes: `A${id}` })),
        loadingMoreMessagesOwner: null, getChatGeneration: () => runtime.generation,
        getCurrentUserHandle: () => runtime.owner,
        roleplayAccountStamp: () => runtime.accountStamp,
        getCurrentChatId: () => group ? runtime.groups.find(item => item.id === runtime.selected_group)?.chat_id : runtime.chatId,
        chatElement: { 0: chatNode,
            children: () => ({ first: () => ({ attr: () => String(rows[0]?.id) }) }), find: () => ({}) },
        power_user: { chat_truncation: 50 }, getPagedChatRenderWindowSize: () => 50,
        getChatHistoryPageSize: () => direction === 'older' ? 9 : 16, getLastMessageId: () => runtime.chat.length - 1,
        getRenderedChatMessageElements: () => rows, getRenderedChatMessageWindow: () => ({ renderedMessageCount: rows.length,
            firstMessageId: rows[0]?.id, lastMessageId: rows.at(-1)?.id }),
        captureVisibleChatMessageAnchor: () => ({}), restoreVisibleChatMessageAnchor: effects.anchor,
        settleVisibleChatMessageAnchor: (...args) => effects.settle(...args),
        pruneRenderedChatMessagesToWindow: effects.prune, syncChatHistoryWindowControls: effects.controls,
        syncRenderedChatLastMessageClass: no, refreshSwipeButtons: effects.swipes, applyStylePins: effects.style,
        updateEditArrowClasses: effects.edit, applyCharacterTagsToMessageDivs: effects.tags,
        shouldBatchMobileChatRendering: () => true, MOBILE_CHAT_RENDER_BATCH_SIZE: 8,
        isChatRenderLifecycleRolloutEnabled: () => lifecycle,
        CHAT_RENDER_LIFECYCLE_ROUTE: { REDISPLAY_BATCH: 'redisplay', SHOW_MORE_BATCH: 'older' },
        updateMessageElement: (message, { messageId }) => [new Element(messageId, message.mes)],
        document: documentRef, HTMLElement: Element, $: () => ({ 0: button, remove: no }),
        CHAT_HISTORY_OLDER_BUTTON_ID: 'older', CHAT_HISTORY_NEWER_BUTTON_ID: 'newer',
        lodash: { range: (a, b) => Array.from({ length: b - a }, (_, id) => a + id) },
        renderMessagesInBatches: options => renderMessagesInBatches({ ...options, documentRef }),
        waitForNextFrame: () => {
            const gate = gates.get(group ? runtime.selected_group : runtime.owner);
            if (!gate || gate.used) return Promise.resolve();
            gate.used = true;
            gate.reached();
            return gate.wait;
        },
        event_types: { MORE_MESSAGES_LOADED: 'history' }, eventSource: { emit: async event => { effects.events.push(event); } },
        clamp: (value, low, high) => Math.min(Math.max(value, low), high),
    });
    button.nextSibling = rows[0];
    vm.runInContext(extract(coreSource, ['captureChatRenderValidity', 'showMoreMessages', 'showNewerMessages',
        'insertShowMoreFragment', 'renderShowMoreMessagesLegacy', 'renderShowMoreMessagesThroughLifecycle', 'renderShowMoreMessages',
        'renderRedisplayChatMessagesLegacy', 'renderRedisplayChatMessagesThroughLifecycle', 'renderRedisplayChatMessages',
        'getMobileChatRenderBatchSize']), runtime);
    return {
        runtime, effects, rows: () => rows,
        pause(id = 'A') {
            let release;
            let reached;
            const wait = new Promise(resolve => { release = resolve; });
            const paused = new Promise(resolve => { reached = resolve; });
            gates.set(id, { wait, reached, used: false });
            return { paused, release };
        },
        switchTo(id) {
            runtime.selected_group = group ? id : null;
            runtime.owner = group ? runtime.owner : id;
            runtime.generation++;
            runtime.chat.splice(0, runtime.chat.length, ...Array.from({ length: 17 }, (_, index) => ({ mes: `${id}${index}` })));
            rows = direction === 'older' ? Array.from({ length: 8 }, (_, offset) => new Element(offset + 9, `${id}${offset + 9}`))
                : [new Element(0, `${id}0`)];
            runtime.chatElement[0].firstChild = rows[0];
            button.nextSibling = rows[0];
        },
        run() { return direction === 'older' ? runtime.showMoreMessages() : runtime.showNewerMessages(); },
    };
}

for (const lifecycle of [false, true]) for (const direction of ['older', 'newer']) {
    test(`${lifecycle ? 'lifecycle' : 'legacy'} ${direction} history completes in order`, async () => {
        const h = createHistoryRuntime(lifecycle, direction);
        await h.run();
        expect(h.rows().map(row => row.text)).toEqual(Array.from({ length: 17 }, (_, id) => `A${id}`));
        expect(h.effects.events).toEqual(['history']);
        expect(h.runtime.loadingMoreMessagesOwner).toBeNull();
    });

    test(`${lifecycle ? 'lifecycle' : 'legacy'} ${direction} history stops after another chat wins`, async () => {
        const h = createHistoryRuntime(lifecycle, direction);
        const gate = h.pause();
        const stale = h.run();
        await gate.paused;
        h.switchTo('B');
        const before = Object.fromEntries(['prune', 'controls', 'tags', 'swipes', 'style', 'edit', 'anchor'].map(key => [key, h.effects[key].mock.calls.length]));
        gate.release();
        await stale;
        expect(h.rows().every(row => row.text.startsWith('B'))).toBe(true);
        for (const [key, count] of Object.entries(before)) expect(h.effects[key]).toHaveBeenCalledTimes(count);
        expect(h.effects.events).toEqual([]);
    });
}

for (const lifecycle of [false, true]) {
    test(`${lifecycle ? 'lifecycle' : 'legacy'} group member peek keeps the group render current`, async () => {
        const h = createHistoryRuntime(lifecycle);
        const gate = h.pause();
        const render = h.run();
        await gate.paused;
        h.runtime.this_chid = 1;
        gate.release();
        await render;
        expect(h.rows()).toHaveLength(17);
        expect(h.effects.events).toEqual(['history']);
    });

    test(`${lifecycle ? 'lifecycle' : 'legacy'} solo character switch cancels even with the same filename`, async () => {
        const h = createHistoryRuntime(lifecycle, 'newer', false);
        const gate = h.pause('owner');
        const render = h.run();
        await gate.paused;
        h.runtime.this_chid = 1;
        gate.release();
        await render;
        expect(h.rows()).toHaveLength(9);
        expect(h.effects.events).toEqual([]);
    });
}

for (const change of ['branch', 'account', 'incarnation', 'generation']) {
    test(`${change} change cancels a paused history render`, async () => {
        const h = createHistoryRuntime(true);
        const gate = h.pause();
        const render = h.run();
        await gate.paused;
        if (change === 'branch') h.runtime.groups[0].chat_id = 'Other branch';
        if (change === 'account') h.runtime.owner = 'another owner';
        if (change === 'incarnation') h.runtime.accountStamp = {};
        if (change === 'generation') h.runtime.generation++;
        gate.release();
        await render;
        expect(h.rows()).toHaveLength(9);
        expect(h.effects.events).toEqual([]);
    });
}

test('stale paging cleanup cannot release a current B operation', async () => {
    const h = createHistoryRuntime(true);
    const A = h.pause('A');
    const first = h.run();
    await A.paused;
    h.switchTo('B');
    const B = h.pause('B');
    const second = h.run();
    await B.paused;
    const Bowner = h.runtime.loadingMoreMessagesOwner;
    A.release();
    await first;
    expect(h.runtime.loadingMoreMessagesOwner).toBe(Bowner);
    B.release();
    await second;
    expect(h.runtime.loadingMoreMessagesOwner).toBeNull();
    expect(h.rows().every(row => row.text.startsWith('B'))).toBe(true);
});

test('A cleanup cannot release C after B has completed', async () => {
    const h = createHistoryRuntime(false);
    const A = h.pause('A');
    const first = h.run();
    await A.paused;
    h.switchTo('B');
    await h.run();
    h.switchTo('C');
    const C = h.pause('C');
    const third = h.run();
    await C.paused;
    const Cowner = h.runtime.loadingMoreMessagesOwner;
    A.release();
    await first;
    expect(h.runtime.loadingMoreMessagesOwner).toBe(Cowner);
    C.release();
    await third;
    expect(h.runtime.loadingMoreMessagesOwner).toBeNull();
    expect(h.rows().every(row => row.text.startsWith('C'))).toBe(true);
});

test('empty newer page and a thrown renderer release only their paging owner', async () => {
    const empty = createHistoryRuntime(false);
    empty.runtime.chat.splice(1);
    await empty.run();
    expect(empty.runtime.loadingMoreMessagesOwner).toBeNull();
    expect(empty.effects.controls).toHaveBeenCalledTimes(1);

    const failed = createHistoryRuntime(true);
    failed.runtime.updateMessageElement = () => { throw new Error('render failed'); };
    await expect(failed.run()).rejects.toThrow('render failed');
    expect(failed.runtime.loadingMoreMessagesOwner).toBeNull();

    const older = createHistoryRuntime(false, 'older');
    older.runtime.updateMessageElement = () => { throw new Error('older render failed'); };
    await expect(older.run()).rejects.toThrow('older render failed');
    expect(older.runtime.loadingMoreMessagesOwner).toBeNull();
});

test('older history rechecks validity after anchor settling before its event', async () => {
    const h = createHistoryRuntime(true, 'older');
    let release;
    let reached;
    const gate = new Promise(resolve => { release = resolve; });
    const paused = new Promise(resolve => { reached = resolve; });
    let capturedValidity;
    h.effects.settle.mockImplementation(async (_anchor, _frames, isCurrent) => {
        capturedValidity = isCurrent;
        reached();
        await gate;
    });
    const rendering = h.run();
    await paused;
    expect(capturedValidity()).toBe(true);
    h.switchTo('B');
    expect(capturedValidity()).toBe(false);
    release();
    await rendering;
    expect(h.effects.events).toEqual([]);
});

test('anchor settling combines caller validity with scroll version and load lock', async () => {
    let current = true;
    const runtime = vm.createContext({
        chatElement: { 0: {} }, chatScrollVersion: 1, isChatLoadBottomLockActive: () => false,
        requestAnimationFrame: () => {},
        settleVisibleMessageAnchor: async (_element, _anchor, { isCurrent }) => {
            expect(isCurrent()).toBe(true);
            current = false;
            expect(isCurrent()).toBe(false);
            current = true;
            runtime.chatScrollVersion++;
            expect(isCurrent()).toBe(false);
        },
    });
    vm.runInContext(extract(coreSource, ['settleVisibleChatMessageAnchor']), runtime);
    await runtime.settleVisibleChatMessageAnchor({}, 8, () => current);
});

test('delayed load pins and media callbacks leave a newer chat alone', () => {
    let current = true;
    const timers = [];
    const pin = jest.fn();
    const lock = jest.fn();
    const load = vm.createContext({
        isChatRenderLifecycleRolloutEnabled: () => false, CHAT_RENDER_LIFECYCLE_ROUTE: { INITIAL_LOAD: 'initial' },
        CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS: [80, 250], CHAT_LOAD_BOTTOM_LOCK_EXTRA_MS: 250,
        MOBILE_SEND_SCROLL_SETTLE_MS: 200, beginChatLoadBottomLock: lock,
        shouldGuardMobileChatScroll: () => false, pinChatLoadToBottom: pin,
        setTimeout: callback => { timers.push(callback); }, scrollLock: true,
        scrollLockImmunityUntil: 0, chatLoadBottomLockUntil: 0,
    });
    vm.runInContext(extract(coreSource, ['scrollLoadedChatToBottomThroughLifecycle', 'scrollLoadedChatToBottom']), load);
    load.scrollLoadedChatToBottomThroughLifecycle(() => current);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    current = false;
    timers.forEach(callback => callback());
    expect(pin).toHaveBeenCalledTimes(1);

    const frames = [];
    const scroll = jest.fn();
    const pendingPin = vm.createContext({
        isChatLoadBottomLockActive: () => true, chatLoadBottomPinFrame: 0, scrollLock: true,
        requestAnimationFrame: callback => { frames.push(callback); return 1; }, scrollChatElementToBottom: scroll,
    });
    vm.runInContext(extract(coreSource, ['pinChatLoadToBottom']), pendingPin);
    current = true;
    pendingPin.pinChatLoadToBottom({ waitForFrame: true, isCurrent: () => current });
    current = false;
    frames.forEach(callback => callback());
    expect(scroll).not.toHaveBeenCalled();
    expect(pendingPin.scrollLock).toBe(true);
    current = true;
    pendingPin.pinChatLoadToBottom({ waitForFrame: true, isCurrent: () => current });
    frames.at(-1)();
    expect(scroll).toHaveBeenCalledTimes(1);

    class ImageElement {
        constructor() { this.complete = false; this.listeners = new Map(); }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        closest() { return this; }
    }
    const image = new ImageElement();
    const mediaPin = jest.fn();
    const mediaScroll = jest.fn();
    const media = vm.createContext({
        chatElement: { find: () => ({ toArray: () => [image] }) },
        HTMLElement: ImageElement, HTMLImageElement: ImageElement, HTMLMediaElement: class {},
        isElementInViewport: () => true, MOBILE_MEDIA_SCROLL_MAX_DELAY_MS: 300,
        pinChatLoadToBottom: mediaPin, scrollChatToBottom: mediaScroll,
    });
    vm.runInContext(extract(coreSource, ['scrollOnMediaLoad']), media);
    current = true;
    media.scrollOnMediaLoad({ force: true, isCurrent: () => current });
    current = false;
    image.listeners.get('load')();
    expect(mediaPin).not.toHaveBeenCalled();
    expect(mediaScroll).not.toHaveBeenCalled();
    current = true;
    media.scrollOnMediaLoad({ force: true, isCurrent: () => current });
    image.listeners.get('load')();
    expect(mediaPin).toHaveBeenCalledTimes(1);
});

for (const lifecycle of [false, true]) {
    test(`${lifecycle ? 'lifecycle' : 'legacy'} internal render dispatchers capture validity when callers omit it`, async () => {
        const newer = createHistoryRuntime(lifecycle);
        await newer.runtime.renderRedisplayChatMessages({ messages: [{ mes: 'A1' }], startIndex: 1 });
        expect(newer.rows().map(row => row.text)).toEqual(['A0', 'A1']);

        const older = createHistoryRuntime(lifecycle, 'older');
        await older.runtime.renderShowMoreMessages({ messages: [{ mes: 'A8' }], firstId: 8,
            insertionReference: older.rows()[0], anchor: null, shouldPreserveScroll: false });
        expect(older.rows()[0].text).toBe('A8');
    });
}
