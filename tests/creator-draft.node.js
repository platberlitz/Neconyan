import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { createCreatorDraft, setCreatorField, undoCreatorDraft, creatorProposal, acceptCreatorProposal, renderCreatorFacts, creatorAssistantContext } from '../public/scripts/creator/model.js';
import { saveCreatorDraft, getCreatorDraft, listCreatorDrafts, deleteCreatorDraft } from '../src/creator/store.js';
import { creatorCharacterSource } from '../src/creator/resources.js';
import { publishCreatorDraft, getCreatorPublication } from '../src/creator/publish.js';
import { buildDossierRequest, dossierProposal } from '../public/scripts/creator/dossier.js';
import { createRawPrompt } from '../public/scripts/generation-format.js';
import { previewCreatorMacros } from '../src/creator/macro-preview.js';
import { applyGameEvent, createGameState, gameRulesPackage } from '../public/scripts/creator/game.js';
import { buildCreatorInterview, interviewExample } from '../public/scripts/creator/interview.js';
import { creatorPublicationCard } from '../public/scripts/creator/embedded-book.js';
import { compareCreatorChanges } from '../public/scripts/creator/conflicts.js';
import { inspectCreatorKeys, acceptCreatorBulkLore } from '../public/scripts/creator/lore-tools.js';
import { buildCreatorLoreRequest, parseCreatorLoreProposal, acceptCreatorLoreProposal } from '../public/scripts/creator/lore-proposals.js';
import { creatorCardExport } from '../public/scripts/creator/export.js';
import { restoreCreatorBackup } from '../public/scripts/creator/backup.js';

test('backup restoration preserves private work without inheriting publication authority', () => {
    const draft = createCreatorDraft({ id: 'original', avatar: 'Nova.png', revision: 'old', extraBooks: ['World'] });
    draft.dossier = 'source'; draft.privateNotes = 'private';
    draft.books = [{ id: 'book', name: 'World', mode: 'linked', revision: 'old-book', data: { entries: {} } }];
    draft.journal = { state: 'done' };
    draft.proposals = [creatorProposal(draft, { description: 'suggestion' }, 'Old proposal')];
    const restored = restoreCreatorBackup({ format: 'neconyan-creator-backup', version: 1, draft }, 'restored');
    assert.equal(restored.id, 'restored');
    assert.equal(restored.source.avatar, null);
    assert.equal(restored.source.revision, null);
    assert.equal(restored.dossier, 'source');
    assert.equal(restored.privateNotes, 'private');
    assert.equal(restored.books[0].mode, 'copy');
    assert.equal(restored.books[0].revision, null);
    assert.equal(restored.card.data.extensions.world, 'World');
    assert.deepEqual(restored.proposals, []);
    assert.equal(restored.journal, null);
    assert.equal(draft.books[0].mode, 'linked');
    assert.throws(() => restoreCreatorBackup({ format: 'unknown', draft }), /backup/);
    assert.throws(() => restoreCreatorBackup({ format: 'neconyan-creator-backup', version: 1, draft: { ...draft, books: [null] } }), /lorebooks/);
});

test('public card export excludes draft-only material and synchronises legacy aliases', () => {
    const draft = createCreatorDraft({ id: 'export', card: { description: 'old', creatorcomment: 'old', spec: 'chara_card_v3', data: { description: 'new', creator_notes: 'public', extensions: { opaque: ['keep'] } } } });
    draft.dossier = 'dossier-secret'; draft.privateNotes = 'private-secret'; draft.interview = [{ text: 'interview-secret' }];
    const output = creatorCardExport(draft);
    assert.equal(output.description, 'new'); assert.equal(output.creatorcomment, 'public');
    assert.deepEqual(output.data.extensions.opaque, ['keep']);
    for (const secret of ['dossier-secret', 'private-secret', 'interview-secret']) assert.equal(JSON.stringify(output).includes(secret), false);
    assert.equal(draft.card.description, 'old');
});

