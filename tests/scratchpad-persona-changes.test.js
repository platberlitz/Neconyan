import { beforeEach, expect, jest, test } from '@jest/globals';

const power_user = {};
const saveSettings = jest.fn();
const setUserName = jest.fn();
let current;
let owner;
jest.unstable_mockModule('../public/script.js', () => ({ saveSettings, setUserName }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'User.png', getUserAvatar: file => `/User Avatars/${file}`, getUserAvatars: jest.fn(), setPersonaDescription: jest.fn() }));
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({ h: (tag, attributes, ...children) => ({ tag, attributes, children }) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: { PERSONA_UPDATED: 'updated' }, eventSource: { emit: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({ sourcePersona: () => current, isCurrentSource: () => true }));
const { preparePersonaChange } = await import('../public/scripts/scratchpad/persona-changes.js');
const { normaliseChange } = await import('../public/scripts/scratchpad/proposals.js');
const shared = { avatar: 'User.png', name: 'Kris' };
const source = { kind: 'general' };
const descriptor = () => power_user.persona_descriptions['User.png'];
const proposal = (extra = {}) => normaliseChange({ type: 'persona', persona: 'Kris', field: 'description', value: 'New {{user}}', ...extra });
const prepare = (extra = {}, guard = () => {}) => preparePersonaChange(proposal(extra), source, shared, guard);

beforeEach(() => {
    jest.clearAllMocks();
    owner = 'owner'; current = { ...shared };
    power_user.personas = { 'User.png': 'Kris' };
    power_user.persona_descriptions = { 'User.png': { description: 'Base', title: 'Traveller', connections: [{ id: 'chat' }],
        appendices: [{ id: 'au', name: 'Modern AU', description: 'Original note' }, { id: 'other', name: 'Other', description: 'Keep' }] } };
    saveSettings.mockResolvedValue(true);
});

test('base edit waits for save and keeps notes and connections', async () => {
    const plan = await prepare();
    expect(descriptor().description).toBe('Base');
    await plan.commit('Edited {{user}}');
    expect(descriptor().description).toBe('Edited {{user}}');
    expect(descriptor().appendices).toHaveLength(2);
    expect(descriptor().connections).toEqual([{ id: 'chat' }]);
    expect(saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
});

test('renaming the persona keeps its avatar identity and updates the active name', async () => {
    const plan = await prepare({ field: 'name', value: 'Kris Rowan' });
    await plan.commit('  Kris Rowan  ');
    expect(power_user.personas).toEqual({ 'User.png': 'Kris Rowan' });
    expect(setUserName).toHaveBeenCalledWith('Kris Rowan', { toastPersonaNameChange: false });
    expect(descriptor().connections).toEqual([{ id: 'chat' }]);
    expect(descriptor().appendices).toHaveLength(2);
});

test.each(['name', 'description'])('Scenario Note %s edit preserves identity and other notes', async field => {
    const plan = await prepare({ type: 'persona-note', noteId: 'au', field, value: 'Updated' });
    expect(plan.target).toBe('Kris: Modern AU');
    await plan.commit('Updated');
    expect(descriptor().appendices[0]).toMatchObject({ id: 'au', [field]: 'Updated' });
    expect(descriptor().appendices[1]).toEqual({ id: 'other', name: 'Other', description: 'Keep' });
    expect(power_user.personas['User.png']).toBe('Kris');
    expect(setUserName).not.toHaveBeenCalled();
});

test('review refuses a switched persona, revoked sharing, changed field or deleted note', async () => {
    const plan = await prepare();
    current.avatar = 'Other.png';
    await expect(plan.commit('New')).rejects.toThrow('original persona');
    current = { ...shared }; descriptor().description = 'External edit';
    await expect(plan.commit('New')).rejects.toThrow('changed');
    const guard = jest.fn();
    const note = await prepare({ type: 'persona-note', noteId: 'au' }, guard);
    guard.mockImplementation(() => { throw new Error('Sharing revoked'); });
    await expect(note.commit('New')).rejects.toThrow('Sharing revoked');
    guard.mockImplementation(() => {});
    descriptor().appendices = [];
    await expect(note.commit('New')).rejects.toThrow('no longer exists');
    expect(saveSettings).not.toHaveBeenCalled();
});

test('failed settings save restores the old text', async () => {
    const plan = await prepare({ type: 'persona-note', noteId: 'au' });
    saveSettings.mockResolvedValue(false);
    await expect(plan.commit('Changed')).rejects.toThrow('not saved');
    expect(descriptor().appendices[0].description).toBe('Original note');
});

test('invalid fields, blank names and ambiguous note IDs are refused', async () => {
    expect(() => proposal({ field: 'connections' })).toThrow();
    expect(() => proposal({ field: 'name', value: ' ' })).toThrow();
    expect(() => proposal({ type: 'persona-note', noteId: 'au', field: 'title' })).toThrow();
    descriptor().appendices.push({ id: 'au', name: 'Duplicate' });
    await expect(prepare({ type: 'persona-note', noteId: 'au' })).rejects.toThrow('ambiguous');
});

test('Scenario Note portrait paths are reviewed, saved independently and removable with rollback', async () => {
    const portrait = '/user/images/persona-notes/full-size-portrait.png';
    const change = { type: 'persona-note', persona: 'Kris', noteId: 'au', field: 'avatar', value: portrait };
    const plan = await preparePersonaChange(change, source, shared, () => {});
    expect(plan.editable).toBe(false);
    expect(plan.visual).toBeDefined();
    expect(descriptor().appendices[0].avatar).toBeUndefined();
    await plan.commit(portrait);
    expect(descriptor().appendices[0]).toEqual({ id: 'au', name: 'Modern AU', description: 'Original note', avatar: portrait });
    const remove = await prepare({ type: 'persona-note', noteId: 'au', field: 'avatar', value: '' });
    saveSettings.mockResolvedValue(false);
    await expect(remove.commit('')).rejects.toThrow('not saved');
    expect(descriptor().appendices[0].avatar).toBe(portrait);
    saveSettings.mockResolvedValue(true);
    await remove.commit('');
    expect(descriptor().appendices[0]).not.toHaveProperty('avatar');
    expect(descriptor().appendices[1]).toEqual({ id: 'other', name: 'Other', description: 'Keep' });
});

test('Scenario Note avatar proposals reject arbitrary images and require an existing note identity', () => {
    expect(() => proposal({ type: 'persona-note', noteId: 'au', field: 'avatar', value: 'https://example.com/avatar.png' })).toThrow();
    expect(() => proposal({ type: 'persona-note', noteId: 'au', field: 'avatar', value: '/user/images/../settings.json' })).toThrow();
    expect(() => proposal({ type: 'persona-note', noteId: 'au', field: 'avatar', value: '/user/images/persona-notes/full.png' })).toThrow();
    const image = { type: 'image', action: 'generate', target: 'persona-note-avatar', persona: 'Kris', noteId: 'au', prompt: 'Winter portrait' };
    expect(normaliseChange(image)).toMatchObject(image);
    expect(() => normaliseChange({ ...image, noteId: '' })).toThrow();
    expect(() => normaliseChange({ ...image, character: 'Nova' })).toThrow();
});
