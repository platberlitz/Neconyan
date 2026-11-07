import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { withRoleplayAccount } from '../src/roleplay-store.js';
import { saveCreatorDraft } from '../src/creator/store.js';
import { publishCreatorDraft } from '../src/creator/publish.js';
import { creatorCharacterSource } from '../src/creator/resources.js';
import { createCreatorDraft, setCreatorField, TEXT_FIELDS } from '../public/scripts/creator/model.js';
import { creatorCardExport } from '../public/scripts/creator/export.js';
import { creatorPublicationCard } from '../public/scripts/creator/embedded-book.js';

function assertV3(card) {
    assert.equal(card.spec, 'chara_card_v3');
    assert.equal(card.spec_version, '3.0');
    for (const field of TEXT_FIELDS) assert.equal(typeof card.data[field], 'string', field);
    for (const field of ['alternate_greetings', 'group_only_greetings', 'tags']) {
        assert.ok(Array.isArray(card.data[field]), field);
        assert.ok(card.data[field].every(value => typeof value === 'string'), field);
    }
    assert.equal(typeof card.data.extensions, 'object');
    assert.notEqual(card.data.extensions, null);
    assert.equal(Array.isArray(card.data.extensions), false);
    if (card.data.character_book) {
        assert.equal(typeof card.data.character_book.extensions, 'object');
        assert.ok(Array.isArray(card.data.character_book.entries));
        for (const entry of card.data.character_book.entries) {
            assert.ok(Array.isArray(entry.keys));
            assert.equal(typeof entry.content, 'string');
            assert.equal(typeof entry.extensions, 'object');
            assert.equal(typeof entry.enabled, 'boolean');
            assert.equal(typeof entry.insertion_order, 'number');
            assert.equal(typeof entry.use_regex, 'boolean');
            assert.ok(entry.case_sensitive === undefined || typeof entry.case_sensitive === 'boolean');
        }
    }
}

function importedCard(spec = 'chara_card_v2') {
    return {
        spec, spec_version: spec === 'chara_card_v2' ? '2.0' : '3.0',
        description: 'Old root description', creatorcomment: 'Old root note', opaqueRoot: { retained: true },
        data: {
            name: 'Mira', description: 'Current description', creator_notes: 'Public note',
            creator: 'Author', character_version: '1.2', tags: ['archive'], alternate_greetings: ['Hello again'],
            group_only_greetings: ['Hello everyone'], nickname: 'Mi',
            creator_notes_multilingual: { fr: 'Note publique' }, source: ['https://example.com/card'],
            assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
            creation_date: 123456, modification_date: 123789, opaqueData: ['retained'],
            extensions: { custom: { intact: true }, depth_prompt: { prompt: 'Public depth', depth: 3, role: 'system' } },
            character_book: { name: 'Archive', opaqueBook: { retained: true }, entries: [
                { id: 'record', keys: ['Mira'], content: 'Public lore', enabled: true, insertion_order: 17, opaqueEntry: 'retained' },
            ] },
        },
    };
}

test('new Catelier drafts contain every required CCv3 character field', () => {
    const draft = createCreatorDraft({ id: 'new-v3' });
    assertV3(draft.card);
    assertV3(creatorCardExport(draft));
    draft.card.data.tags.push('local');
    assert.deepEqual(draft.source.original.data.tags, []);
});