test('lore extraction keeps protected entries private and accepts source changes together with entries', () => {
    const draft = createCreatorDraft({ id: 'extract', card: { description: 'A guard from Alba.', data: { description: 'A guard from Alba.' } } });
    draft.privateNotes = 'private-note';
    draft.books.push({ id: 'book', name: 'World', mode: 'linked', data: { entries: {
        3: { uid: 3, comment: 'Alba', content: 'A city.', key: ['Alba'], probability: 37, opaque: { keep: true } },
        8: { uid: 8, content: 'protected-secret', agentBlacklisted: true },
    } } }, { id: 'detached', name: 'Old', mode: 'linked', detached: true, data: { entries: { 0: { content: 'detached-secret' } } } });
    const request = JSON.stringify(buildCreatorLoreRequest(draft, 'book', 'Extract the city', 'summarise'));
    for (const secret of ['private-note', 'protected-secret', 'detached-secret']) assert.equal(request.includes(secret), false);
    const answer = { entries: [{ uid: 3, title: 'Alba', keys: ['Alba'], content: 'The guard comes from Alba.', constant: false }], description: 'A guard.', coverage: ['Moved the city background into Alba.'] };
    const proposal = parseCreatorLoreProposal(draft, 'book', JSON.stringify(answer), 'summarise');
    draft.proposals.push(proposal);
    const applied = acceptCreatorLoreProposal(draft, proposal);
    assert.equal(applied.card.data.description, 'A guard.');
    assert.equal(applied.card.description, 'A guard.');
    assert.equal(applied.books[0].data.entries[3].probability, 37);
    assert.deepEqual(applied.books[0].data.entries[3].opaque, { keep: true });
    assert.deepEqual(applied.books[0].data.entries[8], draft.books[0].data.entries[8]);
    assert.equal(applied.proposals.length, 0);
    assert.deepEqual(undoCreatorDraft(applied).books, draft.books);
    assert.equal(undoCreatorDraft(applied).card.data.description, 'A guard from Alba.');
    const changed = structuredClone(draft); changed.card.data.description = 'edited';
    assert.throws(() => acceptCreatorLoreProposal(changed, proposal), /background/);
    changed.card.data.description = draft.card.data.description; changed.locks.push('description');
    assert.throws(() => acceptCreatorLoreProposal(changed, proposal), /locked/);
    answer.entries[0].uid = 8;
    assert.throws(() => parseCreatorLoreProposal(draft, 'book', JSON.stringify(answer), 'summarise'), /protected/);
    answer.entries[0].uid = null; answer.description = null;
    const kept = acceptCreatorLoreProposal(draft, parseCreatorLoreProposal(draft, 'book', JSON.stringify(answer)));
    assert.equal(kept.card.data.description, draft.card.data.description);
    assert.equal(Object.keys(kept.books[0].data.entries).length, 3);
});

test('lore bulk review rejects stale books and advisory keys do not alter runtime state', () => {
    const draft = createCreatorDraft({ id: 'bulk' });
    const book = { id: 'book', name: 'World', mode: 'linked', data: { entries: { 7: { uid: 7, key: ['Mira'], content: 'old', probability: 40 }, 9: { uid: 9, key: ['other'], disable: true, content: 'keep' } } } };
    draft.books.push(book);
    const inspection = inspectCreatorKeys(book, 'Mira arrives');
    assert.deepEqual(inspection[0].matched, ['Mira']);
    assert.equal(inspection[1].reason, 'Disabled');
    const proposal = { draftId: draft.id, bookId: book.id, before: JSON.stringify(book.data), changes: [{ uid: '7', field: 'content', after: 'new' }] };
    const applied = acceptCreatorBulkLore(draft, proposal);
    assert.equal(applied.books[0].data.entries[7].content, 'new');
    assert.equal(applied.books[0].data.entries[7].probability, 40);
    assert.equal(draft.books[0].data.entries[7].content, 'old');
    assert.throws(() => acceptCreatorBulkLore(applied, proposal), /changed/);
    assert.equal(undoCreatorDraft(applied).books[0].data.entries[7].content, 'old');
});

