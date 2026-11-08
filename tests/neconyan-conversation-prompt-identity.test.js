import { createHash } from 'node:crypto';
import { RULES as CHESS } from '../public/scripts/neconyan-conversation/games/rules/chess.js';
import { canonicalPromptMedia, createPromptMediaContext } from '../public/scripts/prompt-media-policy.js';
/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const branch = {
    id: 'branch-a',
    memoryMessageCount: 0,
    messages: Array.from({ length: 24 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 ? 'character' : 'user',
        name: index % 2 ? 'Aster' : 'User',
        mes: `message ${index}`,
    })),
};
const gameRecord = (id = 'chess', state = CHESS.createState({ random: () => 0.5 })) => ({
    version: 1, id, difficulty: 'normal', options: {}, state, startedAt: 0, finishedNoted: false,
});
const gameBranch = { ...branch, id: 'branch-game', games: gameRecord() };
const mutationBranch = { ...branch, id: 'branch-mutation', games: gameRecord() };
const explodeBranch = { ...branch, id: 'branch-explode', games: gameRecord('explode', {}) };
const threadStore = {
    activeBranchId: 'branch-a',
    branches: { 'branch-a': branch, 'branch-game': gameBranch, 'branch-mutation': mutationBranch, 'branch-explode': explodeBranch },
    memoryMessageCount: 100,
};
const composeConversationPersonaDescription = jest.fn(() => 'captured persona appendix');
const captureConversationTextBinding = jest.fn(async scope => ({ account: 'tester', scope: { target: scope }, bindingRequest: { participants: {} } }));
const requestConversationBinding = jest.fn(async () => ({ job: { id: 'summary-job' } }));
const refreshConversationStore = jest.fn(async () => ({}));
const observeJob = jest.fn((_id, options) => { void options.onSnapshot().then(() => { options.onStop('done'); options.onDone({ state: 'completed' }); }); });
const getConversationGroupMemorySummaries = jest.fn(() => [{ groupId: 'group-a', groupName: 'Group A', summary: 'captured group memory' }]);
const getConversationParticipants = jest.fn(() => [{ avatar: 'char.png', name: 'Aster' }]);
const getConversationSoloMemorySummary = jest.fn(() => ({ summary: 'captured solo memory' }));
const saveConversationMemorySummary = jest.fn();

await jest.unstable_mockModule('../public/scripts/prompt-media-client.js', () => ({
    promptAttachmentHash: value => createHash('sha256').update(canonicalPromptMedia(value)).digest('hex'),
    browserPromptMediaContext: (metadata = {}) => createPromptMediaContext({}, metadata),
    validatePromptImageCopies: async copies => { if (copies.length) throw new Error('Derivative needs a host fixture'); },
}));
await jest.unstable_mockModule('../public/script.js', () => ({ name1: 'User' }));
await jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'persona-b.png' }));
await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { persona_description: 'active persona fallback' } }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getActiveConversationBranch: avatar => ({
        'game.png': gameBranch,
        'mutation.png': mutationBranch,
        'explode.png': explodeBranch,
    })[avatar] ?? branch,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? 'persona-b.png' : value || ''),
    getConversationThreadKey: (_avatar, groupId, { personaId }) => `persona:${personaId}:${groupId || 'solo'}`,
    getConversationThreadStore: () => threadStore,
    getCurrentCharAvatar: () => 'char.png',
    getCurrentCharName: () => 'Aster',
    parsePositiveInt: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({ captureConversationTextBinding }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/bindings.js', () => ({ requestConversationBinding }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ refreshConversationStore }));
await jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ observeJob }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/media.js', () => ({
    getCharacterAuthorNote: () => '',
    getCharacterForAvatar: avatar => ({ avatar, name: 'Aster' }),
    getConversationParticipants,
    getParticipantNamesForDisplay: participants => participants.map(participant => participant.name),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({
    composeConversationPersonaDescription,
    getAvailabilityCopy: () => ({ label: 'Online' }),
    getConversationPersonaName: personaId => personaId === 'persona-a.png' ? 'Captured User' : 'Active User',
    getUserPersonaStatus: () => '',
    getUserStatus: () => 'online',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/schedule.js', () => ({
    getCurrentActivityFromSchedule: () => ({ activity: 'free', status: 'online' }),
    getStoredSchedule: () => null,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/shared-helpers.js', () => ({
    buildConversationGroupReferenceContext: () => '',
    compileChatroomPrompt: () => '',
    formatPromptText: value => String(value || ''),
    getGroundedDialogueRulesPrompt: () => '',
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({
    getConversationGroupMemorySummaries,
    getConversationMemorySummary: () => '',
    getConversationSoloMemorySummary,
    getSettings: () => ({}),
    saveConversationMemorySummary,
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({
    memorySummaryBusyAvatars: new Set(),
    memorySummaryTimers: new Map(),
}));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/thread-store.js', () => ({
    getConversationAttachmentSummary: () => '',
    getConversationFileAttachments: () => [],
    getConversationMediaAttachments: () => [],
    getConversationMediaDisplay: () => 'list',
    getConversationMediaIndex: () => 0,
    getConversationPromptMediaAttachments: () => [],
    hasConversationMessageContent: message => Boolean(message?.mes),
}));

