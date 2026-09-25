import { getCharacterProviderReferences, hasCharacterReferenceOverrides, normalizeCharacterReferenceRecord } from './client-orchestration.js';

const ARRAY_REFERENCES = ['proxyRefImages', 'customApiRefImages', 'nanobananaRefImages', 'nanogptRefImages'];
const DEFAULTS = { prompt: '{{char}} in the current scene',
    negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, deformed, ugly, duplicate, morbid, mutilated, out of frame, mutation, disfigured',
    style: 'none', width: 512, height: 512 };
const invalid = () => Object.assign(new Error('The saved character image settings need an exact character selection.'), { code: 'QIG_CHARACTER_SETTINGS_INVALID', status: 409 });
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function apply(settings, state) {
    if (!record(state)) throw invalid();
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(state, key)) settings[key] = state[key] ?? DEFAULTS[key];
    for (const key of ARRAY_REFERENCES) if (Object.hasOwn(state, key)) {
        if (state[key] !== null && !Array.isArray(state[key])) throw invalid();
        settings[key] = [...(state[key] || [])];
    }
    if (Object.hasOwn(state, 'localRefImage')) {
        if (state.localRefImage !== null && typeof state.localRefImage !== 'string') throw invalid();
        settings.localRefImage = state.localRefImage || '';
    }
}

/** Resolve the account's persisted character overrides without a mutable page selection. */
export function resolveCharacterImageSettings(base, scope) {
    if (!record(base)) throw invalid();
    if (scope === undefined) return base;
    if (!record(scope) || typeof scope.avatar !== 'string' || !scope.avatar || scope.avatar === '.' || scope.avatar === '..'
        || /[\\/\0]/.test(scope.avatar) || scope.characterId !== undefined && (typeof scope.characterId !== 'string' || !scope.characterId)) throw invalid();
    const keys = [...new Set([`card:${scope.avatar.trim().toLowerCase()}`, scope.avatar, scope.characterId].filter(Boolean))];
    const select = store => {
        if (store == null) return null;
        if (!record(store)) throw invalid();
        const key = keys.find(key => Object.hasOwn(store, key));
        if (key) return store[key];
        if (!scope.characterId && Object.keys(store).some(key => /^\d+$/.test(key))) throw invalid();
        return null;
    };
    const settings = { ...base };
    // This is the saved global state, before the browser applied a different card.
    if (base._charSettingsBaseState != null) apply(settings, base._charSettingsBaseState);
    const saved = select(base._backupCharSettings);
    const references = select(base._backupCharRefImages);
    if (references !== null && !record(references) && !Array.isArray(references)) throw invalid();
    for (const key of ARRAY_REFERENCES) if (references && Object.hasOwn(references, key)
        && !Array.isArray(references[key])) throw invalid();
    const referenceRecord = normalizeCharacterReferenceRecord(references, settings.provider);
    if (saved === null && !hasCharacterReferenceOverrides(referenceRecord)) return settings;
    if (saved !== null) apply(settings, saved);
    for (const key of ARRAY_REFERENCES) settings[key] = [];
    settings.localRefImage = '';
    const selected = getCharacterProviderReferences(referenceRecord, settings.provider);
    const key = { proxy: 'proxyRefImages', custom: 'customApiRefImages', nanobanana: 'nanobananaRefImages', nanogpt: 'nanogptRefImages' }[settings.provider];
    if (key) settings[key] = selected;
    if (settings.provider === 'local') settings.localRefImage = selected;
    for (const key of ARRAY_REFERENCES) if (!Array.isArray(settings[key]) || settings[key].some(value => typeof value !== 'string' || !value)) throw invalid();
    return settings;
}
