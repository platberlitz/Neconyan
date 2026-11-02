/* global globalThis */
import { beforeEach, expect, jest, test } from '@jest/globals';
import { createCreatorDraft } from '../public/scripts/creator/model.js';

let owner = 'owner';
const saveSettings = jest.fn(async () => true);
jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}), adoptServerSettingsWrite: jest.fn(), saveSettings }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
const { CreatorSession } = await import('../public/scripts/creator/session.js');

beforeEach(() => {
    owner = 'owner';
    saveSettings.mockReset().mockResolvedValue(true);
    const storage = new Map();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
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
