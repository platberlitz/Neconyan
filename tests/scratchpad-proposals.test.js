import { describe, expect, test } from '@jest/globals';
import {
    describeChange,
    formatEntry,
    formatField,
    normaliseChange,
    parseEntry,
    parseField,
    splitReply,
} from '../public/scripts/scratchpad/proposals.js';

const fence = value => `\`\`\`scratchpad-change\n${JSON.stringify(value)}\n\`\`\``;

describe('Scratchpad reply parsing', () => {
    test('new personas and Scenario Notes have separate creation targets and discard supplied identities', () => {
        const persona = normaliseChange({ type: 'persona', action: 'create', name: ' Rowan ', description: '{{user}} sails.', avatar: 'User.png', id: 'existing', activeAppendices: { chat: 'au' } });
        expect(persona).toEqual({ type: 'persona', action: 'create', name: 'Rowan', description: '{{user}} sails.', title: '', reason: '' });
        expect(describeChange(persona)).toBe('Create persona \'Rowan\'');
        const note = normaliseChange({ type: 'persona-note', action: 'create', persona: 'Kris', name: 'Voyage', description: '{{user}} sails.', noteId: 'au', title: 'Discard', avatar: '/user/images/old.png' });
        expect(note).toEqual({ type: 'persona-note', action: 'create', persona: 'Kris', name: 'Voyage', description: '{{user}} sails.', reason: '' });
        expect(describeChange(note)).toBe('Create Scenario Note \'Voyage\' for Kris');
        for (const extra of [{ name: '' }, { name: 'x'.repeat(201) }, { description: {} }, { title: 123 }]) {
            expect(() => normaliseChange({ ...persona, ...extra })).toThrow();
        }
        expect(() => normaliseChange({ ...note, persona: '' })).toThrow();
        expect(splitReply(fence(persona))[0]).toMatchObject({ error: '', change: persona });
    });
    test('keeps persona, Scenario Note and avatar targets distinct', () => {
        const persona = normaliseChange({ type: 'persona', persona: 'Kris', field: 'description', value: '{{user}} is a traveller.' });
        expect(persona).toMatchObject({ type: 'persona', persona: 'Kris', value: '{{user}} is a traveller.' });
        const note = normaliseChange({ type: 'persona-note', persona: 'Kris', noteId: 'harbour', field: 'name', value: '  At sea  ' });
        expect(note).toMatchObject({ noteId: 'harbour', value: 'At sea' });
        expect(describeChange(note)).toContain('Scenario Note');
        expect(describeChange(normaliseChange({ type: 'image', action: 'generate', target: 'persona-avatar', persona: 'Kris', prompt: 'A portrait.' }))).toBe('New persona avatar for Kris');
        for (const extra of [{ noteId: '' }, { field: 'title' }, { action: 'delete' }]) {
            expect(() => normaliseChange({ ...note, ...extra })).toThrow();
        }
        expect(() => normaliseChange({ type: 'image', action: 'generate', target: 'persona-avatar', persona: 'Kris', character: 'Nova', prompt: 'A portrait.' })).toThrow();
    });
    test.each(['alternateGreetings', 'alternate_greetings'])('recovers nested creation fields from a fenced draft with %s', key => {
        const parts = splitReply(fence({ type: 'character', action: 'create', character: { name: 'New Nova',
            characterNote: '  Keep this note.\n', [key]: ['  Keep this greeting.\n'] } }));
        expect(parts[0]).toMatchObject({ error: '', change: { type: 'character', action: 'create', character: { name: 'New Nova' },
            characterNote: '  Keep this note.\n', alternateGreetings: ['  Keep this greeting.\n'], avatarPrompt: '' } });
        expect(Object.keys(parts[0].change.character)).toEqual(['name']);
    });

    test.each([
        { characterNote: 'Different note.' },
        { alternateGreetings: ['Different greeting.'] },
        { alternate_greetings: ['Different greeting.'] },
        { characterNote: 42 },
        { avatarPrompt: 'A paid portrait.' },
    ])('keeps malformed fenced creations unavailable for review: %j', extra => {
        const [part] = splitReply(fence({ type: 'character', action: 'create', character: { name: 'New Nova', ...extra },
            characterNote: 'Canonical note.', alternateGreetings: ['Canonical greeting.'] }));
        expect(part.change).toBeNull();
        expect(part.error).not.toBe('');
    });

    test('accepts image and avatar suggestions while removing model URLs, credentials and settings', () => {
        expect(normaliseChange({ type: 'image', action: 'generate', target: 'image', prompt: '  An observatory. ', url: 'https://bad.invalid/pic.png', settings: { key: 'secret' } }))
            .toEqual({ type: 'image', action: 'generate', target: 'image', prompt: 'An observatory.', negative: '', reason: '' });
        const avatar = normaliseChange({ type: 'image', action: 'generate', target: 'avatar', character: 'Nova', prompt: 'Portrait.', negative: 'words' });
        expect(describeChange(avatar)).toBe('New avatar for Nova');
        expect(describeChange({ ...avatar, target: 'image' })).toBe('Generate an image');
    });
    test.each([{ prompt: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(10001) }, { negative: [] }, { negative: 'x'.repeat(10001) },
        { action: 'save' }, { target: 'url' }, { target: 'avatar' }, { character: [] }])('rejects malformed image suggestions: %j', extra => {
        expect(() => normaliseChange({ type: 'image', action: 'generate', target: 'image', prompt: 'A scene.', ...extra })).toThrow();
    });
    test('keeps stable indexed mixed proposals and caps suggestions at 24', () => {
        const reply = Array.from({ length: 27 }, (_, index) => fence(index % 2 ? { type: 'character', action: 'create', character: { name: 'Nova' } }
            : { type: 'image', action: 'generate', target: 'image', prompt: `Scene ${index}` })).join('\n');
        const changes = splitReply(reply).filter(part => part.type === 'change');
        expect(changes).toHaveLength(24);
        expect(changes.map(part => part.index)).toEqual(Array.from({ length: 24 }, (_, index) => index));
        expect(changes.every(part => part.change)).toBe(true);
    });
    test('keeps text and changes in reply order', () => {
        const reply = [
            'Here is an idea.',
            fence({ type: 'lorebook', action: 'add', book: 'Harbour', title: 'Old lighthouse', keys: ['lighthouse'], content: 'It still turns at night.', reason: 'Mentioned twice' }),
            'And one more thing.',
            fence({ type: 'chat', action: 'hide', message: '#4' }),
        ].join('\n');
        const parts = splitReply(reply);
        expect(parts.map(part => part.type)).toEqual(['text', 'change', 'text', 'change']);
        expect(parts[1]).toMatchObject({ index: 0, error: '', change: { type: 'lorebook', action: 'add', book: 'Harbour', keys: ['lighthouse'], constant: false } });
        expect(parts[3]).toMatchObject({ index: 1, change: { type: 'chat', action: 'hide', message: 4 } });
    });

    test('reports broken changes without hiding the rest of the reply', () => {
        const parts = splitReply('Before\n```scratchpad-change\n{not json\n```\nAfter\n' + fence({ type: 'chat', action: 'edit', message: 2 }));
        expect(parts[1]).toMatchObject({ type: 'change', change: null, error: 'This change could not be read.' });
        expect(parts[3]).toMatchObject({ type: 'change', change: null, error: 'This message rewrite has no text.' });
        expect(parts[0].text).toContain('Before');
        expect(parts[2].text).toContain('After');
    });

    test('a reply without changes stays one text part', () => {
        expect(splitReply('Just talk.')).toEqual([{ type: 'text', text: 'Just talk.' }]);
        expect(splitReply('')).toEqual([]);
    });

    test('accepts every supported change shape', () => {
        expect(normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: '7', keys: 'a, b' })).toEqual({ type: 'lorebook', action: 'edit', book: 'B', uid: 7, keys: ['a', 'b'], reason: '' });
        expect(normaliseChange({ type: 'lorebook', action: 'delete', book: 'B', uid: 0 })).toMatchObject({ action: 'delete', uid: 0 });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'alternate_greetings', value: ['Hi', ' ', 'Hello'] })).toMatchObject({ value: ['Hi', 'Hello'] });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'tags', value: 'sea, storm' })).toMatchObject({ value: ['sea', 'storm'] });
        expect(normaliseChange({ type: 'character', character: 'Ayla', field: 'first_mes', value: 'Hello.' })).toMatchObject({ field: 'first_mes', value: 'Hello.' });
        expect(normaliseChange({ type: 'chat', action: 'insert', after: 3, speaker: 'user', text: 'Wait.' })).toMatchObject({ after: 3, speaker: 'user', name: '' });
        expect(normaliseChange({ type: 'chat', action: 'insert', after: 3, speaker: 'narrator', text: 'Rain.' })).toMatchObject({ speaker: 'character' });
    });

    test('rejects changes that cannot be applied safely', () => {
        expect(() => normaliseChange([])).toThrow('not a JSON object');
        expect(() => normaliseChange({ type: 'lorebook', action: 'add', content: 'x' })).toThrow('which lorebook');
        expect(() => normaliseChange({ type: 'lorebook', action: 'add', book: 'B', content: ' ' })).toThrow('no content');
        expect(() => normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: 1 })).toThrow('does not change anything');
        expect(() => normaliseChange({ type: 'lorebook', action: 'edit', book: 'B', uid: -1, content: 'x' })).toThrow('which entry');
        expect(() => normaliseChange({ type: 'character', character: 'Ayla', field: 'avatar', value: 'x' })).toThrow('cannot change that character field');
        expect(() => normaliseChange({ type: 'character', field: 'description', value: 'x' })).toThrow('which character');
        expect(() => normaliseChange({ type: 'chat', action: 'delete', message: 'last' })).toThrow('which message');
        expect(() => normaliseChange({ type: 'chat', action: 'wipe', message: 1 })).toThrow('unknown action');
        expect(() => normaliseChange({ type: 'settings' })).toThrow('unknown type');
    });

    test('describes changes in plain words', () => {
        expect(describeChange({ type: 'lorebook', action: 'add', book: 'Harbour', title: 'Old lighthouse' })).toBe('New lorebook entry \'Old lighthouse\' in Harbour');
        expect(describeChange({ type: 'character', character: 'Ayla', field: 'mes_example' })).toBe('Change Ayla\'s example messages');
        expect(describeChange({ type: 'chat', action: 'unhide', message: 5 })).toBe('Show message #5 again');
        expect(describeChange({ type: 'chat', action: 'insert', after: 2 })).toBe('Add a message after #2');
    });

    test('accepts an Agent text change and refuses anything else about an Agent', () => {
        expect(normaliseChange({ type: 'agent', agent: ' a-1 ', name: ' Scene   Keeper ', field: 'prompt', value: 'Keep {{char}} calm.', reason: 'Shorter', enabled: true }))
            .toEqual({ type: 'agent', action: 'replace', agent: 'a-1', field: 'prompt', value: 'Keep {{char}} calm.', reason: 'Shorter', name: 'Scene Keeper' });
        expect(normaliseChange({ type: 'agent', action: 'edit', agent: 'a-1', field: 'name', value: '  New   name ' })).toMatchObject({ action: 'replace', value: 'New name' });
        expect(() => normaliseChange({ type: 'agent', action: 'delete', agent: 'a-1', field: 'prompt', value: 'x' })).toThrow('can only replace');
        expect(() => normaliseChange({ type: 'agent', field: 'prompt', value: 'x' })).toThrow('exact ID');
        expect(() => normaliseChange({ type: 'agent', agent: 'a-1', field: 'enabled', value: 'x' })).toThrow('name, description or prompt');
        expect(() => normaliseChange({ type: 'agent', agent: 'a-1', field: 'prompt' })).toThrow('no new text');
        expect(() => normaliseChange({ type: 'agent', agent: 'a-1', field: 'name', value: '  ' })).toThrow('needs a name');
        expect(describeChange({ type: 'agent', agent: 'a-1', name: 'Scene Keeper', field: 'prompt' })).toBe('Change Agent \'Scene Keeper\': prompt');
        expect(describeChange({ type: 'agent', agent: 'a-1', field: 'description' })).toBe('Change Agent \'a-1\': description');
    });

    test('accepts a regex script text change and refuses anything else about a script', () => {
        expect(normaliseChange({ type: 'regex', script: ' tidy ', name: ' Tidy   up ', field: 'findRegex', value: '/colou?r/g', reason: 'Both spellings', disabled: true }))
            .toEqual({ type: 'regex', action: 'replace', script: 'tidy', field: 'findRegex', value: '/colou?r/g', reason: 'Both spellings', name: 'Tidy up' });
        expect(normaliseChange({ type: 'regex', action: 'edit', script: 'tidy', field: 'replaceString', value: '' })).toMatchObject({ action: 'replace', value: '' });
        expect(normaliseChange({ type: 'regex', script: 'tidy', field: 'scriptName', value: '  Very   neat ' }).value).toBe('Very neat');
        expect(() => normaliseChange({ type: 'regex', action: 'delete', script: 'tidy', field: 'findRegex', value: 'x' })).toThrow('can only replace');
        expect(() => normaliseChange({ type: 'regex', script: ' ', field: 'findRegex', value: 'x' })).toThrow('exact ID');
        expect(() => normaliseChange({ type: 'regex', script: 'tidy', field: 'disabled', value: 'x' })).toThrow('name, Find pattern or replacement');
        expect(() => normaliseChange({ type: 'regex', script: 'tidy', field: 'findRegex' })).toThrow('no new text');
        expect(() => normaliseChange({ type: 'regex', script: 'tidy', field: 'scriptName', value: '  ' })).toThrow('needs a name');
        expect(describeChange({ type: 'regex', script: 'tidy', name: 'Tidy', field: 'findRegex', value: 'x' })).toBe('Change regex script \'Tidy\': findRegex');
        expect(describeChange({ type: 'regex', script: 'tidy', field: 'replaceString', value: 'x' })).toBe('Change regex script \'tidy\': replaceString');
    });

    test('accepts a replacement of the Author\'s Note text and nothing else about it', () => {
        expect(normaliseChange({ type: 'authors-note', value: 'Keep {{char}} calm.', reason: 'Shorter', depth: 2 }))
            .toEqual({ type: 'authors-note', action: 'replace', value: 'Keep {{char}} calm.', reason: 'Shorter' });
        expect(normaliseChange({ type: 'authors-note', action: 'edit', value: '' })).toMatchObject({ action: 'replace', value: '' });
        expect(() => normaliseChange({ type: 'authors-note', action: 'delete', value: 'x' })).toThrow('can only replace the text');
        expect(() => normaliseChange({ type: 'authors-note' })).toThrow('no new text');
        expect(describeChange({ type: 'authors-note', value: 'Keep calm.' })).toBe('Change the Author\'s Note');
        expect(describeChange({ type: 'authors-note', value: '  ' })).toBe('Clear the Author\'s Note');
    });

    test('accepts all six Notebook mutations and strips model-supplied approvals and unrelated fields', () => {
        const common = { notebookId: 'nb', noteId: 'note', expectedRevision: 'revision', grantId: 'grant', userConfirmed: true, canEdit: true };
        for (const [action, extra] of [
            ['create-note', { title: 'New', markdown: 'Text' }], ['append-note', { markdown: 'Text' }],
            ['edit-note-section', { sectionId: 'section', expectedTextHash: 'hash', markdown: 'Text' }],
            ['edit-note-selection', { find: 'Old', replace: 'New' }], ['edit-note-properties', { set: { tags: ['draft'] } }],
            ['publish-note-lore', { book: 'World', uid: 3 }],
        ]) {
            const change = normaliseChange({ type: 'notebook', action, args: { ...common, ...extra }, reason: 'Requested', userConfirmed: true });
            expect(change).toMatchObject({ type: 'notebook', action, reason: 'Requested' });
            expect(change.args).not.toHaveProperty('userConfirmed');
            expect(change.args).not.toHaveProperty('canEdit');
            expect(describeChange(change)).toBeTruthy();
        }
    });

    test('rejects Notebook reads, unsupported mutations, absent revisions and malformed argument types', () => {
        for (const action of ['read-note', 'delete-note', 'notebooks']) expect(() => normaliseChange({ type: 'notebook', action, args: {} })).toThrow();
        expect(() => normaliseChange({ type: 'notebook', action: 'append-note', args: { notebookId: 'nb', noteId: 'n', markdown: 'x' } })).toThrow('revision');
        expect(() => normaliseChange({ type: 'notebook', action: 'create-note', args: { notebookId: 'nb', title: 'x', markdown: [] } })).toThrow();
        expect(() => normaliseChange({ type: 'notebook', action: 'publish-note-lore', args: { notebookId: 'nb', noteId: 'n', book: 'W', uid: -1 } })).toThrow();
        expect(() => normaliseChange({ type: 'notebook', action: 'edit-note-properties', args: { notebookId: 'nb', noteId: 'n', set: [], expectedRevision: 'r' } })).toThrow();
    });

    test.each(['append', 'add'])('keeps the %s operation for new alternate greetings', action => {
        const change = normaliseChange({ type: 'character', action, character: 'Nova', field: 'alternate_greetings', value: ['Another meeting.'] });
        expect(change).toMatchObject({ action: 'append', value: ['Another meeting.'] });
        expect(describeChange(change)).toBe('Add alternate greetings to Nova');
    });

    test('rejects empty greeting additions and unsupported character operations', () => {
        expect(() => normaliseChange({ type: 'character', action: 'append', character: 'Nova', field: 'alternate_greetings', value: [' '] })).toThrow('no new greetings');
        expect(() => normaliseChange({ type: 'character', action: 'append', character: 'Nova', field: 'description', value: 'More.' })).toThrow('only append alternate greetings');
        expect(() => normaliseChange({ type: 'character', action: 'delete', character: 'Nova', field: 'alternate_greetings', value: ['Hi.'] })).toThrow('unknown action');
    });

    test.each([undefined, null, '', ' ', '#', '# ', [], [0], false, {}, -1, 1.5, '1e2', Number.MAX_SAFE_INTEGER + 1])('rejects missing or malformed targets: %p', target => {
        expect(() => normaliseChange({ type: 'chat', action: 'delete', message: target })).toThrow('which message');
        expect(() => normaliseChange({ type: 'chat', action: 'insert', after: target, text: 'Hello.' })).toThrow('where it goes');
        expect(() => normaliseChange({ type: 'lorebook', action: 'delete', book: 'B', uid: target })).toThrow('which entry');
    });

    test.each([0, '0', '#0', ' #12 '])('accepts explicit numbered targets: %p', target => {
        expect(normaliseChange({ type: 'chat', action: 'hide', message: target }).message).toBe(Number(String(target).trim().replace('#', '')));
    });

    test.each(['constructor', '__proto__', 'toString'])('rejects inherited character fields: %s', field => {
        expect(() => normaliseChange({ type: 'character', character: 'Ayla', field, value: 'x' })).toThrow('cannot change that character field');
    });

    test('review text round-trips for entries and list fields', () => {
        const entry = { title: 'Old lighthouse', keys: ['lighthouse', 'beacon'], constant: true, content: 'Line one\n\nLine two' };
        expect(parseEntry(formatEntry(entry), {})).toEqual(entry);
        expect(parseEntry('Only content', { title: 'Kept', keys: ['k'], constant: false })).toEqual({ title: 'Kept', keys: ['k'], constant: false, content: 'Only content' });
        const greetings = ['Hello there.', 'Morning!'];
        expect(parseField('alternate_greetings', formatField('alternate_greetings', greetings))).toEqual(greetings);
        expect(parseField('tags', formatField('tags', ['a', 'b']))).toEqual(['a', 'b']);
        expect(parseField('description', 'Text')).toBe('Text');
    });
});
