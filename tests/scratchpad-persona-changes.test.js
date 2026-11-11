import { beforeEach, expect, jest, test } from '@jest/globals';

const power_user = {};
const saveSettings = jest.fn();
const setUserName = jest.fn();
let current;
let owner;
jest.unstable_mockModule('../public/script.js', () => ({ saveSettings, setUserName, default_user_avatar: '/img/user.png', getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ user_avatar: 'User.png', getUserAvatar: file => `/User Avatars/${file}`, getUserAvatars: jest.fn(), setPersonaDescription: jest.fn(), persona_description_positions: { IN_PROMPT: 0 } }));
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({ h: (tag, attributes, ...children) => ({ tag, attributes, children }) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: { PERSONA_UPDATED: 'updated' }, eventSource: { emit: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
jest.unstable_mockModule('../public/scripts/scratchpad/context.js', () => ({ sourcePersona: () => current, isCurrentSource: () => true }));
const { needsSavedPersonaSelection, preparePersonaChange, saveSelectedPersona } = await import('../public/scripts/scratchpad/persona-changes.js');
const { preparePersonaCreation } = await import('../public/scripts/scratchpad/persona-create.js');
const { normaliseChange } = await import('../public/scripts/scratchpad/proposals.js');
const shared = { avatar: 'User.png', name: 'Kris' };
const source = { kind: 'general' };
const descriptor = () => power_user.persona_descriptions['User.png'];
const proposal = (extra = {}) => normaliseChange({ type: 'persona', persona: 'Kris', field: 'description', value: 'New {{user}}', ...extra });
const prepare = (extra = {}, guard = () => {}) => preparePersonaChange(proposal(extra), source, shared, guard);
const create = (extra = {}, options = {}) => preparePersonaCreation(normaliseChange({ type: 'persona', action: 'create', name: 'Rowan', description: '{{user}} explores.', ...extra }), source, { shared, key: 'original-message', ...options });

beforeEach(() => {
    jest.clearAllMocks();
    owner = 'owner'; current = { ...shared };
    power_user.personas = { 'User.png': 'Kris' };
    power_user.persona_descriptions = { 'User.png': { description: 'Base', title: 'Traveller', connections: [{ id: 'chat' }],
        appendices: [{ id: 'au', name: 'Modern AU', description: 'Original note' }, { id: 'other', name: 'Other', description: 'Keep' }] } };
    saveSettings.mockResolvedValue(true);
});

test('the persona save retries temporary refusals and reports failure without throwing', async () => {
    saveSettings.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(true);
    await expect(saveSelectedPersona()).resolves.toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(3);
    expect(saveSettings).toHaveBeenLastCalledWith(0, { returnResult: true });
    saveSettings.mockResolvedValue(false);
    await expect(saveSelectedPersona()).resolves.toBe(false);
    expect(saveSettings).toHaveBeenCalledTimes(3 + 4);
});

test('only a Roleplay chat whose connections were not just saved needs the persona saved', () => {
    expect(needsSavedPersonaSelection({ kind: 'roleplay' }, false)).toBe(true);
    expect(needsSavedPersonaSelection({ kind: 'roleplay' }, true)).toBe(false);
    expect(needsSavedPersonaSelection({ kind: 'general' }, false)).toBe(false);
    expect(needsSavedPersonaSelection({ kind: 'conversation' }, false)).toBe(false);
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

test('new persona review works without a shared identity and saves only the edited draft once', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['portrait']) }));
    try {
        current = null;
        const plan = await create({}, { shared: undefined });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(saveSettings).not.toHaveBeenCalled();
        const edited = JSON.stringify({ name: 'Edited', description: '{{char}} keeps its macro.', title: 'Explorer', avatar: 'User.png', connections: ['unsafe'] });
        await Promise.all([plan.commit(edited), plan.commit(edited)]);
        const avatar = Object.keys(power_user.personas).find(key => key !== 'User.png');
        expect(power_user.personas[avatar]).toBe('Edited');
        expect(power_user.persona_descriptions[avatar]).toMatchObject({ description: '{{char}} keeps its macro.', title: 'Explorer', appendices: [], activeAppendices: {} });
        expect(power_user.persona_descriptions[avatar]).not.toHaveProperty('connections');
        expect(descriptor().description).toBe('Base');
        expect(setUserName).not.toHaveBeenCalled();
        await (await create({}, { shared: undefined })).commit(edited);
        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
});

test('new Scenario Notes preserve existing notes and activation, and retries do not duplicate them', async () => {
    descriptor().activeAppendices = { chat: 'au' };
    const before = structuredClone(descriptor());
    const plan = await create({ type: 'persona-note', persona: 'Kris' });
    expect(descriptor()).toEqual(before);
    await plan.commit(JSON.stringify({ name: 'Voyage', description: '{{user}} sails.', id: 'au', active: true }));
    expect(descriptor().appendices.slice(0, 2)).toEqual(before.appendices);
    expect(descriptor().activeAppendices).toEqual(before.activeAppendices);
    expect(descriptor().connections).toEqual(before.connections);
    expect(descriptor().appendices[2]).toEqual({ id: expect.stringMatching(/^scratchpad-/), name: 'Voyage', description: '{{user}} sails.' });
    await (await create({ type: 'persona-note', persona: 'Kris' })).commit(plan.after);
    expect(descriptor().appendices).toHaveLength(3);
    expect(saveSettings).toHaveBeenCalledTimes(1);
});

test('creation refuses revoked sharing, a switched persona or account and invalid review text', async () => {
    const guard = jest.fn();
    const plan = await create({ type: 'persona-note', persona: 'Kris' }, { guard });
    guard.mockImplementation(() => { throw new Error('Sharing revoked'); });
    await expect(plan.commit(plan.after)).rejects.toThrow('Sharing revoked');
    guard.mockImplementation(() => {});
    current.avatar = 'Other.png';
    await expect(plan.commit(plan.after)).rejects.toThrow('original persona');
    current = { ...shared };
    owner = 'other';
    await expect(plan.commit(plan.after)).rejects.toThrow('original account');
    owner = 'owner';
    await expect(plan.commit('not JSON')).rejects.toThrow('valid JSON');
    await expect(plan.commit('{"name":""}')).rejects.toThrow('name');
    expect(saveSettings).not.toHaveBeenCalled();
});

test('failed Scenario Note creation rolls back and can be retried', async () => {
    const plan = await create({ type: 'persona-note', persona: 'Kris' });
    saveSettings.mockResolvedValueOnce(false);
    await expect(plan.commit(plan.after)).rejects.toThrow('not saved');
    expect(descriptor().appendices).toHaveLength(2);
    await plan.commit(plan.after);
    expect(descriptor().appendices).toHaveLength(3);
});

test('failed persona creation removes its portrait and retries without a duplicate', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['portrait']) }));
    try {
        const plan = await create();
        saveSettings.mockResolvedValueOnce(false);
        await expect(plan.commit(plan.after)).rejects.toThrow('not saved');
        expect(power_user.personas).toEqual({ 'User.png': 'Kris' });
        expect(Object.keys(power_user.persona_descriptions)).toEqual(['User.png']);
        expect(fetchMock).toHaveBeenLastCalledWith('/api/avatars/delete', expect.objectContaining({ method: 'POST' }));
        await plan.commit(plan.after);
        expect(Object.keys(power_user.personas)).toHaveLength(2);
    } finally { fetchMock.mockRestore(); }
});

test('failed portrait upload leaves settings untouched', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['portrait']) })
        .mockResolvedValueOnce({ ok: false });
    try {
        const plan = await create();
        await expect(plan.commit(plan.after)).rejects.toThrow('portrait could not be saved');
        expect(power_user.personas).toEqual({ 'User.png': 'Kris' });
        expect(saveSettings).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
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
