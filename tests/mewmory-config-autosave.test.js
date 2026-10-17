import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import {
    createMewmoryConfigAutosave, flushMewmoryConfigAutosave,
} from '../public/scripts/mewmory/config-autosave.js';

const ROLE_NAMES = ['extractor', 'pawspective', 'embedding', 'selector', 'fallback'];

function baseConfig(overrides = {}) {
    return {
        revision: 1,
        enableNewChats: false,
        autoUpdate: true,
        localOnly: false,
        excludeHistory: true,
        autoHide: false,
        autoHideTokens: 30000,
        historyWindow: 30000,
        memoryTokens: 6000,
        batchMessages: 12,
        candidateLimit: 24,
        writerTokenizer: 'auto',
        retrieval: {
            mode: 'hybrid', chunkSize: 800, chunkOverlap: 100, queryMessages: 4, semanticWeight: 0.5,
            minSimilarity: 0.2, resultLimit: 8, maxPerSource: 4, neighbourChunks: 1, batchSize: 4, includeFiles: true,
        },
        roles: Object.fromEntries(ROLE_NAMES.map(name => [name, {
            enabled: false, profileId: '', endpoint: '', model: '', modelOverride: '', modelRevision: '',
            allowRemote: true, contextTokens: 200000, maxOutputTokens: name === 'embedding' ? 0 : 32000,
            timeoutMs: 300000, tokenizer: 'auto', allowedData: ['chat', 'character', 'lore', 'memory', 'file'],
            queryPrefix: '', documentPrefix: '', ...(name === 'embedding' ? { provider: 'custom' } : {}),
        }])),
        profiles: [],
        ...overrides,
    };
}

function savedCopy(config, revision = config.revision + 1) {
    const saved = structuredClone(config);
    saved.revision = revision;
    for (const role of Object.values(saved.roles)) {
        delete role.apiKey;
        delete role.clearKey;
    }
    return saved;
}

function harness({ draft = baseConfig(), save, load, validate, account = 'alice' } = {}) {
    let current = structuredClone(draft);
    let currentAccount = account;
    const saves = [];
    const saveContexts = [];
    const loads = [];
    const states = [];
    const saveImpl = save || (async config => savedCopy(config));
    const autosave = createMewmoryConfigAutosave({
        readDraft: () => current,
        writeDraft: next => {
            if (next === null) {
                current = null;
                return;
            }
            for (const key of Object.keys(current)) if (!Object.hasOwn(next, key)) delete current[key];
            Object.assign(current, next);
        },
        getAccount: () => currentAccount,
        save: async (config, context) => {
            saves.push(structuredClone(config));
            saveContexts.push(context);
            return saveImpl(config, context);
        },
        load: load ? async context => {
            loads.push(context);
            return load(context);
        } : undefined,
        validate,
        onState: state => states.push(state),
        debounceMs: 650,
    });
    autosave.sync(structuredClone(draft), account);
    return {
        autosave, saves, saveContexts, loads, states,
        get draft() { return current; },
        get account() { return currentAccount; },
        setAccount(next) { currentAccount = next; },
    };
}

async function wait(ms = 650) {
    await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

test('typing is debounced into one request while committed controls save promptly', async () => {
    const { autosave, saves, draft } = harness();
    draft.autoHideTokens = 31000;
    autosave.schedule();
    await wait(300);
    draft.autoHideTokens = 32000;
    autosave.schedule();
    await wait(649);
    expect(saves).toHaveLength(0);
    await wait(1);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ autoHideTokens: 32000, revision: 1 });

    draft.enableNewChats = true;
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ enableNewChats: true, autoHideTokens: 32000, revision: 2 });
    expect((await autosave.flush()).ok).toBe(true);
});