test('three-way comparison keeps independent edits and requires explicit choices for conflicting arrays and deletions', () => {
    const base = { name: 'Mira', data: { description: 'old', personality: 'quiet', greetings: ['hello'], optional: 'keep' } };
    const local = structuredClone(base); local.data.description = 'draft'; local.data.greetings.push('second'); delete local.data.optional;
    const remote = structuredClone(base); remote.data.personality = 'curious'; remote.data.greetings[0] = 'welcome'; remote.data.optional = 'changed';
    const result = compareCreatorChanges(base, local, remote);
    assert.equal(result.value.data.description, 'draft');
    assert.equal(result.value.data.personality, 'curious');
    assert.equal(result.conflicts.length, 2);
    const choices = Object.fromEntries(result.conflicts.map(item => [item.id, item.path.at(-1) === 'greetings' ? 'library' : 'draft']));
    const resolved = compareCreatorChanges(base, local, remote, choices);
    assert.deepEqual(resolved.conflicts, []);
    assert.deepEqual(resolved.value.data.greetings, ['welcome']);
    assert.equal(Object.hasOwn(resolved.value.data, 'optional'), false);
    assert.equal(base.data.description, 'old');
    const unusual = JSON.parse('{"__proto__":{"value":1},"constructor":"preserve"}');
    const merged = compareCreatorChanges(unusual, { ...unusual, local: 1 }, { ...unusual, remote: 1 });
    assert.equal(Object.getPrototypeOf(merged.value), Object.prototype);
    assert.deepEqual(merged.value.__proto__, { value: 1 });
    assert.equal(merged.value.constructor, 'preserve');
});

test('additional lore links use native settings, preserve other characters and recover without duplicate publication', t => {
    const f = fixture(t);
    const filename = path.join(f.scope.directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify({ world_info_settings: { world_info: { charLore: [{ name: 'Nova', extraBooks: ['Old'] }, { name: 'Other', extraBooks: ['Keep'] }], unknown: 7 } }, unrelated: 'retained' }));
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const source = locked(lease => creatorCharacterSource(lease, 'Nova.png'));
    assert.deepEqual(source.extraBooks, ['Old']);
    const draft = createCreatorDraft({ id: 'bindings', ...source });
    draft.additionalBooks = ['New'];
    const saved = locked(lease => saveCreatorDraft(lease, draft, null));
    const request = { id: draft.id, expectedRevision: saved.revision, operationId: 'links' };
    assert.throws(() => locked(lease => publishCreatorDraft(lease, request, { afterBindings: () => { throw new Error('interrupted'); } })), /interrupted/);
    const published = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(published.world_info_settings.world_info.charLore, [{ name: 'Nova', extraBooks: ['New'] }, { name: 'Other', extraBooks: ['Keep'] }]);
    assert.equal(published.unrelated, 'retained');
    const inode = fs.statSync(filename).ino;
    const result = locked(lease => publishCreatorDraft(lease, request));
    assert.equal(result.binding.state, 'done');
    assert.deepEqual(result.binding.books, ['New']);
    assert.equal(fs.statSync(filename).ino, inode);
    assert.deepEqual(locked(lease => creatorCharacterSource(lease, 'Nova.png')).extraBooks, ['New']);
});

test('portable lore preserves opaque imported records, serialises edits and detaches only the card copy', () => {
    const original = { name: 'Archive', opaque: { edition: 3 }, entries: [{ id: 'old-id', content: 'Old text', keys: ['archive'], enabled: true, mystery: 17, extensions: { unknown: 'kept' } }] };
    const data = { originalData: original, originalDataUidMap: { 0: 0 }, entries: { 0: { uid: 0, key: ['archive'], content: 'Old text', extensions: { unknown: 'kept' } } } };
    const draft = createCreatorDraft({ id: 'portable', card: { data: { name: 'Mira', character_book: original } } });
    draft.books.push({ id: 'book', name: 'Archive', mode: 'embedded', data: structuredClone(data), original: structuredClone(data) });
    assert.deepEqual(creatorPublicationCard(draft).data.character_book, original);
    draft.books[0].data.entries[0].content = 'Revised text';
    const published = creatorPublicationCard(draft).data.character_book;
    assert.equal(published.entries[0].content, 'Revised text');
    assert.equal(published.entries[0].id, 'old-id');
    assert.equal(published.entries[0].mystery, 17);
    assert.equal(published.entries[0].extensions.unknown, 'kept');
    assert.deepEqual(published.opaque, { edition: 3 });
    assert.equal(draft.card.data.character_book.entries[0].content, 'Old text');
    draft.books[0].detached = true;
    assert.equal(creatorPublicationCard(draft).data.character_book, undefined);
    assert.deepEqual(original.entries[0].keys, ['archive']);
});

