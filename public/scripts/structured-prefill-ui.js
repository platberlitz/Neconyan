import { structuredPrefillSettings } from './structured-prefill.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from './slash-commands/SlashCommandArgument.js';
import { t } from './i18n.js';

let commandActions;

/** One native settings owner; no generation listeners or message DOM rewriting. */
export function initialiseStructuredPrefillUI(power, save, profiles) {
    const root = document.querySelector('#structured-prefill-settings');
    if (!root) return;
    const status = root.querySelector('[data-sp-status]');
    const presets = root.querySelector('[data-sp-presets]');
    const name = root.querySelector('[data-sp-name]');
    const current = () => power.structured_prefill;
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
        const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
        power.structured_prefill = structuredPrefillSettings({ ...current(), [input.dataset.sp]: value });
        save();
    };
    root.ontoggle = refresh;
    const applyPreset = label => {
        const preset = power.structured_prefill_presets.find(item => item.name === label);
        if (!preset) throw new Error(t`Prefill preset not found.`);
        power.structured_prefill = structuredPrefillSettings({ ...preset, enabled: current().enabled });
        name.value = preset.name; refresh(); save();
        return preset.name;
    };
    presets.onchange = () => { if (presets.value) applyPreset(presets.value); };
    if (!commandActions) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'structuredprefill-preset', aliases: ['sp-preset'],
            callback: (_, label) => commandActions.apply(String(label)),
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Prefill preset name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
            helpString: 'Apply a saved Structured Prefill preset by name.' }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'structuredprefill-preset-list', aliases: ['sp-preset-list'],
            callback: () => JSON.stringify(commandActions.list()), helpString: 'List saved Structured Prefill preset names.' }));
    }
    commandActions = { apply: applyPreset, list: () => power.structured_prefill_presets.map(item => item.name) };
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