test('one save runs at a time and edits made during it are saved next', async () => {
    const first = Promise.withResolvers();
    let calls = 0;
    const { autosave, saves, draft, states } = harness({
        save: config => {
            calls++;
            return calls === 1 ? first.promise : Promise.resolve(savedCopy(config));
        },
    });
    draft.autoHideTokens = 31000;
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves).toHaveLength(1);

    draft.autoHideTokens = 32000;
    draft.memoryTokens = 7000;
    autosave.schedule();
    await wait();
    expect(saves).toHaveLength(1);
    expect(states.some(state => state.saving)).toBe(true);

    first.resolve(savedCopy(saves[0]));
    await autosave.flush();
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ revision: 2, autoHideTokens: 32000, memoryTokens: 7000 });
    expect(draft).toMatchObject({ revision: 3, autoHideTokens: 32000, memoryTokens: 7000 });
});

test('an acknowledged API key clears, but a newer key typed during the save stays', async () => {
    const first = Promise.withResolvers();
    let calls = 0;
    const { autosave, saves, draft } = harness({
        save: config => {
            calls++;
            return calls === 1 ? first.promise : Promise.resolve(savedCopy(config));
        },
    });
    draft.roles.extractor.apiKey = 'key-one';
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves[0].roles.extractor.apiKey).toBe('key-one');

    draft.roles.extractor.apiKey = 'key-two';
    first.resolve(savedCopy(saves[0]));
    await autosave.flush();
    expect(saves).toHaveLength(2);
    expect(saves[1].roles.extractor.apiKey).toBe('key-two');
    expect(draft.roles.extractor.apiKey).toBeUndefined();
    expect(draft.roles.extractor.hasKey).toBeUndefined();
});

test('a clear-key tick clears only after the server acknowledges it', async () => {
    let fail = true;
    const { autosave, saves, draft } = harness({
        save: config => fail ? Promise.reject(new Error('Network down.')) : Promise.resolve(savedCopy(config)),
    });
    draft.roles.extractor.clearKey = true;
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves).toHaveLength(1);
    expect(draft.roles.extractor.clearKey).toBe(true);
    expect(autosave.state().error).toBe('Network down.');

    fail = false;
    expect((await autosave.flush()).ok).toBe(true);
    expect(draft.roles.extractor.clearKey).toBeUndefined();
});

test('incomplete number fields stay in the draft and are not sent', async () => {
    const { autosave, saves, draft } = harness({
        validate: current => current.autoHideTokens === '' ? 'finish Hide older messages when the visible chat reaches, tokens before this can save.' : '',
    });
    draft.autoHideTokens = '';
    autosave.schedule();
    await wait();
    expect(saves).toHaveLength(0);
    expect(draft.autoHideTokens).toBe('');
    await expect(autosave.flush()).resolves.toMatchObject({ ok: false, pending: true, invalid: true });

    draft.autoHideTokens = 45000;
    autosave.schedule();
    await wait();
    expect(saves).toHaveLength(1);
    expect(saves[0].autoHideTokens).toBe(45000);
});

test('an incomplete edit replaces the previous failure status', async () => {
    const { autosave, draft } = harness({
        save: () => Promise.reject(new Error('Network down.')),
        validate: current => current.autoHideTokens === '' ? 'finish Hide older messages when the visible chat reaches, tokens before this can save.' : '',
    });
    draft.autoHideTokens = 47000;
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(autosave.state()).toMatchObject({ error: 'Network down.', invalid: '' });

    draft.autoHideTokens = '';
    autosave.schedule();
    expect(autosave.state()).toMatchObject({ error: '', invalid: 'finish Hide older messages when the visible chat reaches, tokens before this can save.' });
});

test('a failed save keeps the draft and a retry saves it', async () => {
    let fail = true;
    const { autosave, saves, draft } = harness({
        save: config => fail ? Promise.reject(new Error('Network down.')) : Promise.resolve(savedCopy(config)),
    });
    draft.autoHideTokens = 47000;
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves).toHaveLength(1);
    expect(draft.autoHideTokens).toBe(47000);
    expect(autosave.state()).toMatchObject({ error: 'Network down.', saving: false });

    expect((await autosave.flush()).ok).toBe(false);
    fail = false;
    expect((await autosave.flush()).ok).toBe(true);
    expect(draft).toMatchObject({ revision: 2, autoHideTokens: 47000 });
});