test('draft interview excludes private source material and promotes only character replies', () => {
    const draft = createCreatorDraft({ id: 'interview' });
    draft.card.data.description = 'Mira keeps her promises.';
    draft.privateNotes = 'PRIVATE-NOTES';
    draft.dossier = 'PRIVATE-DOSSIER';
    draft.interview = { turns: [
        { id: 'q', speaker: 'Interviewer', text: 'What did you promise?' },
        { id: 'a', speaker: 'character', text: 'To bring {{poss}} letter home.' },
        { id: 'peer', speaker: 'Editor', text: 'Ask about the recipient.' },
    ] };
    const messages = buildCreatorInterview(draft, 'Who is waiting?');
    assert.ok(messages[1].content.includes('Mira keeps her promises.'));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE-'));
    assert.equal(interviewExample(draft, 'a'), '<START>\nInterviewer: What did you promise?\n{{char}}: To bring {{poss}} letter home.');
    assert.throws(() => interviewExample(draft, 'peer'), /character reply/);
    assert.throws(() => buildCreatorInterview(draft, ''), /question/);
    assert.equal(draft.card.data.mes_example, '');
});

test('macro preview evaluates only a disposable variable copy and uses explicit names', async () => {
    const variables = { trust: 0 };
    const result = await previewCreatorMacros({ text: '{{char}} meets {{user}}: {{setvar::trust::7}}{{getvar::trust}}', character: 'Mira', user: 'Interviewer', variables });
    assert.equal(result.output, 'Mira meets Interviewer: 7');
    assert.deepEqual(variables, { trust: 0 });
    assert.equal((await previewCreatorMacros({ text: '{{getvar::trust}}', variables })).output, '0');
    assert.throws(() => previewCreatorMacros({ text: 'x'.repeat(20001) }), /20,000/);
});

test('game simulator preserves zero, rejects stale or duplicate actions and keeps source state immutable', () => {
    const original = createGameState(['relationships', 'inventory']);
    const event = { id: 'gift', revision: 0, key: 'trust', operation: 'add', value: 2 };
    const next = applyGameEvent(original, event);
    assert.equal(original.values.trust, 0);
    assert.equal(next.values.trust, 2);
    assert.deepEqual(applyGameEvent(next, event), next);
    assert.throws(() => applyGameEvent(next, { ...event, value: 8 }), /different change/);
    assert.throws(() => applyGameEvent(next, { ...event, id: 'stale' }), /state changed/);
    assert.throws(() => applyGameEvent(original, { ...event, key: 'coins', value: -1 }), /invalid balance/);
    assert.throws(() => applyGameEvent(original, { ...event, key: '__proto__' }), /does not define/);
    const rules = gameRulesPackage({ game: { modules: ['checks', 'time'] } });
    assert.match(rules, /external dice tool result/);
    assert.match(rules, /abandoned alternative does not commit/);
});

test('literal authoring requests preserve macros without evaluating them or adding active chat names', () => {
    for (const api of ['openai', 'textgenerationwebui']) {
        let evaluated = 0;
        const source = '{{setvar::trust::99}} {{user}} {{charposs}}';
        const result = createRawPrompt([{ role: 'user', content: source }], api, false, false, '', '', {
            literalPrompt: true, name1: 'PRIVATE USER', name2: 'PRIVATE CHARACTER',
            substitute: () => { evaluated++; return 'EXECUTED'; },
        });
        assert.equal(evaluated, 0);
        assert.ok(JSON.stringify(result).includes(source));
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE|EXECUTED/);
    }
});

test('accepting one persisted proposal field leaves only the remaining fields, and undo restores the proposal', () => {
    const draft = createCreatorDraft({ id: 'partial' });
    const proposal = creatorProposal(draft, { description: 'Repairer', personality: 'Patient' }, 'Voice');
    draft.proposals.push(proposal);
    const partial = acceptCreatorProposal(draft, proposal, ['description']);
    assert.deepEqual(partial.proposals[0].changes.map(change => change.field), ['personality']);
    const complete = acceptCreatorProposal(partial, partial.proposals[0]);
    assert.equal(complete.proposals.length, 0);
    assert.equal(complete.card.data.description, 'Repairer');
    assert.equal(complete.card.data.personality, 'Patient');
    assert.deepEqual(undoCreatorDraft(complete).proposals, partial.proposals);
});