const realGamesContext = await import('../public/scripts/neconyan-conversation/games/prompt-context.js');
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/games/prompt-context.js', () => ({
    buildConversationGamesContext: (games, options) => {
        if (games?.id === 'explode') {
            throw new Error('game context failed');
        }
        return realGamesContext.buildConversationGamesContext(games, options);
    },
}));

const {
    buildConversationSystemPrompt,
    updateConversationMemorySummary,
} = await import('../public/scripts/neconyan-conversation/prompt.js');

describe('conversation prompt captured identity', () => {
    beforeEach(() => {
        branch.messages.forEach((message, index) => {
            message.mes = `message ${index}`;
        });
        composeConversationPersonaDescription.mockClear();
        captureConversationTextBinding.mockClear();
        requestConversationBinding.mockClear();
        refreshConversationStore.mockClear();
        observeJob.mockClear();
        getConversationGroupMemorySummaries.mockClear();
        getConversationParticipants.mockClear();
        getConversationSoloMemorySummary.mockClear();
        saveConversationMemorySummary.mockClear();
        globalThis.toastr = { info: jest.fn(), success: jest.fn(), warning: jest.fn() };
    });

    test('uses captured persona appendix scope and related memory without active-persona fallback', () => {
        const prompt = buildConversationSystemPrompt({ include_related_memory: true }, 'char.png', {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
            threadAvatar: 'char.png',
        });

        expect(prompt).toContain('captured persona appendix');
        expect(prompt).toContain('Captured User');
        expect(prompt).toContain('captured group memory');
        expect(prompt).not.toContain('active persona fallback');
        expect(composeConversationPersonaDescription).toHaveBeenCalledWith('persona-a.png', {
            avatar: 'char.png',
            groupId: '',
            personaId: 'persona-a.png',
        });
        expect(getConversationGroupMemorySummaries).toHaveBeenCalledWith('char.png', { max: 4, personaId: 'persona-a.png' });

        const groupPrompt = buildConversationSystemPrompt({ include_related_memory: true }, 'char.png', {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a.png',
            threadAvatar: 'char.png',
        });
        expect(groupPrompt).toContain('captured solo memory');
        expect(getConversationSoloMemorySummary).toHaveBeenCalledWith('char.png', { personaId: 'persona-a.png' });
        expect(getConversationParticipants).toHaveBeenLastCalledWith('char.png', expect.any(Object), {
            branchId: 'branch-a',
            groupId: 'group-a',
            personaId: 'persona-a.png',
        });
        expect(prompt).not.toContain('Current game:');
    });

    test('loads the saved game paragraph only for a branch that has one', async () => {
        const prompt = await buildConversationSystemPrompt({ include_related_memory: true }, 'game.png', {
            branchId: 'branch-game',
            groupId: '',
            personaId: 'persona-a.png',
            threadAvatar: 'game.png',
        });

        expect(prompt).toContain('Current game:');
        expect(prompt).toContain('a game of Chess is being played in this DM right now');
    });

    test('freezes the saved game before the asynchronous game module import yields', async () => {
        const originalGames = mutationBranch.games;
        const prompt = buildConversationSystemPrompt({ include_related_memory: true }, 'mutation.png', {
            branchId: 'branch-mutation',
            groupId: '',
            personaId: 'persona-a.png',
            threadAvatar: 'mutation.png',
        });
        mutationBranch.games = gameRecord('poker', {});
        try {
            await expect(prompt).resolves.toContain('a game of Chess is being played in this DM right now');
        } finally {
            mutationBranch.games = originalGames;
        }
    });

    test('propagates a game-context failure instead of sending a game-blind prompt', async () => {
        await expect(buildConversationSystemPrompt({ include_related_memory: true }, 'explode.png', {
            branchId: 'branch-explode',
            groupId: '',
            personaId: 'persona-a.png',
            threadAvatar: 'explode.png',
        })).rejects.toThrow('game context failed');
    });

    test('submits the captured branch to native summary work and observes its saved completion', async () => {
        await expect(updateConversationMemorySummary('char.png', {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        })).resolves.toBe(true);

        expect(captureConversationTextBinding).toHaveBeenCalledWith({ avatar: 'char.png', branchId: 'branch-a', groupId: '', personaId: 'persona-a.png' });
        expect(requestConversationBinding).toHaveBeenCalledWith('summary/submit', expect.objectContaining({ target: { avatar: 'char.png', branchId: 'branch-a', groupId: '', personaId: 'persona-a.png' }, force: false }), 'tester');
        expect(refreshConversationStore).toHaveBeenCalledWith('tester');
        expect(saveConversationMemorySummary).not.toHaveBeenCalled();
    });

    test('a refused native completion never writes a browser summary', async () => {
        observeJob.mockImplementationOnce((_id, options) => { options.onStop('done'); options.onDone({ state: 'failed' }); });
        const update = updateConversationMemorySummary('char.png', {
            branchId: 'branch-a',
            groupId: '',
            personaId: 'persona-a.png',
        });
        branch.messages[0].mes = 'edited while summarizing';

        await expect(update).resolves.toBe(false);
        expect(saveConversationMemorySummary).not.toHaveBeenCalled();
    });

    test('native memory refresh submits on HTTP browsers without randomUUID', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
        try {
            await expect(updateConversationMemorySummary('char.png', { branchId: 'branch-a' })).resolves.toBe(true);
            expect(requestConversationBinding.mock.calls[0][1].submissionKey).toMatch(/^sub_\d+_/);
        } finally {
            if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
            else delete globalThis.crypto;
        }
    });
});