test('a revision conflict merges the newer server copy and retries once', async () => {
    const remote = baseConfig({ revision: 4, memoryTokens: 7000, enableNewChats: true });
    let calls = 0;
    const { autosave, saves, draft } = harness({
        load: async () => structuredClone(remote),
        save: config => {
            calls++;
            if (calls === 1) return Promise.reject(Object.assign(new Error('Mewmory settings were changed in another tab.'), { status: 409 }));
            return Promise.resolve(savedCopy(config));
        },
    });
    draft.autoHideTokens = 48000;
    autosave.schedule({ immediate: true });
    await autosave.flush();
    expect(calls).toBe(2);
    expect(saves[1]).toMatchObject({ revision: 4, autoHideTokens: 48000, memoryTokens: 7000, enableNewChats: true });
    expect(draft).toMatchObject({ revision: 5, autoHideTokens: 48000, memoryTokens: 7000, enableNewChats: true });
});

test('an account change aborts an in-flight save and never queues its secret for another account', async () => {
    const first = Promise.withResolvers();
    let calls = 0;
    const h = harness({
        save: (config, context) => {
            calls++;
            if (calls === 1) {
                context.signal.addEventListener('abort', () => first.reject(Object.assign(new Error('Aborted.'), { name: 'AbortError' })), { once: true });
                return first.promise;
            }
            return Promise.resolve(savedCopy(config));
        },
    });
    h.draft.roles.extractor.apiKey = 'alice-secret';
    h.autosave.schedule({ immediate: true });
    await wait(0);
    expect(h.saveContexts[0]).toMatchObject({ account: 'alice' });
    expect(h.saves[0].roles.extractor.apiKey).toBe('alice-secret');

    h.draft.roles.extractor.apiKey = 'alice-secret-newer';
    h.setAccount('bob');
    h.autosave.changeAccount('bob');
    await wait(0);
    await h.autosave.flush();

    expect(h.draft).toBeNull();
    expect(h.saves).toHaveLength(1);
    expect(h.saveContexts.every(context => context.account === 'alice')).toBe(true);
    expect(h.autosave.state()).toMatchObject({ account: 'bob', accountChanged: false, pending: false });
});

test('an account mismatch response stops retries and never loads a foreign configuration', async () => {
    const h = harness({
        save: () => Promise.reject(Object.assign(
            new Error('Mewmory settings belong to a different signed-in account. Reload the page before continuing.'),
            { status: 403, code: 'MEWMORY_ACCOUNT_CHANGED' },
        )),
        load: () => Promise.resolve(baseConfig({ revision: 2 })),
    });
    h.draft.roles.extractor.apiKey = 'alice-secret';
    h.autosave.schedule({ immediate: true });
    await wait(0);
    expect(h.saveContexts[0]).toMatchObject({ account: 'alice' });
    expect(h.saves).toHaveLength(1);
    expect(h.loads).toHaveLength(0);
    expect(h.draft).toBeNull();
    expect(h.autosave.state()).toMatchObject({ accountChanged: true, pending: false });

    await expect(h.autosave.flush()).resolves.toMatchObject({ ok: false, accountChanged: true });
    expect(h.saves).toHaveLength(1);
    expect(h.loads).toHaveLength(0);
});

