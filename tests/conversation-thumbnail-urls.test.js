import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conversationDir = path.join(repoRoot, 'public', 'scripts', 'neconyan-conversation');

let isMobileViewport = false;
let currentAvatar = 'aster.png';
let currentPersonaAvatar = 'user-persona.png';
let personaThumbnailUnavailable = false;
const mockCharacters = [
    { avatar: 'aster.png', name: 'Aster' },
    { avatar: 'briar.png', name: 'Briar' },
];

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
    translate: text => text,
}));

await jest.unstable_mockModule('../public/scripts/user.js', () => ({
    getCurrentUserHandle: () => 'tester',
}));

await jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    user_avatar: 'user-persona.png',
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    selected_group: null,
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { auto_focus_chat_input: true },
}));

await jest.unstable_mockModule('../public/script.js', () => {
    const getThumbnailUrl = (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
    const getMobileThumbnailUrl = (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}&preset=mobile`;
    const getThumbnailUrlForViewport = (type, file) => {
        if (!file || (type === 'persona' && personaThumbnailUnavailable)) {
            return '';
        }
        return isMobileViewport
            ? getMobileThumbnailUrl(type, file)
            : getThumbnailUrl(type, file);
    };
    return {
        characters: mockCharacters,
        default_avatar: '/img/ai4.png',
        default_user_avatar: '/img/user-default.png',
        getThumbnailUrl,
        getMobileThumbnailUrl,
        getThumbnailUrlForViewport,
        messageFormatting: text => text,
        name1: 'Alex',
    };
});

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    createConversationBranch: (name, id = 'main') => ({ id, name, messages: [] }),
    createConversationGroupRecord: () => null,
    getActiveConversationBranch: () => ({ id: 'main', name: 'Main', messages: [], updatedAt: 1000 }),
    getCharacterConversationStore: () => ({ settings: { enabled: true }, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', messages: [], updatedAt: 1000 } } }),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationGroupThreadAnchor: () => null,
    getConversationGroups: () => [],
    getConversationPersonaId: () => currentPersonaAvatar || 'default',
    getConversationStore: () => ({ settings: {}, characters: {} }),
    getConversationThreadKey: avatar => `persona:${avatar}`,
    getConversationThreadStore: () => ({ settings: { enabled: true }, activeBranchId: 'main', branches: { main: { id: 'main', name: 'Main', messages: [{ role: 'character', mes: 'Hi' }], updatedAt: 1000 } } }),
    getCurrentCharacter: () => mockCharacters.find(c => c.avatar === currentAvatar) || null,
    getCurrentCharAvatar: () => currentAvatar,
    getCurrentCharName: () => 'Aster',
    getDefaultGroupConversationSettings: () => ({}),
    getGroupConversationSettings: () => ({}),
    isConversationThreadKeyForPersona: () => true,
    normalizeConversationBranch: branch => branch || { id: 'main', name: 'Main', messages: [] },
    parseConversationThreadKey: () => ({ avatar: '', groupId: '' }),
    compactConversationSettings: s => s,
    parsePositiveInt: (v, fallback) => Number(v) || fallback,
    persistConversationStore: () => {},
    pickConversationSettings: s => s,
    safeParseSettings: s => s,
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/notifications.js', () => ({
    getActiveConversationThreadKey: () => '',
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationMessagePreviewText: msg => msg?.mes || '',
    getConversationSeenAt: () => 0,
    getConversationThread: () => [],
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-panel.js', () => ({
    closePalsRail: () => {},
    renderConversationMemoryPanel: () => {},
    setPalsRailOpen: () => {},
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/bindings.js', () => ({
    requestConversationBinding: async () => null,
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({
    refreshConversationStore: async () => null,
}));

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    getCurrentActivityFromSchedule: () => ({ status: 'online' }),
    getStoredSchedule: () => null,
}));

const palsRail = await import('../public/scripts/neconyan-conversation/pals-rail.js');
const settingsStore = await import('../public/scripts/neconyan-conversation/settings-store.js');

describe('Conversation viewport-aware portrait URLs', () => {
    beforeEach(() => {
        isMobileViewport = false;
        currentAvatar = 'aster.png';
        currentPersonaAvatar = 'user-persona.png';
        personaThumbnailUnavailable = false;
    });

    test('routes central getConversationMessageAvatar through getThumbnailUrlForViewport for user, partner and character rows', () => {
        expect(palsRail.getConversationMessageAvatar({ role: 'user' }, 'aster.png'))
            .toBe('/thumbnail?type=persona&file=user-persona.png');
        expect(palsRail.getConversationMessageAvatar({ role: 'partner', extra: { partner_avatar: 'briar.png' } }, 'aster.png'))
            .toBe('/thumbnail?type=avatar&file=briar.png');
        expect(palsRail.getConversationMessageAvatar({ role: 'character' }, 'aster.png'))
            .toBe('/thumbnail?type=avatar&file=aster.png');

        isMobileViewport = true;
        expect(palsRail.getConversationMessageAvatar({ role: 'user' }, 'aster.png'))
            .toBe('/thumbnail?type=persona&file=user-persona.png&preset=mobile');
        expect(palsRail.getConversationMessageAvatar({ role: 'partner', extra: { partner_avatar: 'briar.png' } }, 'aster.png'))
            .toBe('/thumbnail?type=avatar&file=briar.png&preset=mobile');
        expect(palsRail.getConversationMessageAvatar({ role: 'character' }, 'aster.png'))
            .toBe('/thumbnail?type=avatar&file=aster.png&preset=mobile');
    });

    test('falls back to default_user_avatar when persona or character avatar is missing', () => {
        personaThumbnailUnavailable = true;
        expect(palsRail.getConversationMessageAvatar({ role: 'user' }, 'aster.png'))
            .toBe('/img/user-default.png');

        currentAvatar = '';
        expect(palsRail.getConversationMessageAvatar({ role: 'character' }, ''))
            .toBe('/img/user-default.png');
    });

    test('uses getThumbnailUrlForViewport for Conversation welcome chat thumbnails on phone vs desktop', () => {
        isMobileViewport = false;
        const desktopChats = settingsStore.getConversationWelcomeChats();
        expect(desktopChats[0]?.char_thumbnail).toBe('/thumbnail?type=avatar&file=aster.png');

        isMobileViewport = true;
        const mobileChats = settingsStore.getConversationWelcomeChats();
        expect(mobileChats[0]?.char_thumbnail).toBe('/thumbnail?type=avatar&file=aster.png&preset=mobile');
    });

    test('uses getThumbnailUrlForViewport and async decoding across Conversation display modules while keeping zoom on originals', () => {
        for (const filename of ['pals-rail.js', 'timeline-render.js', 'media.js', 'pickers.js', 'settings-store.js']) {
            const source = fs.readFileSync(path.join(conversationDir, filename), 'utf8');
            expect(source).toContain('getThumbnailUrlForViewport');
            expect(source).not.toMatch(/\bgetThumbnailUrl\s*\(/);
        }

        const timelineSource = fs.readFileSync(path.join(conversationDir, 'timeline-render.js'), 'utf8');
        expect(timelineSource).toContain('image.decoding = \'async\';');
        expect(timelineSource).toContain('typingImage.decoding = \'async\';');
        expect(timelineSource).toContain('pendingImage.decoding = \'async\';');
        expect(timelineSource).toContain('loading="lazy" decoding="async"');

        const mediaSource = fs.readFileSync(path.join(conversationDir, 'media.js'), 'utf8');
        expect(mediaSource).toContain('fallbackImage.decoding = \'async\';');
        expect(mediaSource).toContain('image.decoding = \'async\';');

        const pickersSource = fs.readFileSync(path.join(conversationDir, 'pickers.js'), 'utf8');
        expect(pickersSource).toContain('avatarEl.decoding = \'async\';');
        expect(pickersSource).toContain('img.decoding = \'async\';');
        expect(pickersSource).toContain('loading="lazy" decoding="async"');

        const chromeSource = fs.readFileSync(path.join(conversationDir, 'chrome.js'), 'utf8');
        expect(chromeSource).toContain('function getConversationFullAvatarUrl(file, type)');
        expect(chromeSource).toContain('return getUserAvatar(file);');
        expect(chromeSource).toContain('return `/characters/${encodeURIComponent(file)}`;');
    });
});
