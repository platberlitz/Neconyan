import assert from 'node:assert/strict';
import { test } from 'node:test';
import { topics } from '../public/scripts/neconyan-assistant-knowledge/index.js';
import { selectAssistantKnowledge } from '../public/scripts/neconyan-assistant-knowledge.js';
import { lexicalSearch, terms } from '../public/scripts/util/lexical-search.js';

const user = mes => ({ role: 'user', mes });
const ids = (list, question) => selectAssistantKnowledge(list, [user(question)]).map(topic => topic.id);

test('precomputed token sets rank exactly like the default lexical search', () => {
    const documents = [
        { text: 'Denji kept the promise', searchText: 'Denji promise' },
        { text: 'Denji broke the promise', searchText: 'Denji promise', status: 'background' },
        { text: 'A different record', searchText: 'other record' },
    ];
    const tokenSets = documents.map(document => new Set(terms(document.text + '\n' + document.searchText)));

    assert.deepEqual(
        lexicalSearch(documents, 'denji promise', 10),
        lexicalSearch(documents, 'denji promise', 10, tokenSets),
    );
});

test('the frozen catalogue and a mutable copy return the same real rankings', () => {
    assert.ok(Object.isFrozen(topics));
    assert.ok(topics.every(topic => Object.isFrozen(topic) && Object.isFrozen(topic.keys)));
    const mutable = topics.map(topic => ({ ...topic }));
    const questions = [
        'How do I set up Structured Prefill with a ready-made preset?',
        'Can I play Chess with a character in Conversation?',
        'Where are push notification settings?',
        'Does Catelier share writing settings between drafts?',
        'How do I insert a Companion kept-notes block at a prompt depth?',
        'What does The provider ended this reply with an error mean?',
        'Does Jev call the model again for the same memory decision?',
        'Why do sparkles appear when I tap in Starlight Conservatory?',
    ];

    for (const question of questions) {
        assert.deepEqual(ids(topics, question), ids(mutable, question), question);
    }
});

test('a mutable caller-owned topic list never reuses stale prepared terms', () => {
    const token = 'zzpreparedtokencachezz';
    const mutable = topics.map(topic => ({ ...topic }));
    assert.deepEqual(selectAssistantKnowledge(mutable, [user(token)]), []);

    mutable[0] = { ...mutable[0], title: `${mutable[0].title} ${token}`, keys: [...mutable[0].keys, token],
        content: `${mutable[0].content} ${token}` };

    assert.deepEqual(ids(mutable, token), [topics[0].id]);
});

test('a frozen array with mutable topic objects does not reuse prepared terms', () => {
    const token = 'zzfrozenarraymutabletopiczz';
    const mixed = Object.freeze(topics.map(topic => ({ ...topic })));
    assert.deepEqual(selectAssistantKnowledge(mixed, [user(token)]), []);

    mixed[0].title = `${mixed[0].title} ${token}`;
    mixed[0].keys = [...mixed[0].keys, token];
    mixed[0].content = `${mixed[0].content} ${token}`;

    assert.deepEqual(ids(mixed, token), [topics[0].id]);
});

test('a frozen topic with mutable keys does not reuse prepared terms', () => {
    const token = 'zzfrozentopicmutablekeyszz';
    const topic = Object.freeze({ ...topics[0], keys: [...topics[0].keys] });
    const list = Object.freeze([topic]);
    assert.ok(Object.isFrozen(topic));
    assert.equal(Object.isFrozen(topic.keys), false);
    assert.deepEqual(selectAssistantKnowledge(list, [user(token)]), []);

    topic.keys.push(token);

    assert.deepEqual(ids(list, token), [topic.id]);
});
