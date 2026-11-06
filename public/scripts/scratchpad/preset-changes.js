import { getPresetManager } from '../preset-manager.js';
import { currentPresetTargets, currentPromptOrderId } from './preset.js';
import { normaliseChange, fail } from './proposals.js';

const conflict = 'This preset changed while the review was open. Review the suggestion again before saving.';

export function preparePresetChange(change, shared, guard) {
    const check = () => {
        guard?.();
        if (!shared?.some(item => item.api === change.api && item.name === change.preset)
            || !currentPresetTargets().some(item => item.api === change.api && item.name === change.preset)) {
            fail('Share and select the original preset before reviewing this change.');
        }
    };
    check();
    const manager = getPresetManager(change.api);
    const saved = manager.getCompletionPresetByName(change.preset);
    if (!saved) fail('Save this preset first, then ask Scratchpad again.');
    const expected = structuredClone(saved);
    const live = structuredClone(manager.getPresetSettings(change.preset));
    const orderId = change.api === 'openai' ? currentPromptOrderId() : null;
    const readField = preset => {
        if (change.api !== 'openai') return preset;
        const prompt = preset.prompts?.find(item => item.identifier === change.module);
        if (!prompt || (prompt.marker && change.field !== 'enabled')) fail('Only the on/off setting of a placeholder slot can be edited here.');
        const entry = preset.prompt_order?.find(item => String(item.character_id) === String(orderId))?.order?.find(item => item.identifier === change.module);
        if (!entry) fail('This prompt module is no longer in the shared preset.');
        return change.field === 'enabled' ? entry : prompt;
    };
    const original = readField(live)[change.field] ?? '';
    const editable = typeof change.value === 'string' && change.field !== 'role';
    return {
        target: change.preset,
        field: `${change.module ? `${change.module} / ` : ''}${change.field}`,
        before: String(original), after: String(change.value), editable,
        hint: 'This saves the selected preset, including its current settings. Other chats using this preset will use the saved change too.',
        async commit(edited) {
            check();
            if (JSON.stringify(manager.getPresetSettings(change.preset)) !== JSON.stringify(live)
                || JSON.stringify(manager.getCompletionPresetByName(change.preset)) !== JSON.stringify(expected)
                || (change.api === 'openai' && currentPromptOrderId() !== orderId)) fail(conflict);
            const proposal = normaliseChange({ ...change, value: editable ? edited : change.value });
            const next = { ...structuredClone(expected), ...structuredClone(live) };
            readField(next)[change.field] = proposal.value;
            await manager.savePreset(change.preset, next, { expectedPreset: expected, quiet: true, isCurrent: () => {
                try { check(); return JSON.stringify(manager.getPresetSettings(change.preset)) === JSON.stringify(live); } catch { return false; }
            } });
        },
    };
}
