import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diagnosticsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'crash-diagnostics.js'), 'utf8');
const TAB_KEY = 'neconyan.crash-tab.v1';
const SESSION_PREFIX = 'neconyan.crash-session.v1:';
const FAILURES_KEY = 'neconyan.crash-startup-failures.v1';
const RELOADS_KEY = 'neconyan.page-reloads.v1';
const ANNOUNCED_KEY = 'neconyan.page-reload-announced.v1';
const RELOAD_NAVIGATION = [{ type: 'reload' }];

function createStorage(entries = {}, { failWritesTo = null } = {}) {
    const values = new Map(Object.entries(entries));
    return {
        values,
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => {
            if (key === failWritesTo) throw new Error('Storage is full');
            values.set(key, String(value));
        },
        removeItem: key => { values.delete(key); },
        get length() { return values.size; },
        key: index => Array.from(values.keys())[index] ?? null,
    };
}

function note(overrides = {}) {
    return { schema: 1, id: 'reload:a1', runtime: 'browser', kind: 'page-reloaded-by-app', at: new Date().toISOString(), reason: 'served-code-changed',
        summary: 'Neconyan reloaded this page to load an update', limitation: 'x', ...overrides };
}

function previousRunning(overrides = {}) {
    return { schema: 1, documentId: 'old-document', state: 'running', ready: false, heartbeatAt: Date.now(), visibility: 'visible',
        snapshot: { schema: 1, pageSessionId: 'old-document', at: Date.now() - 5000, mode: 'roleplay' }, events: [], ...overrides };
}