test('a 409 recovery that loads another account never merges it or retries the secret', async () => {
    const h = harness({
        save: () => Promise.reject(Object.assign(new Error('Mewmory changed elsewhere.'), { status: 409 })),
        load: () => Promise.resolve(baseConfig({ revision: 4, autoHideTokens: 12000, account: 'bob' })),
    });
    h.draft.roles.extractor.apiKey = 'alice-secret';
    h.autosave.schedule({ immediate: true });
    await h.autosave.flush();
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]).toMatchObject({ account: 'alice' });
    expect(h.saves).toHaveLength(1);
    expect(h.draft).toBeNull();
    expect(h.autosave.state()).toMatchObject({ accountChanged: true });
});

test('a 409 recovery rejected while loading another account never retries the secret', async () => {
    const h = harness({
        save: () => Promise.reject(Object.assign(new Error('Mewmory changed elsewhere.'), { status: 409 })),
        load: () => Promise.reject(Object.assign(
            new Error('Mewmory settings belong to a different signed-in account. Reload the page before continuing.'),
            { status: 403, code: 'MEWMORY_ACCOUNT_CHANGED' },
        )),
    });
    h.draft.roles.extractor.apiKey = 'alice-secret';
    h.autosave.schedule({ immediate: true });
    await h.autosave.flush();
    expect(h.saves).toHaveLength(1);
    expect(h.loads).toHaveLength(1);
    expect(h.draft).toBeNull();
    expect(h.autosave.state()).toMatchObject({ accountChanged: true });
});

test('a config fetched under another account is never merged into the draft', async () => {
    const h = harness();
    h.draft.autoHideTokens = 45000;
    h.autosave.sync(baseConfig({ revision: 2, autoHideTokens: 12000, account: 'bob' }), 'bob');
    expect(h.autosave.state()).toMatchObject({ accountChanged: true, remoteChange: false });
    expect(h.draft).toBeNull();

    h.autosave.schedule({ immediate: true });
    await wait(0);
    expect(h.saves).toHaveLength(0);
});

test('a live account change cancels queued work even before the account event', async () => {
    const h = harness();
    h.draft.roles.extractor.apiKey = 'alice-secret';
    h.setAccount('bob');
    h.autosave.schedule({ immediate: true });
    await wait(0);
    expect(h.saves).toHaveLength(0);
    expect(h.draft).toBeNull();
    expect(h.autosave.state().accountChanged).toBe(true);
});

test('unchanged settings are never sent', async () => {
    const { autosave, saves } = harness();
    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves).toHaveLength(0);
    expect(autosave.state().pending).toBe(false);
});

test('a newer remote copy merges with local edits instead of replacing them', async () => {
    const { autosave, saves, draft } = harness();
    draft.autoHideTokens = 45000;
    autosave.sync(baseConfig({ revision: 2, memoryTokens: 6500, enableNewChats: true }));
    expect(draft).toMatchObject({ revision: 2, autoHideTokens: 45000, memoryTokens: 6500, enableNewChats: true });
    expect(autosave.state().remoteChange).toBe(true);

    autosave.schedule({ immediate: true });
    await wait(0);
    expect(saves[0]).toMatchObject({ revision: 2, autoHideTokens: 45000, memoryTokens: 6500, enableNewChats: true });
    expect(autosave.state().remoteChange).toBe(false);
});

test('discarding during a save adopts the in-flight result rather than restoring it', async () => {
    const first = Promise.withResolvers();
    let calls = 0;
    const { autosave, saves, draft } = harness({
        save: config => {
            calls++;
            return calls === 1 ? first.promise : Promise.resolve(savedCopy(config));
        },
    });
    draft.autoHideTokens = 31000;
    autosave.schedule({ immediate: true });
    await wait(0);
    autosave.discard();
    expect(draft.autoHideTokens).toBe(30000);

    first.resolve(savedCopy(saves[0]));
    await autosave.flush();
    expect(calls).toBe(1);
    expect(draft).toMatchObject({ revision: 2, autoHideTokens: 31000 });
});

test('the exported flush helper is safe before the panel mounts', async () => {
    await expect(flushMewmoryConfigAutosave()).resolves.toMatchObject({ ok: true, pending: false, invalid: false, error: '' });
});
