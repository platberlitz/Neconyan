import { getPresetManager } from '../preset-manager.js';
import { currentPresetTargets, currentPromptOrderId } from './preset.js';
import { normaliseChange, fail } from './proposals.js';
import { PRESET_FIELDS } from './preset-fields.js';
import { refuseUndo, UndoConflictError } from './undo-errors.js';
import { isAllowedUndoField } from './undo-fields.js';

const conflict = 'This preset changed while the review was open. Review the suggestion again before saving.';
const undoConflict = 'This preset was edited after Scratchpad saved it, so automatic undo was stopped to avoid overwriting your later changes. Open Change history to see the previous text.';

function presetField(preset, undo) {
    if (undo.api !== 'openai') return preset;
    const prompt = preset.prompts?.find(item => item.identifier === undo.module);
    const entry = preset.prompt_order?.find(item => String(item.character_id) === String(undo.orderId))?.order?.find(item => item.identifier === undo.module);
    return undo.field === 'enabled' ? entry : prompt;
}

export function preparePresetChange(change, shared, guard, { globalOnly = false } = {}) {
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
    const orderId = change.api === 'openai' ? currentPromptOrderId({ globalOnly }) : null;
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
                || (change.api === 'openai' && currentPromptOrderId({ globalOnly }) !== orderId)) fail(conflict);
            const proposal = normaliseChange({ ...change, value: editable ? edited : change.value });
            const next = { ...structuredClone(expected), ...structuredClone(live) };
            const slot = readField(next);
            const previous = Object.hasOwn(slot, change.field) ? structuredClone(slot[change.field]) : undefined;
            slot[change.field] = proposal.value;
            await manager.savePreset(change.preset, next, { expectedPreset: expected, quiet: true, isCurrent: () => {
                try { check(); return JSON.stringify(manager.getPresetSettings(change.preset)) === JSON.stringify(live); } catch { return false; }
            } });
            return { undo: { kind: 'preset', api: change.api, preset: change.preset, module: change.module ?? null, field: change.field,
                orderId, ...(globalOnly ? { globalOnly: true } : {}), missing: previous === undefined, before: previous ?? null, after: structuredClone(proposal.value) } };
        },
    };
}

export async function undoPresetChange(undo) {
    if (!currentPresetTargets().some(item => item.api === undo.api && item.name === undo.preset)) {
        refuseUndo(`Select the preset ${undo.preset} first, then undo again.`);
    }
    if (undo.api === 'openai' && String(currentPromptOrderId({ globalOnly: undo.globalOnly === true })) !== String(undo.orderId)) refuseUndo(`Select the preset ${undo.preset} first, then undo again.`);
    if (typeof undo.api !== 'string' || !Object.hasOwn(PRESET_FIELDS, undo.api) || !isAllowedUndoField(PRESET_FIELDS[undo.api], undo.field)) {
        throw new UndoConflictError(undoConflict);
    }
    const manager = getPresetManager(undo.api);
    const saved = manager.getCompletionPresetByName(undo.preset);
    if (!saved) throw new UndoConflictError(undoConflict);
    const expected = structuredClone(saved);
    const live = structuredClone(manager.getPresetSettings(undo.preset));
    const slot = presetField(live, undo);
    if (!slot || JSON.stringify(slot[undo.field]) !== JSON.stringify(undo.after)) throw new UndoConflictError(undoConflict);
    const next = { ...structuredClone(expected), ...structuredClone(live) };
    const target = presetField(next, undo);
    if (undo.missing) delete target[undo.field];
    else target[undo.field] = structuredClone(undo.before);
    await manager.savePreset(undo.preset, next, { expectedPreset: expected, quiet: true, isCurrent: () => JSON.stringify(manager.getPresetSettings(undo.preset)) === JSON.stringify(live) });
}
