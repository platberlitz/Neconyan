import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import * as scratchpad from '../src/scratchpad/store.js';
import * as bridge from '../src/scratchpad/notebooks.js';
import * as notebooks from '../src/notebooks/store.js';
import * as assistant from '../src/notebooks/assistant.js';
import { applyPolicyPatch } from '../src/notebooks/permissions.js';
import { router as scratchpadRouter } from '../src/endpoints/scratchpad.js';
import { router as notebooksRouter } from '../src/endpoints/notebooks.js';

const SOURCE = { kind: 'roleplay', key: 'character:Nova.png:Original', label: 'Nova' };
const TEXT = '# Rules\n\nOnly this rule.\n\n# Ideas\n\nAn old idea.\n';
let counter = 0;
const op = label => `scratch-notes:${label}:${++counter}`;
const fence = (action, args) => `\`\`\`scratchpad-change\n${JSON.stringify({ type: 'notebook', action, args })}\n\`\`\``;

function prepared(t, owner = 'scratch-notes') {
    const f = fixture(t, false, owner);
    const base = f.scope;
    const world = path.join(base.directories.root, 'worlds', 'Test World.json');
    fs.mkdirSync(path.dirname(world), { recursive: true });
    fs.writeFileSync(world, JSON.stringify({ entries: { 3: { uid: 3, comment: 'Rules', content: 'Old lore.', key: ['rules'], order: 9, disable: false } } }));
    const run = change => scratchpad.withScratchpad(base, change);
    const notebookId = run(lease => notebooks.ensureDefaultNotebookLocked(lease)).id;
    const create = (title, text = TEXT) => run(lease => notebooks.createNoteLocked(lease, { operationId: op('create'), notebookId, title, text })).noteId;
    const read = noteId => run(lease => notebooks.readNoteLocked(lease, { notebookId, noteId })).entry;
    const policy = patch => run(lease => notebooks.writePoliciesLocked(lease, notebookId,
        applyPolicyPatch(notebooks.readPoliciesLocked(lease, notebookId), patch, { noteExists: () => true })));
    const context = notes => run(lease => bridge.notebookContextLocked(lease, { notes }));
    const session = settings => scratchpad.mutateBucket(base, SOURCE, bucket => scratchpad.createSession(bucket, { settings }));
    const reply = (sessionId, text) => scratchpad.mutateBucket(base, SOURCE, bucket => {
        const message = { id: scratchpad.newScratchpadId(), role: 'assistant', state: 'done', assistant: 'miso', text, created: new Date().toISOString() };
        scratchpad.findSession(bucket, sessionId).messages.push(message);
        return message;
    });
    const proposal = (sessionId, messageId, extra = {}) => run(lease => bridge.prepareNotebookProposalLocked(lease, SOURCE, { sessionId, messageId, index: 0, ...extra }));
    const decide = (sessionId, messageId, review, decision = 'allow') => run(lease => bridge.decideNotebookProposalLocked(lease, SOURCE,
        { sessionId, messageId, index: 0, proposalHash: review.proposalHash, decision }, { kind: 'user', handle: base.owner }));
    return { f, base, run, notebookId, create, read, policy, context, session, reply, proposal, decide, world };
}

test('Scratchpad reads only selected, currently shared notes, without expanding links or hidden metadata', t => {
    const a = prepared(t);
    const hidden = a.create('Private title', 'Private words.');
    const chosen = a.create('Chosen', 'Chosen words. ![[Private title]]');
    const unpicked = a.create('Unpicked', 'Unpicked words.');
    const refs = [{ notebookId: a.notebookId, noteId: chosen }, { notebookId: a.notebookId, noteId: hidden }];
    assert.equal(a.context(refs).notes.every(note => note.unavailable), true);
    a.policy({ assistant: 'read', notes: { [hidden]: { assistant: 'none' } } });
    const context = a.context(refs);
    assert.equal(context.notes[0].text, 'Chosen words. ![[Private title]]');
    assert.equal(context.notes[0].canEdit, false);
    assert.equal(context.notes[1].unavailable, true);
    assert.equal(Object.hasOwn(context.notes[1], 'title'), false);
    assert.ok(!context.text.includes('Private words.'));
    assert.ok(!context.text.includes('Unpicked words.'));
    assert.ok(!context.text.includes(unpicked));
    assert.match(context.notice, /never grant permissions/);
    a.policy({ assistant: 'none' });
    const revoked = a.context(refs);
    assert.ok(!revoked.text.includes('Chosen words.'));
    assert.notEqual(revoked.fingerprint, context.fingerprint);
});

