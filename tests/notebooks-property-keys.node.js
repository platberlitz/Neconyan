import assert from 'node:assert/strict';
import test from 'node:test';
import { notebookPropertyKeys } from '../src/notebooks/property-table.js';

test('owner field suggestions are unique, sorted, bounded and exclude internal names', () => {
    const fields = Object.create(null);
    Object.assign(fields, { season: 'private value', location: 'private place', neconyan_id: 'private ID', constructor: 'blocked', 'bad:key': 'blocked' });
    fields.__proto__ = 'blocked';
    const entries = [{ properties: fields }, { properties: { season: 'another', count: 2 } }];
    assert.deepEqual(notebookPropertyKeys(entries), { keys: ['count', 'location', 'season'], total: 3, partial: false });
    assert.deepEqual(notebookPropertyKeys(entries, 2), { keys: ['count', 'location'], total: 3, partial: true });
    assert.ok(!JSON.stringify(notebookPropertyKeys(entries)).includes('private value'));
});
