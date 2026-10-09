/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

globalThis.HTMLElement = class HTMLElement {};

let currentPersonaId = 'persona-a.png';
const stores = new Map();
const submitConversationRewrite = jest.fn();
const saveConversationThread = jest.fn();
const scheduleTimelineRender = jest.fn();

function key(personaId, avatar, groupId = '') {
    return `${personaId}|${avatar}|${groupId}`;
}

function getStore(personaId, avatar = 'char.png', groupId = '') {
    return stores.get(key(personaId, avatar, groupId));
}

await jest.unstable_mockModule('../public/script.js', () => ({ online_status: 'no_connection' }));
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values), translate: text => text }));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/chrome.js', () => ({ setConversationInterfaceActive: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/presentation.js', () => ({ markConversationBranchRead: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getConversationBranches: () => [],
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: (avatar, options = {}) => getStore(options.personaId || currentPersonaId, avatar, options.groupId || ''),
    getCurrentCharacter: () => ({ avatar: 'char.png', name: 'Aster' }),
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    getIdleActionFromSettings: () => 'disabled',
    parsePositiveInt: value => Number(value) || 0,
    saveGroupConversationSettings: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({
    submitConversationRewrite,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getConversationDisplayLabel: () => ({ text: 'Aster', source: 'participants', isValue: true }),
    getConversationParticipants: () => [],
    getEffectiveConversationStatus: () => 'online',
    renderConversationParticipantStack: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    clearUnreadCount: jest.fn(),
    getBadgeLabel: value => String(value || ''),
    getUnreadCount: () => 0,
    isConversationActiveThread: (_avatar, _groupId, options = {}) => options.personaId === currentPersonaId,
    updateConversationNotificationIndicators: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({ getConversationRailItems: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getAvailabilityCopy: () => ({ detail: '', label: 'Online' }), getConnectionProfiles: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pickers.js', () => ({
    readChimingPartnersFromList: () => '',
    readWeeklyScheduleFromEditor: () => '[]',
    updateUserFooter: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    clamp: value => value,
    getConversationReplyMaxTokens: () => 100,
    getCurrentActivityFromSchedule: () => null,
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getSettings: () => ({ prose_polisher: true }),
    saveSettings: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    conversationState: {
        conversationSelectedAvatar: 'char.png',
        conversationSelectedGroupId: null,
        conversationWorkspaceOpen: true,
    },
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationThread: (avatar, options = {}) => {
        const store = getStore(options.personaId || currentPersonaId, avatar, options.groupId || '');
        return store?.branches?.[options.branchId || store.activeBranchId]?.messages || [];
    },
    isConversationPreviewValue: () => false,
    saveConversationThread,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-render.js', () => ({
    renderConversationTimeline: jest.fn(),
    updateConversationNotificationSettingsVisibility: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/typing.js', () => ({
    getActiveTypingParticipants: () => [],
    getLastConversationPreview: () => '',
    isLastConversationPreviewValue: () => false,
    updateLastPreviewFromConversation: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-scheduler.js', () => ({
    registerConversationRenderer: jest.fn(),
    scheduleInterfaceRefresh: jest.fn(),
    scheduleTimelineRender,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-utils.js', () => ({ hashConversationRenderFingerprint: value => value, setUserTextSlot: jest.fn() }));

const { handleCharacterMessagePolish } = await import('../public/scripts/neconyan-conversation/interface.js');

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function message(mes) {
    return { id: 'message-1', role: 'character', name: 'Aster', mes, created_at: 1, extra: {} };
}

describe('Conversation prose polish identity', () => {
    beforeEach(() => {
        currentPersonaId = 'persona-a.png';
        stores.clear();
        stores.set(key('persona-a.png', 'char.png'), {
            activeBranchId: 'branch-a',
            branches: {
                'branch-a': { messages: [message('original')] },
                'branch-b': { messages: [message('other branch')] },
            },
        });
        stores.set(key('persona-b.png', 'char.png'), {
            activeBranchId: 'branch-b',
            branches: { 'branch-b': { messages: [message('other persona')] } },
        });
        submitConversationRewrite.mockReset();
        saveConversationThread.mockClear();
        scheduleTimelineRender.mockClear();
        globalThis.toastr = { error: jest.fn(), info: jest.fn(), success: jest.fn() };
    });

    test('submits the captured persona branch to the server and never writes the reply itself', async () => {
        const job = deferred();
        submitConversationRewrite.mockReturnValueOnce(job.promise);

        const run = handleCharacterMessagePolish('message-1');
        stores.get(key('persona-a.png', 'char.png')).activeBranchId = 'branch-b';
        currentPersonaId = 'persona-b.png';
        job.resolve({ messageId: 'message-1', job: { state: 'completed' } });
        await run;

        expect(submitConversationRewrite).toHaveBeenCalledWith('polish', 'message-1', expect.objectContaining({
            prompt: 'Polish this message text:\n"original"',
            responseLength: 300,
            scope: expect.objectContaining({ avatar: 'char.png', branchId: 'branch-a', groupId: '', personaId: 'persona-a.png',
                messages: [expect.objectContaining({ id: 'message-1', mes: 'original' })] }),
        }));
        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(stores.get(key('persona-a.png', 'char.png')).branches['branch-a'].messages[0].mes).toBe('original');
        expect(scheduleTimelineRender).not.toHaveBeenCalled();
        expect(globalThis.toastr.success).toHaveBeenCalledWith('Reply rewritten.');
    });

    test('reports the server refusal and keeps the original reply', async () => {
        submitConversationRewrite.mockRejectedValueOnce(new Error('The message changed before it could be rewritten. The original reply was kept.'));

        await handleCharacterMessagePolish('message-1');

        expect(saveConversationThread).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalledWith('Could not rewrite the reply. The message changed before it could be rewritten. The original reply was kept.');
    });

    test('tells the user the server is still working when the page stops watching', async () => {
        submitConversationRewrite.mockResolvedValueOnce(null);

        await handleCharacterMessagePolish('message-1');

        expect(globalThis.toastr.info).toHaveBeenCalledWith(expect.stringContaining('still being written on the server'));
        expect(globalThis.toastr.success).not.toHaveBeenCalled();
    });
});
