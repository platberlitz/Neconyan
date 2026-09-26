/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

class FakeElement {
    constructor() {
        this.dataset = {};
        this.hidden = false;
    }
}

globalThis.HTMLElement = FakeElement;
globalThis.HTMLInputElement = class HTMLInputElement extends FakeElement {};
globalThis.HTMLSelectElement = class HTMLSelectElement extends FakeElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends FakeElement {};

const drawer = new FakeElement();
const backdrop = new FakeElement();
const saveCurrentPanelSettings = jest.fn();
const memoryInput = new globalThis.HTMLTextAreaElement();
let memoryText = 'Old memory';
let currentPersonaId = 'persona-b.png';

globalThis.document = {
    getElementById: (id) => {
        if (id === 'settings-drawer') return drawer;
        if (id === 'settings-backdrop') return backdrop;
        if (id === 'sb_conv_memory_summary') return memoryInput;
        return null;
    },
};

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/constants.js', () => ({
    CHROME_IDS: {
        palsRail: 'pals-rail',
        settingsBackdrop: 'settings-backdrop',
        settingsDrawer: 'settings-drawer',
    },
    DEFAULT_INACTIVITY_THRESHOLD: 120,
    DEFAULT_TALKATIVENESS: 50,
    MAX_INACTIVITY_THRESHOLD: 360,
    MIN_INACTIVITY_THRESHOLD: 15,
    WEEKDAY_LABELS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? currentPersonaId : value || ''),
    getConversationThreadStore: () => null,
    getCurrentCharAvatar: () => 'roleplay.png',
    parsePositiveInt: value => Number(value) || 0,
    saveGroupConversationSettings: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/interface.js', () => ({
    applySettingsToPanel: jest.fn(),
    saveCurrentPanelSettings,
    updateConversationChrome: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({ isConversationActiveThread: () => false }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pals-rail.js', () => ({ getScheduleEditorTargets: () => [] }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/pickers.js', () => ({
    bindPartnerList: jest.fn(),
    bindWeeklyScheduleEditor: jest.fn(),
    updateUserFooter: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/prompt.js', () => ({ updateConversationMemorySummary: jest.fn(async () => { memoryText = 'Fresh memory'; return true; }) }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/render-utils.js', () => ({
    escapeHtmlAttribute: value => value,
    escapeHtmlText: value => value,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    clamp: value => value,
    getCurrentActivityFromSchedule: jest.fn(),
    getStoredSchedule: jest.fn(),
    normalizeEditedSchedule: value => value,
    saveEditedCharacterSchedule: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    clearConversationMemorySummary: jest.fn(),
    getConversationMemorySummary: () => memoryText,
    getSettings: () => ({}),
    saveConversationMemorySummary: jest.fn(),
    saveSettings: jest.fn(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationThread: () => [],
    hasConversationMessageContent: () => false,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/timeline-render.js', () => ({
    buildChimingPartnerOptions: () => '',
    buildConnectionProfileOptions: () => '',
    buildLorebookOptions: () => '',
    buildSettingsDrawerHtml: () => '',
    ensureConversationChrome: () => null,
}));

const { closeConversationSettings, refreshConversationMemoryFromPanel } = await import('../public/scripts/neconyan-conversation/settings-panel.js');

describe('Conversation settings close identity', () => {
    beforeEach(() => {
        currentPersonaId = 'persona-b.png';
        drawer.hidden = false;
        drawer.dataset = {
            conversationAvatar: 'drawer.png',
            conversationGroupId: 'drawer-group',
            conversationPersonaId: 'drawer-persona.png',
        };
        backdrop.hidden = false;
        saveCurrentPanelSettings.mockClear();
    });

    test('saves the explicitly captured Conversation identity before selection is cleared', () => {
        closeConversationSettings({
            avatar: 'conversation.png',
            groupId: 'conversation-group',
            personaId: 'persona-a.png',
        });

        expect(saveCurrentPanelSettings).toHaveBeenCalledWith({
            avatar: 'conversation.png',
            groupId: 'conversation-group',
            personaId: 'persona-a.png',
        });
        expect(drawer.hidden).toBe(true);
    });

    test('falls back to the identity captured when the drawer opened', () => {
        closeConversationSettings();

        expect(saveCurrentPanelSettings).toHaveBeenCalledWith({
            avatar: 'drawer.png',
            groupId: 'drawer-group',
            personaId: 'drawer-persona.png',
        });
    });

    test('successful native memory refresh redraws the currently visible field', async () => {
        memoryText = memoryInput.value = 'Old memory';
        await refreshConversationMemoryFromPanel();
        expect(memoryInput.value).toBe('Fresh memory');
    });
});
