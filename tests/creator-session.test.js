/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

let owner = 'owner';
const saveSettings = jest.fn(async () => true);
jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}), adoptServerSettingsWrite: jest.fn(), saveSettings }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
const invalidateWorldInfoCache = jest.fn();
const updateWorldInfoList = jest.fn(async () => {});
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({ world_info: {}, invalidateWorldInfoCache, updateWorldInfoList }));
const { CreatorSession } = await import('../public/scripts/creator/session.js');

beforeEach(() => {
    owner = 'owner';
    saveSettings.mockReset().mockResolvedValue(true);
    invalidateWorldInfoCache.mockClear();
    updateWorldInfoList.mockReset().mockResolvedValue(true);
    const storage = new Map();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
});

test.each([true, false])('canonical book readback acknowledges saved work even when list refresh succeeds: %s', async refreshed => {
    const session = pendingSession();
    updateWorldInfoList.mockResolvedValue(refreshed);
    session.draft.books = [{ id: 'book', name: 'City/Places', mode: 'copy', data: { entries: {} }, revision: null }];
    session.request = jest.fn(async route => {
        if (route === 'publish') return { operationId: 'operation', avatar: 'Mira.png', revision: 'committed', books: [{ id: 'book', name: 'CityPlaces', revision: 'saved-book', state: 'done' }] };
        if (route === 'character') return { avatar: 'Mira.png', revision: 'committed', card: session.draft.card, extraBooks: [] };
        if (route === 'book') return { name: 'CityPlaces', revision: 'saved-book', data: { entries: {} } };
        if (route === 'save') return { revision: 'adopted' };
        if (route === 'acknowledge') return { acknowledged: true };
        throw new Error(`Unexpected ${route}`);
    });
    const result = await session.publish();
    expect(result.refreshWarning).toBe(refreshed ? undefined : 'Saved resources retained. Reload the page to refresh the lorebook list.');
    expect(session.request).toHaveBeenCalledWith('book', { name: 'CityPlaces' });
    expect(session.draft.books[0].name).toBe('CityPlaces');
    expect(session.pending).toBeNull();
    expect(invalidateWorldInfoCache).toHaveBeenCalledWith('CityPlaces');
    expect(updateWorldInfoList).toHaveBeenCalledTimes(1);
    expect(session.request.mock.calls.map(([route]) => route).slice(-2)).toEqual(['save', 'acknowledge']);
});

test('explicit recovery adopts the server draft before unlocking local edits', async () => {
    const session = pendingSession();
    const recovered = structuredClone(session.draft);
    recovered.source.avatar = 'AlreadySaved.png';
    recovered.journal = { operationId: 'operation', recovered: true, books: [] };
    session.request = jest.fn(async () => ({ draft: recovered, revision: 'recovered' }));
    await session.recoverPublication();
    expect(session.request).toHaveBeenCalledWith('recover', { id: 'draft', operationId: 'operation', expectedRevision: 'draft-revision' });
    expect(session.draft.source.avatar).toBe('AlreadySaved.png');
    expect(session.pending).toBeNull();
    expect(session.revision).toBe('recovered');
});

function pendingSession() {
    const session = new CreatorSession();
    session.draft = createCreatorDraft({ id: 'draft', card: { data: { name: 'Mira' } } });
    session.revision = 'draft-revision';
    session.pending = { id: 'draft', expectedRevision: 'draft-revision', operationId: 'operation', copy: false };
    return session;
}

test('a later character edit retains the original draft and recoverable receipt', async () => {
    const session = pendingSession();
    const before = structuredClone(session.draft);
    session.request = jest.fn(async route => {
        if (route === 'publish') return { operationId: 'canonical', avatar: 'Mira.png', revision: 'committed', books: [] };
        if (route === 'character') return { avatar: 'Mira.png', revision: 'later', card: { data: { name: 'Someone edited Mira' } } };
        throw new Error(`Unexpected ${route}`);
    });
    await expect(session.publish()).rejects.toThrow('character changed again');
    expect(session.draft).toEqual(before);
    expect(session.pending.operationId).toBe('canonical');
    expect(session.publishing).toBe(false);
});

test('a later book edit cannot attach its revision to the older local book', async () => {
    const session = pendingSession();
    session.draft.books = [{ id: 'book', name: 'City', mode: 'copy', data: { entries: {} }, revision: null }];
    const before = structuredClone(session.draft);
    session.request = jest.fn(async route => {
        if (route === 'publish') return { operationId: 'canonical', avatar: 'Mira.png', revision: 'committed', books: [{ name: 'City', revision: 'saved-book' }] };
        if (route === 'character') return { avatar: 'Mira.png', revision: 'committed', card: before.card };
        if (route === 'book') return { name: 'City', revision: 'later-book', data: { entries: { 0: { content: 'Another edit' } } } };
        throw new Error(`Unexpected ${route}`);
    });
    await expect(session.publish()).rejects.toThrow('City changed again');
    expect(session.draft).toEqual(before);
    expect(session.pending).not.toBeNull();
});

test('only a definite missing receipt unlocks an unsuccessful publication', async () => {
    const session = pendingSession();
    session.request = jest.fn(async route => {
        throw Object.assign(new Error(route), { status: route === 'receipt' ? 503 : 409 });
    });
    await expect(session.publish()).rejects.toThrow('publish');
    expect(session.pending).not.toBeNull();
    session.request = jest.fn(async route => {
        throw Object.assign(new Error(route), { status: route === 'receipt' ? 404 : 409 });
    });
    await expect(session.publish()).rejects.toThrow('publish');
    expect(session.pending).toBeNull();
});

test('opening a character with an unreadable book keeps the previous draft intact', async () => {
    const session = pendingSession();
    session.pending = null;
    const before = structuredClone(session.draft);
    session.request = jest.fn(async route => {
        if (route === 'character') return { card: { data: { name: 'Other', extensions: { world: 'City' } } }, avatar: 'Other.png', revision: 'other' };
        throw Object.assign(new Error('Book unavailable'), { status: 503 });
    });
    await expect(session.create('Other.png')).rejects.toThrow('Book unavailable');
    expect(session.draft).toEqual(before);
    expect(session.revision).toBe('draft-revision');
});
