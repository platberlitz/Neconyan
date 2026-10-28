import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { newState, refKey, syncSources } = await import('../src/mewmory/core.js');
const { defaultConfig } = await import('../src/mewmory/models.js');
const { processingVersion } = await import('../src/mewmory/processing.js');
const { prepareMewmoryPrompt } = await import('../src/mewmory/prepare.js');
const { planPreservedMessageHiding } = await import('../src/mewmory/hiding.js');
const { recall } = await import('../src/mewmory/retrieval.js');
const { observeMewmoryCatchUp } = await import('../public/scripts/mewmory/catch-up.js');

function fixture(count) {
    const locator = { avatar: 'Mara.png', chat: 'Story', group: false };
    const messages = Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Peter' : 'Mara', is_user: Boolean(index % 2),
        send_date: 'message-' + index, mes: 'The harbour scene contains detail number ' + index + '.',
    }));
    const source = { metadata: {}, messages };
    const state = newState(locator);
    state.enabled = true;
    syncSources(state, messages, []);
    const config = defaultConfig();
    Object.assign(config, { writerTokenizer: 'cl100k_base', historyMode: 'messages', recentMessages: 10, historyBatchMessages: 5 });
    for (const ref of state.timeline) state.checkpoints[refKey(ref)] = processingVersion(config);
    return { locator, messages, source, state, config };
}

async function prepare(item, extra = {}) {
    return prepareMewmoryPrompt({}, { locator: item.locator, history: item.messages.map((message, index) => ({ index, text: message.mes })), ...extra }, undefined, {
        loadState: async () => item.state,
        mutate: (_directories, _locator, fn) => fn(item.state) || item.state,
        readSource: () => item.source, readConfiguration: () => item.config,
        scheduleBackground: false, deterministicMarker: true,
    });
}

test('prepared message window omits only complete preserved groups', async () => {
    const item = fixture(20);
    assert.deepEqual((await prepare(item)).excludedIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    delete item.state.checkpoints[refKey(item.state.timeline[7])];
    const blocked = await prepare(item);
    assert.deepEqual(blocked.excludedIndices, [0, 1, 2, 3, 4]);
    assert.equal(blocked.history.waitingForPreservation, true);
    assert.equal(blocked.history.retainedMessages, 15);
});

test('catch-up choice keeps extra originals by default and waits only for the required prefix', async () => {
    const item = fixture(20);
    delete item.state.checkpoints[refKey(item.state.timeline[2])];
    delete item.state.checkpoints[refKey(item.state.timeline[14])];
    const immediate = await prepare(item);
    assert.equal(immediate.waiting, undefined);
    assert.equal(immediate.history.retainedMessages, 20);
    item.config.historyCatchUp = 'wait';
    const waiting = await prepare(item);
    assert.equal(waiting.waiting, true);
    assert.equal(waiting.pending, 1, 'a recent missing checkpoint does not delay this prefix');
    assert.equal(waiting.waitSnapshot.requiredRefs.length, 10);
    const bypass = await prepare(item, { mewmoryCatchUpOverride: 'reply' });
    assert.equal(bypass.history.retainedMessages, 20);
    item.state.checkpoints[refKey(item.state.timeline[2])] = processingVersion(item.config);
    const ready = await prepare(item, { mewmoryWaitSnapshot: waiting.waitSnapshot });
    assert.deepEqual(ready.excludedIndices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    item.config.memoryTokens += 1;
    await assert.rejects(prepare(item, { mewmoryWaitSnapshot: waiting.waitSnapshot }), /settings changed while waiting/);
});

test('a waiting reply can proceed once its captured older prefix is recorded', async () => {
    const item = fixture(15);
    item.config.historyCatchUp = 'wait';
    delete item.state.checkpoints[refKey(item.state.timeline[1])];
    delete item.state.checkpoints[refKey(item.state.timeline[14])];
    const initial = await prepare(item);
    assert.equal(initial.waiting, true);
    let prepared;
    let starts = 0;
    let sends = 0;
    await observeMewmoryCatchUp({ snapshot: initial.waitSnapshot, deadline: Date.now() + 5000,
        check: async snapshot => {
            prepared = await prepare(item, { mewmoryWaitSnapshot: snapshot });
            return { ready: !prepared.waiting, processing: prepared.processing };
        },
        start: async () => {
            starts++;
            item.state.checkpoints[refKey(item.state.timeline[1])] = processingVersion(item.config);
        },
    });
    if (!prepared.waiting) sends++;
    assert.equal(starts, 1);
    assert.equal(sends, 1);
    assert.deepEqual(prepared.excludedIndices, [0, 1, 2, 3, 4]);
    assert.equal(item.state.checkpoints[refKey(item.state.timeline[14])], undefined, 'recent memory can continue catching up');
});

test('hiding checks exact proposed source revisions without writing to archive', () => {
    const item = fixture(15);
    const before = JSON.stringify(item.state);
    const records = [{ chat_metadata: {} }, ...item.messages];
    assert.deepEqual(planPreservedMessageHiding(records, item.state, item.config, []), [0, 1, 2, 3, 4]);
    const changed = structuredClone(records);
    changed[1].mes = 'A newly edited message must be preserved again.';
    assert.deepEqual(planPreservedMessageHiding(changed, item.state, item.config, []), []);
    assert.equal(JSON.stringify(item.state), before);
});

test('ordinary raw passages in the retained chat are filtered before recall candidates', async () => {
    const item = fixture(15);
    const result = await prepare(item);
    assert.ok(result.inspection.retrieval.proposedPassagesSkipped > 0);
    for (const candidate of result.inspection.candidates.filter(value => value.kind === 'source' && value.dataType === 'chat')) {
        assert.ok(candidate.refs.every(ref => item.state.timeline.slice(0, 5).some(old => refKey(old) === refKey(ref))));
    }
    assert.ok(result.suppression.proof.some(value => value.passageText.includes('detail number 14')));
});

test('an aborted selector cannot retry or dispatch a fallback request', async () => {
    const item = fixture(15);
    item.config.retrieval.mode = 'keyword';
    item.config.roles.selector.enabled = true;
    item.config.roles.fallback.enabled = true;
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(recall({}, item.locator, { signal: controller.signal }, {
        loadState: async () => item.state,
        mutate: (_directories, _locator, fn) => fn(item.state) || item.state,
        readConfiguration: () => item.config,
        call: async () => {
            calls++;
            controller.abort();
            throw Object.assign(new Error('provider ended while disabled'), { status: 502 });
        },
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
});
