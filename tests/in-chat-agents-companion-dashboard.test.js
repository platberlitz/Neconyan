/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('companion dashboard', () => {
    let chat;
    let eventSource;
    let agents;
    let companionResultsByMessage;
    let popupInstances;
    let conversationModeActive;
    let openCompanionPanelMock;
    let automaticCompanionAgents;
    let retryableCompanionAgents;
    let batchGroups;
    let runner;
    let changeSelectedCompanionLinksMock;

    class PopupMock {
        constructor(content, type, header, options) {
            this.content = content;
            this.type = type;
            this.options = options;
            this.showPromise = new Promise(resolve => {
                this.resolveShow = resolve;
            });
            popupInstances.push(this);
        }

        show() {
            return this.showPromise;
        }

        async completeAffirmative() {
            this.resolveShow(1);
        }
    }

    function createEventSource() {
        const handlers = new Map();

        return {
            on: jest.fn((event, handler) => {
                const eventHandlers = handlers.get(event) ?? [];
                eventHandlers.push(handler);
                handlers.set(event, eventHandlers);
            }),
            emit: jest.fn(async (event, ...args) => {
                const eventHandlers = [...(handlers.get(event) ?? [])];
                for (const handler of eventHandlers) {
                    await handler(...args);
                }
            }),
            removeListener: jest.fn((event, handler) => {
                const eventHandlers = handlers.get(event) ?? [];
                handlers.set(event, eventHandlers.filter(item => item !== handler));
            }),
            listenerCount(event) {
                return (handlers.get(event) ?? []).length;
            },
        };
    }

    async function importDashboard() {
        jest.resetModules();

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            substituteParams: jest.fn((value, options = {}) => String(value ?? '')
                .replaceAll('{{user}}', 'Traveler')
                .replaceAll('{{char}}', options.name2Override || 'Assistant')
                .replaceAll('{{original}}', options.original ?? '')),
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: {},
        }));

        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            Popup: PopupMock,
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
            fixToastrForDialogs: jest.fn(),
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => true),
            getAgentById: jest.fn(id => agents.find(agent => agent.id === id)),
            getCompanionConfig: jest.fn(agent => ({
                trigger: agent?.companion?.trigger === 'manual' ? 'manual' : 'auto',
                displayMode: agent?.companion?.displayMode === 'hidden' ? 'hidden' : 'card',
                format: agent?.companion?.format ?? 'markdown',
                batch: Boolean(agent?.companion?.batch),
                batchAgentIds: agent?.companion?.batchAgentIds ?? [],
                includeInChatHistory: Boolean(agent?.companion?.includeInChatHistory),
                feedback: {
                    enabled: Boolean(agent?.companion?.feedback?.enabled),
                    depth: Number(agent?.companion?.feedback?.depth) || 1,
                },
            })),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
            isToolAgent: jest.fn(agent => agent?.category === 'tool'),
        }));

        runner = {
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            cleanUpCompanionNotes: jest.fn(async () => ({ removed: 0, messages: 0, undo: jest.fn(async () => 0) })),
            getAutomaticCompanionAgents: jest.fn(() => automaticCompanionAgents),
            getCompanionBatchGroups: jest.fn(() => batchGroups),
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            getLatestAssistantCompanionMessageIndex: jest.fn(() => chat.length - 1),
            getLatestCompanionResultsMessageIndex: jest.fn(() => chat.length - 1),
            getLatestValidCompanionMessageIndex: jest.fn(() => chat.length - 1),
            getRetryableCompanionAgents: jest.fn(() => retryableCompanionAgents),
            retryFailedCompanionsOnMessage: jest.fn(async () => retryableCompanionAgents.map(() => ({ status: 'done' }))),
            runAutomaticCompanionsOnMessage: jest.fn(async () => automaticCompanionAgents.map(() => ({ status: 'done' }))),
            runCompanionAgentOnMessage: jest.fn(async () => ({})),
            runCompanionsOnMessage: jest.fn(async () => ({})),
        };
        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => runner);

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/quick-settings.js', () => ({
            changeSelectedCompanionLinks: changeSelectedCompanionLinksMock,
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
            captureMessageTargetState: jest.fn(message => ({ message })),
            isMessageTargetCurrent: jest.fn(() => true),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js', () => ({
            isConversationModeActive: jest.fn(() => conversationModeActive),
            openCompanionPanel: openCompanionPanelMock,
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js');
    }

    beforeEach(() => {
        chat = [];
        eventSource = createEventSource();
        agents = [];
        companionResultsByMessage = new Map();
        popupInstances = [];
        conversationModeActive = false;
        openCompanionPanelMock = jest.fn();
        automaticCompanionAgents = [];
        retryableCompanionAgents = [];
        batchGroups = { groups: [], mismatched: new Set() };
        changeSelectedCompanionLinksMock = jest.fn((drafts, field, enabled) => {
            for (const draft of drafts) {
                draft.companion = {
                    ...draft.companion,
                    batch: enabled,
                    [field]: enabled ? drafts.filter(peer => peer !== draft).map(peer => peer.id) : [],
                };
            }
        });
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        globalThis.document = {
            querySelector: jest.fn(() => null),
        };
        globalThis.$ = jest.fn(() => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn() }));
    });

    test('partitions companion and convertible agents into their dashboard sections', async () => {
        agents = [
            { id: 'companion-1', name: 'Scene Notes', execution: 'companion', enabled: true, companion: { trigger: 'manual', format: 'text', batch: true } },
            { id: 'inline-1', name: 'Status Tracker', category: 'tracker', phase: 'pre', enabled: true },
            { id: 'tool-1', name: 'Tool Agent', category: 'tool', enabled: true },
        ];
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => agents,
            getLastAssistantMessageIndex: () => -1,
        });

        const html = dashboard.buildDashboardHtml();

        const companionsSection = html.split('data-section="companions"')[1].split('data-section="convertible"')[0];
        const convertibleSection = html.split('data-section="convertible"')[1].split('data-section="notes"')[0];

        expect(companionsSection).toContain('Scene Notes');
        expect(companionsSection).toContain('data-action="to-inline"');
        expect(companionsSection).toContain('<span>Run</span>');
        expect(companionsSection).toContain('<span>Edit</span>');
        expect(companionsSection).toContain('manual');
        expect(companionsSection).toContain('batch');
        expect(companionsSection).not.toContain('Status Tracker');

        expect(convertibleSection).toContain('Status Tracker');
        expect(convertibleSection).toContain('data-action="to-companion"');
        expect(convertibleSection).not.toContain('Tool Agent');
        expect(html).not.toContain('Tool Agent');
    });

    test('shows latest companion input and output token estimates in rows', async () => {
        agents = [{ id: 'companion-1', name: 'Scene Notes', execution: 'companion', enabled: true }];
        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'companion-1': {
                status: 'done',
                content: 'note',
                tokenUsage: { inputTokens: 1234, outputTokens: 56 },
            },
        });
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => agents,
            getLastAssistantMessageIndex: () => 0,
        });

        const html = dashboard.buildDashboardHtml();

        expect(html).toContain('Input');
        expect(html).toContain('1,234');
        expect(html).toContain('Output');
        expect(html).toContain('56');
    });

    test('shows the disabled notice and empty states when nothing is configured', async () => {
        const dashboard = await importDashboard();
        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        store.areAgentsGloballyEnabled.mockReturnValue(false);
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => [],
            getLastAssistantMessageIndex: () => -1,
        });

        const html = dashboard.buildDashboardHtml();

        expect(html).toContain('globally disabled');
        expect(html).toContain('No companion agents yet');
        expect(html).toContain('No companion notes in this chat yet');
    });

    test('collects recent done notes newest-first with truncated snippets', async () => {
        const dashboard = await importDashboard();
        agents = [{ id: 'message-inbox', name: 'Message Inbox', sourceTemplateId: 'tpl-message-inbox-companion' }];
        const oldMessage = { is_user: false, is_system: false, mes: 'old' };
        const userMessage = { is_user: true, mes: 'question' };
        const newMessage = { is_user: false, is_system: false, mes: 'new' };
        chat.push(oldMessage, userMessage, newMessage);

        companionResultsByMessage.set(oldMessage, {
            'agent-a': { status: 'done', agentName: 'Notes', content: 'x'.repeat(300) },
            'agent-b': { status: 'pending', agentName: 'Pending', content: 'still running' },
        });
        companionResultsByMessage.set(newMessage, {
            'agent-a': { status: 'done', agentName: 'Notes', content: 'fresh  note\nwith   spacing' },
            'message-inbox': { status: 'done', agentName: 'Message Inbox', content: 'phone-none' },
        });

        const entries = dashboard.collectRecentNoteEntries();

        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual(expect.objectContaining({
            messageIndex: 2,
            agentId: 'agent-a',
            agentName: 'Notes',
            snippet: 'fresh note with spacing',
        }));
        expect(entries[1].messageIndex).toBe(0);
        expect(entries[1].snippet.endsWith('…')).toBe(true);
        expect(entries[1].snippet.length).toBeLessThanOrEqual(121);
        expect(entries.some(entry => entry.agentName === 'Pending')).toBe(false);
        expect(entries.some(entry => entry.agentName === 'Message Inbox')).toBe(false);
    });

    test('resolves macros in recent note snippets with the source message context', async () => {
        const dashboard = await importDashboard();
        const message = { name: 'Mona', is_user: false, is_system: false, mes: 'the stars are bright' };
        chat.push(message);

        companionResultsByMessage.set(message, {
            'agent-a': { status: 'done', agentName: 'Notes', content: '{{user}} saw {{char}} write: {{original}}' },
        });

        const entries = dashboard.collectRecentNoteEntries();

        expect(entries).toHaveLength(1);
        expect(entries[0].snippet).toBe('Traveler saw Mona write: the stars are bright');
    });

    test('appends the wand menu item once, wires its click handler, and starts hidden in Conversation Mode', async () => {
        conversationModeActive = true;
        const dashboard = await importDashboard();
        const appended = [];
        const menuItem = { on: jest.fn(() => menuItem), toggle: jest.fn(() => menuItem) };
        let wandItemInstalled = false;
        globalThis.$ = jest.fn(arg => {
            if (arg === '#ica_companions_wand_item') {
                return { length: wandItemInstalled ? 1 : 0 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            if (arg === '#extensionsMenu') {
                return {
                    append: jest.fn(element => {
                        appended.push(element);
                        wandItemInstalled = true;
                    }),
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn() };
        });

        dashboard.initCompanionWandMenuItem();
        dashboard.initCompanionWandMenuItem();

        expect(appended).toHaveLength(1);
        expect(menuItem.on).toHaveBeenCalledWith('click', expect.any(Function));
        expect(menuItem.toggle).toHaveBeenCalledWith(false);
    });

    test('the dashboard refuses to open while Conversation Mode is active', async () => {
        conversationModeActive = true;
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => [],
            getLastAssistantMessageIndex: () => -1,
        });

        await dashboard.openCompanionDashboard();
        expect(popupInstances).toHaveLength(0);
        expect(eventSource.on).not.toHaveBeenCalled();
    });

    test('registers the results listener while open and removes it after close', async () => {
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({
            getVisibleAgents: () => [],
            getLastAssistantMessageIndex: () => -1,
        });
        const rootElement = { closest: jest.fn(() => null) };
        const root = {
            0: rootElement,
            length: 1,
            html: jest.fn(() => root),
            on: jest.fn(() => root),
        };
        globalThis.$ = jest.fn(arg => {
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return root;
            }
            return { length: 0, on: jest.fn(), append: jest.fn() };
        });

        const openPromise = dashboard.openCompanionDashboard();

        expect(eventSource.on).toHaveBeenCalledWith('companion_results_updated', expect.any(Function));
        expect(eventSource.listenerCount('companion_results_updated')).toBe(1);
        expect(popupInstances).toHaveLength(1);
        expect(popupInstances[0].options).toEqual(expect.objectContaining({ wide: true, large: true, allowVerticalScrolling: true }));

        await popupInstances[0].completeAffirmative();
        await openPromise;

        expect(eventSource.removeListener).toHaveBeenCalledWith('companion_results_updated', expect.any(Function));
        expect(eventSource.listenerCount('companion_results_updated')).toBe(0);
    });

    function openingTag(html, action) {
        return html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? '';
    }

    function fullButton(html, action) {
        return html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';
    }

    function companionRow(html, agentId) {
        const section = html.split('data-section="convertible"')[0];
        const start = section.indexOf(`data-agent-id="${agentId}"`);
        const next = section.indexOf('data-agent-id="', start + 1);
        return start < 0 ? '' : section.slice(start, next < 0 ? undefined : next);
    }

    async function flushMicrotasks() {
        for (let turn = 0; turn < 20; turn++) {
            await Promise.resolve();
        }
    }

    function openInteractiveDashboard(dashboard) {
        const handlers = new Map();
        const wrappers = new Map();
        const root = {
            0: { closest: jest.fn(() => null) },
            length: 1,
            currentHtml: '',
            html: jest.fn(value => {
                root.currentHtml = value;
                return root;
            }),
            on: jest.fn((event, selector, handler) => {
                handlers.set(`${event} ${selector}`, handler);
                return root;
            }),
        };
        globalThis.$ = jest.fn(arg => {
            if (typeof arg === 'string' && arg.trim().startsWith('<')) return root;
            return wrappers.get(arg) ?? { length: 0, on: jest.fn(), append: jest.fn() };
        });

        const openPromise = dashboard.openCompanionDashboard();
        return {
            root,
            async click(action, agentId = '') {
                const element = { dataset: { action }, disabled: false, closest: () => (agentId ? { dataset: { agentId } } : null) };
                wrappers.set(element, {
                    attr: name => (name === 'data-action' ? action : undefined),
                    closest: () => ({ attr: () => agentId }),
                    prop: jest.fn(),
                });
                await handlers.get('click [data-action]')({ currentTarget: element, preventDefault: jest.fn(), stopPropagation: jest.fn() });
            },
            select(agentId, checked = true) {
                handlers.get('change input[data-select-agent]')({ currentTarget: { dataset: { selectAgent: agentId }, checked } });
            },
            async close() {
                await popupInstances[0].completeAffirmative();
                await openPromise;
            },
        };
    }

    test('the toolbar counts automatic companions, retryable failures and saved notes', async () => {
        agents = [{ id: 'companion-1', name: 'Scene Notes', execution: 'companion', enabled: true, companion: {} }];
        chat.push({ is_user: false, is_system: false, mes: 'reply', extra: {} });
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => agents, getLastAssistantMessageIndex: () => 0 });

        let html = dashboard.buildDashboardHtml();
        expect(openingTag(html, 'run-auto')).toContain(' disabled');
        expect(openingTag(html, 'retry-failed')).toContain(' disabled');
        expect(openingTag(html, 'clean-up')).toContain(' disabled');

        automaticCompanionAgents = [agents[0]];
        retryableCompanionAgents = [agents[0], { id: 'companion-2' }];
        chat[0].extra.inChatAgentCompanionResults = { 'companion-1': { status: 'done', content: 'note', agentName: 'Scene Notes' } };
        html = dashboard.buildDashboardHtml();

        expect(openingTag(html, 'run-auto')).not.toContain(' disabled');
        expect(fullButton(html, 'run-auto')).toContain('Run automatic');
        expect(fullButton(html, 'run-auto')).toContain('<span class="ica--cdash-badge">1</span>');
        expect(openingTag(html, 'retry-failed')).toContain('message #0');
        expect(fullButton(html, 'retry-failed')).toContain('<span class="ica--cdash-badge">2</span>');
        expect(openingTag(html, 'clean-up')).not.toContain(' disabled');
        expect(runner.getAutomaticCompanionAgents).toHaveBeenCalledWith(0);
        expect(runner.getRetryableCompanionAgents).toHaveBeenCalledWith(0);
    });

    test('rows show batch groups, batch problems and the last failed run', async () => {
        agents = [
            { id: 'a', name: 'Scene Notes', execution: 'companion', enabled: true, companion: { batch: true } },
            { id: 'b', name: 'Mood Ring', execution: 'companion', enabled: true, companion: { batch: true } },
            { id: 'c', name: 'Loner', execution: 'companion', enabled: true, companion: { batch: true } },
            { id: 'd', name: 'Odd One', execution: 'companion', enabled: true, companion: { batch: true } },
        ];
        batchGroups = { groups: [['a', 'b']], mismatched: new Set(['d']) };
        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            a: { status: 'error', content: '', error: 'Request failed: 503', failureKind: 'api' },
            b: { status: 'done', content: 'calm', lastRunError: 'Companion returned no output.' },
            c: { status: 'cancelled', content: '', error: 'Cancelled.' },
        });
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => agents, getLastAssistantMessageIndex: () => 0 });

        const html = dashboard.buildDashboardHtml();

        expect(companionRow(html, 'a')).toContain('batch group 1');
        expect(companionRow(html, 'a')).toContain('title="Runs in one request with Mood Ring"');
        expect(companionRow(html, 'b')).toContain('title="Runs in one request with Scene Notes"');
        expect(companionRow(html, 'c')).toContain('batch: runs alone');
        expect(companionRow(html, 'd')).toContain('batch: settings differ');
        expect(companionRow(html, 'a')).toContain('Last run failed: Request failed: 503');
        expect(companionRow(html, 'b')).toContain('Last run failed, older note kept: Companion returned no output.');
        expect(companionRow(html, 'c')).not.toContain('Last run failed');
        expect(companionRow(html, 'a')).toContain('data-action="toggle-history"');
    });

    test('select mode batches, keeps in history and unbatches only the chosen companions', async () => {
        agents = [
            { id: 'a', name: 'Scene Notes', execution: 'companion', enabled: true, companion: {} },
            { id: 'b', name: 'Mood Ring', execution: 'companion', enabled: true, companion: {} },
            { id: 'c', name: 'Watcher', execution: 'companion', enabled: true, companion: { batch: true, batchAgentIds: ['a'] } },
        ];
        chat.push({ is_user: false, is_system: false, mes: 'reply' });
        const saveCompanionAgents = jest.fn(async drafts => {
            for (const draft of drafts) {
                agents[agents.findIndex(agent => agent.id === draft.id)] = draft;
            }
        });
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => agents, getLastAssistantMessageIndex: () => 0, saveCompanionAgents });
        const view = openInteractiveDashboard(dashboard);

        await view.click('mode-select');
        expect(view.root.currentHtml).toContain('ica--cdash-bulkbar');
        expect(view.root.currentHtml).toContain('data-select-agent="a"');
        expect(openingTag(view.root.currentHtml, 'bulk-batch')).toContain(' disabled');

        view.select('a');
        view.select('b');
        expect(view.root.currentHtml).toContain('2 selected');
        expect(openingTag(view.root.currentHtml, 'bulk-batch')).not.toContain(' disabled');

        batchGroups = { groups: [['a', 'b']], mismatched: new Set() };
        const originalA = agents[0];
        await view.click('bulk-batch');
        expect(changeSelectedCompanionLinksMock).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })], 'batchAgentIds', true);
        expect(changeSelectedCompanionLinksMock.mock.calls[0][0][0]).not.toBe(originalA);
        expect(saveCompanionAgents).toHaveBeenLastCalledWith(expect.any(Array), 'Companion batch');
        expect(globalThis.toastr.success).toHaveBeenLastCalledWith('2 companions now run in one request.');

        await view.click('bulk-history-on');
        expect(saveCompanionAgents).toHaveBeenLastCalledWith([
            expect.objectContaining({ id: 'a', companion: expect.objectContaining({ includeInChatHistory: true }) }),
            expect.objectContaining({ id: 'b', companion: expect.objectContaining({ includeInChatHistory: true }) }),
        ], 'Chat history');

        await view.click('bulk-unbatch');
        const unbatched = saveCompanionAgents.mock.calls.at(-1)[0];
        expect(unbatched.map(agent => agent.id).sort()).toEqual(['a', 'b', 'c']);
        expect(unbatched.find(agent => agent.id === 'a').companion).toEqual(expect.objectContaining({ batch: false, batchAgentIds: [] }));
        expect(unbatched.find(agent => agent.id === 'c').companion).toEqual(expect.objectContaining({ batch: false, batchAgentIds: [] }));

        batchGroups = { groups: [], mismatched: new Set(['a', 'b']) };
        await view.click('bulk-batch');
        expect(globalThis.toastr.warning).toHaveBeenLastCalledWith(expect.stringContaining('still run in separate requests'));

        await view.close();
    });

    test('a second agent change waits until the first save finishes', async () => {
        agents = [
            { id: 'a', name: 'Scene Notes', execution: 'companion', enabled: true, companion: {} },
            { id: 'b', name: 'Mood Ring', execution: 'companion', enabled: true, companion: {} },
        ];
        chat.push({ is_user: false, is_system: false, mes: 'reply' });
        let finishSave = () => {};
        const saveCompanionAgents = jest.fn(() => new Promise(resolve => {
            finishSave = resolve;
        }));
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => agents, getLastAssistantMessageIndex: () => 0, saveCompanionAgents });
        const view = openInteractiveDashboard(dashboard);

        await view.click('mode-select');
        view.select('a');
        view.select('b');
        const firstSave = view.click('bulk-batch');
        await flushMicrotasks();
        expect(saveCompanionAgents).toHaveBeenCalledTimes(1);
        expect(openingTag(view.root.currentHtml, 'bulk-unbatch')).toContain(' disabled');
        expect(openingTag(view.root.currentHtml, 'bulk-history-on')).toContain(' disabled');
        expect(openingTag(view.root.currentHtml, 'select-none')).not.toContain(' disabled');

        await view.click('bulk-unbatch');
        expect(globalThis.toastr.info).toHaveBeenLastCalledWith('Still saving the last change. Try again in a moment.');
        expect(saveCompanionAgents).toHaveBeenCalledTimes(1);

        finishSave();
        await firstSave;
        const secondSave = view.click('bulk-history-on');
        await flushMicrotasks();
        finishSave();
        await secondSave;
        expect(saveCompanionAgents).toHaveBeenCalledTimes(2);

        await view.close();
    });

    test('reorder mode moves companions with Up and Down', async () => {
        agents = ['a', 'b', 'c'].map((id, index) => ({ id, name: `Companion ${id}`, execution: 'companion', enabled: true, companion: {}, injection: { order: index * 10 } }));
        const reorderCompanionAgents = jest.fn(async () => {});
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => [...agents].reverse(), getLastAssistantMessageIndex: () => -1, reorderCompanionAgents });
        const view = openInteractiveDashboard(dashboard);

        await view.click('mode-reorder');
        expect(view.root.currentHtml).toContain('ica--cdash-drag-handle');
        expect(openingTag(companionRow(view.root.currentHtml, 'a'), 'move-up')).toContain(' disabled');
        expect(openingTag(companionRow(view.root.currentHtml, 'c'), 'move-down')).toContain(' disabled');

        await view.click('move-down', 'a');
        expect(reorderCompanionAgents).toHaveBeenLastCalledWith(['b', 'a', 'c']);
        await view.click('move-up', 'c');
        expect(reorderCompanionAgents).toHaveBeenLastCalledWith(['a', 'c', 'b']);
        await view.click('move-up', 'a');
        expect(reorderCompanionAgents).toHaveBeenCalledTimes(2);

        await view.close();
    });

    test('retry and automatic run buttons target the latest message and report the outcome', async () => {
        agents = [{ id: 'a', name: 'Scene Notes', execution: 'companion', enabled: true, companion: {} }];
        chat.push({ is_user: true, mes: 'hi' }, { is_user: false, is_system: false, mes: 'reply' });
        automaticCompanionAgents = [agents[0]];
        retryableCompanionAgents = [agents[0]];
        const dashboard = await importDashboard();
        dashboard.configureCompanionDashboard({ getVisibleAgents: () => agents, getLastAssistantMessageIndex: () => 1 });
        const view = openInteractiveDashboard(dashboard);

        await view.click('run-auto');
        expect(runner.runAutomaticCompanionsOnMessage).toHaveBeenCalledWith(1);

        await view.click('retry-failed');
        expect(runner.retryFailedCompanionsOnMessage).toHaveBeenCalledWith(1);
        expect(globalThis.toastr.success).toHaveBeenLastCalledWith('Retried 1 companion.');

        runner.retryFailedCompanionsOnMessage.mockResolvedValueOnce([{ status: 'error', error: 'Request failed' }]);
        await view.click('retry-failed');
        expect(globalThis.toastr.warning).toHaveBeenLastCalledWith('1 companion failed again. Check the connection, then retry.');

        retryableCompanionAgents = [];
        await view.click('retry-failed');
        expect(globalThis.toastr.info).toHaveBeenLastCalledWith('Nothing to retry on the latest message.');
        expect(runner.retryFailedCompanionsOnMessage).toHaveBeenCalledTimes(2);

        await view.close();
    });
});
