/* eslint playwright/expect-expect: off -- These checks use node:assert. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { hash, newState } = await import('../src/mewmory/core.js');
const { buildMemoryRecoveryGuard, chatPath, listStories, MAX_ARCHIVE_BYTES, mutateState, readState,
    readStateShared, statePath, updateProcessing, writeJson } = await import('../src/mewmory/store.js');
const locator = { chat: 'Status', avatar: 'Mara.png', group: false };
const diskGuard = state => JSON.parse(JSON.stringify(buildMemoryRecoveryGuard(state)));

test('the private processing working state retains all admitted evidence and metadata without vector graphs', () => {
    const source = fs.readFileSync(new URL('../src/mewmory/processing.js', import.meta.url), 'utf8');
    const start = source.indexOf('function indexMetadata(index) {');
    const end = source.indexOf('async function runBatch(', start);
    assert.ok(start >= 0 && end > start);
    const workingState = runInThisContext(`(() => { ${source.slice(start, end)}; return processingWorkingState; })()`, { filename: 'processing-working-state-check.js' });
    for (const build of [false, true]) for (const getters of [false, true]) {
        const state = newState(locator);
        const published = { saved: { textHash: 'published', vector: [0.25, 0.5] } };
        const staged = { next: { textHash: 'staged', vector: [0.75] } };
        Object.assign(state.index, { version: 'published-space', futureMetadata: { keep: true } });
        // An omitted getter must neither run nor survive on the working state.
        Object.defineProperty(state.index, 'vectors', { enumerable: true, configurable: true,
            ...(getters ? { get() { throw new Error('Published vectors read'); } } : { value: published }) });
        if (build) {
            state.index.build = { version: 'next-space', owner: 'other-job', cursor: 7, futureMetadata: { keep: 'staged' } };
            Object.defineProperty(state.index.build, 'vectors', { enumerable: true,
                ...(getters ? { get() { throw new Error('Staged vectors read'); } } : { value: staged }) });
        }
        state.futureOrdinaryField = { preserve: ['every', 'future', 'value'] };
        const draft = workingState(state);
        assert.notEqual(draft, state);
        for (const key of Object.keys(state).filter(key => key !== 'index')) assert.equal(draft[key], state[key], key);
        assert.notEqual(draft.index, state.index);
        assert.equal(Object.hasOwn(draft.index, 'vectors'), false);
        for (const key of Object.keys(state.index).filter(key => !['vectors', 'build'].includes(key))) assert.equal(draft.index[key], state.index[key], key);
        if (build) {
            assert.notEqual(draft.index.build, state.index.build);
            assert.equal(Object.hasOwn(draft.index.build, 'vectors'), false);
            for (const key of Object.keys(state.index.build).filter(key => key !== 'vectors')) assert.equal(draft.index.build[key], state.index.build[key], key);
        } else assert.equal(Object.hasOwn(draft.index, 'build'), false);
        const forbidden = new Set([published, published.saved, published.saved.vector, staged, staged.next, staged.next.vector, state.index, state.index.build].filter(Boolean));
        const seen = new Set();
        const visit = value => {
            if (!value || typeof value !== 'object' || seen.has(value)) return;
            assert.equal(forbidden.has(value), false, 'No original index or vector graph may be reachable');
            seen.add(value);
            for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value);
        };
        visit(draft);
        draft.index.pending = false;
        assert.equal(state.index.pending, true);
        if (build) { draft.index.build.cursor = 8; assert.equal(state.index.build.cursor, 7); }
    }
});

function fixture(t, initial) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-processing-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'groups') };
    const archive = statePath(directories, locator);
    const recovery = path.join(root, 'mewmory', 'recovery', hash(locator) + '.json');
    const state = initial || { ...newState(locator), enabled: true,
        processing: { id: 'job', status: 'running', failures: 2, details: { attempt: 1 } } };
    state.index.vectors.saved = { vector: [0.25, -0.5], textHash: 'saved' };
    state.index.build = { version: 'next', owner: 'builder', vectors: { newer: { vector: [0.75], textHash: 'newer' } } };
    writeJson(archive, state);
    fs.mkdirSync(path.dirname(chatPath(directories, locator)), { recursive: true });
    fs.writeFileSync(chatPath(directories, locator), JSON.stringify({ chat_metadata: {} }));
    return { directories, archive, recovery, state, guards: { branchId: state.branchId, jobId: state.processing?.id } };
}

test('processing updates detach small mutable data and preserve read-only archive/vector identities', t => {
    const { directories, guards, recovery, archive } = fixture(t);
    const shared = readStateShared(directories, locator);
    const before = structuredClone(shared);
    const patch = { status: 'complete', details: { attempt: 3 } };
    const nativeClone = globalThis.structuredClone;
    const clones = t.mock.method(globalThis, 'structuredClone', value => {
        assert.notEqual(value, shared);
        assert.notEqual(value, shared.index);
        assert.notEqual(value, shared.index.vectors);
        return nativeClone(value);
    });
    const now = t.mock.method(Date, 'now', () => shared.updatedAt + 1000);
    const { state, changed } = updateProcessing(directories, locator, guards, { set: patch, remove: ['failures'] });
    assert.equal(changed, true);
    assert.notEqual(state, shared);
    assert.notEqual(state.processing, shared.processing);
    assert.equal(state.index, shared.index);
    assert.equal(state.index.vectors, shared.index.vectors);
    assert.equal(state.index.build.vectors, shared.index.build.vectors);
    for (const key of ['sources', 'records', 'jobs', 'audit', 'coverage', 'checkpoints']) assert.equal(state[key], shared[key]);
    assert.equal(state.revision, shared.revision + 1);
    assert.equal(state.updatedAt, now.mock.calls[0].result);
    assert.equal(Object.hasOwn(state.processing, 'failures'), false);
    assert.deepEqual(shared, before);
    patch.details.attempt = 99;
    state.processing.details.attempt = 88;
    assert.equal(readState(directories, locator).processing.details.attempt, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(recovery)), diskGuard(JSON.parse(fs.readFileSync(archive))));
    assert.equal(listStories(directories)[0].processing.status, 'complete');
    assert.equal(clones.mock.calls.length, 3, 'processing, patch, and the later isolated read are the only clones');
});

test('no-op and mismatched guards preserve revision/time and repair only missing recovery without mutating cached locator', t => {
    const { directories, guards, recovery, archive } = fixture(t);
    const shared = readStateShared(directories, locator);
    const savedLocator = shared.locator;
    const expected = JSON.parse(fs.readFileSync(archive, 'utf8'));
    expected.index.vectors.saved = { textHash: 'saved', vectorF32LE: Buffer.from([0, 0, 128, 62, 0, 0, 0, 191]).toString('base64') };
    expected.index.build.vectors.newer = { textHash: 'newer', vectorF32LE: Buffer.from([0, 0, 64, 63]).toString('base64') };
    for (const guard of [guards, { ...guards, branchId: 'other' }, { ...guards, jobId: 'other' },
        { ...guards, status: 'complete' }, { branchId: guards.branchId }]) {
        fs.rmSync(recovery, { force: true });
        const result = updateProcessing(directories, locator, guard, guard === guards ? {} : { set: { status: 'failed' } });
        assert.equal(result.changed, false);
        assert.equal(result.state.revision, shared.revision);
        assert.equal(result.state.updatedAt, shared.updatedAt);
        assert.equal(shared.locator, savedLocator);
        assert.equal(fs.readFileSync(archive, 'utf8'), JSON.stringify(expected));
        assert.deepEqual(JSON.parse(fs.readFileSync(recovery)), diskGuard(shared));
    }
    const bytes = fs.readFileSync(recovery);
    const rename = t.mock.method(fs, 'renameSync');
    assert.equal(updateProcessing(directories, locator, guards, {}).changed, false);
    assert.equal(rename.mock.calls.filter(call => [archive, recovery].includes(String(call.arguments[1]))).length, 0);
    assert.deepEqual(fs.readFileSync(recovery), bytes);
    assert.throws(() => updateProcessing(directories, locator, { ...guards, expectedRevision: shared.revision - 1 }), { status: 409 });
});

test('existingOnly skips missing archives and undefined is an explicit job identity', t => {
    const { directories, guards, archive, recovery } = fixture(t);
    mutateState(directories, locator, state => { delete state.processing.id; });
    assert.equal(updateProcessing(directories, locator, guards, { set: { status: 'failed' } }).changed, false);
    assert.equal(updateProcessing(directories, locator, { ...guards, jobId: undefined }, { set: { status: 'complete' } }).changed, true);
    fs.rmSync(archive);
    assert.deepEqual(updateProcessing(directories, locator, { ...guards, existingOnly: true }, { set: { status: 'failed' } }), { state: null, changed: false });
    assert.equal(fs.existsSync(archive), false);
    assert.equal(fs.existsSync(recovery), true);
});

for (const stage of ['recovery', 'archive']) for (const prior of [false, true]) {
    test(`${stage} write failure with prior recovery ${prior} leaves warm caches and disk intact, then retries`, t => {
        const { directories, guards, archive, recovery } = fixture(t);
        updateProcessing(directories, locator, guards);
        if (!prior) fs.rmSync(recovery);
        const shared = readStateShared(directories, locator);
        const before = structuredClone(shared);
        listStories(directories);
        const bytes = fs.readFileSync(archive);
        const guardBytes = prior ? fs.readFileSync(recovery) : null;
        const rename = fs.renameSync;
        let failed = false;
        const mock = t.mock.method(fs, 'renameSync', (from, to) => {
            if (!failed && String(to) === (stage === 'archive' ? archive : recovery)) {
                failed = true;
                throw new Error('Injected status write failure');
            }
            return rename(from, to);
        });
        assert.throws(() => updateProcessing(directories, locator, guards, { set: { status: 'complete' } }), /Injected status write failure/);
        assert.equal(failed, true);
        assert.deepEqual(shared, before);
        assert.equal(readStateShared(directories, locator), shared);
        assert.deepEqual(readState(directories, locator), before);
        assert.deepEqual(fs.readFileSync(archive), bytes);
        assert.equal(listStories(directories)[0].processing.status, 'running');
        if (prior) assert.deepEqual(fs.readFileSync(recovery), guardBytes);
        else assert.equal(fs.existsSync(recovery), false);
        mock.mock.restore();
        // This exercises the warmed serialized-text cache after a failed save.
        assert.equal(mutateState(directories, locator, () => {}).revision, before.revision);
        const result = updateProcessing(directories, locator, guards, { set: { status: 'complete' } });
        assert.equal(result.changed, true);
        assert.equal(result.state.revision, before.revision + 1);
        const reopened = JSON.parse(fs.readFileSync(archive));
        assert.deepEqual(readStateShared(directories, locator), reopened);
        assert.deepEqual(readState(directories, locator), reopened);
        assert.deepEqual(reopened.index, before.index);
        assert.deepEqual(JSON.parse(fs.readFileSync(recovery)), diskGuard(reopened));
        assert.equal(listStories(directories)[0].processing.status, 'complete');
    });
}

test('archive size rejection leaves both files and the shared state unchanged', t => {
    const { directories, guards, archive, recovery } = fixture(t);
    updateProcessing(directories, locator, guards);
    const shared = readStateShared(directories, locator);
    const before = fs.readFileSync(archive);
    const guard = fs.readFileSync(recovery);
    const byteLength = Buffer.byteLength;
    t.mock.method(Buffer, 'byteLength', (value, ...args) => String(value).includes('oversize-status') ? MAX_ARCHIVE_BYTES + 1 : byteLength(value, ...args));
    assert.throws(() => updateProcessing(directories, locator, guards, { set: { error: 'oversize-status' } }), { status: 413 });
    assert.equal(readStateShared(directories, locator), shared);
    assert.deepEqual(fs.readFileSync(archive), before);
    assert.deepEqual(fs.readFileSync(recovery), guard);
});

// The original full-state decision is the oracle for the optional small comparison.
function applyPatch(state, { set = {}, remove = [] }) {
    let processing = structuredClone(state.processing);
    if (Object.keys(set).length) processing = { ...processing, ...structuredClone(set) };
    if (processing != null) for (const key of remove) delete processing[key];
    if (Object.hasOwn(state, 'processing') || processing !== undefined) state.processing = processing;
}

test('processing-only JSON decisions match the original whole-archive mutator across patch shapes and recovery repair', t => {
    const initial = [undefined, null, {}, { status: 'running', id: 'job', error: 'old', details: { a: 1 } }];
    const changes = [{}, { set: {} }, { remove: ['absent'] }, { set: { status: 'running' } },
        { set: { status: 'complete', details: { a: 2 } }, remove: ['error'] },
        { set: { status: undefined } }, { remove: ['id', 'status', 'error', 'details'] },
        { set: { error: 'old', id: 'job' }, remove: ['error'] }];
    for (const processing of initial) for (const change of changes) {
        const state = newState(locator);
        if (processing !== undefined) state.processing = processing;
        const full = structuredClone(state);
        applyPatch(full, change);
        assert.equal(JSON.stringify(full.processing) !== JSON.stringify(state.processing), JSON.stringify(full) !== JSON.stringify(state));
        // Own undefined values are JSON-equivalent to absent values as well.
        if (processing === undefined) {
            state.processing = undefined;
            assert.equal(JSON.stringify(full.processing) !== JSON.stringify(state.processing), JSON.stringify(full) !== JSON.stringify(state));
        }
        for (const pretty of [false, true]) {
            const a = fixture(t, structuredClone(state));
            const b = fixture(t, structuredClone(state));
            for (const item of [a, b]) if (pretty) fs.writeFileSync(item.archive, JSON.stringify(item.state, null, 2));
            const before = readStateShared(a.directories, locator);
            const expected = mutateState(a.directories, locator, value => { applyPatch(value, change); });
            const actual = updateProcessing(b.directories, locator, b.guards, change);
            assert.equal(actual.changed, expected.revision !== before.revision);
            // Both writers stamp time independently; pin everything else exactly.
            assert.deepEqual({ ...actual.state, updatedAt: expected.updatedAt }, expected);
            assert.equal(actual.changed || actual.state.updatedAt === before.updatedAt, true);
            assert.deepEqual(JSON.parse(fs.readFileSync(b.recovery)), diskGuard(actual.state));
        }
    }
});
