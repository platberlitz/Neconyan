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

test('Resume refuses a newer draft revision before adopting the frozen card', async () => {
    const session = pendingSession();
    session.revision = 'edited-on-another-device';
    session.draft.card.data.description = 'Newer edits';
    session.request = jest.fn();
    await expect(session.publish()).rejects.toThrow('Recover for comparison');
    expect(session.draft.card.data.description).toBe('Newer edits');
    expect(session.request).not.toHaveBeenCalled();
});

test('An adoption conflict keeps local content and its receipt intact', async () => {
    const session = pendingSession();
    const before = structuredClone(session.draft);
    session.request = jest.fn(async route => {
        if (route === 'publish') return { operationId: 'operation', avatar: 'Mira.png', revision: 'committed', books: [] };
        if (route === 'character') return { avatar: 'Mira.png', revision: 'committed', card: { ...before.card, data: { ...before.card.data, description: 'Frozen publication' } }, extraBooks: [] };
        if (route === 'save') throw new Error('Draft conflict');
        throw new Error(`Unexpected ${route}`);
    });
    await expect(session.publish()).rejects.toThrow('Draft conflict');
    expect(session.draft).toEqual(before);
    expect(session.pending.operationId).toBe('operation');
});

test('Retrying a lost acknowledgement preserves edits made after adoption', async () => {
    const session = pendingSession();
    session.revision = 'adopted-and-edited';
    session.draft.source = { avatar: 'Mira.png', revision: 'committed' };
    session.draft.journal = { operationId: 'operation', avatar: 'Mira.png', revision: 'committed', state: 'done', books: [] };
    session.draft.card.data.description = 'Newer edits';
    session.request = jest.fn(async route => {
        if (route === 'acknowledge') return { acknowledged: true };
        throw new Error(`Unexpected ${route}`);
    });
    await session.publish();
    expect(session.draft.card.data.description).toBe('Newer edits');
    expect(session.pending).toBeNull();
    expect(session.request).toHaveBeenCalledTimes(1);
});

test('Opening the server version preserves the previous local recovery copy', async () => {
    const session = pendingSession();
    session.draft.card.data.description = 'Unsaved local work';
    session.remember();
    const remote = structuredClone(session.draft);
    remote.card.data.description = 'Server work';
    session.request = jest.fn(async () => ({ draft: remote, revision: 'remote', publication: null }));
    await session.open('draft');
    expect(session.draft.card.data.description).toBe('Server work');
    expect(session.recovery(true).draft.card.data.description).toBe('Unsaved local work');
});

test('Opening a library card resumes its latest draft instead of creating duplicates', async () => {
    const session = new CreatorSession();
    const draft = createCreatorDraft({ id: 'existing', avatar: 'Mira.png', card: { data: { name: 'Mira' } } });
    session.request = jest.fn(async route => {
        if (route === 'list') return { drafts: [{ id: 'existing', avatar: 'Mira.png', updatedAt: '2026-11-03' }] };
        if (route === 'get') return { draft, revision: 'saved', publication: null };
        throw new Error(`Unexpected ${route}`);
    });
    await session.create('Mira.png');
    expect(session.draft.id).toBe('existing');
    expect(session.request.mock.calls.map(([route]) => route)).toEqual(['list', 'get']);
});

test('Edits made during an open request cannot be replaced by its response', async () => {
    const session = pendingSession();
    const remote = structuredClone(session.draft);
    session.request = jest.fn(async () => {
        session.draft = structuredClone(session.draft);
        session.draft.card.data.description = 'Typed while loading';
        return { draft: remote, revision: 'remote', publication: null };
    });
    await expect(session.open('draft')).rejects.toThrow('local draft changed');
    expect(session.draft.card.data.description).toBe('Typed while loading');
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