test('dossier conversion sends only chosen fields and keeps original source through apply and undo', () => {
    const draft = createCreatorDraft({ id: 'dossier' });
    draft.dossier = 'Mira repairs clocks. {{charposs}} workshop overlooks the harbour.';
    draft.privateNotes = 'HIDDEN NOTES';
    draft.card.data.system_prompt = 'UNSELECTED PROMPT';
    draft.locks = ['personality'];
    const request = buildDossierRequest(draft);
    assert.ok(!request.fields.includes('personality'));
    assert.doesNotMatch(JSON.stringify(request.messages), /HIDDEN NOTES|UNSELECTED PROMPT/);
    assert.equal(JSON.parse(request.messages[1].content).dossier, draft.dossier);
    const proposal = dossierProposal(draft, JSON.stringify({ fields: { description: 'A clock repairer at the harbour.' }, coverage: ['Her trade and workshop are in Description.'], questions: [] }), request.fields);
    const applied = acceptCreatorProposal(draft, proposal);
    assert.equal(applied.dossier, draft.dossier);
    assert.equal(applied.card.data.description, 'A clock repairer at the harbour.');
    assert.equal(undoCreatorDraft(applied).card.data.description, '');
    assert.equal(undoCreatorDraft(applied).dossier, draft.dossier);
    assert.equal(applied.card.data.dossier, undefined);
    assert.equal(creatorAssistantContext(draft).dossier, undefined);
    const changed = structuredClone(draft);
    changed.dossier += ' Her trade is actually carpentry.';
    assert.throws(() => acceptCreatorProposal(changed, proposal), /dossier changed/);
});

test('dossier proposals reject unrequested fields, malformed responses and missing coverage', () => {
    const draft = createCreatorDraft({ id: 'dossier' });
    assert.throws(() => buildDossierRequest(draft), /information/);
    draft.dossier = 'Mira repairs clocks.';
    assert.throws(() => dossierProposal(draft, '{"fields":'), /complete card fields/);
    assert.throws(() => dossierProposal(draft, JSON.stringify({ fields: { system_prompt: 'Override' }, questions: [], coverage: [] })), /unrequested/);
    assert.throws(() => dossierProposal(draft, JSON.stringify({ fields: { description: 'Repairer' } })), /coverage and questions/);
    draft.locks = ['description'];
    assert.throws(() => buildDossierRequest(draft, ['description']), /unlocked/);
});

test('Creator edits preserve opaque card data and undo without changing the source', () => {
    const card = { spec: 'chara_card_v3', data: { name: 'Mira', description: 'Original', extensions: { unknown: { keep: [1, 2] } }, alternate_greetings: Array(25).fill('Hi') } };
    const draft = createCreatorDraft({ id: 'one', card });
    const edited = setCreatorField(draft, 'description', 'Changed');
    assert.equal(edited.rawAhead, true);
    assert.deepEqual(edited.card.data.extensions, card.data.extensions);
    assert.equal(edited.card.data.alternate_greetings.length, 25);
    assert.deepEqual(edited.source.original, card);
    assert.equal(undoCreatorDraft(edited).card.data.description, 'Original');
    assert.equal(undoCreatorDraft(undoCreatorDraft(edited), true).card.data.description, 'Changed');
});

test('Creator proposals reject stale targets and locks before applying any field', () => {
    const draft = createCreatorDraft({ id: 'one' });
    const proposal = creatorProposal(draft, { description: 'New', personality: 'Careful' }, 'Flesh out');
    const changed = setCreatorField(draft, 'personality', 'My edit');
    assert.throws(() => acceptCreatorProposal(changed, proposal), /changed/);
    assert.equal(changed.card.data.description, '');
    draft.locks.push('description');
    assert.throws(() => acceptCreatorProposal(draft, proposal), /locked/);
    assert.throws(() => acceptCreatorProposal(createCreatorDraft({ id: 'other' }), proposal), /another draft/);
});

test('guided rendering uses Interviewer and excludes private and undecided facts', () => {
    const draft = createCreatorDraft({ id: 'one' });
    draft.facts = [
        { id: 'a', section: 'voice', text: 'Short sentences.', status: 'decided', visibility: 'model' },
        { id: 'b', section: 'history', text: 'Private twist', status: 'decided', visibility: 'private' },
        { id: 'c', section: 'goals', text: 'Maybe', status: 'tentative', visibility: 'model' },
    ];
    const result = renderCreatorFacts(draft, 'alichat');
    assert.match(result.fields.mes_example, /Interviewer:/);
    assert.doesNotMatch(result.fields.mes_example, /Private|Maybe|\{\{user\}\}/);
    assert.deepEqual(result.excluded, ['b', 'c']);
    assert.equal(draft.card.data.mes_example, '');
});

