/* global globalThis */
import { afterEach, expect, jest, test } from '@jest/globals';
import { mutateWorldInfo } from '../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/host.js';
import { liveLorebook, restoreLorebook } from '../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js';

const originalFetch = globalThis.fetch;
const originalHost = globalThis.SillyTavern;
const book = () => ({ entries: { 0: { uid: 0, content: 'Loaded content' } } });
const headers = revision => ({ get: () => revision });

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalHost;
});

function host(overrides = {}) {
    const context = { getRequestHeaders: () => ({}), loadWorldInfo: jest.fn(async () => book()),
        getWorldInfoLoadedRevision: () => 'loaded-revision', saveWorldInfo: jest.fn(async () => {}), ...overrides };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

test('World Info Lab carries the revision of its original fresh copy through later checks', async () => {
    const context = host();
    let reads = 0;
    globalThis.fetch = jest.fn(async () => ({ ok: true, headers: headers(++reads === 1 ? 'original-revision' : 'later-revision'), json: async () => book() }));
    await mutateWorldInfo('Lab revision', draft => { draft.entries[0].content = 'Reviewed change'; });
    expect(context.saveWorldInfo).toHaveBeenCalledWith('Lab revision', { entries: { 0: { uid: 0, content: 'Reviewed change' } } }, true, { revision: 'original-revision' });
});

test('a write after the Lab final read still conflicts at the shared save boundary', async () => {
    let current = book();
    const context = host({ saveWorldInfo: jest.fn(async (_name, draft, _immediate, { revision }) => {
        if (revision !== 'newer-revision') throw Object.assign(new Error('Conflict'), { status: 409 });
        current = draft;
    }) });
    let reads = 0;
    globalThis.fetch = jest.fn(async () => ({ ok: true, headers: headers('original-revision'), json: async () => {
        if (++reads === 2) current = { entries: { 0: { uid: 0, content: 'Another tab saved' } } };
        return book();
    } }));
    await expect(mutateWorldInfo('Lab race', draft => { draft.entries[0].content = 'Stale draft'; })).rejects.toMatchObject({ status: 409 });
    expect(context.saveWorldInfo).toHaveBeenCalledTimes(1);
    expect(current.entries[0].content).toBe('Another tab saved');
});

test('the Lab refuses to mutate when a loaded response has no revision', async () => {
    const context = host();
    const mutate = jest.fn();
    globalThis.fetch = jest.fn(async () => ({ ok: true, headers: headers(null), json: async () => book() }));
    await expect(mutateWorldInfo('Missing Lab revision', mutate)).rejects.toThrow('could not verify');
    expect(mutate).not.toHaveBeenCalled();
    expect(context.saveWorldInfo).not.toHaveBeenCalled();
});

test('Time Machine keeps the revision of its live copy outside portable snapshot data', async () => {
    const context = host();
    const live = await liveLorebook('Time Machine revision');
    expect(live).toEqual(book());
    expect(JSON.stringify(live)).not.toContain('revision');
    const snapshot = { entries: { 0: { uid: 0, content: 'Stored snapshot' } } };
    await restoreLorebook('Time Machine revision', snapshot, live);
    expect(context.saveWorldInfo).toHaveBeenCalledWith('Time Machine revision', snapshot, true, { revision: 'loaded-revision' });
});

test('Time Machine rejects an unguarded restore and preserves a 409 as a no-write conflict', async () => {
    const conflict = Object.assign(new Error('Another tab changed this book'), { status: 409 });
    const context = host({ saveWorldInfo: jest.fn(async () => { throw conflict; }) });
    await expect(restoreLorebook('Time Machine conflict', book())).rejects.toThrow('Read the current');
    expect(context.saveWorldInfo).not.toHaveBeenCalled();
    const live = await liveLorebook('Time Machine conflict');
    await expect(restoreLorebook('Time Machine conflict', book(), live)).rejects.toBe(conflict);
    expect(conflict.partialRestore).toBeUndefined();
});

test('Time Machine uses the fresh response revision when the cached host lacks revision metadata', async () => {
    const context = host({ getWorldInfoLoadedRevision: undefined });
    globalThis.fetch = jest.fn(async () => ({ ok: true, headers: headers('fresh-revision'), json: async () => book() }));
    const live = await liveLorebook('Time Machine fresh');
    await restoreLorebook('Time Machine fresh', book(), live);
    expect(context.saveWorldInfo).toHaveBeenCalledWith('Time Machine fresh', book(), true, { revision: 'fresh-revision' });
});

test('Time Machine can recreate a missing book only with an absent-only guard', async () => {
    const context = host({ loadWorldInfo: jest.fn(async () => null) });
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 404 }));
    const live = await liveLorebook('Missing Time Machine book');
    expect(live).toBeNull();
    await restoreLorebook('Missing Time Machine book', book(), live);
    expect(context.saveWorldInfo).toHaveBeenCalledWith('Missing Time Machine book', book(), true, { revision: null });
});
