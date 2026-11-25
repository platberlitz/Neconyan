/* global globalThis */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('companion tracker panel', () => {
    let chat;
    let eventSource;
    let agents;
    let companionResultsByMessage;
    let globallyEnabled;
    let chatTokenEstimate;
    let automaticCompanionAgents;
    let retryableCompanionAgents;
    let accountStorageValues;
    let accountStorage;
    let hiddenAgentIds;
    let powerUser;
    let translatedKeys;
    let initCompanionWindowsMock;
    let formatCompanionContentMock;
    let isCompanionRunStoppableMock;
    let stopCompanionRunMock;
    let stopServerReplyCompanionMock;

    function buttonTag(html, action) {
        return html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? '';
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
            removeListener: jest.fn(),
        };
    }

    async function importPanel() {
        jest.resetModules();
        isCompanionRunStoppableMock = jest.fn(() => true);
        stopCompanionRunMock = jest.fn(async () => true);
        stopServerReplyCompanionMock = jest.fn(async () => true);
        initCompanionWindowsMock = jest.fn();
        formatCompanionContentMock = jest.fn((agentId, result) => `<formatted>${result.content}</formatted>`);

        await jest.unstable_mockModule('../public/scripts/ui-motion.js', () => ({
            setUiVisibility: jest.fn((element, open, apply) => apply(open)),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/plot-compass-context.js', () => ({
            getPlotCompassIdentity: () => ({ avatar: 'character.png', chatId: 'chat-1' }),
        }));

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            chat_metadata: {},
            getCurrentChatId: jest.fn(() => 'chat-1'),
            getShortModelName: jest.fn(model => String(model ?? '').split('/').pop()),
        }));

        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
            power_user: powerUser,
        }));

        // The real i18n.js needs more of power-user.js than this suite provides. This one records each key and returns the English text.
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => {
                translatedKeys.push(strings.reduce((key, part, index) => key + part + (index < values.length ? `\${${index}}` : ''), ''));
                return strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), '');
            },
        }));

        await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
            accountStorage,
        }));

        await jest.unstable_mockModule('../public/scripts/chats.js', () => ({
            hideChatMessageRange: jest.fn(async () => {}),
        }));

        await jest.unstable_mockModule('../public/scripts/popup.js', () => ({
            Popup: class {
                async show() {
                    return 1;
                }
            },
            POPUP_TYPE: { CONFIRM: 1 },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
        }));

        await jest.unstable_mockModule('../public/scripts/events.js', () => ({
            eventSource,
            event_types: {
                CHAT_CHANGED: 'chat_changed',
                MESSAGE_DELETED: 'message_deleted',
                MESSAGE_SWIPED: 'message_swiped',
            },
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => globallyEnabled),
            getAgentById: jest.fn(id => agents.find(agent => agent.id === id)),
            getAgents: jest.fn(() => agents),
            getCompanionConfig: jest.fn(agent => ({
                trigger: agent?.companion?.trigger === 'manual' ? 'manual' : 'auto',
                displayMode: agent?.companion?.displayMode ?? 'panel',
            })),
            getHiddenAgentIds: jest.fn(() => new Set(hiddenAgentIds)),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isAgentHidden: jest.fn(agentId => hiddenAgentIds.has(String(agentId ?? '').trim())),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
            reorderAgentsIntoOrderSlots: jest.fn(async () => false),
            saveAgent: jest.fn(async (id, { update }) => {
                const agent = agents.find(agent => agent.id === id);
                Object.assign(agent, update(structuredClone(agent)));
            }),
            setHiddenAgentIds: jest.fn(ids => {
                hiddenAgentIds = new Set([...ids].map(id => String(id ?? '').trim()).filter(Boolean));
            }),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
            captureMessageTargetState: jest.fn(message => ({ message, swipe: message?.swipe_id })),
            isMessageTargetCurrent: jest.fn((message, target) => message === target.message && message.swipe_id === target.swipe),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/view-state.js', () => ({
            patchCompanionView: jest.fn((root, html) => root.html(html)),
            runCompanionViewAction: jest.fn((button, action) => action()),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-windows.js', () => ({
            initCompanionWindows: initCompanionWindowsMock,
            openCompanionWindow: jest.fn(() => true),
            refreshCompanionWindows: jest.fn(),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            COMPANION_RESULTS_UPDATED_EVENT: 'companion_results_updated',
            captureCompanionResultTarget: jest.fn(() => () => true),
            getAutomaticCompanionAgents: jest.fn(() => automaticCompanionAgents),
            getCompanionCoveredMessageIndices: jest.fn((index, agentId) => companionResultsByMessage.get(chat[index])?.[agentId]?.contextCoverage ?? []),
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            getDisplayedCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            isCompanionRunStoppable: isCompanionRunStoppableMock,
            isServerReplyCompanionStopping: jest.fn(() => false),
            stopCompanionRun: stopCompanionRunMock,
            stopServerReplyCompanion: stopServerReplyCompanionMock,
            getLatestAssistantCompanionMessageIndex: jest.fn(() => chat.length - 1),
            getLatestCompanionResultsMessageIndex: jest.fn(() => chat.length - 1),
            getLatestValidCompanionMessageIndex: jest.fn(() => chat.length - 1),
            getRetryableCompanionAgents: jest.fn(() => retryableCompanionAgents),
            meetsCompanionContextThreshold: jest.fn(agent => !agent?.companion?.minContextTokens || agent.companion.minContextTokens <= chatTokenEstimate),
            retryFailedCompanionsOnMessage: jest.fn(async () => retryableCompanionAgents.map(() => ({ status: 'done' }))),
            runAutomaticCompanionsOnMessage: jest.fn(async () => automaticCompanionAgents.map(() => ({ status: 'done' }))),
            runCompanionAgentOnMessage: jest.fn(async () => ({ status: 'done' })),
            runPlotCompassBeforeConversation: jest.fn(async () => ({ status: 'done' })),
            runCompanionsOnMessage: jest.fn(async () => ({})),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
            buildLastRunErrorNotice: jest.fn(() => ''),
            cleanCompanionAgentName: jest.fn(name => String(name ?? '').trim() || 'Companion'),
            editCompanionResult: jest.fn(async () => {}),
            formatCompanionContent: formatCompanionContentMock,
            getChatroomReplyRunOptions: jest.fn((agentId, messageIndex, viewerText) => ({
                extraContextSections: [{ title: 'Viewer reply', content: viewerText }],
            })),
            insertChoiceIntoMessageInput: jest.fn(() => true),
            togglePlotCompassChoice: jest.fn(async () => false),
            refreshCompanionCards: jest.fn(),
            isSilentCompanionAgent: jest.fn(agent => String(agent?.sourceTemplateId ?? agent?.id ?? '') === 'tpl-message-inbox-companion'),
            isSuppressedCompanionResult: jest.fn((agentId, result) =>
                ['PHONE_NONE', 'phone-none', 'TRACKER_NONE', 'tracker-none'].includes(String(result?.content ?? '').trim())),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-runner.js', () => ({
            captureMessageTargetState: jest.fn(() => ({})),
            isMessageTargetCurrent: jest.fn(() => true),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js');
    }

    beforeEach(() => {
        translatedKeys = [];
        chat = [];
        eventSource = createEventSource();
        agents = [];
        companionResultsByMessage = new Map();
        globallyEnabled = true;
        chatTokenEstimate = 0;
        automaticCompanionAgents = [];
        retryableCompanionAgents = [];
        accountStorageValues = new Map();
        accountStorage = {
            getItem: jest.fn(key => accountStorageValues.get(key) ?? null),
            setItem: jest.fn((key, value) => accountStorageValues.set(key, String(value))),
        };
        hiddenAgentIds = new Set();
        powerUser = { timestamp_model_name_short: false };
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        globalThis.document = {
            body: {},
            querySelector: jest.fn(() => null),
            addEventListener: jest.fn(),
        };
        globalThis.$ = jest.fn(() => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() }));
    });

    test('collects the latest state and the full history per agent', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        agents = [tracker];
        const panel = await importPanel();

        for (let index = 0; index < 8; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                'tracker-1': { status: 'done', content: `state ${index}`, agentName: 'Scene Tracker' },
            });
        }

        const states = panel.collectPanelAgentStates();

        expect(states).toHaveLength(1);
        expect(states[0].latest.messageIndex).toBe(7);
        expect(states[0].latest.result.content).toBe('state 7');
        expect(states[0].history).toHaveLength(7);
        expect(states[0].history[0].messageIndex).toBe(6);
        expect(states[0].history.at(-1).messageIndex).toBe(0);
    });

    test('puts the local Dice Roller widget in the panel instead of a note or run state', async () => {
        agents = [{
            id: 'dice-1', name: 'Dice Roller', icon: 'fa-dice-d20', execution: 'companion', category: 'companion',
            sourceTemplateId: 'tpl-dice-roller-companion', enabled: true, companion: { displayMode: 'panel', trigger: 'manual' },
        }];
        const panel = await importPanel();
        const html = panel.buildPanelHtml();
        expect(html).toContain('data-neco-dice-host="true"');
        expect(html).toContain('data-neco-dice-agent="dice-1"');
        expect(html).toContain('data-neco-dice-surface="panel"');
        expect(html).not.toContain('No state yet');
        expect(html).not.toContain('data-action="panel-regenerate"');
        expect(html).not.toContain('data-action="panel-fix"');
    });

    test('shows live notes ahead of saved history without exposing saved-message actions', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        const saved = { is_user: false, mes: 'Saved reply' };
        const preview = { is_user: false, mes: 'Live reply', extra: { inChatAgentCompanionResults: {} } };
        chat.push(saved);
        companionResultsByMessage.set(saved, { 'tracker-1': { status: 'done', content: 'Previous state' } });
        companionResultsByMessage.set(preview, { 'tracker-1': { status: 'done', content: 'Ready before the last Companion' } });
        const panel = await importPanel();
        panel.initCompanionPanel();
        const listeners = new Map(globalThis.document.addEventListener.mock.calls);
        const element = { isConnected: true };
        listeners.get('neconyan:roleplay-preview-rendered')({ detail: { element, message: preview } });

        const [state] = panel.collectPanelAgentStates();
        expect(state.latest.preview).toBe(preview);
        expect(state.latest.result.content).toBe('Ready before the last Companion');
        expect(state.history[0].result.content).toBe('Previous state');
        const html = panel.buildPanelHtml();
        expect(html).toContain('data-roleplay-draft="true"');
        expect(html).toContain('Ready before the last Companion');
        for (const action of ['panel-edit-note', 'panel-regenerate', 'panel-fix', 'panel-run-latest', 'panel-jump', 'panel-edit', 'panel-open-window', 'panel-hide']) {
            expect(buttonTag(html, action)).toContain(' disabled');
        }
        expect(buttonTag(html, 'panel-regenerate-all')).toContain(' disabled');
        expect(buttonTag(html, 'panel-run-auto')).toContain(' disabled');
        expect(html).not.toContain('data-action="panel-stop"');
        expect(chat).toEqual([saved]);

        element.isConnected = false;
        listeners.get('neconyan:roleplay-preview-removed')({ detail: { element } });
        expect(panel.collectPanelAgentStates()[0].latest.result.content).toBe('Previous state');
        expect(buttonTag(panel.buildPanelHtml(), 'panel-edit-note')).not.toContain(' disabled');
    });

    test('keeps every button in place but greyed out while a companion writes, except Stop', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        const message = { is_user: false, is_system: false, mes: 'Reply' };
        chat.push(message);
        companionResultsByMessage.set(message, { 'tracker-1': { status: 'pending', content: '' } });
        const panel = await importPanel();

        let html = panel.buildPanelHtml();
        const stop = buttonTag(html, 'panel-stop');
        expect(html).toMatch(/data-action="panel-stop"[^>]*><i class="fa-solid fa-stop"><\/i>/);
        expect(stop).not.toContain(' disabled');
        expect(html.indexOf('data-action="panel-stop"')).toBeLessThan(html.indexOf('data-action="panel-hide"'));
        for (const action of ['panel-hide', 'panel-run-latest', 'panel-regenerate', 'panel-fix', 'panel-edit-note', 'panel-open-window', 'panel-edit', 'panel-jump', 'panel-regenerate-all', 'panel-run-auto']) {
            expect(buttonTag(html, action)).toContain(' disabled');
        }
        expect(html).toMatch(/ica--tpanel-drag-handle"[^>]* disabled/);

        isCompanionRunStoppableMock.mockReturnValue(false);
        expect(buttonTag(panel.buildPanelHtml(), 'panel-stop')).toContain(' disabled');

        companionResultsByMessage.set(message, { 'tracker-1': { status: 'done', content: 'Ready' } });
        html = panel.buildPanelHtml();
        expect(html).not.toContain('data-action="panel-stop"');
        for (const action of ['panel-hide', 'panel-run-latest', 'panel-regenerate', 'panel-edit-note', 'panel-jump', 'panel-regenerate-all']) {
            expect(buttonTag(html, action)).not.toContain(' disabled');
        }
    });

    function bindPanelActions(panel, sectionAttributes) {
        const panelElement = {
            on: jest.fn(() => panelElement),
            html: jest.fn(() => panelElement),
            toggle: jest.fn(() => panelElement),
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
            removeClass: jest.fn(() => panelElement),
            0: { addEventListener: jest.fn(), dataset: {} },
        };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement), attr: jest.fn(() => handleElement) };
        const actionButton = {};
        const section = { attr: jest.fn(name => sectionAttributes[name]) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) return { append: jest.fn() };
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-stop' : undefined)),
                    closest: jest.fn(() => section),
                    prop: jest.fn(),
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });
        panel.initCompanionPanel();
        const handler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        return () => handler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });
    }

    test('Stop in the panel stops that companion only', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        const message = { is_user: false, is_system: false, mes: 'Reply' };
        chat.push(message);
        companionResultsByMessage.set(message, { 'tracker-1': { status: 'pending', content: '' } });
        const panel = await importPanel();
        const clickStop = bindPanelActions(panel, { 'data-agent-id': 'tracker-1', 'data-message-index': '0' });

        await clickStop();
        expect(stopCompanionRunMock).toHaveBeenCalledWith(0, 'tracker-1');
        expect(stopServerReplyCompanionMock).not.toHaveBeenCalled();
        expect(globalThis.toastr.info).not.toHaveBeenCalled();

        stopCompanionRunMock.mockResolvedValueOnce(false);
        await clickStop();
        expect(globalThis.toastr.info).toHaveBeenCalledWith('This companion cannot be stopped yet. Try again in a moment.');
    });

    test('Stop on a live reply companion asks the server reply job to stop it', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        const preview = { is_user: false, mes: 'Live reply', extra: { inChatAgentCompanionResults: {} } };
        companionResultsByMessage.set(preview, { 'tracker-1': { status: 'pending', content: '' } });
        const panel = await importPanel();
        const clickStop = bindPanelActions(panel, { 'data-agent-id': 'tracker-1', 'data-roleplay-draft': 'true' });
        const listeners = new Map(globalThis.document.addEventListener.mock.calls);
        listeners.get('neconyan:roleplay-preview-rendered')({ detail: { element: { isConnected: true, dataset: {} }, message: preview, jobId: 'job-7' } });

        expect(buttonTag(panel.buildPanelHtml(), 'panel-stop')).not.toContain(' disabled');
        await clickStop();
        expect(stopServerReplyCompanionMock).toHaveBeenCalledWith('job-7', 'tracker-1');
        expect(stopCompanionRunMock).not.toHaveBeenCalled();
    });

    test('shows a model pill on the latest note that follows Short Model Name', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        const panel = await importPanel();
        const message = { is_user: false, is_system: false, mes: 'latest reply' };
        chat.push(message);
        const setResult = result => companionResultsByMessage.set(message, {
            'tracker-1': { status: 'done', content: 'state', agentName: 'Scene Tracker', ...result },
        });

        setResult({ model: 'moonshot/kimi-k3' });
        let html = panel.buildPanelHtml();
        expect(html.match(/ica--card-pill--model/g)).toHaveLength(1);
        expect(html).toContain('<span>moonshot/kimi-k3</span>');

        powerUser.timestamp_model_name_short = true;
        html = panel.buildPanelHtml();
        expect(html).toContain('title="Model: moonshot/kimi-k3"');
        expect(html).toContain('<span>kimi-k3</span>');

        setResult({ modelLabel: 'deepseek/deepseek-chat' });
        expect(panel.buildPanelHtml()).toContain('<span>deepseek-chat</span>');

        setResult({ modelLabel: 'Main model' });
        expect(panel.buildPanelHtml()).not.toContain('ica--card-pill--model');
    });

    test('orders panel sections by agents-page order with orphans last', async () => {
        agents = [
            { id: 'last-by-order', name: 'CYOA Choices', execution: 'companion', enabled: true, injection: { order: 900 } },
            { id: 'first-by-order', name: 'Scene Tracker', execution: 'companion', enabled: true, injection: { order: 10 } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'orphan-agent': { status: 'done', content: 'orphan', agentName: 'Old Tracker' },
            'last-by-order': { status: 'done', content: 'choices', agentName: 'CYOA Choices' },
            'first-by-order': { status: 'done', content: 'scene', agentName: 'Scene Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states.map(state => state.agentId)).toEqual(['first-by-order', 'last-by-order', 'orphan-agent']);
    });

    test('clamps the draggable handle position fraction', async () => {
        const panel = await importPanel();

        expect(panel.clampHandleTopFraction(0.5)).toBe(0.5);
        expect(panel.clampHandleTopFraction(-2)).toBe(0.08);
        expect(panel.clampHandleTopFraction(1.4)).toBe(0.92);
        expect(panel.clampHandleTopFraction('nonsense')).toBe(0.5);
    });

    test('snaps the handle dock to the nearest viewport edge', async () => {
        const panel = await importPanel();

        expect(panel.resolveHandleDock(390, 300, 400, 800)).toEqual({ edge: 'right', fraction: 0.375 });
        expect(panel.resolveHandleDock(5, 700, 400, 800)).toEqual({ edge: 'left', fraction: 0.875 });
        expect(panel.resolveHandleDock(200, 10, 400, 800)).toEqual({ edge: 'top', fraction: 0.5 });
        expect(panel.resolveHandleDock(360, 790, 400, 800)).toEqual({ edge: 'bottom', fraction: 0.9 });
        expect(panel.resolveHandleDock(2, 2, 400, 800).fraction).toBe(0.08);
    });

    test('parses stored handle positions including the legacy number form', async () => {
        const panel = await importPanel();

        expect(panel.parseStoredHandlePosition('0.4')).toEqual({ edge: 'right', fraction: 0.4 });
        expect(panel.parseStoredHandlePosition(JSON.stringify({ edge: 'bottom', fraction: 0.25 }))).toEqual({ edge: 'bottom', fraction: 0.25 });
        expect(panel.parseStoredHandlePosition('garbage')).toBeNull();
        expect(panel.parseStoredHandlePosition(JSON.stringify({ edge: 'diagonal', fraction: 0.5 }))).toBeNull();
        expect(panel.parseStoredHandlePosition(null)).toBeNull();
    });

    test('includes enabled companions without stored state and orphaned results', async () => {
        agents = [{ id: 'fresh', name: 'Fresh Companion', execution: 'companion', enabled: true }];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'deleted-agent': { status: 'done', content: 'orphan state', agentName: 'Old Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        const fresh = states.find(state => state.agent?.id === 'fresh');
        expect(fresh).toBeDefined();
        expect(fresh.latest).toBeNull();

        const orphan = states.find(state => state.latest?.result?.content === 'orphan state');
        expect(orphan).toBeDefined();
        expect(orphan.agent).toBeNull();
    });

    test('shows Message Inbox while suppressing empty no-message results', async () => {
        const inbox = {
            id: 'message-inbox',
            name: 'Message Inbox',
            sourceTemplateId: 'tpl-message-inbox-companion',
            execution: 'companion',
            enabled: true,
            companion: { displayMode: 'panel' },
        };
        agents = [inbox];
        const panel = await importPanel();

        const initialHtml = panel.buildPanelHtml();
        expect(initialHtml).toContain('Message Inbox');
        expect(initialHtml).toContain('No state yet');

        const emptyMessage = { is_user: false, is_system: false, mes: 'reply without a text' };
        chat.push(emptyMessage);
        companionResultsByMessage.set(emptyMessage, {
            'message-inbox': { status: 'done', content: 'phone-none', agentName: 'Message Inbox' },
        });

        const waitingStates = panel.collectPanelAgentStates();
        expect(waitingStates).toHaveLength(1);
        expect(waitingStates[0].agent?.id).toBe('message-inbox');
        expect(waitingStates[0].latest).toBeNull();

        const waitingHtml = panel.buildPanelHtml();
        expect(waitingHtml).toContain('Message Inbox');
        expect(waitingHtml).toContain('No state yet');
        expect(waitingHtml).not.toContain('phone-none');

        const textMessage = { is_user: false, is_system: false, mes: 'reply with a text' };
        chat.push(textMessage);
        companionResultsByMessage.set(textMessage, {
            'message-inbox': { status: 'done', content: 'phone-start|Messages|now\nphone-text|Mona|now|Where are you?\nphone-end', agentName: 'Message Inbox' },
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('Message Inbox');
        expect(html).toContain('<formatted>phone-start|Messages|now');
    });

    test('builds panel sections with state, actions, and empty states', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        const fresh = { id: 'fresh', name: 'Fresh Companion', execution: 'companion', enabled: true, companion: { trigger: 'manual' } };
        agents = [tracker, fresh];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'tracker-1': {
                status: 'done',
                content: 'Sumeru City Market',
                agentName: 'Scene Tracker',
                tokenUsage: { inputTokens: 321, outputTokens: 45 },
            },
        });

        const html = panel.buildPanelHtml();

        expect(html).toContain('Companions');
        expect(html).toContain('Scene Tracker');
        expect(html).toContain('<formatted>Sumeru City Market</formatted>');
        expect(html).toContain('data-action="panel-regenerate"');
        expect(html).toContain('data-action="panel-fix"');
        expect(html).toContain('data-action="panel-edit-note"');
        expect(html).toContain('data-action="panel-edit"');
        expect(html).toContain('data-action="panel-jump"');
        expect(html).toContain('data-action="panel-lock"');
        expect(html).toContain('data-action="panel-run-latest"');
        expect(html).toContain('data-action="panel-open-window"');
        expect(html).toContain('data-action="panel-regenerate-all"');
        expect(html).toContain('data-message-index="0"');
        expect(html).toContain('Input');
        expect(html).toContain('321');
        expect(html).toContain('Output');
        expect(html).toContain('45');
        expect(html).toContain('No state yet');

        // Neconyan: the per-companion Play button must remain visible after a companion has
        // already produced state, otherwise manual companions can only regenerate the first run
        // and never pick up a newer assistant reply from the draggable panel.
        expect(html).toMatch(/<section class="ica--tpanel-agent"[\s\S]*?data-message-index="0"[\s\S]*?data-action="panel-run-latest"[\s\S]*?<\/section>/);
    });

    test('offers labelled Run all, Run automatic and Run failed again buttons under the panel header', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } }];
        chat.push({ is_user: false, is_system: false, mes: 'reply' });
        const panel = await importPanel();

        let html = panel.buildPanelHtml();
        expect(html).toMatch(/data-action="panel-run-auto"[^>]*disabled/);
        expect(html).not.toContain('data-action="panel-retry-failed"');

        automaticCompanionAgents = [agents[0]];
        retryableCompanionAgents = [agents[0], { id: 'other' }];
        html = panel.buildPanelHtml();

        expect(html).not.toMatch(/data-action="panel-run-auto"[^>]*disabled/);
        expect(html).toContain('Run the 1 automatic companion on the latest reply');
        expect(html).toContain('<span>Run all</span>');
        expect(html).toContain('<span>Run automatic</span>');
        expect(html).toMatch(/<div class="ica--tpanel-header">[\s\S]*?<\/div>\s*<div class="ica--tpanel-run" role="group" aria-label="Run companions">/);
        expect(html).toContain('data-action="panel-retry-failed"');
        expect(html).toContain('Run the 2 companions that failed on message #0 again');
        expect(html).toContain('<span>Run failed again</span>');
        expect(html).toContain('<span class="ica--tpanel-action-count">2</span>');

        globallyEnabled = false;
        html = panel.buildPanelHtml();
        expect(html).toMatch(/data-action="panel-regenerate-all"[^>]*disabled/);
        expect(html).not.toContain('data-action="panel-run-auto"');
    });

    test('keeps the visible companion anchored while pending cards replace completed content', async () => {
        const agentIds = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];
        agents = agentIds.map((id, index) => ({
            id,
            name: `Agent ${index + 1}`,
            execution: 'companion',
            enabled: true,
            companion: { displayMode: 'panel' },
        }));
        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        const setResults = status => companionResultsByMessage.set(message, Object.fromEntries(agentIds.map(id => [id, {
            status,
            content: `${id} state`,
            agentName: id,
        }])));
        setResults('done');
        const panel = await importPanel();

        let naturalHeights = [150, 150, 150, 150];
        let sections = [];
        let hasPendingCards = false;
        let scrollTop = 0;
        const panelNode = {
            clientHeight: 200,
            getBoundingClientRect: () => ({ top: 0, bottom: 200, height: 200 }),
            querySelectorAll: () => sections,
        };
        const pendingNodes = [null, {}];
        const getSectionHeight = section => Math.max(section.naturalHeight, Number.parseFloat(section.style.minHeight) || 0);
        const getTotalHeight = () => sections.reduce((total, section) => total + getSectionHeight(section), 0);
        Object.defineProperty(panelNode, 'scrollTop', {
            get: () => scrollTop,
            set: value => {
                scrollTop = Math.max(0, Math.min(Number(value), Math.max(0, getTotalHeight() - panelNode.clientHeight)));
            },
        });
        const createSection = (agentId, index) => {
            const section = {
                naturalHeight: naturalHeights[index],
                style: {},
                getAttribute: () => agentId,
                querySelector: () => pendingNodes[Number(hasPendingCards)],
                getBoundingClientRect: () => {
                    const top = sections.slice(0, index).reduce((total, item) => total + getSectionHeight(item), 0) - panelNode.scrollTop;
                    const height = getSectionHeight(section);
                    return { top, bottom: top + height, height };
                },
            };
            return section;
        };
        const panelElement = {
            0: panelNode,
            length: 1,
            html: jest.fn(html => {
                hasPendingCards = html.includes('ica--companion-pending');
                sections = agentIds.map(createSection);
                panelNode.scrollTop = scrollTop;
                return panelElement;
            }),
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
        };
        const jqueryElements = new Map([['#ica--tracker-panel', panelElement]]);
        globalThis.$ = jest.fn(selector => jqueryElements.get(selector) ?? { length: 0, attr: jest.fn() });

        panel.openCompanionPanel();
        panelNode.scrollTop = 320;
        const anchorOffset = sections[2].getBoundingClientRect().top;
        expect(anchorOffset).toBe(-20);

        naturalHeights = [40, 40, 40, 40];
        setResults('pending');
        panel.refreshCompanionPanel();
        expect(sections[2].getBoundingClientRect().top).toBe(anchorOffset);
        expect(sections.map(section => section.style.minHeight)).toEqual(['150px', '150px', '150px', '150px']);

        naturalHeights = [90, 200, 100, 170];
        setResults('done');
        panel.refreshCompanionPanel();
        expect(sections[2].getBoundingClientRect().top).toBe(anchorOffset);
        expect(sections.map(section => section.style.minHeight)).toEqual([undefined, undefined, undefined, undefined]);
    });

    test('keeps hidden companions unhideable from the collapsed panel row', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } };
        agents = [tracker];
        hiddenAgentIds = new Set(['tracker-1']);
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'tracker-1': { status: 'done', content: 'Hidden state', agentName: 'Scene Tracker' },
        });

        const html = panel.buildPanelHtml();

        expect(html).toContain('data-agent-id="tracker-1" data-message-index="0" data-hidden="true"');
        expect(html).toContain('data-action="panel-hide"');
        expect(html).toContain('aria-label="Unhide companion"');
        expect(html).toContain('data-action="panel-run-latest"');
    });

    test('renders edit buttons with per-entry message indices on history entries', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true };
        agents = [tracker];
        const panel = await importPanel();

        for (let index = 0; index < 3; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                'tracker-1': { status: 'done', content: `state ${index}`, agentName: 'Scene Tracker' },
            });
        }

        panel.revealPanelHistory('tracker-1');
        const html = panel.buildPanelHtml();

        expect(html).toContain('Previous states (2)');
        expect(html).toMatch(/ica--tpanel-history-entry[\s\S]*?data-message-index="1"/);
        expect(html).toMatch(/ica--tpanel-history-entry[\s\S]*?data-message-index="0"/);
        const editNoteMatches = html.match(/data-action="panel-edit-note"/g);
        expect(editNoteMatches).toHaveLength(3);
    });

    test('lists every earlier note, not only the newest five', async () => {
        const tracker = { id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true };
        agents = [tracker];
        const panel = await importPanel();

        for (let index = 0; index < 12; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                'tracker-1': { status: 'done', content: `state ${index}`, agentName: 'Scene Tracker' },
            });
        }

        const [state] = panel.collectPanelAgentStates();
        expect(state.latest.messageIndex).toBe(11);
        expect(state.history.map(entry => entry.messageIndex)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
        const closed = panel.buildPanelHtml();
        expect(closed).toContain('Previous states (11)');
        expect(closed).not.toContain('class="ica--tpanel-history-entry"');

        panel.revealPanelHistory('tracker-1', 5);
        const firstPage = panel.buildPanelHtml();
        expect(firstPage.match(/class="ica--tpanel-history-entry"/g)).toHaveLength(5);
        expect(firstPage).toContain('Showing 5 of 11');
        expect(firstPage).toContain('data-action="panel-history-more"');

        panel.revealPanelHistory('tracker-1', 20);
        const everything = panel.buildPanelHtml();
        expect(everything.match(/class="ica--tpanel-history-entry"/g)).toHaveLength(11);
        expect(everything).not.toContain('data-action="panel-history-more"');
    });

    test('shows lorebook actions on every stored state only for tagged agents', async () => {
        const scout = { id: 'scout', name: 'Lorebook Scout', execution: 'companion', enabled: true, tags: ['LoreBook'] };
        agents = [scout];
        const panel = await importPanel();

        for (let index = 0; index < 3; index++) {
            const message = { is_user: false, is_system: false, mes: `reply ${index}` };
            chat.push(message);
            companionResultsByMessage.set(message, {
                scout: { status: 'done', content: `state ${index}`, agentName: 'Lorebook Scout' },
            });
        }

        panel.revealPanelHistory('scout');
        expect(panel.buildPanelHtml().match(/data-action="panel-send-to-lorebook"/g)).toHaveLength(3);

        scout.tags = ['notes'];
        expect(panel.buildPanelHtml()).not.toContain('data-action="panel-send-to-lorebook"');
    });

    test('shows enabled memory shard before threshold and offers shard compaction after a run', async () => {
        agents = [
            { id: 'memory-shard', name: 'Memory Shard', sourceTemplateId: 'tpl-memory-shard-companion', execution: 'companion', enabled: true, companion: { minContextTokens: 30000 } },
        ];
        const panel = await importPanel();

        // Below the threshold with no state: it still appears so users know it is enabled.
        const waitingHtml = panel.buildPanelHtml();
        expect(waitingHtml).toContain('Memory Shard');
        expect(waitingHtml).toContain('No state yet');

        // Legacy shards have no record of which messages were actually summarised.
        const message0 = { is_user: false, is_system: false, mes: 'old reply' };
        const message1 = { is_user: false, is_system: false, mes: 'new reply' };
        chat.push(message0, message1);
        companionResultsByMessage.set(message1, {
            'memory-shard': { status: 'done', content: '## Timeline', agentName: 'Memory Shard' },
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('Memory Shard');
        expect(html).not.toContain('data-action="panel-hide-before"');
        companionResultsByMessage.get(message1)['memory-shard'].contextCoverage = [0];
        expect(panel.buildPanelHtml()).toContain('data-action="panel-hide-before"');

        // Non-shard agents never offer compaction.
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        companionResultsByMessage.set(message1, {
            'tracker-1': { status: 'done', content: 'state', agentName: 'Scene Tracker' },
        });
        expect(panel.buildPanelHtml()).not.toContain('data-action="panel-hide-before"');
    });

    test('keeps earlier shards listed after their host messages are hidden', async () => {
        agents = [
            { id: 'memory-shard', name: 'Memory Shard', sourceTemplateId: 'tpl-memory-shard-companion', execution: 'companion', enabled: true },
        ];
        const panel = await importPanel();

        const olderShardHost = { is_user: false, is_system: false, mes: 'reply the first shard absorbed' };
        const filler = { is_user: true, is_system: false, mes: 'keep going' };
        const newerShardHost = { is_user: false, is_system: false, mes: 'latest reply' };
        chat.push(olderShardHost, filler, newerShardHost);
        companionResultsByMessage.set(olderShardHost, {
            'memory-shard': { status: 'done', content: '# MEMORY SHARD: A-1', agentName: 'Memory Shard' },
        });
        companionResultsByMessage.set(newerShardHost, {
            'memory-shard': { status: 'done', content: '# MEMORY SHARD: A-2', agentName: 'Memory Shard' },
        });

        expect(panel.buildPanelHtml()).toContain('Previous states (1)');

        // "Hide story above this shard" only flips is_system on the absorbed range.
        olderShardHost.is_system = true;
        filler.is_system = true;

        panel.revealPanelHistory('memory-shard');
        const html = panel.buildPanelHtml();
        expect(html).toContain('Previous states (1)');
        expect(html).toMatch(/ica--tpanel-history-entry[\s\S]*?data-message-index="0"/);
        expect(html).toContain('# MEMORY SHARD: A-1');
        expect(html).toContain('ica--card-pill--absorbed');
        // The newest shard is still on a visible host, so it keeps its rerun controls.
        expect(html).toContain('data-action="panel-regenerate"');
        // Everything above the newest shard is already hidden, so there is nothing left to absorb.
        expect(html).not.toContain('data-action="panel-hide-before"');
    });

    test('drops rerun controls and compaction once the newest note sits on a hidden host', async () => {
        agents = [
            { id: 'memory-shard', name: 'Memory Shard', sourceTemplateId: 'tpl-memory-shard-companion', execution: 'companion', enabled: true },
        ];
        const panel = await importPanel();

        const filler = { is_user: true, is_system: false, mes: 'opening' };
        const shardHost = { is_user: false, is_system: false, mes: 'absorbed reply' };
        chat.push(filler, shardHost);
        companionResultsByMessage.set(shardHost, {
            'memory-shard': { status: 'done', content: '# MEMORY SHARD: A-1', agentName: 'Memory Shard' },
        });

        expect(panel.buildPanelHtml()).toContain('data-action="panel-regenerate"');

        shardHost.is_system = true;

        const html = panel.buildPanelHtml();
        // The note survives, but it cannot be re-run and cannot compact a range it sits inside.
        expect(html).toContain('# MEMORY SHARD: A-1');
        expect(html).toContain('data-host-hidden="true"');
        expect(html).not.toContain('data-action="panel-regenerate"');
        expect(html).not.toContain('data-action="panel-fix"');
        expect(html).not.toContain('data-action="panel-hide-before"');
        // Editing the stored text and jumping to the message still work.
        expect(html).toContain('data-action="panel-edit-note"');
        expect(html).toContain('data-action="panel-jump"');
    });

    test('shows the panel empty state when nothing is enabled or stored', async () => {
        const panel = await importPanel();

        const html = panel.buildPanelHtml();

        expect(html).toContain('No companion agents are enabled');
    });

    test('keeps readable panel content accessible while Agent runs are paused or blocked', async () => {
        const panel = await importPanel();
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);

        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, { 'tracker-1': { status: 'done', content: 'Rain on the station roof.', agentName: 'Scene Tracker' } });
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);

        globallyEnabled = false;
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
        expect(panel.buildPanelHtml()).toContain('data-action="panel-regenerate-all" title="Switch Agents on to run companions" disabled');
    });

    test('waits for the first note of an automatic Companion before showing the floating button', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        const panel = await importPanel();
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        // The top bar button covers nothing, so it stays available.
        panel.setCompanionPanelLauncher('topbar');
        expect(panel.shouldShowCompanionPanelTopbarButton()).toBe(true);
        panel.setCompanionPanelLauncher('handle');

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, { 'tracker-1': { status: 'done', content: 'Rain on the station roof.', agentName: 'Scene Tracker' } });
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
    });

    test('shows the launcher for a manual Companion before it has run', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        const panel = await importPanel();
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
    });

    test('defaults the launcher to the floating button and normalises unknown values', async () => {
        const panel = await importPanel();

        expect(panel.getCompanionPanelLauncher()).toBe('handle');
        expect(panel.normalizeCompanionPanelLauncher('topbar')).toBe('topbar');
        expect(panel.normalizeCompanionPanelLauncher('sidebar')).toBe('handle');
        expect(panel.normalizeCompanionPanelLauncher(null)).toBe('handle');
    });

    test('shows either the floating button or the top bar button, never both', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        const panel = await importPanel();

        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
        expect(panel.shouldShowCompanionPanelTopbarButton()).toBe(false);

        expect(panel.setCompanionPanelLauncher('topbar')).toBe('topbar');
        expect(accountStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-launcher', 'topbar');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        expect(panel.shouldShowCompanionPanelTopbarButton()).toBe(true);
        // Hiding the floating button means nothing once the top bar owns the launcher.
        expect(panel.buildPanelHtml()).not.toContain('panel-hide-handle');

        globallyEnabled = false;
        expect(panel.shouldShowCompanionPanelTopbarButton()).toBe(true);
        globallyEnabled = true;

        expect(panel.setCompanionPanelLauncher('handle')).toBe('handle');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
        expect(panel.shouldShowCompanionPanelTopbarButton()).toBe(false);
        expect(panel.buildPanelHtml()).toContain('panel-hide-handle');
    });

    test('docks the panel beside the chat only for desktop left and right edges', async () => {
        const panel = await importPanel();
        const classes = new Set();
        globalThis.document.body.classList = {
            toggle: jest.fn((name, force) => {
                if (force) classes.add(name);
                else classes.delete(name);
                return Boolean(force);
            }),
        };

        panel.syncCompanionPanelDock({ open: true, edge: 'right', phone: false });
        expect([...classes].sort()).toEqual(['neconyan-companion-beside', 'neconyan-companion-beside-right']);

        panel.syncCompanionPanelDock({ open: true, edge: 'left', phone: false });
        expect([...classes].sort()).toEqual(['neconyan-companion-beside', 'neconyan-companion-beside-left']);

        panel.syncCompanionPanelDock({ open: true, edge: 'top', phone: false });
        expect(classes.size).toBe(0);

        panel.syncCompanionPanelDock({ open: true, edge: 'right', phone: true });
        expect(classes.size).toBe(0);

        panel.syncCompanionPanelDock({ open: true, edge: 'right', phone: false });
        panel.syncCompanionPanelDock({ open: false, edge: 'right', phone: false });
        expect(classes.size).toBe(0);
    });

    test('restores the top bar choice, puts its button in the bar slot, and removes it when switched back', async () => {
        accountStorageValues.set('ica--tracker-panel-launcher', 'topbar');
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        const nodes = new Map();
        const slot = { append: jest.fn(node => nodes.set(node.id, node)) };
        globalThis.document.getElementById = jest.fn(id => (id === 'sb-topbar-extension-slot' ? slot : nodes.get(id) ?? null));
        globalThis.document.createElement = jest.fn(() => {
            const node = {
                attributes: {},
                setAttribute: jest.fn((name, value) => {
                    node.attributes[name] = String(value);
                }),
                addEventListener: jest.fn((name, handler) => {
                    node[`on${name}`] = handler;
                }),
                remove: jest.fn(() => nodes.delete(node.id)),
            };
            return node;
        });
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        globalThis.$ = jest.fn(arg => {
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            return elementStub();
        });
        const panel = await importPanel();

        expect(panel.getCompanionPanelLauncher()).toBe('topbar');
        panel.updateCompanionPanelHandleVisibility();

        expect(handleElement.toggle).toHaveBeenLastCalledWith(false);
        expect(slot.append).toHaveBeenCalledTimes(1);
        const button = nodes.get('ica--tracker-panel-topbar');
        expect(button.attributes).toEqual(expect.objectContaining({
            'aria-controls': 'ica--tracker-panel',
            'aria-expanded': 'false',
            'data-sb-topbar-adopt': 'true',
        }));

        button.onclick();
        expect(panelElement.attr).toHaveBeenCalledWith('data-edge', 'right');
        expect(panelElement.attr).toHaveBeenCalledWith('data-launcher', 'topbar');
        expect(panelElement.addClass).toHaveBeenCalledWith('is-open');
        expect(button.attributes['aria-expanded']).toBe('true');

        button.onclick();
        expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        expect(button.attributes['aria-expanded']).toBe('false');

        // A second sync reuses the button instead of stacking another one.
        panel.updateCompanionPanelHandleVisibility();
        expect(slot.append).toHaveBeenCalledTimes(1);

        panel.setCompanionPanelLauncher('handle');
        expect(button.remove).toHaveBeenCalled();
        expect(nodes.has('ica--tracker-panel-topbar')).toBe(false);
        expect(handleElement.toggle).toHaveBeenLastCalledWith(true);
    });

    test('hides the panel, handle, and both wand items only while Conversation Mode is active', async () => {
        let conversationMode = 'on';
        const sheld = {
            dataset: { sbConversationMode: conversationMode },
            getAttribute: jest.fn(() => conversationMode),
        };
        globalThis.document.getElementById = jest.fn(id => id === 'sheld' ? sheld : null);
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        const panel = await importPanel();
        const panelElement = {
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
            removeClass: jest.fn(() => panelElement),
        };
        const handleElement = { toggle: jest.fn(() => handleElement), attr: jest.fn(() => handleElement) };
        const panelMenuElement = { toggle: jest.fn(() => panelMenuElement) };
        const dashboardMenuElement = { toggle: jest.fn(() => dashboardMenuElement) };
        globalThis.$ = jest.fn(arg => {
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            if (arg === '#ica_tracker_panel_wand_item') return panelMenuElement;
            if (arg === '#ica_companions_wand_item') return dashboardMenuElement;
            return { toggle: jest.fn() };
        });

        expect(panel.isConversationModeActive()).toBe(true);
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        panel.openCompanionPanel();
        expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        expect(handleElement.toggle).toHaveBeenLastCalledWith(false);
        expect(panelMenuElement.toggle).toHaveBeenLastCalledWith(false);
        expect(dashboardMenuElement.toggle).toHaveBeenLastCalledWith(false);

        conversationMode = 'off';
        sheld.dataset.sbConversationMode = conversationMode;
        panel.updateCompanionPanelHandleVisibility();
        expect(handleElement.toggle).toHaveBeenLastCalledWith(true);
        expect(panelMenuElement.toggle).toHaveBeenLastCalledWith(true);
        expect(dashboardMenuElement.toggle).toHaveBeenLastCalledWith(true);
    });

    test('hides the story handle while Scratchpad is open, then restores it', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        let scratchpadOpen = true;
        globalThis.document.body.classList = { contains: name => name === 'neconyan-scratchpad-open' && scratchpadOpen };
        globalThis.matchMedia = jest.fn(() => ({ matches: true }));
        const panel = await importPanel();
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        scratchpadOpen = false;
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
        scratchpadOpen = true;
        globalThis.matchMedia = jest.fn(() => ({ matches: false }));
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        delete globalThis.matchMedia;
    });

    test('gives the side to Scratchpad or Notes when either opens beside the chat', async () => {
        const hideScratchpad = jest.fn();
        const hideNotes = jest.fn();
        globalThis.NeconyanScratchpad = { hide: hideScratchpad };
        globalThis.NeconyanNotes = { hide: hideNotes };
        const panelElement = {
            on: jest.fn(() => panelElement),
            html: jest.fn(() => panelElement),
            toggle: jest.fn(() => panelElement),
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
            removeClass: jest.fn(() => panelElement),
            0: {
                addEventListener: jest.fn(), dataset: {}, scrollHeight: 0, clientHeight: 0, scrollTop: 0,
                querySelectorAll: jest.fn(() => []),
                querySelector: jest.fn(() => null),
                getBoundingClientRect: jest.fn(() => ({ height: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0 })),
                contains: jest.fn(() => false),
            },
        };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement), attr: jest.fn(() => handleElement) };
        const elementStub = () => ({
            length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn(),
            attr: jest.fn(), addClass: jest.fn(), removeClass: jest.fn(),
        });
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) return { append: jest.fn() };
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            return elementStub();
        });

        try {
            const panel = await importPanel();
            panel.initCompanionPanel();
            panel.openCompanionPanel();

            expect(hideScratchpad).toHaveBeenCalled();
            expect(hideNotes).toHaveBeenCalled();

            const listeners = new Map(globalThis.document.addEventListener.mock.calls);
            globalThis.document.body.classList = { contains: name => name === 'neconyan-scratchpad-open' };
            listeners.get('neconyan:scratchpad-visibility')();
            expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');

            panel.openCompanionPanel();
            panelElement.removeClass.mockClear();
            globalThis.document.body.classList = { contains: name => name === 'neconyan-notes-open' };
            listeners.get('neconyan:notes-visibility')();
            expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        } finally {
            delete globalThis.NeconyanScratchpad;
            delete globalThis.NeconyanNotes;
        }
    });

    test('a real MutationObserver drives both wand items across Conversation Mode changes without stacking observers', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        const observers = [];
        class MutationObserverMock {
            constructor(callback) {
                this.callback = callback;
                this.observed = [];
                this.disconnected = false;
                observers.push(this);
            }
            observe(target, options) {
                this.observed.push({ target, options });
            }
            disconnect() {
                this.disconnected = true;
            }
        }
        globalThis.MutationObserver = MutationObserverMock;
        const sheld = {
            dataset: { sbConversationMode: 'off' },
            getAttribute: jest.fn(name => (name === 'data-sb-conversation-mode' ? sheld.dataset.sbConversationMode : null)),
        };
        globalThis.document.getElementById = jest.fn(id => id === 'sheld' ? sheld : null);
        const panel = await importPanel();
        const elementStub = () => {
            const element = {
                length: 1,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const handleElement = elementStub();
        const panelMenuElement = elementStub();
        const dashboardMenuElement = elementStub();
        const panelElement = elementStub();
        globalThis.$ = jest.fn(arg => {
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            if (arg === '#ica_tracker_panel_wand_item') return panelMenuElement;
            if (arg === '#ica_companions_wand_item') return dashboardMenuElement;
            if (arg === globalThis.document || arg === globalThis.document.body) return elementStub();
            if (typeof arg === 'string' && arg.trim().startsWith('<')) return elementStub();
            return elementStub();
        });

        panel.initCompanionPanel();
        panel.initCompanionPanel();
        const activeObservers = observers.filter(observer => !observer.disconnected);
        expect(activeObservers).toHaveLength(1);
        expect(activeObservers[0].observed).toEqual([
            { target: sheld, options: { attributes: true, attributeFilter: ['data-sb-conversation-mode'] } },
        ]);

        // Observed attribute flips drive both wand entries via the observer callback.
        sheld.dataset.sbConversationMode = 'on';
        activeObservers[0].callback();
        expect(panelMenuElement.toggle).toHaveBeenLastCalledWith(false);
        expect(dashboardMenuElement.toggle).toHaveBeenLastCalledWith(false);

        sheld.dataset.sbConversationMode = 'off';
        activeObservers[0].callback();
        expect(panelMenuElement.toggle).toHaveBeenLastCalledWith(true);
        expect(dashboardMenuElement.toggle).toHaveBeenLastCalledWith(true);
        delete globalThis.MutationObserver;
    });

    test('injects the panel, handle, and wand item once on init', async () => {
        const panel = await importPanel();
        const bodyAppends = [];
        const wandAppends = [];
        const elementStub = () => ({ length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() });
        const panelElement = elementStub();
        const handleElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn(element => bodyAppends.push(element)) };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 0 };
            }
            if (arg === '#extensionsMenu') {
                return { append: jest.fn(element => wandAppends.push(element)) };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });

        panel.initCompanionPanel();
        panel.initCompanionPanel();

        expect(bodyAppends).toHaveLength(2);
        expect(wandAppends).toHaveLength(1);
        expect(menuItem.on).toHaveBeenCalledWith('click', expect.any(Function));
        expect(panelElement.on).toHaveBeenCalledWith('click', '[data-action]', expect.any(Function));
        expect(panelElement.on).toHaveBeenCalledWith('click', '.ica--tpanel-agent-body .ica--choice-line', expect.any(Function));
        expect(handleElement.toggle).toHaveBeenCalled();
        const registered = eventSource.on.mock.calls.map(([eventName]) => eventName);
        expect(registered).toEqual(expect.arrayContaining([
            'companion_results_updated',
            'chat_changed',
            'message_deleted',
            'message_swiped',
        ]));
        expect(initCompanionWindowsMock).toHaveBeenCalledTimes(1);
        const windowHooks = initCompanionWindowsMock.mock.calls[0][0];
        expect(windowHooks.getLivePreview()).toBeNull();
        expect(windowHooks.formatEntry('agent-1', { preview: {}, result: { status: 'done', content: 'note' } }))
            .toContain('<formatted>note');
        expect(formatCompanionContentMock).toHaveBeenCalledWith(
            'agent-1',
            expect.objectContaining({ content: 'note' }),
            {},
            '.ica--cwin-body ',
        );
    });

    test('keeps the panel open on outside clicks while locked', async () => {
        const panel = await importPanel();
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        const documentElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === globalThis.document) {
                return documentElement;
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);

        try {
            panel.initCompanionPanel();
            const outsideClickHandler = documentElement.on.mock.calls.find(([eventName]) => eventName === 'click')[1];

            panel.openCompanionPanel();
            nowSpy.mockReturnValue(2000);
            outsideClickHandler({ target: { closest: jest.fn(() => null) } });

            expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');

            panelElement.removeClass.mockClear();
            panel.openCompanionPanel();
            panel.setCompanionPanelLocked(true);
            nowSpy.mockReturnValue(3000);
            outsideClickHandler({ target: { closest: jest.fn(() => null) } });

            expect(panel.isCompanionPanelLocked()).toBe(true);
            expect(accountStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-locked', 'true');
            expect(panel.buildPanelHtml()).toContain('aria-pressed="true"');
            expect(panelElement.removeClass).not.toHaveBeenCalled();

            panel.setCompanionPanelLocked(false);
            expect(accountStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-locked', 'false');
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('keeps the panel open when clicking inside an open popup or fullscreen editor overlay', async () => {
        const panel = await importPanel();
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        const documentElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        let openPopup = null;
        globalThis.document.querySelector = jest.fn(selector => (selector.includes('dialog.popup[open]') ? openPopup : null));
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === globalThis.document) {
                return documentElement;
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);

        try {
            panel.initCompanionPanel();
            const outsideClickHandler = documentElement.on.mock.calls.find(([eventName]) => eventName === 'click')[1];

            panel.openCompanionPanel();
            nowSpy.mockReturnValue(2000);

            // Clicking inside a popup dialog or fullscreen overlay leaves the panel open.
            outsideClickHandler({
                target: {
                    isConnected: true,
                    closest: jest.fn(selector => (selector.includes('dialog.popup') ? {} : null)),
                },
            });
            expect(panelElement.removeClass).not.toHaveBeenCalled();

            // Clicking a detached control (e.g. a button removed during popup re-render) leaves the panel open.
            outsideClickHandler({
                target: {
                    isConnected: false,
                    closest: jest.fn(() => null),
                },
            });
            expect(panelElement.removeClass).not.toHaveBeenCalled();

            // Any click while an open modal popup sits above the panel leaves the panel open.
            openPopup = {};
            outsideClickHandler({
                target: {
                    isConnected: true,
                    closest: jest.fn(() => null),
                },
            });
            expect(panelElement.removeClass).not.toHaveBeenCalled();

            // Once no popup is open, a normal outside click closes the panel as expected.
            openPopup = null;
            outsideClickHandler({
                target: {
                    isConnected: true,
                    closest: jest.fn(() => null),
                },
            });
            expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('restores the saved panel lock state', async () => {
        accountStorageValues.set('ica--tracker-panel-locked', 'true');
        const panel = await importPanel();

        expect(panel.isCompanionPanelLocked()).toBe(true);
        expect(panel.buildPanelHtml()).toContain('aria-pressed="true"');
    });

    test('hides the floating handle from the panel and restores it on the next explicit open', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        const panel = await importPanel();
        const panelElement = {
            on: jest.fn(() => panelElement),
            html: jest.fn(() => panelElement),
            toggle: jest.fn(() => panelElement),
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
            removeClass: jest.fn(() => panelElement),
        };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement), attr: jest.fn(() => handleElement) };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-hide-handle' : undefined)),
                    closest: jest.fn(() => ({ attr: jest.fn() })),
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('fa-cat');
        expect(html).toContain('data-action="panel-hide-handle"');

        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(accountStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-handle-hidden', 'true');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        expect(handleElement.toggle).toHaveBeenLastCalledWith(false);
        expect(globalThis.toastr.info).toHaveBeenCalled();

        panel.openCompanionPanel();
        expect(accountStorage.setItem).toHaveBeenCalledWith('ica--tracker-panel-handle-hidden', 'false');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
        expect(handleElement.toggle).toHaveBeenLastCalledWith(true);
    });

    test('jumps the panel to its top and bottom and hides the jump buttons when nothing scrolls', async () => {
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel', trigger: 'manual' } }];
        const panel = await importPanel();
        const createButton = () => {
            const attributes = new Map();
            return {
                getAttribute: jest.fn(name => attributes.get(name) ?? null),
                setAttribute: jest.fn((name, value) => attributes.set(name, String(value))),
            };
        };
        const buttons = { 'panel-scroll-top': createButton(), 'panel-scroll-bottom': createButton() };
        const group = {
            hidden: true,
            offsetHeight: 78,
            querySelector: jest.fn(selector => buttons[selector.match(/data-action="([^"]+)"/)?.[1]] ?? null),
        };
        let scrollTop = 0;
        const panelNode = {
            scrollHeight: 1200,
            clientHeight: 400,
            dataset: {},
            addEventListener: jest.fn(),
            querySelector: jest.fn(selector => (selector === '[data-role="panel-jump"]' ? group : null)),
            querySelectorAll: jest.fn(() => []),
            getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
            scrollTo: jest.fn(({ top }) => {
                panelNode.scrollTop = top;
            }),
        };
        Object.defineProperty(panelNode, 'scrollTop', {
            get: () => scrollTop,
            set: value => {
                scrollTop = Math.max(0, Math.min(Number(value), panelNode.scrollHeight - panelNode.clientHeight));
            },
        });
        const panelElement = {
            0: panelNode,
            length: 1,
            on: jest.fn(() => panelElement),
            html: jest.fn(() => {
                group.hidden = true;
                return panelElement;
            }),
            toggle: jest.fn(() => panelElement),
            attr: jest.fn(() => panelElement),
            addClass: jest.fn(() => panelElement),
            removeClass: jest.fn(() => panelElement),
        };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement), attr: jest.fn(() => handleElement) };
        let pressedAction = '';
        const actionButton = {};
        globalThis.document.getElementById = jest.fn(id => (id === 'ica--tracker-panel' ? panelNode : null));
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) return { append: jest.fn() };
            if (arg === '#ica--tracker-panel') return panelElement;
            if (arg === '#ica--tracker-panel-handle') return handleElement;
            if (arg === '#ica_tracker_panel_wand_item') return { length: 1 };
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? pressedAction : undefined)),
                    closest: jest.fn(() => ({ attr: jest.fn() })),
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });
        const frames = [];
        const previousFrame = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = jest.fn(callback => frames.push(callback));
        const flushFrames = () => frames.splice(0).forEach(callback => callback());

        try {
            const html = panel.buildPanelHtml();
            expect(html).toContain('data-action="panel-scroll-top"');
            expect(html).toContain('data-action="panel-scroll-bottom"');
            expect(translatedKeys).toEqual(expect.arrayContaining(['Jump through the panel', 'Jump to top', 'Jump to bottom']));

            panel.initCompanionPanel();
            const scrollListener = panelNode.addEventListener.mock.calls.find(([type]) => type === 'scroll');
            expect(scrollListener?.[2]).toEqual({ passive: true });
            const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
            const press = async action => {
                pressedAction = action;
                await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });
                flushFrames();
            };

            panel.openCompanionPanel();
            flushFrames();
            expect(group.hidden).toBe(false);
            expect(buttons['panel-scroll-top'].getAttribute('aria-disabled')).toBe('true');
            expect(buttons['panel-scroll-bottom'].getAttribute('aria-disabled')).toBe('false');

            await press('panel-scroll-bottom');
            expect(panelNode.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
            expect(scrollTop).toBe(800);
            expect(buttons['panel-scroll-top'].getAttribute('aria-disabled')).toBe('false');
            expect(buttons['panel-scroll-bottom'].getAttribute('aria-disabled')).toBe('true');

            globalThis.document.body.classList = { contains: name => name === 'reduced-motion' };
            await press('panel-scroll-top');
            expect(panelNode.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
            expect(buttons['panel-scroll-top'].getAttribute('aria-disabled')).toBe('true');

            scrollTop = 300;
            scrollListener[1]();
            flushFrames();
            expect(buttons['panel-scroll-top'].getAttribute('aria-disabled')).toBe('false');
            expect(buttons['panel-scroll-bottom'].getAttribute('aria-disabled')).toBe('false');

            panelNode.scrollHeight = 402;
            scrollTop = 0;
            panel.refreshCompanionPanel();
            expect(group.hidden).toBe(true);
        } finally {
            globalThis.requestAnimationFrame = previousFrame;
        }
    });

    test('keeps the handle hidden on load until the panel is opened', async () => {
        accountStorageValues.set('ica--tracker-panel-handle-hidden', 'true');
        agents = [{ id: 'tracker-1', name: 'Scene Tracker', execution: 'companion', enabled: true }];
        const panel = await importPanel();

        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
    });

    test('runs a stateless companion on the latest assistant reply', async () => {
        agents = [{ id: 'relationship-lens', name: 'Relationship Lens', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        const panel = await importPanel();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const section = { attr: jest.fn(name => (name === 'data-agent-id' ? 'relationship-lens' : undefined)) };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-run-latest' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-action="panel-run-latest"');
        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('relationship-lens', 1);
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
    });

    test('the retry button says how many companions failed again, one or several, with a key for each', async () => {
        agents = [{ id: 'relationship-lens', name: 'Relationship Lens', execution: 'companion', enabled: true, companion: { trigger: 'manual' } }];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        retryableCompanionAgents = [agents[0]];
        const panel = await importPanel();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-retry-failed' : undefined)),
                    closest: jest.fn(() => ({ attr: jest.fn() })),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        panel.buildPanelHtml();
        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];

        runner.retryFailedCompanionsOnMessage.mockResolvedValueOnce([{ status: 'error' }]);
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });
        expect(globalThis.toastr.warning).toHaveBeenLastCalledWith('1 companion failed again. Check your connection, then try again.');

        runner.retryFailedCompanionsOnMessage.mockResolvedValueOnce([{ status: 'error' }, { status: 'done', lastRunError: 'x' }, { status: 'error' }]);
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });
        expect(globalThis.toastr.warning).toHaveBeenLastCalledWith('3 companions failed again. Check your connection, then try again.');

        expect(translatedKeys).toEqual(expect.arrayContaining([
            '1 companion failed again. Check your connection, then try again.',
            '${0} companions failed again. Check your connection, then try again.',
        ]));
    });

    test.each([true, false])('sends Chat Only input privately and clears it only on success (success=%s)', async succeeds => {
        agents = [{
            id: 'chat-only',
            name: 'Chat Only',
            sourceTemplateId: 'tpl-chat-only-companion',
            execution: 'companion',
            enabled: true,
            companion: { trigger: 'manual', displayMode: 'panel' },
        }];
        chat.push({ is_user: true, mes: 'hello' }, { is_user: false, is_system: false, mes: 'latest reply' });
        companionResultsByMessage.set(chat[1], {
            'chat-only': { status: 'done', content: 'You: Hey\n\nMona: I can hear you.', agentName: 'Chat Only' },
        });
        const panel = await importPanel();
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        runner.runCompanionAgentOnMessage.mockResolvedValue(succeeds ? { status: 'done' } : { status: 'done', lastRunError: 'Request failed' });
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Are you actually okay?' : inputField)), prop: jest.fn(() => inputField) };
        const section = {
            attr: jest.fn(name => (name === 'data-agent-id' ? 'chat-only' : '1')),
            find: jest.fn(() => inputField),
        };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-chat-only-send' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-role="chat-only-input"');
        expect(html).toContain('data-action="panel-chat-only-send"');
        expect(html).toContain('Private side chat');

        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(runner.runCompanionAgentOnMessage).toHaveBeenCalledWith('chat-only', 1, expect.objectContaining({
            pendingContent: expect.stringContaining('You: Are you actually okay?'),
            extraContextSections: [expect.objectContaining({
                title: 'Chat Only side chat',
                content: expect.stringContaining('Mona: I can hear you.'),
            })],
        }));
        expect(runner.runCompanionAgentOnMessage.mock.calls[0][2].extraContextSections[0].content).toContain('You: Are you actually okay?');
        expect(inputField.prop).toHaveBeenCalledWith('disabled', true);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', false);
        expect(inputField.val.mock.calls.filter(([value]) => value === '')).toHaveLength(succeeds ? 1 : 0);
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
    });

    test.each(['assistant', 'user', 'empty'])('saves Plot Compass objective and runs with %s messages', async (kind) => {
        const plotCompass = {
            id: 'plot-compass',
            name: 'Plot Compass',
            sourceTemplateId: 'tpl-plot-compass-companion',
            execution: 'companion',
            enabled: true,
            settings: { plotCompassObjective: 'Old objective' },
            companion: { trigger: 'auto', displayMode: 'panel' },
        };
        agents = [plotCompass];
        if (kind !== 'empty') chat.push({ is_user: true, mes: 'hello' });
        if (kind === 'assistant') chat.push({ is_user: false, is_system: false, mes: 'latest reply' });
        const panel = await importPanel();
        const store = await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
        const runner = await import('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const panelElement = { on: jest.fn(() => panelElement), html: jest.fn(() => panelElement), toggle: jest.fn(() => panelElement), attr: jest.fn(() => panelElement), addClass: jest.fn(() => panelElement) };
        const handleElement = { on: jest.fn(() => handleElement), toggle: jest.fn(() => handleElement) };
        const button = { prop: jest.fn() };
        const inputField = { val: jest.fn(value => (value === undefined ? 'Reach the tower' : inputField)), prop: jest.fn(() => inputField) };
        const section = {
            0: { querySelectorAll: () => ['global', 'character', 'chat'].map(scope => ({ dataset: { plotScope: scope }, value: scope === 'global' ? 'Reach the tower' : `${scope} plan` })), querySelector: selector => ({ checked: !selector.includes('global') }) },
            attr: jest.fn(name => (name === 'data-agent-id' ? 'plot-compass' : '1')),
            find: jest.fn(() => inputField),
        };
        const actionButton = {};
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (arg === actionButton) {
                return {
                    attr: jest.fn(name => (name === 'data-action' ? 'panel-plot-compass-save' : undefined)),
                    closest: jest.fn(() => section),
                    prop: button.prop,
                };
            }
            return { length: 0, on: jest.fn(), append: jest.fn(), html: jest.fn(), toggle: jest.fn() };
        });

        const html = panel.buildPanelHtml();
        expect(html).toContain('data-role="plot-compass-objective"');
        expect(html).toContain('data-action="panel-plot-compass-save"');
        expect(html).toContain('Old objective');

        panel.initCompanionPanel();
        const actionHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '[data-action]')[2];
        await actionHandler({ preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: actionButton });

        expect(plotCompass.settings.plotCompassObjective).toBe('Reach the tower');
        expect(plotCompass.settings.plotCompassObjectives['["character","character.png"]']).toBe('character plan');
        expect(plotCompass.settings.plotCompassObjectives['["character","character.png","chat-1"]']).toBe('chat plan');
        expect(plotCompass.settings.plotCompassObjectiveEnabled.global).toBe(false);
        expect(store.saveAgent).toHaveBeenCalledWith('plot-compass', { update: expect.any(Function) });
        expect(runner.runPlotCompassBeforeConversation.mock.calls).toEqual(kind === 'empty' ? [['plot-compass']] : []);
        expect(runner.runCompanionAgentOnMessage.mock.calls).toEqual(kind === 'empty' ? [] : [['plot-compass', kind === 'assistant' ? 1 : 0]]);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', true);
        expect(inputField.prop).toHaveBeenCalledWith('disabled', false);
        expect(button.prop).toHaveBeenCalledWith('disabled', true);
        expect(button.prop).toHaveBeenCalledWith('disabled', false);
        expect(globalThis.toastr.success).toHaveBeenCalledWith('Plot Objectives saved.');
    });

    test('closes after a panel choice inserts into the message box', async () => {
        agents = [{ id: 'choices', name: 'CYOA Choices', execution: 'companion', enabled: true }];
        const panel = await importPanel();
        const companionUi = await import('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        const elementStub = () => {
            const element = {
                length: 0,
                on: jest.fn(() => element),
                append: jest.fn(() => element),
                html: jest.fn(() => element),
                toggle: jest.fn(() => element),
                attr: jest.fn(() => element),
                addClass: jest.fn(() => element),
                removeClass: jest.fn(() => element),
            };
            return element;
        };
        const panelElement = elementStub();
        const handleElement = elementStub();
        const menuItem = { on: jest.fn(() => menuItem) };
        globalThis.$ = jest.fn(arg => {
            if (arg === globalThis.document.body) {
                return { append: jest.fn() };
            }
            if (arg === '#ica--tracker-panel') {
                return panelElement;
            }
            if (arg === '#ica--tracker-panel-handle') {
                return handleElement;
            }
            if (arg === '#ica_tracker_panel_wand_item') {
                return { length: 1 };
            }
            if (typeof arg === 'string' && arg.trim().startsWith('<')) {
                return menuItem;
            }
            return elementStub();
        });

        panel.initCompanionPanel();
        panel.openCompanionPanel();
        const choiceHandler = panelElement.on.mock.calls.find(([, selector]) => selector === '.ica--tpanel-agent-body .ica--choice-line')[2];
        const event = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
        choiceHandler.call({ textContent: 'A) Open the door' }, event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(companionUi.insertChoiceIntoMessageInput).toHaveBeenCalledWith('A) Open the door');
        expect(panelElement.removeClass).toHaveBeenCalledWith('is-open');
        expect(panelElement.attr).toHaveBeenCalledWith('aria-hidden', 'true');

        panelElement.removeClass.mockClear();
        panelElement.attr.mockClear();
        companionUi.insertChoiceIntoMessageInput.mockClear();
        panel.openCompanionPanel();
        panel.setCompanionPanelLocked(true);
        const lockedEvent = { preventDefault: jest.fn(), stopPropagation: jest.fn() };
        choiceHandler.call({ textContent: 'B) Stay here' }, lockedEvent);

        expect(lockedEvent.preventDefault).toHaveBeenCalled();
        expect(lockedEvent.stopPropagation).toHaveBeenCalled();
        expect(companionUi.insertChoiceIntoMessageInput).toHaveBeenCalledWith('B) Stay here');
        expect(panelElement.removeClass).not.toHaveBeenCalled();
        expect(panelElement.attr).not.toHaveBeenCalledWith('aria-hidden', 'true');
        choiceHandler.call({ textContent: '33. Keep this number', dataset: { icaChoiceText: '3. 3. Keep this number' } }, lockedEvent);
        expect(companionUi.insertChoiceIntoMessageInput).toHaveBeenLastCalledWith('3. 3. Keep this number');
    });

    test('keeps card and hidden companions out of the tracker panel', async () => {
        agents = [
            { id: 'card-agent', name: 'Card Note', execution: 'companion', enabled: true, companion: { displayMode: 'card' } },
            { id: 'hidden-agent', name: 'Hidden Feedback', execution: 'companion', enabled: true, companion: { displayMode: 'hidden' } },
            { id: 'panel-agent', name: 'Panel Tracker', execution: 'companion', enabled: true, companion: { displayMode: 'panel' } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'card-agent': { status: 'done', content: 'inline card content', agentName: 'Card Note' },
            'hidden-agent': { status: 'done', content: 'hidden feedback', agentName: 'Hidden Feedback' },
            'panel-agent': { status: 'done', content: 'panel state', agentName: 'Panel Tracker' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states).toHaveLength(1);
        expect(states[0].agentId).toBe('panel-agent');
        expect(states[0].latest.result.content).toBe('panel state');

        const html = panel.buildPanelHtml();
        expect(html).toContain('Panel Tracker');
        expect(html).not.toContain('data-agent-id="card-agent"');
        expect(html).not.toContain('data-agent-id="hidden-agent"');
        expect(html).not.toContain('inline card content');
        expect(html).not.toContain('hidden feedback');
        expect(panel.shouldShowCompanionPanelHandle()).toBe(true);
    });

    test('hides the panel handle when only card/hidden companions are enabled', async () => {
        agents = [
            { id: 'card-only', name: 'Card Only', execution: 'companion', enabled: true, companion: { displayMode: 'card' } },
            { id: 'hidden-only', name: 'Hidden Only', execution: 'companion', enabled: true, companion: { displayMode: 'hidden' } },
        ];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'card-only': { status: 'done', content: 'card', agentName: 'Card Only' },
            'hidden-only': { status: 'done', content: 'hidden', agentName: 'Hidden Only' },
        });

        expect(panel.shouldShowCompanionPanelHandle()).toBe(false);
        expect(panel.collectPanelAgentStates()).toHaveLength(0);
        expect(panel.buildPanelHtml()).toContain('No companion agents are enabled');
    });

    test('excludes orphaned card/hidden results, keeps panel results', async () => {
        agents = [];
        const panel = await importPanel();

        const message = { is_user: false, is_system: false, mes: 'reply' };
        chat.push(message);
        companionResultsByMessage.set(message, {
            'orphan-card': { status: 'done', content: 'card orphan', agentName: 'Old Card', displayMode: 'card' },
            'orphan-panel': { status: 'done', content: 'panel orphan', agentName: 'Old Panel', displayMode: 'panel' },
            'orphan-legacy': { status: 'done', content: 'legacy', agentName: 'Legacy' },
        });

        const states = panel.collectPanelAgentStates();

        expect(states.map(state => state.agentId).sort()).toEqual(['orphan-legacy', 'orphan-panel']);
        expect(states.find(state => state.agentId === 'orphan-card')).toBeUndefined();
    });

    describe('companion panel resize', () => {
        const savedGlobals = {};

        function saveGlobal(name) {
            savedGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
        }

        afterEach(() => {
            for (const [name, descriptor] of Object.entries(savedGlobals)) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
                delete savedGlobals[name];
            }
        });

        function setupResizeHarness({
            width = 1280,
            phone = false,
            sidebarOffset = '244px',
            pinnedOpen = false,
            pinnedWidth = 400,
            panelRect = { left: 860, right: 1280, top: 0, bottom: 900, width: 420, height: 900 },
        } = {}) {
            saveGlobal('innerWidth');
            saveGlobal('getComputedStyle');
            saveGlobal('matchMedia');
            saveGlobal('MutationObserver');
            saveGlobal('addEventListener');
            saveGlobal('removeEventListener');

            let currentViewportWidth = width;
            let isPhone = phone;
            let currentSidebarOffset = sidebarOffset;
            let isPinnedOpen = pinnedOpen;
            let currentPanelRect = { ...panelRect };
            let currentHtml = '';

            Object.defineProperty(globalThis, 'innerWidth', {
                configurable: true,
                writable: true,
                value: currentViewportWidth,
            });

            const windowListeners = new Map();
            const addListener = (map, type, fn) => {
                if (!map.has(type)) map.set(type, new Set());
                map.get(type).add(fn);
            };
            const removeListener = (map, type, fn) => {
                map.get(type)?.delete(fn);
            };
            const emit = (map, event) => {
                for (const fn of [...(map.get(event.type) ?? [])]) fn(event);
            };

            globalThis.addEventListener = jest.fn((type, fn) => addListener(windowListeners, type, fn));
            globalThis.removeEventListener = jest.fn((type, fn) => removeListener(windowListeners, type, fn));

            const bodyClasses = new Set();
            const bodyStyles = new Map();
            const body = {
                classList: {
                    toggle: jest.fn((name, force) => {
                        const next = force === undefined ? !bodyClasses.has(name) : Boolean(force);
                        if (next) bodyClasses.add(name);
                        else bodyClasses.delete(name);
                        return next;
                    }),
                    add: jest.fn(name => bodyClasses.add(name)),
                    remove: jest.fn(name => bodyClasses.delete(name)),
                    contains: jest.fn(name => bodyClasses.has(name)),
                },
                style: {
                    setProperty: jest.fn((name, value) => bodyStyles.set(name, value)),
                    removeProperty: jest.fn(name => bodyStyles.delete(name)),
                    getPropertyValue: jest.fn(name => bodyStyles.get(name) ?? ''),
                },
                append: jest.fn(),
            };

            const resizerAttrs = new Map();
            const resizerListeners = new Map();
            const resizerNode = {
                tagName: 'DIV',
                dataset: { role: 'panel-resizer' },
                setAttribute: jest.fn((name, value) => resizerAttrs.set(name, String(value))),
                getAttribute: jest.fn(name => resizerAttrs.get(name) ?? null),
                addEventListener: jest.fn((type, fn) => addListener(resizerListeners, type, fn)),
                removeEventListener: jest.fn((type, fn) => removeListener(resizerListeners, type, fn)),
                setPointerCapture: jest.fn(),
                releasePointerCapture: jest.fn(),
                hasPointerCapture: jest.fn(() => true),
                closest: jest.fn(selector => (selector === '.ica--tpanel-resizer' ? resizerNode : null)),
                dispatchEvent: jest.fn(event => emit(resizerListeners, event)),
            };

            const panelAttrs = new Map([['data-edge', 'right'], ['data-launcher', 'handle']]);
            const panelDelegated = [];
            const panelDomNode = {
                dataset: {},
                getBoundingClientRect: jest.fn(() => currentPanelRect),
                querySelector: jest.fn(selector => (selector === '.ica--tpanel-resizer' ? resizerNode : null)),
                querySelectorAll: jest.fn(() => []),
                addEventListener: jest.fn(),
                scrollHeight: 400,
                clientHeight: 400,
                scrollTop: 0,
            };
            const panelWrapper = {
                0: panelDomNode,
                length: 1,
                on: jest.fn((eventName, selectorOrHandler, maybeHandler) => {
                    const selector = typeof selectorOrHandler === 'string' ? selectorOrHandler : null;
                    const handler = typeof selectorOrHandler === 'function' ? selectorOrHandler : maybeHandler;
                    panelDelegated.push({ eventName, selector, handler });
                    return panelWrapper;
                }),
                off: jest.fn(() => panelWrapper),
                html: jest.fn(html => {
                    currentHtml = String(html ?? '');
                    const match = currentHtml.match(/<div class="ica--tpanel-resizer"[^>]*>/);
                    if (match) {
                        for (const [, key, value] of match[0].matchAll(/([a-z-]+)="([^"]*)"/g)) {
                            resizerAttrs.set(key, value);
                        }
                    }
                    return panelWrapper;
                }),
                append: jest.fn(),
                toggle: jest.fn(),
                attr: jest.fn((name, value) => {
                    if (value === undefined) return panelAttrs.get(name);
                    panelAttrs.set(name, String(value));
                    return panelWrapper;
                }),
                addClass: jest.fn(() => panelWrapper),
                removeClass: jest.fn(() => panelWrapper),
                find: jest.fn(() => ({ val: jest.fn() })),
            };

            const rightNavObservers = [];
            const rightNavPanel = {
                getBoundingClientRect: jest.fn(() => ({ width: isPinnedOpen ? pinnedWidth : 0 })),
            };
            const queryMatch = selector => {
                if (selector === '#ica--tracker-panel .ica--tpanel-resizer') return resizerNode;
                if (selector === '#right-nav-panel.openDrawer.pinnedOpen:not(.sb-character-editor-fullscreen)') {
                    return isPinnedOpen ? rightNavPanel : null;
                }
                return null;
            };

            globalThis.document = {
                body,
                activeElement: null,
                addEventListener: jest.fn(),
                removeEventListener: jest.fn(),
                querySelector: jest.fn(queryMatch),
                querySelectorAll: jest.fn(() => []),
                getElementById: jest.fn(id => {
                    if (id === 'ica--tracker-panel') return panelDomNode;
                    if (id === 'right-nav-panel') return rightNavPanel;
                    return null;
                }),
            };

            globalThis.getComputedStyle = jest.fn(() => ({
                getPropertyValue: name => (name === '--neco-sidebar-offset' ? currentSidebarOffset : ''),
            }));

            const mediaListeners = new Set();
            globalThis.matchMedia = jest.fn(query => ({
                matches: query === '(max-width: 768px)' ? isPhone : false,
                addEventListener: jest.fn((type, fn) => {
                    if (type === 'change') mediaListeners.add(fn);
                }),
                removeEventListener: jest.fn((type, fn) => {
                    if (type === 'change') mediaListeners.delete(fn);
                }),
            }));

            globalThis.MutationObserver = class {
                constructor(callback) {
                    this.callback = callback;
                    rightNavObservers.push(this);
                }
                observe() {}
                disconnect() {}
            };

            const emptyStub = {
                length: 0,
                on: jest.fn(() => emptyStub),
                off: jest.fn(() => emptyStub),
                append: jest.fn(),
                attr: jest.fn(() => emptyStub),
                toggle: jest.fn(),
                addClass: jest.fn(() => emptyStub),
                removeClass: jest.fn(() => emptyStub),
                css: jest.fn(() => emptyStub),
            };
            const handleStub = { ...emptyStub, length: 1 };
            globalThis.$ = jest.fn(selector => {
                if (selector === '#ica--tracker-panel') return panelWrapper;
                if (selector === '#ica--tracker-panel-handle') return handleStub;
                if (typeof selector === 'string' && selector.startsWith('\n            <div id="ica--tracker-panel"')) return panelWrapper;
                return emptyStub;
            });

            const triggerDelegated = (eventName, selector, event) => {
                const matches = panelDelegated.filter(entry => entry.eventName === eventName && entry.selector === selector);
                for (const entry of matches) {
                    entry.handler.call(resizerNode, event);
                }
            };

            return {
                bodyClasses,
                bodyStyles,
                resizerAttrs,
                resizerNode,
                panelAttrs,
                panelWrapper,
                getHtml: () => currentHtml,
                triggerResizerPointerDown: event => triggerDelegated('pointerdown', '.ica--tpanel-resizer', event),
                triggerResizerKeydown: event => triggerDelegated('keydown', '.ica--tpanel-resizer', event),
                emitPointerMove: event => emit(windowListeners, { type: 'pointermove', ...event }),
                emitPointerUp: event => emit(windowListeners, { type: 'pointerup', ...event }),
                setViewportWidth: next => {
                    currentViewportWidth = next;
                    globalThis.innerWidth = next;
                    emit(windowListeners, { type: 'resize' });
                },
                setPhone: next => {
                    isPhone = next;
                    for (const fn of mediaListeners) fn({ matches: next });
                },
                setPinnedOpen: next => {
                    isPinnedOpen = next;
                    for (const observer of rightNavObservers) observer.callback();
                },
                setPanelRect: next => {
                    currentPanelRect = { ...currentPanelRect, ...next };
                },
                setSidebarOffset: next => {
                    currentSidebarOffset = next;
                },
            };
        }

        test('clamps panel width between 320px minimum and comfortable chat width maximum', async () => {
            const { clampCompanionPanelWidth } = await importPanel();
            expect(clampCompanionPanelWidth(undefined, 0, 1280)).toBe(420);
            expect(clampCompanionPanelWidth(Number.NaN, 0, 1280)).toBe(420);
            expect(clampCompanionPanelWidth(180, 0, 1280)).toBe(320);
            expect(clampCompanionPanelWidth(1100, 0, 1280)).toBe(920);
            expect(clampCompanionPanelWidth(Infinity, 244, 1280)).toBe(676);
            expect(clampCompanionPanelWidth(750, 244, 1280)).toBe(676);
            // Sidebar 244 + pinned character panel 400 + 360 chat leaves < 320, so minimum 320 wins.
            expect(clampCompanionPanelWidth(500, 644, 1280)).toBe(320);
        });

        test('persists stored width in accountStorage and applies --neco-companion-width when docked', async () => {
            accountStorageValues.set('ica--tracker-panel-width', '548');
            const harness = setupResizeHarness();
            const { initCompanionPanel, openCompanionPanel, closeCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();

            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('548px');
            expect(harness.resizerAttrs.get('role')).toBe('separator');
            expect(harness.resizerAttrs.get('aria-orientation')).toBe('vertical');
            expect(harness.resizerAttrs.get('aria-label')).toBe('Resize Companions');
            expect(harness.resizerAttrs.get('tabindex')).toBe('0');
            expect(harness.resizerAttrs.get('aria-valuemin')).toBe('320');
            expect(harness.resizerAttrs.get('aria-valuemax')).toBe('676');
            expect(harness.resizerAttrs.get('aria-valuenow')).toBe('548');

            closeCompanionPanel();
            expect(harness.bodyStyles.has('--neco-companion-width')).toBe(false);
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('548');
        });

        test('supports right-edge pointer drag widening/narrowing, defers renderPanel during drag, and persists on pointerup', async () => {
            const harness = setupResizeHarness({ panelRect: { left: 860, right: 1280, top: 0, bottom: 900, width: 420, height: 900 } });
            const { initCompanionPanel, openCompanionPanel, refreshCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();
            harness.panelWrapper.html.mockClear();

            harness.triggerResizerPointerDown({
                pointerId: 7,
                button: 0,
                clientX: 860,
                preventDefault: jest.fn(),
                currentTarget: harness.resizerNode,
            });
            expect(harness.resizerNode.setPointerCapture).toHaveBeenCalledWith(7);
            expect(harness.bodyClasses.has('neconyan-companion-resizing')).toBe(true);

            harness.emitPointerMove({ pointerId: 7, clientX: 740 });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('540px');
            expect(harness.resizerAttrs.get('aria-valuenow')).toBe('540');

            // Re-render triggered mid-drag is deferred until pointerup.
            refreshCompanionPanel();
            expect(harness.panelWrapper.html).not.toHaveBeenCalled();

            // Dragging further right clamps at 320px minimum.
            harness.emitPointerMove({ pointerId: 7, clientX: 1020 });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('320px');

            harness.emitPointerMove({ pointerId: 7, clientX: 760 });
            harness.emitPointerUp({ pointerId: 7 });

            expect(harness.bodyClasses.has('neconyan-companion-resizing')).toBe(false);
            expect(harness.resizerNode.releasePointerCapture).toHaveBeenCalledWith(7);
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('520');
            expect(harness.panelWrapper.html).toHaveBeenCalledTimes(1);
        });

        test('supports left-edge pointer drag widening right and narrowing left', async () => {
            accountStorageValues.set('ica--tracker-panel-handle-top-v2', JSON.stringify({ edge: 'left', fraction: 0.5 }));
            const harness = setupResizeHarness({ panelRect: { left: 244, right: 664, top: 0, bottom: 900, width: 420, height: 900 } });
            const { initCompanionPanel, openCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();

            expect(harness.panelAttrs.get('data-edge')).toBe('left');
            expect(harness.bodyClasses.has('neconyan-companion-beside-left')).toBe(true);

            harness.triggerResizerPointerDown({
                pointerId: 3,
                button: 0,
                clientX: 664,
                preventDefault: jest.fn(),
                currentTarget: harness.resizerNode,
            });

            harness.emitPointerMove({ pointerId: 3, clientX: 794 });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('550px');
            expect(harness.resizerAttrs.get('aria-valuenow')).toBe('550');

            harness.emitPointerMove({ pointerId: 3, clientX: 480 });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('320px');

            harness.emitPointerMove({ pointerId: 3, clientX: 764 });
            harness.emitPointerUp({ pointerId: 3 });

            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('520');
        });

        test('resizes by 32px with ArrowLeft and ArrowRight on right and left edges', async () => {
            const harness = setupResizeHarness();
            const { initCompanionPanel, openCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();

            const arrowLeft = { key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() };
            const arrowRight = { key: 'ArrowRight', preventDefault: jest.fn(), stopPropagation: jest.fn() };

            harness.triggerResizerKeydown(arrowLeft);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('452px');
            expect(harness.resizerAttrs.get('aria-valuenow')).toBe('452');
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('452');
            expect(arrowLeft.preventDefault).toHaveBeenCalled();
            expect(arrowLeft.stopPropagation).toHaveBeenCalled();

            harness.triggerResizerKeydown(arrowRight);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('420px');
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('420');

            // Switch to left dock: ArrowRight widens, ArrowLeft narrows.
            accountStorageValues.set('ica--tracker-panel-handle-top-v2', JSON.stringify({ edge: 'left', fraction: 0.5 }));
            const leftHarness = setupResizeHarness();
            const leftApi = await importPanel();
            leftApi.initCompanionPanel();
            leftApi.openCompanionPanel();

            leftHarness.triggerResizerKeydown({ key: 'ArrowRight', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(leftHarness.bodyStyles.get('--neco-companion-width')).toBe('452px');
            leftHarness.triggerResizerKeydown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(leftHarness.bodyStyles.get('--neco-companion-width')).toBe('420px');
        });

        test('re-clamps width on #right-nav-panel pin/unpin and window resize without discarding saved preference', async () => {
            accountStorageValues.set('ica--tracker-panel-width', '640');
            const harness = setupResizeHarness({ width: 1280, sidebarOffset: '52px', pinnedOpen: false, pinnedWidth: 400 });
            const { initCompanionPanel, openCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('640px');
            expect(harness.resizerAttrs.get('aria-valuemax')).toBe('868');

            // Pinning #right-nav-panel (400px) reduces max to 1280 - 52 - 400 - 360 = 468px.
            harness.setPinnedOpen(true);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('468px');
            expect(harness.resizerAttrs.get('aria-valuemax')).toBe('468');
            expect(harness.resizerAttrs.get('aria-valuenow')).toBe('468');

            // Unpinning restores the user's saved 640px width.
            harness.setPinnedOpen(false);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('640px');

            // Narrowing viewport re-clamps to 1024 - 52 - 360 = 612px.
            harness.setViewportWidth(1024);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('612px');
            expect(harness.resizerAttrs.get('aria-valuemax')).toBe('612');
        });

        test('preserves single resizer node markup and delegated resize after refreshCompanionPanel()', async () => {
            const harness = setupResizeHarness();
            const { initCompanionPanel, openCompanionPanel, refreshCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();
            refreshCompanionPanel();
            refreshCompanionPanel();

            const resizerMatches = harness.getHtml().match(/class="ica--tpanel-resizer"/g) ?? [];
            expect(resizerMatches).toHaveLength(1);

            harness.triggerResizerKeydown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('452px');

            refreshCompanionPanel();
            expect(harness.getHtml()).toContain('aria-valuenow="452"');
            harness.triggerResizerKeydown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('484px');
        });

        test('clears --neco-companion-width and ignores resize on phone viewports and top/bottom sheet docks', async () => {
            accountStorageValues.set('ica--tracker-panel-width', '540');
            const harness = setupResizeHarness({ phone: false });
            const { initCompanionPanel, openCompanionPanel } = await importPanel();

            initCompanionPanel();
            openCompanionPanel();
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('540px');

            // Switching to phone clears dock classes and width property, and ignores keyboard resize.
            harness.setPhone(true);
            expect(harness.bodyClasses.has('neconyan-companion-beside')).toBe(false);
            expect(harness.bodyStyles.has('--neco-companion-width')).toBe(false);
            harness.triggerResizerKeydown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('540');

            // Back to desktop, then switch handle edge to top sheet and back via topbar launcher.
            harness.setPhone(false);
            expect(harness.bodyStyles.get('--neco-companion-width')).toBe('540px');

            accountStorageValues.set('ica--tracker-panel-handle-top-v2', JSON.stringify({ edge: 'top', fraction: 0.5 }));
            const topHarness = setupResizeHarness();
            const topApi = await importPanel();
            topApi.initCompanionPanel();
            topApi.openCompanionPanel();
            expect(topHarness.panelAttrs.get('data-edge')).toBe('top');
            expect(topHarness.bodyClasses.has('neconyan-companion-beside')).toBe(false);
            expect(topHarness.bodyStyles.has('--neco-companion-width')).toBe(false);
            topHarness.triggerResizerKeydown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: jest.fn() });
            expect(accountStorageValues.get('ica--tracker-panel-width')).toBe('540');

            // Topbar launcher docks on right edge and applies saved width.
            topApi.setCompanionPanelLauncher('topbar');
            expect(topHarness.panelAttrs.get('data-edge')).toBe('right');
            expect(topHarness.bodyClasses.has('neconyan-companion-beside-right')).toBe(true);
            expect(topHarness.bodyStyles.get('--neco-companion-width')).toBe('540px');

            // Verify stylesheet hides the resizer on phones and top/bottom sheet docks.
            const stylePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/scripts/extensions/in-chat-agents/style.css');
            const styleCss = fs.readFileSync(stylePath, 'utf8');
            expect(styleCss).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.ica--tpanel-resizer\s*\{\s*display:\s*none;/);
            expect(styleCss).toContain('.ica--tpanel:not([data-edge="right"]):not([data-edge="left"]) .ica--tpanel-resizer');
        });
    });
});