test('temporary selection sharing exposes only its exact text and stops after revocation or expiry', t => {
    const a = prepared(t);
    const text = 'Private beginning. Shared passage. Private ending.';
    const noteId = a.create('Selection', text);
    const start = text.indexOf('Shared');
    const expectedRevision = a.read(noteId).hash;
    const grant = a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId, scope: 'selection',
        selection: { start, end: start + 'Shared passage.'.length }, operations: ['read', 'edit'], expectedRevision }));
    const refs = [{ notebookId: a.notebookId, noteId, grantId: grant.id }];
    const shared = a.context(refs);
    assert.equal(shared.notes[0].text, 'Shared passage.');
    assert.equal(shared.notes[0].canEdit, true);
    assert.equal(shared.notes[0].canAppend, false);
    assert.equal(shared.notes[0].canPublishLore, false);
    assert.ok(!shared.text.includes('Private beginning'));
    assert.ok(!shared.text.includes('Private ending'));
    a.run(lease => assistant.revokeGrantLocked(lease, grant.id));
    assert.equal(a.context(refs).notes[0].unavailable, true);
    const expired = a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId,
        scope: 'note', operations: ['read'], minutes: 1 }, Date.now() - 120000));
    assert.equal(a.context([{ ...refs[0], grantId: expired.id }]).notes[0].unavailable, true);
    assert.throws(() => a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId,
        scope: 'note', operations: ['read'], expectedRevision: 'a'.repeat(64) })), error => error.code === 'NOTE_CONFLICT');
});

test('long sections page without sharing neighbouring sections and note changes invalidate the context fingerprint', t => {
    const a = prepared(t);
    const body = 'An idea. '.repeat(4000);
    const noteId = a.create('Long', `# Shared\n${body}\n\n# Neighbour\nPrivate neighbour.`);
    a.policy({ assistant: 'read' });
    const sections = a.context([{ notebookId: a.notebookId, noteId }]).notes[0].sections;
    const ref = { notebookId: a.notebookId, noteId, sectionId: sections[0].id };
    const first = a.context([ref]);
    const second = a.context([{ ...ref, offset: first.notes[0].nextOffset }]);
    assert.equal(scratchpad.normaliseSettings({ notes: [{ ...ref, offset: 3_000_000 }] }).notes[0].offset, 3_000_000, 'pages cover the full 4 MiB note limit');
    assert.equal(first.notes[0].text + second.notes[0].text, body);
    assert.ok(!first.text.includes('Private neighbour.'));
    assert.ok(!second.text.includes('Private neighbour.'));
    const expectedRevision = a.read(noteId).hash;
    a.run(lease => notebooks.updateNoteLocked(lease, { notebookId: a.notebookId, noteId, operationId: op('update'),
        expectedRevision, changes: [{ type: 'append', markdown: 'New words.' }] }));
    assert.notEqual(a.context([ref]).fingerprint, first.fingerprint);
});

