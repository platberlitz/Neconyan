import { createDefaultRules } from '../../public/scripts/extensions/third-party/Neconyan-PromptTags/src/sections.js';
import { normalizeRules } from '../../public/scripts/extensions/third-party/Neconyan-PromptTags/src/settings.js';
import { normalizePresetData } from '../../public/scripts/extensions/third-party/Neconyan-PromptTags/src/preset-store.js';
import { labError } from './store.js';

/** Resolve the same saved scopes as Prompt Tags, without changing their assignments. */
export function capturePromptingTags(settings, metadata, character, controls, pin) {
    const raw = settings.extension_settings?.promptTags ?? {};
    const entries = Object.entries(raw.profiles ?? {});
    const find = (id, name) => entries.find(([key, profile]) => id ? profile.id === id : key === name || profile.aliases?.includes(name));
    const deletedId = id => (raw.deletedProfileIds ?? []).includes(id);
    const deletedName = name => (raw.deletedProfileNames ?? []).includes(name);
    const assigned = assignment => {
        if (!assignment || typeof assignment !== 'object') return null;
        if (assignment.profileId) return deletedId(assignment.profileId) ? null : find(assignment.profileId);
        return assignment.profile && !deletedName(assignment.profile) ? find(null, assignment.profile) : null;
    };
    const preset = normalizePresetData(controls.extensions?.promptTags);
    const selected = pin ? find(pin.id, pin.name) : find(raw.activeProfileId, raw.activeProfile) ?? entries[0];
    if (pin && !selected) throw labError('The pinned Prompt Tags profile no longer exists.');
    const scopes = [['chat', assigned(metadata.promptTags)], ['character', assigned(character.extensions?.promptTags)],
        ['preset', assigned(preset)], ['global', selected]];
    const [scope, resolved] = scopes.find(([, profile]) => profile) ?? ['global', ['Default', { id: '', rules: createDefaultRules() }]];
    const disabled = settings.extension_settings?.disabledExtensions ?? [];
    return { enabled: raw.enabled !== false && !disabled.includes('third-party/Neconyan-PromptTags'), scope,
        name: resolved[0], id: resolved[1].id ?? '', rules: { ...normalizeRules(resolved[1].rules), ...preset.rules } };
}
