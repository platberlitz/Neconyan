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
const LOW_MEMORY_KEY = 'neconyan:low-memory-mode:v1';
const IOS_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

function createStorage(entries = {}) {
    const values = new Map(Object.entries(entries));
    return {
        values,
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => { values.set(key, String(value)); },
        removeItem: key => { values.delete(key); },
        get length() { return values.size; },
        key: index => Array.from(values.keys())[index] ?? null,
    };
}

function previousRunning(overrides = {}) {
    return { schema: 1, documentId: 'old-document', state: 'running', ready: false, heartbeatAt: Date.now(), visibility: 'visible',
        snapshot: { schema: 1, pageSessionId: 'old-document', at: Date.now() - 5000, mode: 'roleplay' }, events: [], ...overrides };
}

function harness({ storedCount, previous = null, lowMemoryMode, userAgent = IOS_USER_AGENT, platform = 'iPhone' } = {}) {
    const entries = {};
    if (storedCount !== undefined) entries[FAILURES_KEY] = JSON.stringify({ schema: 1, count: storedCount, at: Date.now() });
    if (lowMemoryMode !== undefined) entries[LOW_MEMORY_KEY] = lowMemoryMode;
    const localStorage = createStorage(entries);
    const sessionStorage = createStorage({ [TAB_KEY]: 'tab-1' });
    if (previous) localStorage.setItem(SESSION_PREFIX + 'tab-1', JSON.stringify(previous));
    const listeners = new Map();
    const document = {
        visibilityState: 'visible',
        wasDiscarded: false,
        body: null,
        addEventListener: (type, listener) => listeners.set(type, listener),
        getElementById: () => null,
    };
    const context = {
        console, Date, JSON, Math, Promise, Number, Object, Array, String, RegExp, Set, Map, TextEncoder,
        window: null,
        document,
        navigator: { userAgent, platform, maxTouchPoints: 5, onLine: true },
        performance: {},
        localStorage,
        sessionStorage,
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    context.window = context;
    vm.runInNewContext(diagnosticsSource, context);
    return { api: context.NeconyanCrashDiagnostics, localStorage, sessionStorage, listeners };
}

describe('startup crash-loop guard', () => {
    test('counts one unfinished start and stays quiet, then offers the safe start on the next one', () => {
        const first = harness({ previous: previousRunning() });
        expect(first.api.getStartupGuardState()).toMatchObject({ failures: 1, safeStart: false });
        expect(JSON.parse(first.localStorage.getItem(FAILURES_KEY)).count).toBe(1);

        const second = harness({ storedCount: 1, previous: previousRunning() });
        expect(second.api.getStartupGuardState()).toMatchObject({ failures: 2, safeStart: true });
        expect(JSON.parse(second.localStorage.getItem(FAILURES_KEY)).count).toBe(2);
    });

    test('a previous page that reached ready resets the run of failures', () => {
        const { api, localStorage } = harness({ storedCount: 4, previous: previousRunning({ ready: true }) });
        expect(api.getStartupGuardState()).toMatchObject({ failures: 0, safeStart: false });
        expect(localStorage.getItem(FAILURES_KEY)).toBeNull();
    });

    test('a cleanly closed previous page resets the counter', () => {
        const { api, localStorage } = harness({ storedCount: 3, previous: previousRunning({ state: 'closed' }) });
        expect(api.getStartupGuardState()).toMatchObject({ failures: 0, safeStart: false });
        expect(localStorage.getItem(FAILURES_KEY)).toBeNull();
    });

    test('a fresh tab never inherits a safe start from another tab', () => {
        const { api } = harness({ storedCount: 5 });
        expect(api.getStartupGuardState()).toMatchObject({ failures: 5, safeStart: false });
    });

    test('markAppReady resets the counter and removes the stored run', () => {
        const { api, localStorage } = harness({ storedCount: 1, previous: previousRunning() });
        expect(api.getStartupGuardState().safeStart).toBe(true);
        api.markAppReady();
        expect(api.getStartupGuardState()).toMatchObject({ failures: 0, safeStart: false });
        expect(localStorage.getItem(FAILURES_KEY)).toBeNull();
        expect(JSON.parse(localStorage.getItem(SESSION_PREFIX + 'tab-1')).ready).toBe(true);
    });

    test('the loader disappearing is not app readiness', () => {
        const { api, localStorage } = harness({ storedCount: 1, previous: previousRunning() });
        api.markBootLoaderComplete();
        expect(api.getActivity().snapshot.ready).toBe(false);
        expect(api.getStartupGuardState().safeStart).toBe(true);
        expect(localStorage.getItem(FAILURES_KEY)).not.toBeNull();
    });

    test('an explicit low-memory off is respected, and automatic mode is turned on otherwise', () => {
        const automatic = harness({ storedCount: 1, previous: previousRunning(), lowMemoryMode: 'auto' });
        expect(automatic.api.getStartupGuardState()).toMatchObject({ safeStart: true, lowMemoryAuto: true });
        expect(automatic.localStorage.getItem(LOW_MEMORY_KEY)).toBe('on');

        const explicitOff = harness({ storedCount: 1, previous: previousRunning(), lowMemoryMode: 'off' });
        expect(explicitOff.api.getStartupGuardState()).toMatchObject({ safeStart: true, lowMemoryAuto: false });
        expect(explicitOff.localStorage.getItem(LOW_MEMORY_KEY)).toBe('off');
    });

    test('desktop browsers do not turn low-memory mode on by themselves', () => {
        const { api, localStorage } = harness({ storedCount: 1, previous: previousRunning(), userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36', platform: 'Linux x86_64' });
        expect(api.getStartupGuardState()).toMatchObject({ safeStart: true, lowMemoryAuto: false });
        expect(localStorage.getItem(LOW_MEMORY_KEY)).toBeNull();
    });

    test('the pure decision caps the run and only counts an unfinished previous page', () => {
        const { api } = harness();
        expect(api.evaluateStartupGuard({ storedCount: 5, previous: previousRunning() })).toEqual({ count: 6, unfinished: true, safeStart: true });
        expect(api.evaluateStartupGuard({ storedCount: 200, previous: previousRunning() })).toEqual({ count: 99, unfinished: true, safeStart: true });
        expect(api.evaluateStartupGuard({ storedCount: 2, previous: previousRunning({ ready: true }) })).toEqual({ count: 0, unfinished: false, safeStart: false });
        expect(api.evaluateStartupGuard({ storedCount: 2, previous: null })).toEqual({ count: 2, unfinished: false, safeStart: false });
    });

    test('the gate resolves immediately for a normal load and falls back when there is no startup surface', async () => {
        const normal = harness();
        await expect(normal.api.waitForStartupGate()).resolves.toBeNull();
        expect(normal.api.getStartupGuardState()).toMatchObject({ safeStart: false, holdActive: false });

        const loop = harness({ storedCount: 1, previous: previousRunning() });
        await expect(loop.api.waitForStartupGate()).resolves.toBeNull();
        expect(loop.api.getStartupGuardState()).toMatchObject({ safeStart: false, holdActive: false });
    });
});