for (const access of ['read', 'edit']) {
    test(`selection and read-only grants stay narrow when permanent access is ${access}`, t => {
        const a = prepared(t);
        const text = 'Outside beginning. Shared passage. Outside ending.';
        const noteId = a.create('Already shared', text);
        a.policy({ assistant: access, assistantPublish: true });
        const start = text.indexOf('Shared');
        const grant = a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId, scope: 'selection',
            selection: { start, end: start + 'Shared passage.'.length }, operations: ['read'] }));
        const ref = { notebookId: a.notebookId, noteId, grantId: grant.id };
        const context = a.context([ref]);
        assert.equal(context.notes[0].scope, 'selection');
        assert.equal(context.notes[0].text, 'Shared passage.');
        assert.equal(context.notes[0].canEdit, false);
        assert.equal(context.notes[0].canAppend, false);
        assert.equal(context.notes[0].canPublishLore, false);
        assert.ok(!context.text.includes('Outside beginning'));
        assert.ok(!context.text.includes('Outside ending'));
        for (const tool of ['append-note', 'edit-note-selection', 'edit-note-properties']) {
            assert.throws(() => a.run(lease => assistant.captureNoteToolLocked(lease, { tool, args: { ...ref,
                markdown: 'Added.', find: 'Shared passage.', replace: 'Changed.', set: { tags: ['new'] } } })), error => error.status === 403);
        }
        const whole = a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId, scope: 'note', operations: ['read'] }));
        const note = a.context([{ ...ref, grantId: whole.id }]).notes[0];
        assert.equal(note.canEdit, false);
        assert.equal(note.canAppend, false);
        assert.equal(note.canPublishLore, false);
        a.run(lease => assistant.revokeGrantLocked(lease, grant.id));
        assert.equal(a.context([ref]).notes[0].unavailable, true, 'revocation cannot fall back to permanent access');
    });
}

for (const action of ['create-note', 'append-note', 'edit-note-section', 'edit-note-selection', 'edit-note-properties', 'publish-note-lore']) {
    test(`${action} uses the shared owner review, never requested-edit auto-saving, and replays once`, t => {
        const a = prepared(t);
        const noteId = a.create('Plan');
        a.policy({ assistant: 'edit', assistantPublish: true, requestedEdits: { operations: ['create', 'append', 'edit'], hours: 1 } });
        const section = a.run(lease => assistant.captureNoteToolLocked(lease, { tool: 'read-note', args: { notebookId: a.notebookId, noteId } })).response.sections[1];
        const sectionText = a.run(lease => assistant.captureNoteToolLocked(lease, { tool: 'read-note', args: { notebookId: a.notebookId, noteId, sectionId: section.id } })).response;
        const args = { notebookId: a.notebookId, noteId, expectedRevision: a.read(noteId).hash };
        if (action === 'create-note') Object.assign(args, { title: 'Fresh note', markdown: 'Fresh words.' });
        if (action === 'append-note') Object.assign(args, { markdown: 'Another idea.' });
        if (action === 'edit-note-section') Object.assign(args, { sectionId: section.id, expectedTextHash: sectionText.textHash, markdown: 'A new idea.' });
        if (action === 'edit-note-selection') Object.assign(args, { find: 'An old idea.', replace: 'A new idea.' });
        if (action === 'edit-note-properties') Object.assign(args, { set: { tags: ['planning'], aliases: ['Plan B'] } });
        const world = a.world;
        const originalWorld = fs.readFileSync(world, 'utf8');
        if (action === 'publish-note-lore') Object.assign(args, { book: 'Test World', uid: 3, sectionId: section.id });
        const session = a.session();
        const message = a.reply(session.id, fence(action, args));
        const review = a.proposal(session.id, message.id, { change: { args: { markdown: 'Forged text.' } }, userConfirmed: true });
        assert.equal(review.state, 'waiting');
        assert.equal(a.read(noteId).text, TEXT, 'preparing a review never writes a note');
        assert.equal(fs.readFileSync(world, 'utf8'), originalWorld, 'preparing a review never publishes lore');
        assert.equal(a.run(lease => assistant.listProposalsLocked(lease)).length, 1);
        assert.equal(a.proposal(session.id, message.id).proposalId, review.proposalId, 'the same card has one shared review');
        const rebound = a.run(lease => bridge.prepareNotebookProposalLocked(lease, { ...SOURCE, key: 'different-storage-key' },
            { sessionId: session.id, messageId: message.id, index: 0 }, { bucket: scratchpad.readBucketLocked(lease, SOURCE), save: false }));
        assert.equal(rebound.proposalId, review.proposalId, 'a stored review survives a change to the public source key');
        assert.equal(a.run(lease => assistant.listProposalsLocked(lease)).length, 1);
        const approved = a.decide(session.id, message.id, review);
        assert.equal(approved.result.committed, true);
        assert.equal(approved.bucket.sessions[0].messages[0].proposals[0], 'applied');
        const after = a.read(noteId).text;
        const replay = a.decide(session.id, message.id, review);
        assert.equal(replay.result.replayed, true);
        assert.equal(a.read(noteId).text, after);
        if (action === 'create-note') assert.equal(a.read(approved.result.noteId).text, 'Fresh words.');
        if (action === 'append-note') assert.equal(after.split('Another idea.').length, 2);
        if (action.startsWith('edit-note-')) assert.match(after, /Only this rule\./);
        if (action === 'edit-note-properties') assert.match(after, /planning/);
        if (action === 'publish-note-lore') {
            const beforeEntry = JSON.parse(originalWorld).entries[3];
            const entry = JSON.parse(fs.readFileSync(world, 'utf8')).entries[3];
            assert.equal(entry.content, 'An old idea.');
            assert.deepEqual({ ...entry, content: beforeEntry.content }, beforeEntry);
            assert.equal(after, TEXT);
        }
    });
}

