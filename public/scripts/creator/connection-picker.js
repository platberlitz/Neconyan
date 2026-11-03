import { ConnectionManagerRequestService } from '../extensions/shared.js';
import { element, button } from './fields.js';

export function renderCreatorConnection(workspace, main) {
    const value = workspace.session.draft.writing?.connection ?? {};
    const profiles = ConnectionManagerRequestService.getSupportedProfiles();
    const group = element('fieldset', 'creator-fieldset');
    group.append(element('legend', '', 'Model connection'), element('p', 'creator-muted', 'Used for all Creator writing requests. If a request fails, try the fallback profiles in order. Provider output limits still apply.'));
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
    label.append(input); group.append(label); main.append(group);
}
