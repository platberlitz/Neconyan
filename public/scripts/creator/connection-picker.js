import { ConnectionManagerRequestService } from '../extensions/shared.js';
import { element, button, textField } from './fields.js';
import { getGeneratingModel } from '../../script.js';
import { isKimiK3Model } from '../openai-model-capabilities.js';

export function renderCreatorConnection(workspace, main) {
    const value = workspace.session.draft.writing?.connection ?? {};
    let profiles = [];
    let unavailable = false;
    try { profiles = ConnectionManagerRequestService.getSupportedProfiles(); } catch { unavailable = true; }
    const group = element('fieldset', 'creator-fieldset');
    group.dataset.creatorConnection = '';
    group.append(element('legend', '', 'Model connection'), element('p', 'creator-muted', 'Used for all Catelier writing requests. Failed requests try fallback profiles in order. The output limit is sent as entered, without automatic adjustment to the model. Lower it if your provider rejects it or your local model has a smaller context.'));
    if (unavailable) group.append(element('p', 'creator-muted', 'Connection Manager is unavailable. Choose Current connection to keep writing. Saved profile choices are retained until you change them.'));
    const edit = (change, redraw = true) => workspace.edit(next => {
        next.writing ??= {};
        next.writing.connection ??= {};
        change(next.writing.connection);
    }, redraw);
    const picker = (label, selected, change, fallback = false) => {
        const wrapper = element('label', 'creator-field');
        wrapper.append(element('span', '', label));
        const select = element('select', 'text_pole');
        select.setAttribute('aria-label', label);
        for (const item of [{ id: '', name: fallback ? 'Choose a profile' : 'Current connection' }, ...profiles]) {
            const option = element('option', '', item.name);
            option.value = item.id;
            select.append(option);
        }
        if (selected && !profiles.some(profile => profile.id === selected)) {
            const missing = element('option', '', 'Unavailable saved profile');
            missing.value = selected;
            select.append(missing);
        }
        select.value = selected || '';
        select.addEventListener('change', () => change(select.value));
        wrapper.append(select);
        return wrapper;
    };
    group.append(picker('Connection profile', value.profile, profile => edit(next => { next.profile = profile; })));
    (value.fallbacks ?? []).forEach((id, index) => {
        const row = picker(`Fallback ${index + 1}`, id, profile => edit(next => { next.fallbacks[index] = profile; }), true);
        row.append(button('Remove fallback', () => edit(next => { next.fallbacks.splice(index, 1); })));
        group.append(row);
    });
    group.append(button('Add fallback', () => edit(next => { next.fallbacks = [...(next.fallbacks ?? []), '']; })));
    const label = element('label', 'creator-field');
    label.append(element('span', '', 'Maximum output tokens'));
    const input = element('input', 'text_pole');
    input.type = 'number'; input.min = '1'; input.step = '1';
    input.value = String(value.maxTokens ?? 64000);
    input.setAttribute('aria-label', 'Maximum output tokens');
    input.addEventListener('change', () => {
        if (!input.reportValidity() || !input.value) return;
        edit(next => { next.maxTokens = Number(input.value); }, false);
    });
    label.append(input); group.append(label);
    group.append(textField('Prefill', value.prefill ?? '', prefill => edit(next => { next.prefill = prefill; }, false), {
        rows: 3, hint: 'Start the model’s reply with this text. Kept in this draft and used for Catelier writing requests. Your provider must support assistant prefills.',
    }));
    const models = [value.profile ? profiles.find(profile => profile.id === value.profile)?.model : getGeneratingModel(), ...(value.fallbacks ?? []).map(id => profiles.find(profile => profile.id === id)?.model)];
    if (models.some(isKimiK3Model)) group.append(textField('Partial prefill', value.partialPrefill ?? '', partialPrefill => edit(next => { next.partialPrefill = partialPrefill; }, false), {
        rows: 3, hint: 'Used instead of Prefill for Kimi K3 and K3.1 Pro, including fallback connections. Sends partial: true. Leave blank to use Prefill. A <think> block starts the model’s reasoning.',
    }));
    const streaming = element('label', 'creator-choice-pill');
    const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = value.stream === true;
    toggle.addEventListener('change', () => edit(next => { next.stream = toggle.checked; }, false));
    streaming.append(toggle, document.createTextNode('Stream live output'));
    group.append(streaming, element('p', 'creator-muted', 'Watch replies arrive before reviewing the finished proposal. Supported by chat and text completion connections; other connections show their reply when it finishes.'));
    main.append(group);
}
