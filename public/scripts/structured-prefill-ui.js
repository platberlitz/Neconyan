import { structuredPrefillSettings, STRUCTURED_PREFILL_PRESETS } from './structured-prefill.js';
import { t } from './i18n.js';

let cleanupPreset;

/** Native settings controls; the recorded request status is painted eagerly by power-user. */
export function initialiseStructuredPrefillUI(power, save, profiles) {
    const root = document.querySelector('#structured-prefill-settings');
    if (!root) return;
    const status = root.querySelector('[data-sp-status]');
    const presets = root.querySelector('[data-sp-presets]');
    const name = root.querySelector('[data-sp-name]');
    const current = () => power.structured_prefill;
    cleanupPreset?.();
    const bundled = root.querySelector('[data-sp-bundled]');
    const clearStartingPoint = () => {
        if (bundled) bundled.value = '';
        const description = root.querySelector('[data-sp-description]');
        if (description) description.textContent = '';
    };
    if (bundled) bundled.replaceChildren(new Option(t`Choose a starting point`, ''), ...STRUCTURED_PREFILL_PRESETS.map(preset => new Option(preset.name, preset.name)));
    if (bundled) bundled.onchange = () => {
        const preset = STRUCTURED_PREFILL_PRESETS.find(item => item.name === bundled.value);
        if (!preset) return;
        power.structured_prefill = structuredPrefillSettings({ ...preset, enabled: current().enabled,
            prefill_gen_profile_id: current().prefill_gen_profile_id });
        root.querySelector('[data-sp-description]').textContent = preset.description;
        name.value = ''; refresh(); save();
    };
    const options = (select, entries, selected, empty) => {
        select.replaceChildren(new Option(empty, ''), ...entries.map(entry => new Option(entry.name, entry.id ?? entry.name)));
        select.value = selected;
    };
    const refresh = () => {
        const profile = root.querySelector('[data-sp="prefill_gen_profile_id"]');
        const available = profiles().filter(item => item.mode === 'cc');
        if (current().prefill_gen_profile_id && !available.some(item => item.id === current().prefill_gen_profile_id)) {
            available.push({ id: current().prefill_gen_profile_id, name: t`Missing saved profile` });
        }
        options(profile, available, current().prefill_gen_profile_id, t`Choose a saved connection`);
        for (const input of root.querySelectorAll('[data-sp]')) {
            const value = current()[input.dataset.sp];
            if (input.type === 'checkbox') input.checked = value;
            else input.value = value;
        }
        options(presets, power.structured_prefill_presets, name.value, t`Choose a preset`);
    };
    // Settings can reload after imports or account changes. Replace handlers, not the controls.
    root.oninput = event => {
        const input = event.target;
        if (!input.dataset.sp) return;
        clearStartingPoint();
        const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
        power.structured_prefill = structuredPrefillSettings({ ...current(), [input.dataset.sp]: value });
        save();
    };
    root.ontoggle = refresh;
    const applyPreset = label => {
        const preset = power.structured_prefill_presets.find(item => item.name === label);
        if (!preset) throw new Error(t`Prefill preset not found.`);
        clearStartingPoint();
        power.structured_prefill = structuredPrefillSettings({ ...preset, enabled: current().enabled });
        name.value = preset.name; refresh(); save();
        return preset.name;
    };
    presets.onchange = () => { if (presets.value) applyPreset(presets.value); };
    const receivePreset = event => {
        const presetName = String(event.detail?.name ?? '');
        if (!presetName) return;
        clearStartingPoint();
        name.value = presetName;
        refresh();
    };
    window.addEventListener('neconyan:structured-prefill-preset-applied', receivePreset);
    cleanupPreset = () => window.removeEventListener('neconyan:structured-prefill-preset-applied', receivePreset);
    root.onclick = event => {
        const action = event.target.closest('[data-sp-action]')?.dataset.spAction;
        if (!action) return;
        const label = name.value.trim();
        if (action === 'save') {
            if (!label) { status.textContent = t`Enter a preset name first.`; return; }
            const list = power.structured_prefill_presets.filter(item => item.name !== label);
            power.structured_prefill_presets = [...list, { ...current(), name: label }];
            status.textContent = t`Preset saved.`; refresh(); save();
        } else if (action === 'delete') {
            power.structured_prefill_presets = power.structured_prefill_presets.filter(item => item.name !== label);
            name.value = ''; status.textContent = t`Preset deleted.`; refresh(); save();
        } else if (action === 'export') {
            const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, presets: power.structured_prefill_presets }, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'structured-prefill-presets.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    };
    root.querySelector('[data-sp-import]').onchange = async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            if (file.size > 1024 * 1024) throw new Error(t`Keep the preset file below 1 MB.`);
            const raw = JSON.parse(await file.text());
            const list = Array.isArray(raw) ? raw : raw.presets ?? [raw.preset ?? raw];
            if (!Array.isArray(list) || !list.length || list.length > 100 || list.some(item => !item || typeof item.name !== 'string')) {
                throw new Error(t`Choose a prefill preset export containing named presets.`);
            }
            const imported = list.map(item => ({ ...structuredPrefillSettings(item), name: item.name.slice(0, 80) }));
            power.structured_prefill_presets = [...power.structured_prefill_presets.filter(item => !imported.some(next => next.name === item.name)), ...imported];
            status.textContent = t`Presets imported. Choose one to apply it.`; refresh(); save();
        } catch (error) { status.textContent = error.message; } finally { event.target.value = ''; }
    };
    refresh();
}
