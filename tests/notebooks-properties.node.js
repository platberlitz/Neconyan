import assert from 'node:assert/strict';
import test from 'node:test';
import { noteProperties, splitFrontmatter, updateFrontmatter } from '../src/notebooks/markdown.js';
import { buildEntry } from '../src/notebooks/note-index.js';
import { PROPERTY_TABLE_LIMITS, queryPropertyTable } from '../src/notebooks/property-table.js';

const entry = (number, text, folder = '') => buildEntry(`n_${number.toString(16).padStart(16, '0')}`, `${folder ? `${folder}/` : ''}Note ${number}.md`, text, `revision-${number}`);
const table = (entries, options = {}) => queryPropertyTable(entries, { canRead: () => true, ...options });

test('property names remain own data fields without changing the property map prototype', () => {
    const source = '---\r\n__proto__: [keep]\r\nconstructor: ordinary\r\ntoString: saved\r\nscore: 2 # retain this comment\r\nnested:\r\n  unknown: true\r\n---\r\n# Body\r\nExact body.\r\n';
    const parsed = noteProperties(splitFrontmatter(source).data);
    assert.equal(Object.getPrototypeOf(parsed.properties), Object.prototype);
    assert.ok(Object.hasOwn(parsed.properties, '__proto__'));
    assert.deepEqual(parsed.properties.__proto__, ['keep']);
    assert.equal(parsed.properties.constructor, 'ordinary');
    assert.equal(parsed.properties.toString, 'saved');
    const updated = updateFrontmatter(source, { score: 3 });
    assert.equal(splitFrontmatter(updated).body, splitFrontmatter(source).body);
    assert.match(updated, /# retain this comment/);
    assert.deepEqual(splitFrontmatter(updated).data.nested, { unknown: true });
    assert.deepEqual(splitFrontmatter(updated).data.__proto__, ['keep']);
});

test('unsupported numeric values remain in the source rather than being changed to JSON null', () => {
    const source = '---\nnumber: .inf\nlist: [one, .nan]\nfinite: 2.5\n---\nBody.';
    const parsed = noteProperties(splitFrontmatter(source).data);
    assert.deepEqual(parsed.complex.sort(), ['list', 'number']);
    assert.deepEqual(parsed.properties, { finite: 2.5 });
    assert.throws(() => updateFrontmatter(source, { number: Infinity }), error => error.code === 'NOTE_PROPERTIES_INVALID');
    assert.match(updateFrontmatter(source, { finite: 3 }), /number: \.inf/);
});

test('permissions are filtered before property names, values, totals, filters and pages', () => {
    const visible = entry(1, '---\nstatus: draft\n---\nVisible body.');
    const hidden = entry(2, '---\nsecret_field: TOP SECRET\n---\nHidden body.', 'Private');
    const options = { canRead: note => note.id === visible.id, columns: ['status', 'secret_field'] };
    assert.deepEqual(queryPropertyTable([visible, hidden], options), queryPropertyTable([visible], options));
    assert.equal(queryPropertyTable([visible, hidden], { ...options, filter: { key: 'secret_field', op: 'exists' } }).total, 0);
    assert.doesNotMatch(JSON.stringify(queryPropertyTable([visible, hidden], options)), /TOP SECRET|Private|Hidden body/);
    assert.throws(() => queryPropertyTable([visible]), TypeError);
});

test('typed filters and numeric sorting produce stable bounded pages without coercing strings', () => {
    const entries = [entry(1, '---\nscore: 10\nstatus: draft\ntags: [world/city]\n---\n', 'World'),
        entry(2, '---\nscore: 2\nstatus: done\ntags: [world/city/port]\n---\n', 'World/Cities'),
        entry(3, '---\nscore: "2"\nactive: true\n---\n', 'Other'), entry(4, 'Missing.')];
    const first = table(entries, { columns: ['score'], sort: { by: 'property', key: 'score' }, limit: 1 });
    assert.equal(first.rows[0].id, entries[1].id);
    assert.equal(first.nextOffset, 1);
    const second = table(entries, { columns: ['score'], sort: { by: 'property', key: 'score' }, offset: first.nextOffset, limit: 1 });
    assert.equal(second.rows[0].id, entries[0].id);
    assert.equal(table(entries, { filter: { key: 'score', op: 'equals', value: 2 } }).total, 1);
    assert.equal(table(entries, { filter: { key: 'score', op: 'equals', value: '2' } }).rows[0].id, entries[2].id);
    assert.equal(table(entries, { filter: { key: 'score', op: 'greater', value: 3 } }).rows[0].id, entries[0].id);
    assert.equal(table(entries, { folder: 'World', tag: '#world/city' }).total, 2);
    assert.equal(table(entries, { folder: '' }).total, 1);
    assert.equal(table(entries, { filter: { key: 'score', op: 'missing' } }).rows[0].id, entries[3].id);
    assert.equal(table(entries, { filter: { key: 'tags', op: 'contains', value: 'port' } }).rows[0].id, entries[1].id);
    assert.throws(() => table(entries, { filter: { key: 'score', op: 'greater', value: '3' } }), error => error.code === 'NOTE_TABLE_FILTER');
    assert.throws(() => table(entries, { columns: ['invalid:key'] }), error => error.code === 'NOTE_TABLE_COLUMNS');
});

test('cells preserve their data types and keep nested, identity and large values read-only', () => {
    const text = `---\ntext: draft\nnumber: 2\nboolean: false\nlist: [one, 2, true]\nempty: null\nnested: { unknown: true }\nneconyan_id: n_0000000000000001\nlarge: ${'x'.repeat(5000)}\n__proto__: [ordinary]\n---\nPrivate body.`;
    const note = entry(1, text);
    const result = table([note], { columns: ['text', 'number', 'boolean', 'list', 'empty', 'nested', 'neconyan_id', 'large', 'missing', '__proto__'] });
    const row = result.rows[0];
    assert.equal(row.revision, note.hash);
    assert.deepEqual(['text', 'number', 'boolean', 'list', 'empty'].map(key => row.cells[key].kind), ['text', 'number', 'boolean', 'list', 'null']);
    assert.equal(row.cells.number.value, 2);
    assert.equal(row.cells.boolean.value, false);
    assert.deepEqual(row.cells.list.value, ['one', 2, true]);
    assert.equal(row.cells.nested.editable, false);
    assert.equal(row.cells.neconyan_id.editable, false);
    assert.equal(row.cells.large.editable, false);
    assert.equal(row.cells.missing.editable, true);
    assert.deepEqual(row.cells.__proto__.value, ['ordinary']);
    assert.doesNotMatch(JSON.stringify(result), /Private body|"unknown"/);
});

test('large notebooks and large values cannot exceed row, column or response-byte budgets', () => {
    const entries = Array.from({ length: 3000 }, (_, index) => entry(index + 1, `---\nscore: ${index}\nstatus: draft\n---\nPrivate body.`));
    const result = table(entries, { limit: 99999, sort: { by: 'property', key: 'score', direction: 'desc' } });
    assert.equal(result.total, 3000);
    assert.equal(result.rows.length, PROPERTY_TABLE_LIMITS.rows);
    assert.equal(result.rows[0].cells.score.value, 2999);
    assert.equal(result.nextOffset, 100);
    const columns = Array.from({ length: 20 }, (_, index) => `column${index}`);
    const large = Array.from({ length: 100 }, (_, index) => entry(index + 1, `---\n${columns.map(key => `${key}: ${'😺'.repeat(250)}`).join('\n')}\n---\nBody.`));
    const bounded = table(large, { columns, limit: 100 });
    assert.equal(bounded.columns.length, PROPERTY_TABLE_LIMITS.columns);
    assert.ok(bounded.limited.bytes);
    assert.ok(bounded.nextOffset > 0 && bounded.nextOffset < 100);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= PROPERTY_TABLE_LIMITS.totalBytes);
});
test('editing simple lists and changing a property type keeps existing YAML comments', () => {
    const source = '---\r\nscore: 2 # keep field comment\r\nlabels:\r\n  - one # keep first item\r\n  - two # keep second item\r\nunknown:\r\n  nested: unchanged\r\n---\r\nExact body.\r\n';
    const changed = updateFrontmatter(source, { score: ['three'], labels: ['new one', 'two'] });
    assert.match(changed, /keep field comment/);
    assert.match(changed, /keep first item/);
    assert.match(changed, /keep second item/);
    assert.deepEqual(splitFrontmatter(changed).data.unknown, { nested: 'unchanged' });
    assert.equal(splitFrontmatter(changed).body, 'Exact body.\r\n');
});

test('explicit type changes do not retain a YAML tag that silently changes the requested type', () => {
    const source = '---\nscore: !!str "2" # retained comment\nlabels: [!!str "3", keep]\n---\nBody unchanged.\n';
    const changed = updateFrontmatter(source, { score: 2, labels: [3, 'keep'] });
    const parsed = splitFrontmatter(changed);
    assert.equal(parsed.data.score, 2);
    assert.deepEqual(parsed.data.labels, [3, 'keep']);
    assert.match(changed, /retained comment/);
    assert.equal(parsed.body, 'Body unchanged.\n');
});
