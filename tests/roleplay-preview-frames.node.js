import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoleplayPreviewFrame, buildRoleplayPreviewFrame } from '../public/scripts/neconyan-conversation/roleplay-preview-frames.js';

/** Frames cross a JSON wire; both sides must agree on what arrives. */
const wire = frame => JSON.parse(JSON.stringify(frame));
const roundTrip = (sent, value) => applyRoleplayPreviewFrame(sent, wire(buildRoleplayPreviewFrame(sent, value)));
const normalized = value => JSON.parse(JSON.stringify(value));

test('a first frame is a full snapshot and reconstructs it exactly', () => {
    const value = { childId: 'child-1', stage: 'generating', text: 'Hello', reasoning: '', updatedAt: 1 };
    const frame = buildRoleplayPreviewFrame(null, value);
    assert.deepEqual(frame, { preview: value });
    assert.deepEqual(applyRoleplayPreviewFrame(null, wire(frame)), value);
});

test('growth sends only appended suffixes and omits unchanged fields', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'Hello', reasoning: 'Think', updatedAt: 1, name: 'Nova' };
    const value = { ...sent, text: 'Hello world', updatedAt: 2 };
    const frame = buildRoleplayPreviewFrame(sent, value);
    assert.deepEqual(frame.delta.text, ' world');
    assert.equal('reasoning' in frame.delta, false, 'unchanged reasoning is omitted');
    assert.equal('stage' in frame.delta.set, false, 'unchanged stage is omitted');
    assert.equal('childId' in frame.delta.set, false, 'unchanged candidate is omitted');
    assert.equal('name' in frame.delta.set, false, 'unchanged name is omitted');
    assert.deepEqual(frame.delta.set, { updatedAt: 2 });
    assert.equal('preview' in frame, false);
    assert.deepEqual(roundTrip(sent, value), value);
});

test('reasoning growth and metadata changes ride the same delta', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'Hello', reasoning: 'Think', reasoning_finished: false, token_count: 1, updatedAt: 1 };
    const value = { ...sent, reasoning: 'Thinking harder', reasoning_finished: true, token_count: 5, updatedAt: 2 };
    const frame = buildRoleplayPreviewFrame(sent, value);
    assert.equal(frame.delta.reasoning, 'ing harder');
    assert.equal('text' in frame.delta, false);
    assert.deepEqual(frame.delta.set, { reasoning_finished: true, token_count: 5, updatedAt: 2 });
    assert.deepEqual(roundTrip(sent, value), value);
});

test('a non-prefix text or reasoning rewrite falls back to a full snapshot', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'Hello world', reasoning: 'Keep', updatedAt: 1 };
    const rewrittenText = { ...sent, text: 'Goodbye', updatedAt: 2 };
    assert.deepEqual(buildRoleplayPreviewFrame(sent, rewrittenText), { preview: rewrittenText });
    const rewrittenReasoning = { ...sent, reasoning: 'Changed mind', updatedAt: 3 };
    assert.deepEqual(buildRoleplayPreviewFrame(sent, rewrittenReasoning), { preview: rewrittenReasoning });
    // An empty reply replacing text is a rewrite, not an append.
    const emptied = { ...sent, text: '', updatedAt: 4 };
    assert.deepEqual(buildRoleplayPreviewFrame(sent, emptied), { preview: emptied });
});

test('a candidate change is always a full snapshot even when the text would append', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'Hello', updatedAt: 1 };
    const value = { childId: 'child-2', stage: 'generating', text: 'Hello there', updatedAt: 2 };
    assert.deepEqual(buildRoleplayPreviewFrame(sent, value), { preview: value });
    assert.deepEqual(roundTrip(sent, value), value);
});

test('changed object metadata is sent once and unchanged object references are skipped', () => {
    const generation = { source: 'custom', model: 'fixture' };
    const sent = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', generation, updatedAt: 1 };
    // A republished snapshot keeps the same reference: nothing to send.
    const sameReference = { ...sent, updatedAt: 2 };
    let frame = buildRoleplayPreviewFrame(sent, sameReference);
    assert.deepEqual(frame.delta.set, { updatedAt: 2 });
    // A rebuilt but equal object is still unchanged content.
    const equalContent = { ...sent, generation: { model: 'fixture', source: 'custom' }, updatedAt: 3 };
    frame = buildRoleplayPreviewFrame(sent, equalContent);
    assert.equal('generation' in frame.delta.set, false, 'equal content is not resent');
    // A genuinely changed object is sent whole.
    const changed = { ...sent, generation: { ...generation, model: 'other' }, updatedAt: 4 };
    frame = buildRoleplayPreviewFrame(sent, changed);
    assert.deepEqual(frame.delta.set.generation, { source: 'custom', model: 'other' });
    assert.deepEqual(roundTrip(sent, changed), changed);
});

