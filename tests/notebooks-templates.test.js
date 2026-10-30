import { beforeEach, expect, jest, test } from '@jest/globals';
import { NOTE_TEMPLATES, normaliseTemplates, TEMPLATE_LIMITS, templateById } from '../public/scripts/notebooks/templates.js';

let account = 'owner';
const data = new Map();
const setItem = jest.fn((key, value) => data.set(key, value));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: key => data.get(key) ?? null, setItem } }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
const { readSavedTemplates, savedTemplates, saveTemplates } = await import('../public/scripts/notebooks/template-settings.js');
const template = overrides => ({ id: 'custom_example', label: 'My template', title: 'My note', text: '# My starting text\n', ...overrides });

beforeEach(() => { account = 'owner'; data.clear(); setItem.mockClear(); });

test('defaults are independent copies and Blank note is always an empty fallback', () => {
    const first = savedTemplates();
    first[1].text = 'changed locally';
    expect(savedTemplates()[1].text).toBe(NOTE_TEMPLATES[1].text);
    expect(templateById('removed', [template()])).toEqual(NOTE_TEMPLATES[0]);
    expect(NOTE_TEMPLATES[0].text).toBe('');
});

test('editing, adding and removing templates persists only plain account settings', () => {
    const list = saveTemplates([template({ text: 'Literal {{user}} and <script>stay as text</script>\r\n' })], 'owner');
    expect(list.map(item => item.id)).toEqual(['blank', 'custom_example']);
    expect(savedTemplates()[1].text).toBe('Literal {{user}} and <script>stay as text</script>\n');
    expect(templateById('custom_example', list).title).toBe('My note');
    saveTemplates([], 'owner');
    expect(savedTemplates()).toEqual([NOTE_TEMPLATES[0]]);
});

test('an account switch cannot save templates for the previous account', () => {
    account = 'other';
    expect(() => saveTemplates([template()], 'owner')).toThrow(/account changed/);
    expect(setItem).not.toHaveBeenCalled();
});

test.each(['{broken', JSON.stringify({ version: 2, templates: [] }), JSON.stringify({ version: 1, templates: [{ id: 'blank' }] })])('damaged settings are not replaced silently', raw => {
    data.set('neconyan_note_templates', raw);
    expect(() => savedTemplates()).toThrow(/No templates have been replaced/);
    expect(data.get('neconyan_note_templates')).toBe(raw);
    expect(setItem).not.toHaveBeenCalled();
});

test('template limits reject duplicate IDs, unsafe shapes and oversized Unicode content', () => {
    expect(() => normaliseTemplates([template(), template()])).toThrow();
    expect(() => normaliseTemplates([template({ id: 'blank' })])).toThrow();
    expect(() => normaliseTemplates([template({ label: ' ' })])).toThrow();
    expect(() => normaliseTemplates([template({ text: 'λ'.repeat(TEMPLATE_LIMITS.textBytes) })])).toThrow();
    expect(() => normaliseTemplates(Array.from({ length: TEMPLATE_LIMITS.count + 1 }, (_, i) => template({ id: `custom_${i}` })))).toThrow();
    expect(normaliseTemplates([template({ text: '', extra: 'not saved' })])[0]).not.toHaveProperty('extra');
});

test.each(['{broken', JSON.stringify({ version: 2, templates: [] }), JSON.stringify({ version: 1, templates: [{ id: 'blank' }] })])('unreadable settings fall back to Blank note, are reported and are left untouched', raw => {
    data.set('neconyan_note_templates', raw);
    const result = readSavedTemplates();
    expect(result.unreadable).toBe(true);
    expect(result.templates).toEqual([NOTE_TEMPLATES[0]]);
    expect(data.get('neconyan_note_templates')).toBe(raw);
    expect(setItem).not.toHaveBeenCalled();
});

test('readable settings are reported as readable, including the defaults before anything is saved', () => {
    expect(readSavedTemplates()).toEqual({ templates: NOTE_TEMPLATES, unreadable: false });
    saveTemplates([template()], 'owner');
    const saved = readSavedTemplates();
    expect(saved.unreadable).toBe(false);
    expect(saved.templates.map(item => item.id)).toEqual(['blank', 'custom_example']);
});

test('restoring the defaults replaces unreadable settings', () => {
    data.set('neconyan_note_templates', '{broken');
    expect(readSavedTemplates().unreadable).toBe(true);
    saveTemplates(NOTE_TEMPLATES.filter(item => item.id !== 'blank'), 'owner');
    const restored = readSavedTemplates();
    expect(restored.unreadable).toBe(false);
    expect(restored.templates.map(item => item.id)).toEqual(NOTE_TEMPLATES.map(item => item.id));
});

test('the Blank note fallback is an independent copy', () => {
    data.set('neconyan_note_templates', '{broken');
    readSavedTemplates().templates[0].text = 'changed locally';
    expect(readSavedTemplates().templates[0].text).toBe('');
    expect(NOTE_TEMPLATES[0].text).toBe('');
});