test('assistant context omits private notes, unknown extensions and blacklisted lore', () => {
    const draft = createCreatorDraft({ id: 'one' });
    draft.privateNotes = 'PRIVATE';
    draft.card.data.extensions = { secret: 'PRIVATE' };
    draft.books = [{ name: 'Book', data: { entries: { a: { content: 'PRIVATE', agentBlacklisted: true }, b: { content: 'Public' } } } }];
    const context = creatorAssistantContext(draft);
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE/);
    assert.equal(creatorAssistantContext(draft, { includePrivate: true }).privateNotes, 'PRIVATE');
});

test('account draft storage checks revisions, survives retries and guards deletion', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = createCreatorDraft({ id: 'one' });
    const first = locked(lease => saveCreatorDraft(lease, draft, null));
    assert.deepEqual(locked(lease => saveCreatorDraft(lease, draft, null)), first);
    const changed = setCreatorField(draft, 'name', 'Mira');
    assert.throws(() => locked(lease => saveCreatorDraft(lease, changed, null)), { status: 409 });
    const second = locked(lease => saveCreatorDraft(lease, changed, first.revision));
    assert.equal(locked(lease => getCreatorDraft(lease, 'one')).draft.card.data.name, 'Mira');
    assert.equal(locked(listCreatorDrafts).length, 1);
    assert.throws(() => locked(lease => deleteCreatorDraft(lease, 'one', first.revision)), { status: 409 });
    locked(lease => deleteCreatorDraft(lease, 'one', second.revision));
    assert.deepEqual(locked(listCreatorDrafts), []);
    assert.throws(() => locked(lease => getCreatorDraft(lease, '../outside')), { status: 400 });
});

test('publication retries preserve the server identity after a lost response', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const draft = setCreatorField(createCreatorDraft({ id: 'new-card' }), 'name', 'Mira');
    draft.card.data.extensions = { opaque: { keep: true } };
    const saved = locked(lease => saveCreatorDraft(lease, draft, null));
    const request = { id: draft.id, expectedRevision: saved.revision, operationId: 'publish-one' };
    assert.throws(() => locked(lease => publishCreatorDraft(lease, request, { afterCharacter: () => { throw new Error('response lost'); } })), /response lost/);
    assert.deepEqual(locked(lease => getCreatorPublication(lease, draft.id)), { ...request, copy: false });
    const complete = locked(lease => publishCreatorDraft(lease, { ...request, operationId: 'other-device' }));
    assert.equal(complete.state, 'done');
    assert.deepEqual(locked(lease => publishCreatorDraft(lease, request)), complete);
    assert.equal(fs.readdirSync(f.scope.directories.characters).filter(name => name.startsWith('Creator-')).length, 1);
    const source = locked(lease => creatorCharacterSource(lease, complete.avatar));
    assert.deepEqual(source.card.data.extensions.opaque, { keep: true });
    assert.throws(() => locked(lease => publishCreatorDraft(lease, { ...request, expectedRevision: 'stale' })), { status: 409 });
});

test('publication retains successful books and resumes only its interrupted work', t => {
    const f = fixture(t);
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const source = locked(lease => creatorCharacterSource(lease, 'Nova.png'));
    const draft = createCreatorDraft({ id: 'edit-card', ...source });
    draft.books = [{ id: 'new-book', mode: 'copy', name: 'New book', data: { entries: { 17: { uid: 17, content: 'Keep', probability: 37, opaque: true } } } }];
    draft.card.data.extensions = { world: 'New book' };
    const saved = locked(lease => saveCreatorDraft(lease, draft, null));
    const request = { id: draft.id, expectedRevision: saved.revision, operationId: 'publish-books' };
    assert.throws(() => locked(lease => publishCreatorDraft(lease, request, { afterBook: () => { throw new Error('interrupted'); } })), /interrupted/);
    const bookFile = path.join(f.scope.directories.worlds, 'New book.json');
    const before = fs.statSync(bookFile).ino;
    const complete = locked(lease => publishCreatorDraft(lease, request));
    assert.equal(complete.books[0].state, 'done');
    assert.equal(fs.statSync(bookFile).ino, before);
    assert.equal(JSON.parse(fs.readFileSync(bookFile)).entries[17].probability, 37);
    const stale = locked(lease => saveCreatorDraft(lease, setCreatorField(draft, 'description', 'Stale edit'), saved.revision));
    assert.throws(() => locked(lease => publishCreatorDraft(lease, { ...request, expectedRevision: stale.revision, operationId: 'stale-source' })), { status: 409 });
});
