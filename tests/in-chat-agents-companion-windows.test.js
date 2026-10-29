/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('companion floating windows', () => {
    let chat;
    let agents;
    let companionResultsByMessage;
    let accountStorageValues;
    let accountStorage;
    let globallyEnabled;
    let latestValidMessageIndex;
    let windows;

    async function importWindows() {
        jest.resetModules();

        await jest.unstable_mockModule('../public/script.js', () => ({
            chat,
            getCurrentChatId: jest.fn(() => 'chat-1'),
        }));

        await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
            escapeHtml: jest.fn(value => String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')),
        }));

        await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
            accountStorage,
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
            areAgentsGloballyEnabled: jest.fn(() => globallyEnabled),
            areAgentsLoaded: jest.fn(() => true),
            getAgentById: jest.fn(id => agents.find(agent => agent.id === id)),
            getAgents: jest.fn(() => agents),
            isAgentEnabledForCurrentScope: jest.fn(agent => Boolean(agent?.enabled)),
            isAgentRuntimeAllowed: jest.fn(() => true),
            isCompanionAgent: jest.fn(agent => agent?.execution === 'companion' || agent?.category === 'companion'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-ui.js', () => ({
            cleanCompanionAgentName: jest.fn(name => String(name ?? '').trim() || 'Companion'),
            insertChoiceIntoMessageInput: jest.fn(() => true),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', () => ({
            getCompanionResults: jest.fn(message => companionResultsByMessage.get(message) ?? {}),
            getLatestValidCompanionMessageIndex: jest.fn(() => latestValidMessageIndex),
            runCompanionAgentOnMessage: jest.fn(async () => ({ status: 'done' })),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-shared.js', () => ({
            holdsReadableCompanionResults: jest.fn(message => Boolean(message)),
            isSuppressedCompanionResult: jest.fn((agentId, result) => result?.content === 'suppressed'),
        }));

        await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/view-state.js', () => ({
            runCompanionViewAction: jest.fn((button, action) => action()),
        }));

        return await import('../public/scripts/extensions/in-chat-agents/companion/companion-windows.js');
    }

    function agent(overrides = {}) {
        return {
            id: 'agent-1',
            name: 'Scene Tracker',
            icon: 'fa-cat',
            execution: 'companion',
            enabled: true,
            category: 'tracker',
            ...overrides,
        };
    }

    beforeEach(async () => {
        chat = [];
        agents = [];
        companionResultsByMessage = new Map();
        accountStorageValues = new Map();
        accountStorage = {
            getItem: jest.fn(key => accountStorageValues.get(key) ?? null),
            setItem: jest.fn((key, value) => accountStorageValues.set(key, String(value))),
        };
        globallyEnabled = true;
        latestValidMessageIndex = 0;
        globalThis.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
        windows = await importWindows();
    });

    test('parses stored state defensively and clamps fractions', () => {
        const parsed = windows.parseCompanionWindowsState(JSON.stringify({
            agents: {
                'agent-1': {
                    open: true,
                    collapsed: true,
                    positions: {
                        desktop: { x: 2, y: -4 },
                        phone: { x: 'half', y: 0.25 },
                    },
                },
                '__proto__': { open: true },
                constructor: { open: true },
                'agent-2': { open: 'yes', collapsed: 'no', positions: [] },
            },
        }));

        expect(parsed.agents['agent-1']).toEqual({
            open: true,
            collapsed: true,
            positions: { desktop: { x: 1, y: 0 } },
        });
        expect(parsed.agents['agent-2']).toEqual({ open: false, collapsed: false, positions: {} });
        expect(Object.hasOwn(parsed.agents, '__proto__')).toBe(false);
        expect(Object.hasOwn(parsed.agents, 'constructor')).toBe(false);
        expect(windows.parseCompanionWindowsState('{not json').agents).toEqual({});
        expect(windows.parseCompanionWindowsState([]).agents).toEqual({});
        expect(windows.parseCompanionWindowsState(null).agents).toEqual({});
    });

    test('keeps a window header inside the viewport and above the phone composer', () => {
        expect(windows.resolveCompanionWindowLayout({
            viewportWidth: 1280,
            viewportHeight: 900,
            desiredLeft: 5000,
            desiredTop: 100,
            width: 320,
            headerHeight: 40,
        })).toMatchObject({ left: 952, top: 100, bodyMaxHeight: 752, temporaryCollapse: false });

        const phone = windows.resolveCompanionWindowLayout({
            viewportWidth: 393,
            viewportHeight: 852,
            desiredLeft: 9999,
            desiredTop: 9999,
            width: 360,
            headerHeight: 52,
            bottomLimit: 692,
        });
        expect(phone).toMatchObject({ left: 25, top: 640, bodyMaxHeight: 0, temporaryCollapse: true });

        const collapsed = windows.resolveCompanionWindowLayout({
            viewportWidth: 393,
            viewportHeight: 852,
            desiredLeft: 9999,
            desiredTop: 9999,
            width: 260,
            headerHeight: 52,
            bottomLimit: 692,
            collapsed: true,
        });
        expect(collapsed).toMatchObject({ left: 125, top: 640, bodyMaxHeight: 0, temporaryCollapse: false });

        expect(windows.getCompanionWindowWidth(393, false, 'phone')).toBe(360);
        expect(windows.getCompanionWindowWidth(393, true, 'phone')).toBe(260);
        expect(windows.getCompanionWindowWidth(200, false, 'phone')).toBe(184);
        expect(windows.getCompanionWindowWidth(1280, false, 'desktop')).toBe(320);

        const firstDefault = windows.getCompanionWindowDefaultLayout(0, { viewportWidth: 393, width: 360, topbarBottom: 42 });
        const secondDefault = windows.getCompanionWindowDefaultLayout(1, { viewportWidth: 393, width: 360, topbarBottom: 42 });
        expect(secondDefault.top - firstDefault.top).toBeGreaterThanOrEqual(64);

        const occupied = [{
            left: firstDefault.left,
            right: firstDefault.left + 360,
            top: firstDefault.top,
            bottom: firstDefault.top + 54,
        }];
        expect(windows.findCompanionWindowDefaultSlot({
            viewportWidth: 393,
            viewportHeight: 852,
            width: 360,
            headerHeight: 54,
            topbarBottom: 42,
            bottomLimit: 635,
            occupied,
        })).toBe(1);

        const fourOccupied = [0, 1, 2, 3, 4].map(slot => {
            const layout = windows.getCompanionWindowDefaultLayout(slot, { viewportWidth: 393, width: 360, topbarBottom: 42 });
            return { left: layout.left, right: layout.left + 360, top: layout.top, bottom: layout.top + 54 };
        });
        expect(windows.findCompanionWindowDefaultSlot({
            viewportWidth: 393,
            viewportHeight: 852,
            width: 360,
            headerHeight: 54,
            topbarBottom: 42,
            bottomLimit: 635,
            occupied: fourOccupied,
        })).toBe(5);
    });

    test('turns pixel positions into bounded fractions for each viewport', () => {
        expect(windows.resolveCompanionWindowFraction({
            left: 960,
            top: 450,
            viewportWidth: 1280,
            viewportHeight: 900,
        })).toEqual({ x: 0.75, y: 0.5 });
        expect(windows.resolveCompanionWindowFraction({
            left: -20,
            top: 2000,
            viewportWidth: 393,
            viewportHeight: 852,
        })).toEqual({ x: 0, y: 1 });
    });

    test('builds escaped native controls with collapse state and unique ids', () => {
        const entry = { messageIndex: 2, result: { status: 'done', content: 'note' }, message: {}, preview: false, hostHidden: false };
        const first = windows.buildCompanionWindowHtml({
            agent: agent({ name: '<Scene>', icon: 'fa-cat' }),
            entry,
            collapsed: false,
            noteHtml: '<p>Formatted note</p>',
            canRun: true,
            canRegenerate: true,
            canShowInChat: true,
        });
        const second = windows.buildCompanionWindowHtml({ agent: agent(), entry, collapsed: true });

        expect(first).toContain('&lt;Scene&gt;');
        expect(first).not.toContain('<Scene>');
        expect(first).toContain('fa-cat');
        expect(first).toContain('role="region"');
        expect(first).toMatch(/data-action="cwin-collapse"[^>]*aria-expanded="true"/);
        expect(first).toContain('data-action="cwin-close"');
        expect(first).toContain('data-action="cwin-run-latest"');
        // Shell styles repaint every .menu_button except the shared primary class, so Run latest must carry it.
        expect(first).toMatch(/class="[^"]*\bmenu_button_primary\b[^"]*"[^>]*data-action="cwin-run-latest"/);
        expect(first).toContain('data-action="cwin-regenerate"');
        expect(first).toContain('data-action="cwin-show"');
        expect(first).toContain('Formatted note');
        expect(first).toContain('Message #2');

        const bodyId = first.match(/aria-controls="([^"]+)"/)[1];
        expect(first).toContain(`<div class="ica--cwin-body" id="${bodyId}">`);
        expect(second).toContain('aria-expanded="false"');
        expect(first.match(/aria-controls="([^"]+)"/)[1]).not.toBe(second.match(/aria-controls="([^"]+)"/)[1]);
    });

    test('rejects invalid icons and disables runs for paused or pending companions', () => {
        globallyEnabled = false;
        agents = [agent({ enabled: false })];
        const entry = { messageIndex: 1, result: { status: 'pending', content: '' }, message: {}, preview: false, hostHidden: false };
        const html = windows.buildCompanionWindowHtml({
            agent: agent({ icon: '"><img src=x onerror=alert(1)>', enabled: false }),
            entry,
            noteHtml: '',
            canRun: windows.canRunCompanionWindow(agents[0], entry),
        });

        expect(html).toContain('fa-user-astronaut');
        expect(html).not.toContain('onerror');
        expect(html).toContain('Paused');
        expect(html).toContain('Runs are off for this companion');
        expect(html).toMatch(/data-action="cwin-run-latest"[^>]*disabled/);
        expect(html).not.toContain('Formatted note');
        expect(windows.canRunCompanionWindow(agents[0], entry)).toBe(false);
    });

    test('finds the latest current-chat note across display modes and live replies', () => {
        const first = { is_user: false, is_system: false, mes: 'first' };
        const second = { is_user: false, is_system: false, mes: 'second' };
        const preview = { is_user: false, is_system: false, mes: 'live' };
        chat.push(first, second);
        companionResultsByMessage.set(first, { 'agent-1': { status: 'done', content: 'old' } });
        companionResultsByMessage.set(second, { 'agent-1': { status: 'done', content: 'new' } });
        companionResultsByMessage.set(preview, { 'agent-1': { status: 'done', content: 'live note' } });

        expect(windows.findLatestCompanionWindowEntry('agent-1')).toMatchObject({
            messageIndex: 1,
            result: { content: 'new' },
        });
        expect(windows.findLatestCompanionWindowEntry('agent-1', { previewMessage: preview })).toMatchObject({
            messageIndex: -1,
            preview: true,
            result: { content: 'live note' },
        });

        companionResultsByMessage.set(second, { 'agent-1': { status: 'done', content: 'suppressed' } });
        expect(windows.findLatestCompanionWindowEntry('agent-1')).toMatchObject({
            messageIndex: 0,
            result: { content: 'old' },
        });
    });

    test('refuses to open a hidden window without a chat context', () => {
        agents = [agent()];

        expect(windows.openCompanionWindow('agent-1')).toBe(false);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith('Open a chat with at least one message before opening a Companion window.');
        expect(accountStorage.setItem).not.toHaveBeenCalled();
    });

    test('explains every reason a window cannot open', () => {
        expect(windows.resolveCompanionWindowBlockReason({ agentExists: false })).toBe('missing');
        expect(windows.resolveCompanionWindowBlockReason({ conversationMode: true })).toBe('conversation');
        expect(windows.resolveCompanionWindowBlockReason({ hasContext: false })).toBe('no-chat');
        expect(windows.resolveCompanionWindowBlockReason()).toBe('');
    });

    test('accepts focus only from fixed header and toolbar controls', () => {
        const container = (className, parentClass) => ({
            classList: { contains: name => name === className },
            parentElement: { classList: { contains: name => name === parentClass } },
        });
        const header = container('ica--cwin-head', 'ica--cwin');
        const toolbar = container('ica--cwin-actions', 'ica--cwin-body');
        const noteSpoof = container('ica--cwin-actions', 'ica--cwin-note');

        const control = (key, parent) => ({
            dataset: { cwinFocus: key },
            closest: selector => (selector === '.ica--cwin-head, .ica--cwin-actions' ? parent : null),
        });

        expect(windows.isCompanionWindowFocusControl(control('grip', header))).toBe(true);
        expect(windows.isCompanionWindowFocusControl(control('run-latest', toolbar))).toBe(true);
        expect(windows.isCompanionWindowFocusControl(control('grip"]', header))).toBe(false);
        expect(windows.isCompanionWindowFocusControl(control('grip', noteSpoof))).toBe(false);
        expect(windows.isCompanionWindowFocusControl(control('grip', null))).toBe(false);
        expect(windows.getCompanionWindowFocusSelector('collapse')).toContain('[data-cwin-focus="collapse"]');
        expect(windows.getCompanionWindowFocusSelector('grip"]')).toBe('');
    });

    test('separates unchanged notes from chat and result changes', () => {
        const entry = { messageIndex: 3, preview: false, hostHidden: false, result: { status: 'done', content: 'same note' } };
        const noteKey = windows.getCompanionWindowNoteKey({ chatId: 'chat-1', entry });
        const render = (overrides = {}) => windows.getCompanionWindowRenderKey({
            noteKey,
            agent: { name: 'Scene Tracker', icon: 'fa-cat' },
            stateEntry: { collapsed: false },
            noteHtml: '<p>same note</p>',
            canRun: true,
            canRegenerate: true,
            canShowInChat: true,
            statusLabel: 'Ready',
            ...overrides,
        });

        expect(windows.getCompanionWindowNoteKey({ chatId: 'chat-1', entry })).toBe(noteKey);
        expect(windows.getCompanionWindowNoteKey({ chatId: 'chat-2', entry })).not.toBe(noteKey);
        expect(windows.getCompanionWindowNoteKey({
            chatId: 'chat-1',
            entry: { ...entry, result: { status: 'done', content: 'new note' } },
        })).not.toBe(noteKey);
        expect(render()).toBe(render());
        expect(render({ stateEntry: { collapsed: true } })).toBe(render());
        expect(render({ statusLabel: 'Error' })).not.toBe(render());
    });

    test('persists open, collapsed and closed state only from explicit controls', () => {
        agents = [agent()];
        chat.push({ is_user: false, is_system: false, mes: 'reply' });

        expect(windows.openCompanionWindow('agent-1')).toBe(true);
        let stored = JSON.parse(accountStorageValues.get(windows.COMPANION_WINDOWS_STORAGE_KEY));
        expect(stored.agents['agent-1']).toEqual({ open: true, collapsed: false, positions: {} });

        expect(windows.setCompanionWindowCollapsed('agent-1', true)).toBe(true);
        stored = JSON.parse(accountStorageValues.get(windows.COMPANION_WINDOWS_STORAGE_KEY));
        expect(stored.agents['agent-1'].collapsed).toBe(true);

        expect(windows.closeCompanionWindow('agent-1')).toBe(true);
        stored = JSON.parse(accountStorageValues.get(windows.COMPANION_WINDOWS_STORAGE_KEY));
        expect(stored.agents['agent-1'].open).toBe(false);
        expect(windows.isCompanionWindowOpen('agent-1')).toBe(false);

        const callsBefore = accountStorage.setItem.mock.calls.length;
        expect(windows.openCompanionWindow('missing-agent')).toBe(false);
        expect(windows.openCompanionWindow('__proto__')).toBe(false);
        expect(accountStorage.setItem).toHaveBeenCalledTimes(callsBefore);
    });
});