test('Notebook-side decisions update Scratchpad cards, and stale, denied or changed suggestions cannot write', t => {
    const a = prepared(t);
    const noteId = a.create('Plan');
    a.policy({ assistant: 'edit' });
    const session = a.session();
    const args = { notebookId: a.notebookId, noteId, markdown: 'New idea.', expectedRevision: a.read(noteId).hash };
    const first = a.reply(session.id, fence('append-note', args));
    const review = a.proposal(session.id, first.id);
    a.run(lease => assistant.decideProposalLocked(lease, { proposalId: review.proposalId, proposalHash: review.proposalHash, decision: 'deny' }));
    const projected = a.run(lease => bridge.projectNotebookProposalsLocked(lease, scratchpad.readBucketLocked(lease, SOURCE)));
    assert.equal(projected.sessions[0].messages[0].proposals[0], 'rejected');
    assert.equal(a.decide(session.id, first.id, review).result.committed, false);
    const second = a.reply(session.id, fence('append-note', args));
    const stale = a.proposal(session.id, second.id);
    a.run(lease => notebooks.updateNoteLocked(lease, { notebookId: a.notebookId, noteId, operationId: op('human'),
        expectedRevision: args.expectedRevision, changes: [{ type: 'append', markdown: 'Owner edit.' }] }));
    assert.throws(() => a.decide(session.id, second.id, stale), error => error.code === 'NOTE_CONFLICT');
    assert.ok(!a.read(noteId).text.includes('New idea.'));
    scratchpad.mutateBucket(a.base, SOURCE, bucket => scratchpad.updateMessage(bucket, session.id, second.id, fence('append-note', { ...args, markdown: 'Changed idea.' })));
    assert.throws(() => a.decide(session.id, second.id, stale), error => error.code === 'SCRATCHPAD_PROPOSAL_INVALID');
    const third = a.reply(session.id, fence('append-note', { ...args, expectedRevision: a.read(noteId).hash }));
    const revoked = a.proposal(session.id, third.id);
    a.policy({ assistant: 'read' });
    assert.throws(() => a.decide(session.id, third.id, revoked), error => error.code === 'PROPOSAL_STALE');
});

