import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let activePersonaId = 'persona-a.png';
const stores = new Map();
const runtimeStatusOverrides = new Map();

await jest.unstable_mockModule('../public/scripts/neconyan-conversation/context.js', () => ({
    getCharacterConversationStore: (avatar, { create = true, personaId = activePersonaId } = {}) => {
        const key = `${personaId}|${avatar}`;
        if (!stores.has(key) && create) stores.set(key, {});
        return stores.get(key) || null;
    },
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: value => String(typeof value === 'undefined' ? activePersonaId : value || ''),
    getCurrentCharAvatar: () => 'char.png',
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
}));
const captureConversationTextBinding = jest.fn();
const requestConversationBinding = jest.fn();
const waitForNativeConversationJob = jest.fn();
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/generation.js', () => ({ captureConversationTextBinding }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'tester' }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/bindings.js', () => ({ requestConversationBinding }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/native-jobs.js', () => ({ waitForNativeConversationJob }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/store-sync.js', () => ({ flushConversationStore: jest.fn(), refreshConversationStore: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/shared-helpers.js', () => ({ formatPromptText: value => String(value || '') }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/settings-store.js', () => ({ getSettings: () => ({}) }));
await jest.unstable_mockModule('../public/scripts/neconyan-conversation/state.js', () => ({ runtimeStatusOverrides }));

const {
    generateCharacterSchedule,
    getConversationRuntimeStatusKey,
    getCurrentActivityFromSchedule,
    getStoredSchedule,
} = await import('../public/scripts/neconyan-conversation/schedule.js');

function storeServerSchedule(avatar, schedule, personaId) {
    stores.set(`${personaId}|${avatar}`, { schedule });
}

describe('Conversation schedule persona scoping', () => {
    beforeEach(() => {
        activePersonaId = 'persona-a.png';
        stores.clear();
        runtimeStatusOverrides.clear();
    });

    test('reads the explicitly captured persona after the active persona changes', () => {
        const scheduleA = { days: { 0: [] }, marker: 'A' };
        const scheduleB = { days: { 0: [] }, marker: 'B' };
        storeServerSchedule('char.png', scheduleA, 'persona-a.png');
        storeServerSchedule('char.png', scheduleB, 'persona-b.png');

        activePersonaId = 'persona-b.png';

        expect(getStoredSchedule('char.png', { personaId: 'persona-a.png' })).toBe(scheduleA);
        expect(getStoredSchedule('char.png', { personaId: 'persona-b.png' })).toBe(scheduleB);
    });

    test('keeps runtime activity overrides isolated by persona', () => {
        const now = new Date('2026-07-25T12:00:00Z');
        runtimeStatusOverrides.set(getConversationRuntimeStatusKey('char.png', 'persona-a.png'), {
            activity: 'working',
            expiresAt: now.getTime() + 60_000,
            status: 'dnd',
        });

        expect(getCurrentActivityFromSchedule(null, 'char.png', now, { personaId: 'persona-a.png' })).toMatchObject({
            activity: 'working',
            source: 'override',
            status: 'dnd',
        });
        expect(getCurrentActivityFromSchedule(null, 'char.png', now, { personaId: 'persona-b.png' })).toMatchObject({
            source: 'default',
            status: 'online',
        });
    });

    test('asks the server for the schedule and reports a job the page stopped watching as pending', async () => {
        captureConversationTextBinding.mockResolvedValue({ account: 'tester', scope: { target: { avatar: 'char.png' }, branchCreatedAt: '1' },
            bindingRequest: { participants: {}, acknowledgement: 'ack' } });
        requestConversationBinding.mockResolvedValue({ job: { id: 'job-1' } });
        const saved = { days: { 0: [] }, marker: 'server' };
        waitForNativeConversationJob.mockImplementationOnce(async () => {
            storeServerSchedule('char.png', saved, 'persona-a.png');
            return { state: 'completed' };
        });

        await expect(generateCharacterSchedule({ avatar: 'char.png', name: 'Char' }, { personaId: 'persona-a.png' })).resolves.toBe(saved);
        expect(requestConversationBinding).toHaveBeenCalledWith('schedule/submit', expect.objectContaining({
            target: { avatar: 'char.png' }, acknowledgement: 'ack', submissionKey: expect.any(String) }), 'tester');

        waitForNativeConversationJob.mockResolvedValueOnce(null);
        await expect(generateCharacterSchedule({ avatar: 'char.png' }, { personaId: 'persona-a.png' })).rejects.toMatchObject({ pending: true });

        waitForNativeConversationJob.mockResolvedValueOnce({ state: 'failed', error: { message: 'The provider refused.' } });
        await expect(generateCharacterSchedule({ avatar: 'char.png' }, { personaId: 'persona-a.png' })).rejects.toThrow('The provider refused.');
    });
});
