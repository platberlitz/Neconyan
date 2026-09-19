import assert from 'node:assert/strict';
import test from 'node:test';
import { composePersonaDescription, conversationPersonaSelection } from '../public/scripts/neconyan-conversation/persona-description.js';

test('saved persona notes retain scoped selection, legacy fallback and command-safe labels', () => {
    const descriptor = { description: ' User description ', appendices: [
        { id: 'private', name: 'Private note', description: 'Private context' },
        { id: 'shared', name: 'Shared note', description: ' Shared context ' },
    ], activeAppendices: { solo: ['private'], group: ['shared'], __default__: ['shared'] } };
    const before = structuredClone(descriptor);
    const compose = (scope, legacy) => composePersonaDescription(descriptor, conversationPersonaSelection(descriptor, scope, legacy));
    assert.equal(compose('solo', 'group'), 'User description\n\n(Private note)\nPrivate context');
    assert.equal(compose('new-scope', 'group'), 'User description\n\n(Shared note)\nShared context');
    assert.equal(compose('group', 'solo').includes('Private context'), false);
    assert.deepEqual(descriptor, before);
    descriptor.activeAppendices.group = [];
    assert.equal(compose('group', 'solo'), 'User description');
    descriptor.activeAppendices = ['private'];
    assert.equal(compose('new-scope', 'missing').includes('Private context'), true);
});