test('CCv3 JSON output upgrades legacy and v2 cards without changing comparison baselines', () => {
    for (const imported of [
        { name: 'Legacy', description: 'Legacy description', creatorcomment: 'Legacy notes', tags: ['old'], extensions: { opaque: 'legacy' } },
        importedCard(), importedCard('chara_card_v3'),
    ]) {
        const before = structuredClone(imported);
        const draft = createCreatorDraft({ id: 'imported', card: imported });
        draft.privateNotes = 'PRIVATE NOTES'; draft.dossier = 'PRIVATE DOSSIER';
        const comparison = creatorPublicationCard(draft);
        const output = JSON.parse(JSON.stringify(creatorCardExport(draft)));
        assertV3(output);
        assert.deepEqual(imported, before);
        assert.deepEqual(draft.source.original, before);
        assert.deepEqual(creatorPublicationCard(draft), comparison);
        assert.equal(output.description, output.data.description);
        assert.equal(output.creatorcomment, output.data.creator_notes);
        assert.doesNotMatch(JSON.stringify(output), /PRIVATE NOTES|PRIVATE DOSSIER/);
        if (imported.data) {
            for (const field of ['group_only_greetings', 'nickname', 'creator_notes_multilingual', 'source', 'assets', 'creation_date', 'modification_date', 'opaqueData', 'extensions']) {
                assert.deepEqual(output.data[field], imported.data[field], field);
            }
            assert.deepEqual(output.opaqueRoot, imported.opaqueRoot);
            assert.deepEqual(output.data.character_book.opaqueBook, imported.data.character_book.opaqueBook);
            assert.equal(output.data.character_book.entries[0].opaqueEntry, 'retained');
            assert.equal(output.data.character_book.entries[0].use_regex, false);
        } else {
            assert.deepEqual(output.data.tags, imported.tags);
            assert.deepEqual(output.data.extensions, imported.extensions);
        }
    }
});

test('CCv3 output completes embedded draft books while preserving imported records and detach behaviour', () => {
    const draft = createCreatorDraft({ id: 'embedded-v3', card: importedCard() });
    const original = draft.card.data.character_book;
    const data = { originalData: structuredClone(original), originalDataUidMap: { 0: 0 }, entries: { 0: { uid: 0, key: ['Mira'], content: 'Public lore' } } };
    draft.books.push({ id: 'book', name: 'Archive', mode: 'embedded', data, original: structuredClone(data) });
    assert.deepEqual(creatorPublicationCard(draft).data.character_book, original);
    const output = creatorCardExport(draft);
    assertV3(output);
    assert.equal(output.data.character_book.entries[0].id, 'record');
    draft.books[0].data.entries[0].content = 'Edited lore';
    const edited = creatorCardExport(draft);
    assertV3(edited);
    assert.equal(edited.data.character_book.entries[0].content, 'Edited lore');
    assert.equal(edited.data.character_book.entries[0].opaqueEntry, 'retained');
    draft.books[0].detached = true;
    assert.equal(creatorCardExport(draft).data.character_book, undefined);
    assert.deepEqual(draft.source.original.data.character_book, original);
});

test('publication writes complete CCv3 cards for new and previously saved v2 drafts', t => {
    const f = fixture(t);
    const locked = operation => withRoleplayAccount(f.scope, f.scope, operation);
    const drafts = [setCreatorField(createCreatorDraft({ id: 'publish-new' }), 'name', 'New card'), createCreatorDraft({ id: 'publish-imported', card: importedCard() })];
    // Simulate an existing pre-upgrade draft, with its old envelope and missing lists.
    drafts[1].card.spec = 'chara_card_v2'; drafts[1].card.spec_version = '2.0';
    delete drafts[1].card.data.group_only_greetings;
    for (const draft of drafts) {
        const original = structuredClone(draft.source.original);
        const saved = locked(lease => saveCreatorDraft(lease, draft, null));
        const result = locked(lease => publishCreatorDraft(lease, { id: draft.id, expectedRevision: saved.revision, operationId: draft.id }));
        assert.equal(result.state, 'done');
        const source = locked(lease => creatorCharacterSource(lease, result.avatar));
        assertV3(source.card);
        assert.deepEqual(draft.source.original, original);
        if (draft.id === 'publish-imported') {
            assert.equal(source.card.description, source.card.data.description);
            assert.equal(source.card.creatorcomment, source.card.data.creator_notes);
            assert.deepEqual(source.card.data.assets, original.data.assets);
            assert.deepEqual(source.card.data.extensions, original.data.extensions);
            assert.equal(source.card.data.character_book.entries[0].opaqueEntry, 'retained');
            assert.equal(source.card.data.character_book.entries[0].use_regex, false);
        }
    }
});