/** One page load. Pass the same `storage` to a second call to model the next page of the same browser. */
function pageLoad({ storage = createStorage(), notes, rawNotes, previous = null, storedFailures, navigation = RELOAD_NAVIGATION, legacyNavigationType, crashNotice = false } = {}) {
    if (notes) storage.setItem(RELOADS_KEY, JSON.stringify(notes));
    if (rawNotes !== undefined) storage.setItem(RELOADS_KEY, rawNotes);
    if (storedFailures !== undefined) storage.setItem(FAILURES_KEY, JSON.stringify({ schema: 1, count: storedFailures, at: Date.now() }));
    const sessionStorage = createStorage({ [TAB_KEY]: 'tab-1' });
    if (previous) storage.setItem(SESSION_PREFIX + 'tab-1', JSON.stringify(previous));
    const performance = {};
    if (navigation) performance.getEntriesByType = type => type === 'navigation' ? navigation : [];
    if (legacyNavigationType !== undefined) performance.navigation = { type: legacyNavigationType };
    const listeners = new Map();
    const document = {
        visibilityState: 'visible', wasDiscarded: false, body: null,
        addEventListener: () => {},
        getElementById: id => crashNotice && id === 'neconyan-crash-notice' ? { id } : null,
    };
    const context = {
        console, Date, JSON, Math, Promise, Number, Object, Array, String, RegExp, Set, Map, TextEncoder,
        window: null, document, performance, localStorage: storage, sessionStorage,
        navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', platform: 'Linux x86_64', maxTouchPoints: 0, onLine: true },
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    context.window = context;
    vm.runInNewContext(diagnosticsSource, context);
    // Leaving the page normally, as a reload does, so the next page does not see an unfinished one.
    const close = () => listeners.get('pagehide')({ persisted: false });
    return { api: context.NeconyanCrashDiagnostics, storage, close };
}

const decide = (overrides = {}) => pageLoad().api.evaluateReloadNotice({ reloads: [note()], now: Date.now(), navigationType: 'reload', ...overrides });

describe('evaluateReloadNotice', () => {
    test.each(['served-code-changed', 'cache-cleared-after-update'])('announces the automatic update reload %s', reason => {
        expect(decide({ reloads: [note({ reason })] })).toMatchObject({ action: 'show', id: 'reload:a1' });
    });

    test.each(['update-toast', 'user-requested', 'server-restarted', 'cache-cleared', 'data-protection', 'settings-conflict', 'import-finished', 'other', 'made-up'])('never announces %s', reason => {
        expect(decide({ reloads: [note({ reason })] }).action).toBe('skip');
    });

    test('only the newest note counts, even when an older one was an update', () => {
        const older = note({ id: 'reload:old' });
        expect(decide({ reloads: [older, note({ id: 'reload:new', reason: 'user-requested' })] }).action).toBe('skip');
        expect(decide({ reloads: [note({ id: 'reload:old', reason: 'user-requested' }), note({ id: 'reload:new' })] })).toMatchObject({ action: 'show', id: 'reload:new' });
    });

    test('a note is recent for two minutes and a stale or future one is left alone', () => {
        const now = Date.parse('2026-11-23T12:00:00.000Z');
        const at = offsetMs => new Date(now - offsetMs).toISOString();
        expect(decide({ now, reloads: [note({ at: at(119000) })] }).action).toBe('show');
        expect(decide({ now, reloads: [note({ at: at(120000) })] }).action).toBe('show');
        expect(decide({ now, reloads: [note({ at: at(120001) })] }).action).toBe('skip');
        expect(decide({ now, reloads: [note({ at: at(24 * 3600000) })] }).action).toBe('skip');
        expect(decide({ now, reloads: [note({ at: at(-3000) })] }).action).toBe('show');
        expect(decide({ now, reloads: [note({ at: at(-60000) })] }).action).toBe('skip');
        expect(decide({ now, reloads: [note({ at: 'not a date' })] }).action).toBe('skip');
        expect(decide({ now, reloads: [note({ at: undefined })] }).action).toBe('skip');
        expect(decide({ now, reloads: [note({ at: now })] }).action).toBe('skip');
    });

    test('a note that was already announced is not announced again', () => {
        expect(decide({ announcedId: 'reload:a1' }).action).toBe('skip');
        expect(decide({ announcedId: 'reload:other' }).action).toBe('show');
    });

    test('only a page load that is a reload counts', () => {
        for (const navigationType of ['navigate', 'back_forward', 'prerender', '', undefined, null, 1]) {
            expect(decide({ navigationType }).action).toBe('skip');
        }
        expect(decide({ navigationType: 'reload' }).action).toBe('show');
    });

    test('a crash notice or the safe start holds the notice back and marks the note handled', () => {
        expect(decide({ crashNoticePending: true })).toMatchObject({ action: 'suppress', id: 'reload:a1' });
        expect(decide({ safeStart: true })).toMatchObject({ action: 'suppress', id: 'reload:a1' });
    });

    test('an old, wrong or already announced note is never marked by a crash notice or the safe start', () => {
        expect(decide({ crashNoticePending: true, navigationType: 'navigate' }).action).toBe('skip');
        expect(decide({ safeStart: true, announcedId: 'reload:a1' }).action).toBe('skip');
        expect(decide({ safeStart: true, reloads: [note({ reason: 'user-requested' })] }).action).toBe('skip');
    });

    test('missing, empty or damaged input is left alone', () => {
        const { api } = pageLoad();
        for (const reloads of [undefined, null, [], 'text', 7, {}, [null], [undefined], [7], ['x'], [{}], [note({ id: 'bad id!' })], [note({ id: '' })], [note({ kind: 'something-else' })]]) {
            expect(api.evaluateReloadNotice({ reloads, now: Date.now(), navigationType: 'reload' }).action).toBe('skip');
        }
        expect(api.evaluateReloadNotice().action).toBe('skip');
        expect(api.evaluateReloadNotice(null).action).toBe('skip');
        expect(api.evaluateReloadNotice({ reloads: [{ get id() { throw new Error('getter'); } }] }).action).toBe('skip');
    });
});

describe('claimReloadNotice', () => {
    test('announces an automatic update reload once, then never for another reload, a new tab or a later visit', () => {
        const storage = createStorage();
        const first = pageLoad({ storage, notes: [note()] });
        expect(first.api.claimReloadNotice()).toBe(true);
        expect(storage.getItem(ANNOUNCED_KEY)).toBe('reload:a1');
        // The same page asking again, such as when it was hidden at first.
        expect(first.api.claimReloadNotice()).toBe(false);
        first.close();
        // The person pressing the browser's reload button afterwards.
        const second = pageLoad({ storage });
        expect(second.api.claimReloadNotice()).toBe(false);
        second.close();
        // A new tab or a later visit.
        const third = pageLoad({ storage, navigation: [{ type: 'navigate' }] });
        expect(third.api.claimReloadNotice()).toBe(false);
        third.close();
        expect(pageLoad({ storage, navigation: [{ type: 'back_forward' }] }).api.claimReloadNotice()).toBe(false);
    });

    test('a later automatic reload is a new note and is announced once more', () => {
        const storage = createStorage();
        const first = pageLoad({ storage, notes: [note()] });
        expect(first.api.claimReloadNotice()).toBe(true);
        first.close();
        expect(pageLoad({ storage, notes: [note(), note({ id: 'reload:a2', reason: 'cache-cleared-after-update', from: '1.0.0', to: '1.0.1' })] }).api.claimReloadNotice()).toBe(true);
        expect(storage.getItem(ANNOUNCED_KEY)).toBe('reload:a2');
    });

    test('a reload the person asked for shows nothing and marks nothing', () => {
        for (const reason of ['update-toast', 'user-requested', 'server-restarted', 'cache-cleared']) {
            const { api, storage } = pageLoad({ notes: [note({ reason })] });
            expect(api.claimReloadNotice()).toBe(false);
            expect(storage.getItem(ANNOUNCED_KEY)).toBeNull();
        }
    });

    test('a stale note and a page that is not a reload show nothing and are left unmarked', () => {
        const stale = pageLoad({ notes: [note({ at: new Date(Date.now() - 3 * 60000).toISOString() })] });
        expect(stale.api.claimReloadNotice()).toBe(false);
        expect(stale.storage.getItem(ANNOUNCED_KEY)).toBeNull();
        const opened = pageLoad({ notes: [note()], navigation: [{ type: 'navigate' }] });
        expect(opened.api.claimReloadNotice()).toBe(false);
        expect(opened.storage.getItem(ANNOUNCED_KEY)).toBeNull();
        expect(pageLoad({ notes: [note()], navigation: [] }).api.claimReloadNotice()).toBe(false);
        expect(pageLoad({ notes: [note()], navigation: null }).api.claimReloadNotice()).toBe(false);
    });

    test('an older browser without Navigation Timing 2 reports a reload through performance.navigation', () => {
        expect(pageLoad({ notes: [note()], navigation: null, legacyNavigationType: 1 }).api.claimReloadNotice()).toBe(true);
        expect(pageLoad({ notes: [note()], navigation: null, legacyNavigationType: 0 }).api.claimReloadNotice()).toBe(false);
    });

    test('a note this page writes itself right before reloading is not announced by this page', () => {
        const { api, storage, close } = pageLoad();
        expect(api.noteReload({ reason: 'served-code-changed', from: 'c0c45f1', to: 'd4e5f6a' })).toBe(true);
        expect(api.claimReloadNotice()).toBe(false);
        expect(storage.getItem(ANNOUNCED_KEY)).toBeNull();
        close();
        // The next page, which is the reload, announces it.
        expect(pageLoad({ storage }).api.claimReloadNotice()).toBe(true);
    });

    test('a note written by noteReload round-trips into an announcement with the real record shape', () => {
        const first = pageLoad();
        first.api.noteReload({ reason: 'cache-cleared-after-update', from: '1.2.3', to: '1.2.4' });
        first.close();
        const next = pageLoad({ storage: first.storage });
        expect(next.api.getReports().reloads.at(-1)).toMatchObject({ reason: 'cache-cleared-after-update', from: '1.2.3', to: '1.2.4' });
        expect(next.api.claimReloadNotice()).toBe(true);
    });

    test('a crash notice on screen holds the notice back, marks the note handled and never shows it later', () => {
        const storage = createStorage();
        const held = pageLoad({ storage, notes: [note()], crashNotice: true });
        expect(held.api.claimReloadNotice()).toBe(false);
        expect(storage.getItem(ANNOUNCED_KEY)).toBe('reload:a1');
        held.close();
        expect(pageLoad({ storage }).api.claimReloadNotice()).toBe(false);
    });

    test('a pending crash recovery holds the notice back and marks the note handled', () => {
        const storage = createStorage();
        const held = pageLoad({ storage, notes: [note()], previous: previousRunning() });
        expect(held.api.getReports().recoveries).toHaveLength(1);
        expect(held.api.claimReloadNotice()).toBe(false);
        expect(storage.getItem(ANNOUNCED_KEY)).toBe('reload:a1');
    });

    test('a hidden previous page leaves no crash notice, so the update is still announced', () => {
        const { api } = pageLoad({ notes: [note()], previous: previousRunning({ visibility: 'hidden' }) });
        expect(api.claimReloadNotice()).toBe(true);
    });

    test('the safe start screen holds the notice back and marks the note handled', () => {
        const storage = createStorage();
        const held = pageLoad({ storage, notes: [note()], storedFailures: 1, previous: previousRunning({ visibility: 'hidden' }) });
        expect(held.api.getStartupGuardState().safeStart).toBe(true);
        expect(held.api.claimReloadNotice()).toBe(false);
        expect(storage.getItem(ANNOUNCED_KEY)).toBe('reload:a1');
        held.api.markAppReady();
        held.close();
        // The next ordinary reload does not bring it back.
        expect(pageLoad({ storage }).api.claimReloadNotice()).toBe(false);
    });

    test('missing, corrupt or oversized stored notes show nothing and never throw', () => {
        for (const rawNotes of [undefined, '', '{not json', 'null', '"text"', '{}', '[null]', '[{"schema":1}]', `[${'1,'.repeat(20000)}1]`]) {
            const { api, storage } = pageLoad({ rawNotes });
            expect(api.claimReloadNotice()).toBe(false);
            expect(storage.getItem(ANNOUNCED_KEY)).toBeNull();
        }
    });

    test('a damaged announced marker is ignored, and a browser that cannot remember the note shows nothing', () => {
        const damaged = createStorage({ [ANNOUNCED_KEY]: '<script>' });
        expect(pageLoad({ storage: damaged, notes: [note()] }).api.claimReloadNotice()).toBe(true);
        const full = createStorage({}, { failWritesTo: ANNOUNCED_KEY });
        expect(pageLoad({ storage: full, notes: [note()] }).api.claimReloadNotice()).toBe(false);
        expect(full.getItem(ANNOUNCED_KEY)).toBeNull();
    });

    test('the notice never changes what a reload note means for a crash: no recovery, no failed start, no stored report', () => {
        const { api, storage } = pageLoad({ notes: [note()] });
        api.claimReloadNotice();
        expect(api.getReports()).toMatchObject({ recoveries: [], reports: [] });
        expect(api.getStartupGuardState()).toMatchObject({ failures: 0, safeStart: false, holdActive: false });
        expect(storage.getItem(FAILURES_KEY)).toBeNull();
    });
});