test('disappeared fields are unset and null values survive as null', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', gen_finished: 'x', error: null, updatedAt: 1 };
    const value = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', error: 'failed', updatedAt: 2 };
    const frame = buildRoleplayPreviewFrame(sent, value);
    assert.deepEqual(frame.delta.unset, ['gen_finished']);
    assert.equal(frame.delta.set.error, 'failed');
    assert.deepEqual(roundTrip(sent, value), normalized(value));
    // A field going null is a value, not a removal.
    const nulled = { ...sent, error: null, gen_finished: null, updatedAt: 3 };
    const nullFrame = buildRoleplayPreviewFrame(sent, nulled);
    assert.equal(nullFrame.delta.set.gen_finished, null);
    assert.equal(nullFrame.delta.unset, undefined);
    assert.deepEqual(roundTrip(sent, nulled), nulled);
});

test('undefined is treated as absent, matching the JSON wire', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', reasoning_duration: undefined, updatedAt: 1 };
    const value = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', updatedAt: 2 };
    const frame = buildRoleplayPreviewFrame(sent, value);
    assert.deepEqual(frame.delta.set, { updatedAt: 2 });
    assert.equal(frame.delta.unset, undefined, 'a field absent on the wire both times is not unset');
    assert.deepEqual(normalized(roundTrip(sent, value)), normalized(value));
});

test('an unchanged snapshot produces an empty delta that changes nothing', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: 'a', reasoning: '', updatedAt: 1 };
    const frame = buildRoleplayPreviewFrame(sent, { ...sent });
    assert.deepEqual(frame, { delta: {} });
    assert.deepEqual(roundTrip(sent, { ...sent }), sent);
});

test('empty and null values keep the protocol safe', () => {
    const sent = { childId: 'child-1', stage: 'generating', text: '', reasoning: '', updatedAt: 1 };
    const firstText = { ...sent, text: 'First', updatedAt: 2 };
    const frame = buildRoleplayPreviewFrame(sent, firstText);
    assert.deepEqual(frame.delta, { text: 'First', set: { updatedAt: 2 } });
    assert.deepEqual(roundTrip(sent, firstText), firstText);
    assert.deepEqual(buildRoleplayPreviewFrame(sent, null), { preview: null });
    assert.equal(applyRoleplayPreviewFrame(sent, null), sent, 'a malformed frame keeps the reader on its last snapshot');
});

test('a delta without a base fails so the reader reconnects, and full frames stay accepted', () => {
    assert.equal(applyRoleplayPreviewFrame(null, { delta: { text: 'orphan' } }), null);
    assert.equal(applyRoleplayPreviewFrame(undefined, wire({ delta: { set: { stage: 'generating' } } })), null);
    // Backwards compatibility: an older server only sends full snapshots.
    const full = { childId: 'child-1', stage: 'generating', text: 'whole reply', reasoning: '' };
    const latest = { childId: 'child-1', stage: 'generating', text: 'stale', reasoning: '' };
    assert.deepEqual(applyRoleplayPreviewFrame(latest, wire({ preview: full })), full);
});

test('a long stream of deltas ends in full parity with the final snapshot', () => {
    let sent = { childId: 'child-1', stage: 'preparing', text: '', reasoning: '', updatedAt: 0 };
    let reader = applyRoleplayPreviewFrame(null, wire(buildRoleplayPreviewFrame(null, sent)));
    let value = sent;
    for (let index = 1; index <= 50; index++) {
        value = { ...value, text: `${value.text} token${index}`, reasoning: `${value.reasoning} thought${index}`,
            stage: index % 10 === 0 ? 'agents' : 'generating', token_count: index, updatedAt: index };
        const frame = wire(buildRoleplayPreviewFrame(sent, value));
        reader = applyRoleplayPreviewFrame(reader, frame);
        assert.deepEqual(reader, normalized(value), `frame ${index} keeps the reader in parity`);
        sent = applyRoleplayPreviewFrame(sent, frame);
    }
    // An Agent rewrite mid-stream forces a full frame and parity survives it.
    const rewritten = { ...value, text: 'The Agent rewrote the reply.', token_count: 99, updatedAt: 51 };
    const frame = wire(buildRoleplayPreviewFrame(sent, rewritten));
    assert.equal('preview' in frame, true);
    assert.deepEqual(applyRoleplayPreviewFrame(reader, frame), normalized(rewritten));
});
