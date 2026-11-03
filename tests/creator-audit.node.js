import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { writeAuthoringFileLocked } from '../src/authoring-store.js';
import { saveCreatorDraft, getCreatorDraft, listCreatorDrafts, deleteCreatorDraft } from '../src/creator/store.js';
import { publishCreatorDraft, getCreatorPublication, discardCreatorDraft, recoverCreatorPublication } from '../src/creator/publish.js';
import { createCreatorDraft, editCreatorDraft, setCreatorField, undoCreatorDraft, withCreatorTextEdit } from '../public/scripts/creator/model.js';
import { buildCreatorInterview } from '../public/scripts/creator/interview.js';

test('Portrait bytes stay out of undo and consecutive typing is one undo step', () => {
    let draft = createCreatorDraft({ id: 'typing' });
    draft.media = [{ id: 'portrait', dataUrl: 'x'.repeat(1024 * 1024) }];
    draft.selectedMedia = 'portrait';
    for (let index = 1; index <= 80; index++) draft = withCreatorTextEdit('description', () => setCreatorField(draft, 'description', 'a'.repeat(index)));
    assert.equal(draft.history.length, 1);
    assert.ok(!JSON.stringify(draft.history).includes('dataUrl'));
    const undone = undoCreatorDraft(draft);
    assert.equal(undone.card.data.description, '');
    assert.equal(undone.media[0].dataUrl.length, 1024 * 1024);
    assert.equal(undoCreatorDraft(undone, true).card.data.description.length, 80);
    const initialised = editCreatorDraft(undone, next => { next.interview = { defaultsAdded: true }; }, { record: false });
    assert.equal(initialised.future.length, undone.future.length);
    assert.equal(initialised.history.length, undone.history.length);
    const legacy = createCreatorDraft({ id: 'legacy-history' });
    legacy.media = [{ id: 'old-image', dataUrl: 'x'.repeat(1024 * 1024) }];
    legacy.history = [{ ...structuredClone(legacy), history: undefined, future: undefined }];
    const removed = editCreatorDraft(legacy, next => { next.media = []; }, { record: false });
    assert.ok(!JSON.stringify(removed).includes('dataUrl'));
});

test('Collaborator prompts omit avatars and unknown profile properties', () => {
    const draft = createCreatorDraft({ id: 'interview' });
    const prompt = JSON.stringify(buildCreatorInterview(draft, 'Who are you?', { speaker: 'collaborator', assistant: { name: 'Editor', instructions: 'Be concise.', examples: 'Hello.', avatar: 'data:image/png;base64,AVATAR', secret: 'UNRELATED' } }));
    assert.match(prompt, /Be concise/);
    assert.doesNotMatch(prompt, /AVATAR|UNRELATED|data:image/);
});

test('Portrait-heavy drafts have independent space and legacy migration retains revisions', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = createCreatorDraft({ id: 'legacy' });
    const legacy = { draft, revision: 'old-revision', updatedAt: '2026-01-01' };
    locked(lease => writeAuthoringFileLocked(lease, path.join(f.scope.directories.root, 'creator', 'drafts.json'), JSON.stringify({ schema: 1, drafts: { legacy } })));
    assert.equal(locked(lease => getCreatorDraft(lease, 'legacy')).revision, 'old-revision');
    locked(lease => deleteCreatorDraft(lease, 'legacy', 'old-revision'));
    for (let i = 0; i < 5; i++) {
        const large = createCreatorDraft({ id: `large-${i}` });
        large.media = [0, 1, 2].map(id => ({ id: String(id), dataUrl: 'x'.repeat(2 * 1024 * 1024) }));
        locked(lease => saveCreatorDraft(lease, large, null));
    }
    assert.equal(locked(listCreatorDrafts).length, 5);
    assert.throws(() => locked(lease => getCreatorDraft(lease, 'legacy')), { status: 404 });
});

test('An oversized receipt creates no publication lock and a smaller retry works', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = createCreatorDraft({ id: 'large-receipt' });
    draft.card.data.name = 'Large card';
    draft.card.data.extensions = { payload: 'x'.repeat(12 * 1024 * 1024) };
    const item = locked(lease => saveCreatorDraft(lease, draft, null));
    assert.throws(() => locked(lease => publishCreatorDraft(lease, { id: draft.id, expectedRevision: item.revision, operationId: 'too-large' })), { code: 'CREATOR_RECEIPT_SIZE' });
    assert.equal(locked(lease => getCreatorPublication(lease, draft.id)), null);
    delete draft.card.data.extensions.payload;
    const small = locked(lease => saveCreatorDraft(lease, draft, item.revision));
    assert.equal(locked(lease => publishCreatorDraft(lease, { id: draft.id, expectedRevision: small.revision, operationId: 'smaller' })).state, 'done');
});

test('A legacy pointer without a receipt can be recovered and discarded', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = createCreatorDraft({ id: 'orphan' });
    const item = locked(lease => saveCreatorDraft(lease, draft, null));
    const operation = { id: draft.id, expectedRevision: item.revision, operationId: 'missing', copy: false };
    const hash = createHash('sha256').update(draft.id).digest('hex');
    locked(lease => writeAuthoringFileLocked(lease, path.join(f.scope.directories.root, 'creator', 'publications', `${hash}.json`), JSON.stringify(operation)));
    assert.equal(locked(lease => recoverCreatorPublication(lease, operation)).revision, item.revision);
    assert.equal(locked(lease => getCreatorPublication(lease, draft.id)).acknowledged, true);
    assert.deepEqual(locked(lease => discardCreatorDraft(lease, operation)), { deleted: true });
});

test('Interrupted recovery rebuilds from newer edits rather than its stale snapshot', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = createCreatorDraft({ id: 'recovery-race' });
    draft.card.data.name = 'Mira';
    const item = locked(lease => saveCreatorDraft(lease, draft, null));
    const operation = { id: draft.id, expectedRevision: item.revision, operationId: 'recover-race' };
    locked(lease => publishCreatorDraft(lease, operation));
    const file = path.join(f.scope.directories.root, 'creator', 'receipts', 'recover-race.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.state = 'recovering';
    receipt.recoveryPrepared = true;
    receipt.recoveryRevision = item.revision;
    locked(lease => writeAuthoringFileLocked(lease, file, JSON.stringify(receipt)));
    locked(lease => writeAuthoringFileLocked(lease, file.replace('.json', '.recovery.json'), JSON.stringify(draft)));
    const changed = setCreatorField(draft, 'description', 'Written on the other device');
    const latest = locked(lease => saveCreatorDraft(lease, changed, item.revision));
    const recovered = locked(lease => recoverCreatorPublication(lease, { ...operation, expectedRevision: latest.revision }));
    assert.equal(recovered.draft.card.data.description, 'Written on the other device');
    assert.equal(recovered.draft.journal.recovered, true);
});