test('selection edit grants cannot append, change properties, publish or reach text outside the shared passage', t => {
    const a = prepared(t);
    const noteId = a.create('Private', 'Private. Shared. Other private.');
    const grant = a.run(lease => assistant.createGrantLocked(lease, { notebookId: a.notebookId, noteId,
        scope: 'selection', selection: { start: 9, end: 16 }, operations: ['read', 'edit'] }));
    const session = a.session();
    const args = { notebookId: a.notebookId, noteId, grantId: grant.id, expectedRevision: a.read(noteId).hash };
    for (const [action, extra] of [
        ['append-note', { markdown: 'More.' }], ['edit-note-properties', { set: { tags: ['x'] } }],
        ['edit-note-selection', { find: 'Private.', replace: 'Changed.' }], ['publish-note-lore', { book: 'Test World', uid: 3 }],
    ]) {
        const message = a.reply(session.id, fence(action, { ...args, ...extra }));
        assert.throws(() => a.proposal(session.id, message.id), error => [403, 404, 409].includes(error.status));
    }
    const message = a.reply(session.id, fence('edit-note-selection', { ...args, find: 'Shared.', replace: 'Changed.' }));
    a.decide(session.id, message.id, a.proposal(session.id, message.id));
    assert.equal(a.read(noteId).text, 'Private. Changed. Other private.');
});

async function endpoint(t, a) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { profile: { handle: a.base.owner }, directories: a.base.directories }; next(); });
    app.use('/scratchpad', scratchpadRouter);
    app.use('/notebooks', notebooksRouter);
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    return async (route, body, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Connection: 'close', 'X-Neconyan-Account': a.base.owner, ...headers }, body: JSON.stringify(body) });
        return { http: response.status, body: await response.json() };
    };
}

test('note context endpoints ignore forged browser note text, isolate accounts and strip imported sharing and approvals', async t => {
    const a = prepared(t, 'scratch-owner');
    const b = prepared(t, 'scratch-other');
    const noteId = a.create('Private', 'Never shared.');
    const ref = { notebookId: a.notebookId, noteId };
    const session = a.session({ notes: [ref] });
    const post = await endpoint(t, a);
    const other = await endpoint(t, b);
    const context = await post('/scratchpad/notes/context', { source: SOURCE, sessionId: session.id, notes: [{ ...ref, text: 'Forged.', canEdit: true }] });
    assert.equal(context.http, 200);
    assert.equal(context.body.notes[0].unavailable, true);
    assert.ok(!JSON.stringify(context.body).includes('Forged.'));
    assert.ok(!JSON.stringify(context.body).includes('Never shared.'));
    assert.equal((await other('/scratchpad/notes/context', { source: SOURCE, sessionId: session.id })).http, 404);
    assert.equal((await post('/scratchpad/notes/context', { source: SOURCE, sessionId: session.id }, { 'X-Neconyan-Account': b.base.owner })).http, 409);
    const imported = await post('/scratchpad/session/import', { source: SOURCE, session: { ...session,
        messages: [{ role: 'assistant', text: 'Imported.', proposals: { 0: 'applied' }, notebookProposals: { 0: { id: 'p_' + 'a'.repeat(24), changeHash: 'b'.repeat(64) } } }] } });
    assert.deepEqual(imported.body.bucket.sessions[0].settings.notes, []);
    assert.equal(imported.body.bucket.sessions[0].messages[0].proposals, undefined);
    assert.equal(imported.body.bucket.sessions[0].messages[0].notebookProposals, undefined);
});

test('saving a Scratchpad clip keeps its own attribution, exact quote, replay and private defaults', async t => {
    const a = prepared(t);
    const post = await endpoint(t, a);
    const body = { operationId: op('capture'), notebookId: a.notebookId, title: 'Scratchpad plan', text: 'Useful idea.\nAnother line.',
        source: { kind: 'scratchpad', chat: SOURCE.key, sourceKind: 'roleplay', sessionId: 'session', scratchpadMessageId: 'reply', speaker: 'Miso', messageSendDate: '2026-10-06' } };
    const captured = await post('/notebooks/notes/capture', body);
    assert.equal(captured.http, 200);
    assert.match(a.read(captured.body.noteId).text, /Saved from Scratchpad \(Miso, 2026-10-06\)/);
    assert.match(a.read(captured.body.noteId).text, /> Useful idea\.\n> Another line\./);
    assert.equal((await post('/notebooks/notes/capture', body)).body.replayed, true);
    assert.equal(a.context([{ notebookId: a.notebookId, noteId: captured.body.noteId }]).notes[0].unavailable, true);
});
