import { beforeEach, expect, jest, test } from '@jest/globals';

let selected;
let live;
let saved;
let orderId;
const savePreset = jest.fn(async (_name, next, options) => {
    if (!options.isCurrent()) throw new Error('stale');
    saved = structuredClone(next);
    live = structuredClone(next);
});
jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: () => ({
    getPresetSettings: () => live, getCompletionPresetByName: () => saved, savePreset,
}) }));
jest.unstable_mockModule('../public/scripts/scratchpad/preset.js', () => ({
    currentPresetTargets: () => selected, currentPromptOrderId: () => orderId,
}));
const { preparePresetChange } = await import('../public/scripts/scratchpad/preset-changes.js');
const { normaliseChange } = await import('../public/scripts/scratchpad/proposals.js');
const shared = [{ api: 'openai', name: 'Lantern' }];
const proposal = { type: 'preset', action: 'replace', api: 'openai', preset: 'Lantern', module: 'main', field: 'content', value: 'New {{char}} text.' };

beforeEach(() => {
    selected = structuredClone(shared);
    orderId = 7;
    live = { temperature: 0.8, prompts: [{ identifier: 'main', content: 'Old text.', role: 'system' }, { identifier: 'slot', marker: true }],
        prompt_order: [{ character_id: 7, order: [{ identifier: 'main', enabled: true }, { identifier: 'slot', enabled: true }] },
            { character_id: 8, order: [{ identifier: 'main', enabled: false }] }] };
    saved = { ...structuredClone(live), extensionData: { keep: true } };
    savePreset.mockClear();
});

test('reviews without mutation, then saves edited raw text with a conditional write and preserves unrelated settings', async () => {
    const expected = structuredClone(saved);
    const plan = preparePresetChange(normaliseChange(proposal), shared);
    expect(plan).toMatchObject({ before: 'Old text.', after: 'New {{char}} text.', editable: true });
    expect(savePreset).not.toHaveBeenCalled();
    await plan.commit('  Reviewed {{char}}.\n');
    expect(saved.prompts[0].content).toBe('  Reviewed {{char}}.\n');
    expect(saved).toMatchObject({ temperature: 0.8, extensionData: { keep: true }, prompt_order: expected.prompt_order });
    expect(savePreset.mock.calls[0][2].expectedPreset).toEqual(expected);
});

test('changes only the active prompt order when toggling a module or slot', async () => {
    for (const module of ['main', 'slot']) {
        const plan = preparePresetChange(normaliseChange({ ...proposal, module, field: 'enabled', value: false }), shared);
        expect(plan.editable).toBe(false);
        await plan.commit('false');
        expect(saved.prompt_order[0].order.find(item => item.identifier === module).enabled).toBe(false);
    }
    expect(saved.prompt_order[1].order).toEqual([{ identifier: 'main', enabled: false }]);
    expect(saved.prompts[0].content).toBe('Old text.');
});

test('refuses a preset that was not shared', () => {
    expect(() => preparePresetChange(normaliseChange(proposal), [])).toThrow(/Share/);
    expect(savePreset).not.toHaveBeenCalled();
});

test.each(['selected', 'live', 'saved', 'order', 'guard'])('refuses a %s target change before saving', async kind => {
    let allowed = true;
    const guard = () => { if (!allowed) throw new Error('Sharing was turned off'); };
    const plan = preparePresetChange(normaliseChange(proposal), shared, guard);
    if (kind === 'selected') selected = [{ api: 'openai', name: 'Other' }];
    if (kind === 'live') live.temperature = 0.9;
    if (kind === 'saved') saved.temperature = 0.9;
    if (kind === 'order') orderId = 8;
    if (kind === 'guard') allowed = false;
    await expect(plan.commit('Edited')).rejects.toThrow();
    expect(savePreset).not.toHaveBeenCalled();
});

test('rejects module text for a slot and a module outside the current order', () => {
    expect(() => preparePresetChange(normaliseChange({ ...proposal, module: 'slot' }), shared)).toThrow(/placeholder/);
    live.prompt_order[0].order = [];
    expect(() => preparePresetChange(normaliseChange(proposal), shared)).toThrow(/no longer/);
});

test.each([
    ['sysprompt', 'post_history'], ['context', 'story_string'], ['instruct', 'input_sequence'],
])('saves %s template %s as literal text', async (api, field) => {
    selected = [{ api, name: 'Template' }];
    live = { [field]: 'Old', untouched: 'Keep' };
    saved = structuredClone(live);
    const plan = preparePresetChange(normaliseChange({ ...proposal, api, preset: 'Template', field, value: '\n{{char}}\n' }), selected);
    await plan.commit(plan.after);
    expect(saved).toEqual({ [field]: '\n{{char}}\n', untouched: 'Keep' });
});

test.each([
    { field: 'enabled', value: 'false' }, { field: 'injection_depth', value: -1 }, { field: 'role', value: 'tool' },
    { field: 'temperature', value: 1 }, { field: '__proto__', value: {} }, { api: '__proto__' }, { module: '' },
])('rejects malformed preset proposal %j', value => {
    expect(() => normaliseChange({ ...proposal, ...value })).toThrow();
});

test('a failed save leaves the live preset untouched and may be retried', async () => {
    const plan = preparePresetChange(normaliseChange(proposal), shared);
    savePreset.mockRejectedValueOnce(new Error('Conflict on disk'));
    await expect(plan.commit('Reviewed')).rejects.toThrow('Conflict on disk');
    expect(live.prompts[0].content).toBe('Old text.');
    await plan.commit('Reviewed');
    expect(live.prompts[0].content).toBe('Reviewed');
});
