/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings[0] }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));

let currentAvatar = 'char.png';
let currentPersonaId = 'persona-a.png';
let lowMemoryActive = false;
const messageFormattingSpy = jest.fn(value => value);
const stores = new Map();
const extractCharacterReplyCommands = jest.fn(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
const submitConversationRewrite = jest.fn();
const requestConversationSelfie = jest.fn();
const captureConversationTextBinding = jest.fn(async () => ({}));
const buildConversationPromptMessages = jest.fn(async () => []);
const saveConversationThread = jest.fn();
const commitCharacterReplyCommands = jest.fn();
const revealUi = jest.fn();
await jest.unstable_mockModule('../public/scripts/ui-motion.js', () => ({ revealUi }));
await jest.unstable_mockModule('../public/scripts/low-memory-mode.js', () => ({
    isLowMemoryModeActive: () => lowMemoryActive,
    subscribeLowMemoryState: () => () => {},
}));

function storeKey(personaId, avatar, groupId = '') {
    return [personaId, avatar, groupId].join('|');
}

function getStore(avatar, groupId, personaId) {
    return stores.get(storeKey(personaId, avatar, groupId)) || null;
}

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ avatar: 'char.png', name: 'Aster' }],
    default_user_avatar: 'default.png',
    getThumbnailUrl: () => '',
    getThumbnailUrlForViewport: () => '',
    messageFormatting: (...args) => messageFormattingSpy(...args),
    name1: 'User',
}));
let momentFactory = () => ({ isValid: () => false });
await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ timestampToMoment: value => momentFactory(value) }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-a.png' }));
await jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_names: [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    createConversationBranch: (name, id = 'new-branch') => ({ id, name, messages: [] }),
    getActiveConversationBranch: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId] || null;
    },
    getConversationBranches: avatar => Object.values(getStore(avatar, '', currentPersonaId)?.branches || {}),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: (avatar, options = {}) => getStore(avatar, options.groupId || '', options.personaId || currentPersonaId),
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    persistConversationStore: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({
    captureConversationTextBinding,
    commitCharacterReplyCommands,
    extractCharacterReplyCommands,
    requestConversationSelfie,
    getCharacterReplyCommandMetadata: parts => parts?.selfieRequests?.length ? { selfieRequests: parts.selfieRequests } : null,
    normalizeConversationOutputText: value => String(value || '').trim(),
    reportConversationGenerationError: jest.fn(),
    submitConversationRewrite,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({
    getConversationMessageAvatar: () => '',
    getConversationMessageReceipt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/partners.js', () => ({
    escapeRegExp: value => value,
    getCharacterMentionHandles: () => [],
    parseAvatarList: () => [],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({
    buildConversationPromptMessages,
    buildConversationSystemPrompt: () => '',
    renderConversationAttachments: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    schedulePalsRailRender: jest.fn(),
    scheduleTimelineRender: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-utils.js', () => ({
    escapeHtmlAttribute: value => value,
    escapeHtmlText: value => value,
    getConversationMessageExtraFingerprint: () => '',
    hashConversationRenderFingerprint: value => value,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({ getConversationReplyMaxTokens: () => 100 }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    assertConversationAccount: () => {},
    captureConversationStore: jest.fn(),
    flushConversationStore: jest.fn(async () => true),
    getConversationSavedSnapshot: jest.fn(() => null),
    getConversationSavedVersion: jest.fn(() => 0),
    getConversationSyncState: jest.fn(() => ({})),
    initConversationStoreSync: jest.fn(),
    persistConversationStoreDebounced: jest.fn(),
    persistConversationStoreNow: jest.fn(async () => true),
    refreshConversationStore: jest.fn(async () => null),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-search.js', () => ({ getConversationTimelineMessages: messages => messages }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-slash-commands.js', () => ({
    appendConversationOocNote: jest.fn(),
    handleConversationSlashAction: jest.fn(),
    parseConversationReminderArgs: jest.fn(),
    parseConversationSlashCommand: jest.fn(),
    quickConversationSummarize: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/tts.js', () => ({ narrateConversationMessage: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    addConversationReminder: jest.fn(),
    buildConversationMessageReplyReference: message => ({
        messageId: message.id,
        name: message.name,
        role: message.role,
        text: message.mes,
    }),
    getConversationAttachmentSummary: () => '',
    getConversationMessagePreviewText: message => message?.mes || '',
    getConversationSeenAt: () => 0,
    getConversationThread: (avatar, options = {}) => {
        const store = getStore(avatar, options.groupId || '', options.personaId || currentPersonaId);
        return store?.branches?.[options.branchId || store.activeBranchId]?.messages || [];
    },
    saveConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getPrimaryTypingParticipant: () => null,
    updateLastPreviewFromConversation: jest.fn(),
    withTypingParticipant: (_participant, task) => task(),
}));

const stateModule = await import('../public/scripts/neconyan-conversation/state.js');
const {
    getActiveConversationReplyTarget,
    getConversationMessageById,
    markConversationMessageRuns,
    moveConversationTimelineWindowToLatest,
    navigateConversationTimelineWindow,
    regenerateConversationMessage,
    renderConversationTimeline,
    syncConversationTimelineHistoryControlsDisabledState,
} = await import('../public/scripts/neconyan-conversation/timeline-render.js');

function makeMessage(id, mes = `message ${id}`) {
    return {
        id,
        role: 'character',
        name: 'Aster',
        mes,
        created_at: 1,
        extra: {},
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('conversation timeline operation identity', () => {
    beforeEach(() => {
        currentAvatar = 'char.png';
        currentPersonaId = 'persona-a.png';
        stores.clear();
        stores.set(storeKey('persona-a.png', 'char.png'), {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { id: 'branch-a', messages: [makeMessage('message-1'), makeMessage('message-2')] },
                'branch-b': { id: 'branch-b', messages: [makeMessage('branch-b-message')] },
            },
        });
        stores.set(storeKey('persona-b.png', 'char.png'), {
            activeBranchId: 'branch-b',
            branches: { 'branch-b': { id: 'branch-b', messages: [makeMessage('persona-b-message')] } },
        });
        submitConversationRewrite.mockReset();
        captureConversationTextBinding.mockReset().mockResolvedValue({});
        buildConversationPromptMessages.mockClear();
        extractCharacterReplyCommands.mockReset().mockImplementation(rawText => ({ text: String(rawText || '').trim(), selfieRequests: [] }));
        saveConversationThread.mockClear();
        commitCharacterReplyCommands.mockClear();
        revealUi.mockClear();
        stateModule.regenerationBusyKeys.clear();
        stateModule.activeConversationGenerationOperations.clear();
        stateModule.activeConversationReplyOperations.clear();
        stateModule.conversationState.externalGenerationActive = false;
        stateModule.conversationState.conversationReplyBusy = false;
        stateModule.conversationState.generationActive = false;
        stateModule.conversationState.conversationReplyTarget = null;
        globalThis.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn() };
    });

    test('isolates and clears reply targets when persona or branch changes', () => {
        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'message-1',
            text: 'message 1',
        };
        expect(getActiveConversationReplyTarget()).not.toBeNull();

        stores.get(storeKey('persona-a.png', 'char.png')).activeBranchId = 'branch-b';
        expect(getActiveConversationReplyTarget()).toBeNull();
        expect(stateModule.conversationState.conversationReplyTarget).toBeNull();

        stateModule.conversationState.conversationReplyTarget = {
            avatar: 'char.png',
            branchId: 'branch-b',
            groupId: '',
            personaId: 'persona-a.png',
            messageId: 'branch-b-message',
            text: 'branch message',
        };
        currentPersonaId = 'persona-b.png';
        expect(getActiveConversationReplyTarget()).toBeNull();
    });

    test('guards duplicate regeneration and keeps busy state until all operations finish', async () => {
        const first = deferred();
        const second = deferred();
        const started = deferred();
        submitConversationRewrite
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => { started.resolve(); return second.promise; });

        const firstRun = regenerateConversationMessage('message-1');
        const duplicateRun = regenerateConversationMessage('message-1');
        const secondRun = regenerateConversationMessage('message-2');
        await started.promise;
        expect(submitConversationRewrite).toHaveBeenCalledTimes(2);
        expect(captureConversationTextBinding.mock.invocationCallOrder[0]).toBeLessThan(buildConversationPromptMessages.mock.invocationCallOrder[0]);
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        first.resolve({ messageId: 'message-1' });
        await firstRun;
        await duplicateRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(true);

        second.resolve({ messageId: 'message-2' });
        await secondRun;
        expect(stateModule.conversationState.conversationReplyBusy).toBe(false);
    });

    test('a rejected capture prevents prompt preparation, generation and replacement', async () => {
        const before = structuredClone(stores.get(storeKey('persona-a.png', 'char.png')));
        captureConversationTextBinding.mockRejectedValueOnce(new Error('Connection changed'));
        await regenerateConversationMessage('message-1');
        expect(buildConversationPromptMessages).not.toHaveBeenCalled();
        expect(submitConversationRewrite).not.toHaveBeenCalled();
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(stores.get(storeKey('persona-a.png', 'char.png'))).toEqual(before);
    });

    test('submits the captured persona, branch and prefix to the server without writing in the page', async () => {
        const job = deferred();
        submitConversationRewrite.mockImplementationOnce(() => job.promise);
        const before = structuredClone(stores.get(storeKey('persona-a.png', 'char.png')));

        const run = regenerateConversationMessage('message-2');
        await Promise.resolve();
        currentPersonaId = 'persona-b.png';
        job.resolve({ messageId: 'message-2' });
        await run;

        expect(captureConversationTextBinding).toHaveBeenCalledWith(expect.objectContaining({ avatar: 'char.png', branchId: 'branch-a',
            personaId: 'persona-a.png', messages: before.branches['branch-a'].messages }));
        expect(submitConversationRewrite).toHaveBeenCalledWith('regenerate', 'message-2', expect.objectContaining({
            scope: expect.objectContaining({ avatar: 'char.png', branchId: 'branch-a', personaId: 'persona-a.png' }),
            bindingContext: {},
        }), expect.anything());
        expect(stores.get(storeKey('persona-a.png', 'char.png'))).toEqual(before);
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(commitCharacterReplyCommands).not.toHaveBeenCalled();
        expect(extractCharacterReplyCommands).not.toHaveBeenCalled();
        expect(globalThis.toastr.success).toHaveBeenCalledWith('Message regenerated.');
    });

    test('says the server is still writing when the page stops watching', async () => {
        submitConversationRewrite.mockResolvedValueOnce(null);

        await regenerateConversationMessage('message-1');

        expect(globalThis.toastr.info).toHaveBeenCalledWith(expect.stringContaining('still being written on the server'));
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
    });

    test('changes the rendered thread identity when only the persona changes', () => {
        class FakeElement extends EventTarget {
            constructor() {
                super();
                this.children = [];
                this.clientHeight = 400;
                this.dataset = {};
                this.innerHTML = '';
                this.isConnected = false;
                this.scrollHeight = 400;
                this.scrollTop = 0;
                this.textContent = '';
            }

            appendChild(child) {
                this.children.push(child);
                return child;
            }

            querySelector() {
                return null;
            }

            querySelectorAll() {
                return [];
            }
        }

        globalThis.HTMLElement = FakeElement;
        globalThis.HTMLInputElement = class HTMLInputElement extends FakeElement {};
        const timeline = new FakeElement();
        const elements = new Map([['sb_conversation_timeline', timeline]]);
        globalThis.document = {
            createElement: () => new FakeElement(),
            getElementById: id => elements.get(id),
        };
        stores.get(storeKey('persona-a.png', 'char.png')).branches['branch-a'].messages = [];
        stores.get(storeKey('persona-b.png', 'char.png')).branches['branch-b'].messages = [];
        stateModule.conversationState.lastRenderedThreadKey = '';
        stateModule.conversationState.lastRenderedMessageCount = 0;
        stateModule.conversationState.lastTimelineFingerprint = '';

        renderConversationTimeline();
        const personaAThreadKey = stateModule.conversationState.lastRenderedThreadKey;
        currentPersonaId = 'persona-b.png';
        renderConversationTimeline();

        expect(personaAThreadKey).toContain('persona-a.png');
        expect(stateModule.conversationState.lastRenderedThreadKey).toContain('persona-b.png');
        expect(stateModule.conversationState.lastRenderedThreadKey).not.toBe(personaAThreadKey);
        expect(revealUi).toHaveBeenCalledTimes(2);
        renderConversationTimeline();
        expect(revealUi).toHaveBeenCalledTimes(2);
    });
});

describe('conversation message runs and day labels', () => {
    class FakeNode {
        constructor(index = 0) {
            this.dataset = { messageId: `m-${index}` };
            this.classList = {
                contains: name => name === 'sb-conversation-message',
            };
        }
    }

    function fakeMoment(value) {
        const date = new Date(value);
        const sameDay = other => date.getFullYear() === other.toDate().getFullYear()
            && date.getMonth() === other.toDate().getMonth()
            && date.getDate() === other.toDate().getDate();
        return {
            isValid: () => !Number.isNaN(date.getTime()),
            toDate: () => date,
            toISOString: () => date.toISOString(),
            isSame: (other, unit) => unit === 'day' && sameDay(other),
            diff: other => date.getTime() - other.toDate().getTime(),
            format: pattern => `${pattern}:${date.getDate()}`,
        };
    }

    function markRuns(messages) {
        const timeline = { children: messages.map((_, index) => new FakeNode(index)) };
        markConversationMessageRuns(timeline, messages);
        return timeline.children.map(node => ({ run: node.dataset.sbRun, day: node.dataset.sbDayLabel }));
    }

    function at(daysAgo, hour, minute) {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        date.setHours(hour, minute, 0, 0);
        return date.toISOString();
    }

    const message = (role, name, sendDate, extra = {}) => ({ role, name, send_date: sendDate, mes: 'hi', extra });

    beforeEach(() => {
        globalThis.HTMLElement = FakeNode;
        momentFactory = fakeMoment;
    });

    afterEach(() => {
        momentFactory = () => ({ isValid: () => false });
    });

    test('groups close messages from the same sender and labels each new day', () => {
        const marks = markRuns([
            message('character', 'Miso', at(1, 9, 0)),
            message('character', 'Miso', at(0, 9, 0)),
            message('character', 'Miso', at(0, 9, 4)),
            message('character', 'Miso', at(0, 9, 8)),
            message('user', 'You', at(0, 9, 9)),
            message('user', 'You', at(0, 9, 40)),
            message('system', 'System', at(0, 9, 41)),
            message('system', 'System', at(0, 9, 41)),
        ]);

        expect(marks).toEqual([
            { run: 'single', day: 'Yesterday' },
            { run: 'start', day: 'Today' },
            { run: 'middle', day: undefined },
            { run: 'end', day: undefined },
            { run: 'single', day: undefined },
            { run: 'single', day: undefined },
            { run: 'single', day: undefined },
            { run: 'single', day: undefined },
        ]);
    });

    test('keeps different partners apart and names older days', () => {
        const marks = markRuns([
            message('partner', 'Ash', at(3, 12, 0), { partner_avatar: 'ash.png' }),
            message('partner', 'Ash', at(3, 12, 1), { partner_avatar: 'ash.png' }),
            message('partner', 'Bo', at(3, 12, 2), { partner_avatar: 'bo.png' }),
            message('character', 'Miso', at(30, 12, 0)),
        ]);

        expect(marks.map(mark => mark.run)).toEqual(['start', 'end', 'single', 'single']);
        expect(marks[0].day).toMatch(/^dddd:/);
        expect(marks[3].day).toMatch(/^LL:/);
    });

    test('still groups a sender when dates are missing, without a day label', () => {
        momentFactory = () => ({ isValid: () => false });
        const marks = markRuns([
            message('character', 'Miso', ''),
            message('character', 'Miso', ''),
        ]);

        expect(marks).toEqual([{ run: 'start', day: undefined }, { run: 'end', day: undefined }]);
    });

    test('reconciles a 1,000-message thread to the bounded window, preserves the overlap message scroll anchor when paging, and blocks paging while an edit is open', () => {
        class FakeDomNode extends EventTarget {
            constructor(tagName = 'div') {
                super();
                this.tagName = tagName;
                this._className = '';
                this.children = [];
                this.parentNode = null;
                this.dataset = {};
                this.innerHTML = '';
                this._textContent = '';
                this.isConnected = true;
                this.scrollTop = 0;
                this.scrollHeight = 4000;
                this.clientHeight = 500;
                this.attributes = new Map();
                const classes = new Set();
                this.classList = {
                    add: (...names) => names.forEach(n => classes.add(n)),
                    remove: (...names) => names.forEach(n => classes.delete(n)),
                    toggle: (name, force) => {
                        const next = force === undefined ? !classes.has(name) : Boolean(force);
                        if (next) classes.add(name);
                        else classes.delete(name);
                        return next;
                    },
                    contains: name => classes.has(name),
                };
                Object.defineProperty(this, 'className', {
                    get: () => [...classes].join(' '),
                    set: value => {
                        classes.clear();
                        String(value || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n));
                    },
                });
            }

            get textContent() {
                return this._textContent;
            }

            set textContent(value) {
                this._textContent = String(value ?? '');
                if (this._textContent === '') {
                    this.children.forEach((child) => { child.parentNode = null; });
                    this.children.length = 0;
                }
            }

            get firstChild() {
                return this.children[0] || null;
            }

            get nextSibling() {
                if (!this.parentNode) return null;
                const idx = this.parentNode.children.indexOf(this);
                return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null;
            }

            get offsetTop() {
                if (!this.parentNode) return 0;
                const idx = this.parentNode.children.indexOf(this);
                return idx >= 0 ? idx * 80 : 0;
            }

            getAttribute(name) {
                return this.attributes.get(name) ?? null;
            }

            setAttribute(name, value) {
                this.attributes.set(name, String(value));
            }

            appendChild(child) {
                if (child.parentNode) {
                    child.remove();
                }
                child.parentNode = this;
                this.children.push(child);
                return child;
            }

            insertBefore(newNode, referenceNode) {
                if (!referenceNode) {
                    return this.appendChild(newNode);
                }
                if (newNode === referenceNode) {
                    return newNode;
                }
                if (newNode.parentNode) {
                    newNode.remove();
                }
                newNode.parentNode = this;
                const refIdx = this.children.indexOf(referenceNode);
                if (refIdx < 0) {
                    this.children.push(newNode);
                } else {
                    this.children.splice(refIdx, 0, newNode);
                }
                return newNode;
            }

            replaceWith(nextNode) {
                if (!this.parentNode) return;
                const parent = this.parentNode;
                const idx = parent.children.indexOf(this);
                if (idx >= 0) {
                    if (nextNode.parentNode) nextNode.remove();
                    nextNode.parentNode = parent;
                    parent.children[idx] = nextNode;
                    this.parentNode = null;
                }
            }

            remove() {
                if (!this.parentNode) return;
                const idx = this.parentNode.children.indexOf(this);
                if (idx >= 0) {
                    this.parentNode.children.splice(idx, 1);
                }
                this.parentNode = null;
            }

            append(...nodes) {
                nodes.forEach(node => this.appendChild(node));
            }

            prepend(...nodes) {
                for (let i = nodes.length - 1; i >= 0; i--) {
                    this.insertBefore(nodes[i], this.firstChild);
                }
            }

            querySelector() {
                return null;
            }

            querySelectorAll(selector) {
                if (selector === '.sb-conversation-history-button') {
                    return this.children
                        .filter(child => child.dataset?.sbConversationHistoryNav)
                        .flatMap(container => container.children);
                }
                if (selector.includes('.sb-conversation-thread-empty')) {
                    return this.children.filter(child => (
                        child.classList.contains('sb-conversation-thread-empty')
                        || child.classList.contains('sb-conversation-typing-indicator')
                        || child.classList.contains('sb-conversation-image-pending')
                    ));
                }
                return [];
            }
        }

        const pendingFrames = [];
        globalThis.HTMLElement = FakeDomNode;
        globalThis.HTMLInputElement = class HTMLInputElement extends FakeDomNode {};
        globalThis.requestAnimationFrame = callback => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        };
        momentFactory = fakeMoment;

        const timeline = new FakeDomNode('div');
        const elements = new Map([['sb_conversation_timeline', timeline]]);
        globalThis.document = {
            createElement: tag => new FakeDomNode(tag),
            getElementById: id => elements.get(id),
        };

        const thousandMessages = Array.from({ length: 1000 }, (_, idx) => ({
            id: `m-${idx}`,
            role: idx % 2 === 0 ? 'user' : 'character',
            name: idx % 2 === 0 ? 'User' : 'Aster',
            mes: `Line ${idx}`,
            send_date: at(2, 10, idx % 60),
            created_at: 1000 + idx,
            extra: {},
        }));

        currentAvatar = 'char.png';
        currentPersonaId = 'persona-a.png';
        lowMemoryActive = true;
        stores.set(storeKey('persona-a.png', 'char.png'), {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': {
                    id: 'branch-a',
                    messages: thousandMessages,
                },
            },
        });

        stateModule.conversationState.lastRenderedThreadKey = '';
        stateModule.conversationState.lastRenderedMessageCount = 0;
        stateModule.conversationState.lastTimelineFingerprint = '';
        stateModule.conversationState.timelineWindowDescriptor = null;
        messageFormattingSpy.mockClear();

        renderConversationTimeline();

        // Only the 25-message low-memory window is formatted and mounted.
        expect(messageFormattingSpy).toHaveBeenCalledTimes(25);
        const messageNodesAfterOpen = timeline.children.filter(node => node.classList.contains('sb-conversation-message'));
        const historyControlsAfterOpen = timeline.children.filter(node => node.dataset.sbConversationHistoryNav);
        expect(messageNodesAfterOpen).toHaveLength(25);
        expect(messageNodesAfterOpen[0].dataset.messageId).toBe('m-975');
        expect(messageNodesAfterOpen.at(-1).dataset.messageId).toBe('m-999');
        expect(historyControlsAfterOpen.map(node => node.dataset.sbConversationHistoryNav)).toEqual(['older']);

        // History button wrapper does not acquire message run or day metadata, while the first mounted message row has a day label.
        expect(historyControlsAfterOpen[0].dataset.sbRun).toBeUndefined();
        expect(historyControlsAfterOpen[0].dataset.sbDayLabel).toBeUndefined();
        expect(messageNodesAfterOpen[0].dataset.sbRun).toBeDefined();
        expect(messageNodesAfterOpen[0].dataset.sbDayLabel).toBeDefined();

        // Full history remains addressable by ID even for unmounted messages.
        expect(getConversationMessageById('m-0')?.message.mes).toBe('Line 0');
        expect(getConversationMessageById('m-500')?.message.mes).toBe('Line 500');

        // Paging Older preserves the overlap anchor (m-975) at the same viewport offset and cancels scheduled bottom pins.
        timeline.scrollTop = 20;
        const overlapBeforeOlder = messageNodesAfterOpen[0];
        expect(overlapBeforeOlder.dataset.messageId).toBe('m-975');
        const offsetBeforeOlder = overlapBeforeOlder.offsetTop - timeline.scrollTop;

        navigateConversationTimelineWindow('older');
        while (pendingFrames.length) {
            pendingFrames.shift()();
        }

        const messageNodesAfterOlder = timeline.children.filter(node => node.classList.contains('sb-conversation-message'));
        const historyControlsAfterOlder = timeline.children.filter(node => node.dataset.sbConversationHistoryNav);
        expect(messageNodesAfterOlder).toHaveLength(25);
        expect(messageNodesAfterOlder[0].dataset.messageId).toBe('m-951');
        expect(messageNodesAfterOlder.at(-1).dataset.messageId).toBe('m-975');
        expect(historyControlsAfterOlder.map(node => node.dataset.sbConversationHistoryNav)).toEqual(['older', 'newer']);

        const overlapAfterOlder = messageNodesAfterOlder.find(node => node.dataset.messageId === 'm-975');
        expect(overlapAfterOlder.offsetTop - timeline.scrollTop).toBe(offsetBeforeOlder);

        // Paging Newer preserves the overlap anchor (m-975, old last message) at the same viewport offset.
        timeline.scrollTop = 1940;
        const offsetBeforeNewer = overlapAfterOlder.offsetTop - timeline.scrollTop;
        navigateConversationTimelineWindow('newer');
        const messageNodesAfterNewer = timeline.children.filter(node => node.classList.contains('sb-conversation-message'));
        expect(messageNodesAfterNewer[0].dataset.messageId).toBe('m-975');
        expect(messageNodesAfterNewer.at(-1).dataset.messageId).toBe('m-999');
        const overlapAfterNewer = messageNodesAfterNewer.find(node => node.dataset.messageId === 'm-975');
        expect(overlapAfterNewer.offsetTop - timeline.scrollTop).toBe(offsetBeforeNewer);

        // Page back to m-951..m-975, then open an edit on m-951: paging controls are disabled and cannot page away.
        navigateConversationTimelineWindow('older');
        const editedNode = timeline.children.find(node => node.dataset.messageId === 'm-951');
        editedNode.classList.add('is-editing');
        syncConversationTimelineHistoryControlsDisabledState(timeline);
        const historyButtons = timeline.querySelectorAll('.sb-conversation-history-button');
        expect(historyButtons.length).toBeGreaterThan(0);
        expect(historyButtons.every(btn => btn.disabled === true && btn.getAttribute('aria-disabled') === 'true')).toBe(true);

        navigateConversationTimelineWindow('latest');
        expect(stateModule.conversationState.timelineWindowDescriptor.followingLatest).toBe(false);
        expect(stateModule.conversationState.timelineWindowDescriptor.startMessageId).toBe('m-951');

        // Incoming message while reading history does not stretch the window or jump scrollTop.
        editedNode.classList.remove('is-editing');
        syncConversationTimelineHistoryControlsDisabledState(timeline);
        const scrollBeforeIncoming = timeline.scrollTop;
        thousandMessages.push({
            id: 'm-1000',
            role: 'character',
            name: 'Aster',
            mes: 'Line 1000',
            send_date: at(0, 11, 0),
            created_at: 2000,
            extra: {},
        });
        renderConversationTimeline();
        expect(timeline.scrollTop).toBe(scrollBeforeIncoming);
        const messageNodesAfterIncoming = timeline.children.filter(node => node.classList.contains('sb-conversation-message'));
        expect(messageNodesAfterIncoming).toHaveLength(25);
        expect(messageNodesAfterIncoming[0].dataset.messageId).toBe('m-951');
        expect(messageNodesAfterIncoming.at(-1).dataset.messageId).toBe('m-975');

        // Explicitly moving to latest (as on workspace reopen or tab return) lands on m-976..m-1000.
        moveConversationTimelineWindowToLatest();
        renderConversationTimeline();
        const messageNodesAtLatest = timeline.children.filter(node => node.classList.contains('sb-conversation-message'));
        expect(messageNodesAtLatest).toHaveLength(25);
        expect(messageNodesAtLatest[0].dataset.messageId).toBe('m-976');
        expect(messageNodesAtLatest.at(-1).dataset.messageId).toBe('m-1000');

        delete globalThis.requestAnimationFrame;
        lowMemoryActive = false;
    });
});
