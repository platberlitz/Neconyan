import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';
import { escapeHtml } from '../../utils.js';
import {
    captureAgentSaveGuard,
    DEFAULT_LENGTH_TARGET,
    getAgentById,
    getAgents,
    getCompanionConfig,
    isCompanionAgent,
    LENGTH_TRIMMER_TEMPLATE_ID,
    MAX_PROMPT_TRANSFORM_CONTEXT_MESSAGES,
    normalizePromptTransformContextMessages,
    saveAgentBatch,
} from './agent-store.js';
import { getCompanionReferenceIds } from './companion/companion-shared.js';
import { populateConnectionProfileSelect } from './profile-utils.js';

const KEEP = '__ica_keep__';

// Change only links between the selected companions, including legacy template references.
export function changeSelectedCompanionLinks(agents, field, enabled) {
    const companions = agents.filter(isCompanionAgent);
    const flag = field === 'batchAgentIds' ? 'batch' : 'sendContextToCompanions';
    for (const agent of companions) {
        const peers = companions.filter(peer => peer.id !== agent.id);
        const references = new Set(peers.flatMap(getCompanionReferenceIds));
        const config = getCompanionConfig(agent);
        const links = config[field].filter(id => !references.has(id));
        config[field] = [...new Set([...links, ...(enabled ? peers.map(peer => peer.id) : [])])];
        config[flag] = enabled || (config[flag] && config[field].length > 0);
        agent.companion = config;
    }
}

function addReferenceChecklist(root, agent, field, title, help, onSelect = () => {}) {
    const saved = getCompanionConfig(agent)[field];
    const selected = new Set(saved);
    const candidates = getAgents().filter(candidate => candidate.id !== agent.id && isCompanionAgent(candidate))
        .sort((a, b) => a.name.localeCompare(b.name));
    const available = new Set(candidates.flatMap(getCompanionReferenceIds));
    const options = candidates.map(candidate => ({
        id: candidate.id, label: candidate.name,
        values: saved.filter(id => getCompanionReferenceIds(candidate).includes(id)),
        checked: getCompanionReferenceIds(candidate).some(id => selected.has(id)),
    }));
    for (const id of saved.filter(id => !available.has(id))) {
        options.push({ id, label: `Unavailable: ${id}`, values: [id], checked: true });
    }
    const section = $(`<fieldset class="ica--link-list"><legend>${title}</legend><p class="ica--profile-help">${help}</p>
        <label>Find a companion<input type="search" class="text_pole" placeholder="Search names"></label>
        <div class="flex-container flexGap5"><button type="button" class="menu_button" data-select="true">Select shown</button><button type="button" class="menu_button" data-select="false">Clear shown</button></div>
        <div class="ica--link-options"></div><small role="status"></small></fieldset>`);
    const list = section.find('.ica--link-options');
    for (const option of options) {
        const row = $('<label class="checkbox_label"></label>');
        const input = $('<input type="checkbox">').attr('data-link-field', field).val(option.id).prop('checked', option.checked);
        input.data('referenceValues', option.values.length ? option.values : [option.id]);
        row.append(input, $('<span>').text(option.label));
        list.append(row);
    }
    const update = () => section.find('[role="status"]').text(`${list.find('input:checked').length} selected`);
    section.find('input[type="search"]').on('input', function () {
        const query = this.value.toLowerCase();
        list.children().each((_, row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
    });
    section.find('[data-select]').on('click', function () {
        const shown = list.children().filter((_, row) => !row.hidden).find('input');
        const checked = this.dataset.select === 'true';
        shown.prop('checked', checked);
        if (checked && shown.length) onSelect();
        update();
    });
    list.on('change', 'input', function () {
        if (this.checked) onSelect();
        update();
    });
    update();
    if (!options.length) section.find('[role="status"]').text('No other companions yet.');
    root.append(section);
}

export async function openAgentQuickSettings(ids, { view = 'settings', lockAgent, onSaved } = {}) {
    const agents = [...new Set(ids)].map(getAgentById).filter(Boolean);
    if (!agents.length) return;
    const isCurrent = captureAgentSaveGuard(agents.map(agent => agent.id));
    const bulk = agents.length > 1;
    const companions = agents.filter(isCompanionAgent);
    const first = agents[0];
    const config = getCompanionConfig(companions[0]);
    const title = view === 'connections' ? 'Batch & connect' : 'Agent settings';
    const root = $(`<div class="ica--quick-settings"><h3>${title}</h3><p data-selection></p><p role="alert" hidden></p></div>`);
    root.find('[data-selection]').text(bulk ? `${agents.length} agents selected · ${companions.length} companions` : first.name);
    const fields = [];
    const addSelect = (section, key, label, options, value, companion = false) => {
        const row = $('<label></label>').text(label);
        const select = $('<select class="text_pole"></select>').attr('aria-label', label);
        if (bulk) select.append($('<option>').val(KEEP).text('Leave unchanged'));
        for (const [id, text] of options) select.append($('<option>').val(String(id)).text(text));
        select.val(bulk ? KEEP : String(value));
        row.append(select);
        section.append(row);
        fields.push({ input: select[0], key, companion, initial: select.val() });
        return select;
    };
    const addNumber = (section, key, label, value, min, max, companion = false) => {
        const input = $('<input type="number" class="text_pole" step="1">').attr({ min, ...(max ? { max } : {}), placeholder: bulk ? 'Leave unchanged' : '' }).val(bulk ? '' : value);
        section.append($('<label>').text(label).append(input));
        fields.push({ input: input[0], key, companion, initial: input.val(), number: true });
    };
    const addSection = label => {
        const section = $('<fieldset class="ica--quick-fields"></fieldset>').append($('<legend>').text(label));
        root.append(section);
        return section;
    };
    const yesNo = [[true, 'Yes'], [false, 'No']];
    if (view === 'settings') {
        const connection = addSection('Connection & timing');
        const profile = addSelect(connection, 'connectionProfile', 'Connection profile', [], first.connectionProfile);
        populateConnectionProfileSelect(profile[0], { selectedValue: first.connectionProfile, emptyLabel: 'Use default connection' });
        if (bulk) profile.prepend($('<option>').val(KEEP).text('Leave unchanged')).val(KEEP);
        fields.at(-1).initial = profile.val();
        const model = $('<input class="text_pole" type="text" placeholder="Use the connection’s model">').val(bulk ? '' : first.modelOverride);
        connection.append($('<label>').text('Model override').append(model));
        const modelField = { input: model[0], key: 'modelOverride', initial: model.val() };
        if (bulk) {
            const apply = $('<input type="checkbox">');
            connection.append($('<label class="checkbox_label">').append(apply, $('<span>').text('Set model for selected agents (blank uses the connection’s model)')));
            model.prop('disabled', true);
            apply.on('change', () => model.prop('disabled', !apply.prop('checked')));
            modelField.apply = apply[0];
        }
        fields.push(modelField);
        addSelect(connection, 'phase', 'Run timing', [['pre', 'Before reply'], ['post', 'After reply'], ['both', 'Before and after']], first.phase);
        if (!bulk) addNumber(connection, 'order', 'Order', first.injection.order, 0, 999);
        if (!bulk && !companions.length && first.postProcess?.promptTransformEnabled) {
            const rewrite = addSection('Reply rewrite');
            if (String(first.sourceTemplateId ?? '').trim() === LENGTH_TRIMMER_TEMPLATE_ID) {
                const lengthTarget = typeof first.settings?.lengthTarget === 'string' ? first.settings.lengthTarget : DEFAULT_LENGTH_TARGET;
                const input = $('<input type="text" class="text_pole" maxlength="200">').attr('placeholder', DEFAULT_LENGTH_TARGET).val(lengthTarget);
                rewrite.append($('<label>').text('Target length').append(input));
                fields.push({ input: input[0], key: 'lengthTarget', setting: true, initial: input.val() });
                rewrite.append('<p class="ica--profile-help">Plain words work: ‘About 300 words’, ‘Two short paragraphs’, ‘Under 150 words’.</p>');
            }
            addNumber(rewrite, 'promptTransformContextMessages', 'Recent messages to read', normalizePromptTransformContextMessages(first.postProcess.promptTransformContextMessages), 0, MAX_PROMPT_TRANSFORM_CONTEXT_MESSAGES);
            fields.at(-1).postProcess = true;
            rewrite.append('<p class="ica--profile-help">Earlier chat messages this rewrite can read, so it can catch repeats and slips. They are never changed. 0 sends the reply alone.</p>');
        }
        if (companions.length) {
            const history = addSection('Chat history');
            addSelect(history, 'includeInChatHistory', 'Keep in chat history', yesNo, config.includeInChatHistory, true);
            addSelect(history, 'includeAllChatHistory', 'Keep all saved notes', yesNo, config.includeAllChatHistory, true);
            addNumber(history, 'chatHistoryDepth', 'Notes to keep when not keeping all', config.chatHistoryDepth, 1, null, true);
            addSelect(history, 'keepInChatHistoryWhenHostHidden', 'Keep notes when the reply is hidden', yesNo, config.keepInChatHistoryWhenHostHidden, true);
            history.append('<p class="ica--profile-help">Saved companion notes become context for future replies. These settings also update notes in the open chat.</p>');
            const behaviour = addSection('Companion settings');
            addSelect(behaviour, 'trigger', 'Run companions', [['auto', 'Automatically'], ['manual', 'Manually']], config.trigger, true);
            addSelect(behaviour, 'displayMode', 'Show notes', [['panel', 'Companion panel'], ['card', 'Under replies'], ['hidden', 'Hidden']], config.displayMode, true);
            addNumber(behaviour, 'contextMessages', 'Chat messages to read', config.contextMessages, 1, null, true);
            addNumber(behaviour, 'historyDepth', 'Previous notes to read', config.historyDepth, 1, 10, true);
            addNumber(behaviour, 'maxTokens', 'Maximum output tokens', config.maxTokens, 16, 64000, true);
        }
    } else if (bulk) {
        const links = addSection('Connect selected companions');
        addSelect(links, 'batchAgentIds', 'Batch in one request', [[true, 'Batch selected companions'], [false, 'Remove batches between selected companions']], false, true);
        addSelect(links, 'contextRecipientAgentIds', 'Share latest notes', [[true, 'Share between selected companions'], [false, 'Stop sharing between selected companions']], false, true);
        links.append('<p class="ica--profile-help">Connections are added in both directions. Other connections stay as they are. Sharing uses the latest completed notes; it does not wait for a new note.</p>');
    } else if (companions.length) {
        const switches = addSection('Companion connections');
        const batch = addSelect(switches, 'batch', 'Use batching', yesNo, config.batch, true);
        const send = addSelect(switches, 'sendContextToCompanions', 'Send latest notes', yesNo, config.sendContextToCompanions, true);
        addSelect(switches, 'waitForDependencies', 'Wait for linked companions', yesNo, config.waitForDependencies, true);
        addReferenceChecklist(root, first, 'batchAgentIds', 'Batch with', 'Choosing companions turns batching on. You can pause it above without clearing this list.', () => batch.val('true'));
        addReferenceChecklist(root, first, 'contextRecipientAgentIds', 'Send notes to', 'Choosing companions turns note sharing on. Each receives this agent’s latest completed note.', () => send.val('true'));
        addReferenceChecklist(root, first, 'dependencies', 'Run after', 'Read these companions’ notes and re-run when they update. Turn on waiting to let scheduled companions finish first.');
    }
    if (view === 'connections') root.append('<p class="ica--profile-help">Only companions with matching connections, models and context can share a request. Others run separately. Companions must be enabled and scheduled to run.</p>');
    let saving = false;
    const result = await new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Save changes', cancelButton: 'Cancel', allowVerticalScrolling: true,
        onOpen: popup => {
            popup.dlg.setAttribute('aria-label', title);
            for (const button of [popup.okButton, popup.cancelButton]) {
                button.setAttribute('role', 'button');
                button.tabIndex = 0;
            }
            root.find('select, input').first().trigger('focus');
        },
        onClosing: async popup => {
            if (saving) return false;
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const invalid = root.find('input').toArray().find(input => !input.checkValidity());
            if (invalid) { invalid.reportValidity(); return false; }
            if (!isCurrent()) {
                root.find('[role="alert"]').text('These agents changed. Cancel and reopen settings.').prop('hidden', false);
                return false;
            }
            const controls = root.find('input, select, button').toArray();
            const disabled = controls.map(control => control.disabled);
            saving = true;
            controls.forEach(control => { control.disabled = true; });
            try {
                const drafts = agents.map(agent => structuredClone(agent));
                for (const field of fields) {
                    let value = field.input.value;
                    if (field.apply ? !field.apply.checked : value === field.initial || value === KEEP || (field.number && value === '')) continue;
                    if (field.number) value = Number(value);
                    if (field.companion && ['batchAgentIds', 'contextRecipientAgentIds'].includes(field.key)) {
                        changeSelectedCompanionLinks(drafts, field.key, value === 'true');
                        continue;
                    }
                    for (const draft of drafts) {
                        if (field.companion) {
                            if (!isCompanionAgent(draft)) continue;
                            draft.companion = getCompanionConfig(draft);
                            draft.companion[field.key] = ['true', 'false'].includes(value) ? value === 'true' : value;
                        } else if (field.key === 'order') draft.injection = { ...draft.injection, order: value };
                        else if (field.postProcess) draft.postProcess = { ...draft.postProcess, [field.key]: normalizePromptTransformContextMessages(value) };
                        else if (field.setting) draft.settings = { ...draft.settings, [field.key]: String(value).trim() || DEFAULT_LENGTH_TARGET };
                        else draft[field.key] = value;
                    }
                }
                if (!bulk && view === 'connections' && companions.length) {
                    const draft = drafts[0];
                    draft.companion = getCompanionConfig(draft);
                    for (const field of ['batchAgentIds', 'contextRecipientAgentIds', 'dependencies']) {
                        const selected = new Set(root.find(`input[data-link-field="${field}"]:checked`).toArray()
                            .flatMap(input => $(input).data('referenceValues')));
                        draft.companion[field] = [...new Set([...config[field].filter(id => selected.has(id)), ...selected])];
                    }
                }
                const changes = drafts.filter((draft, index) => JSON.stringify(draft) !== JSON.stringify(agents[index]));
                changes.forEach(draft => lockAgent?.(draft));
                await saveAgentBatch(changes, title);
                // Refresh after the dialog closes so a successful save cannot be retried.
                return true;
            } catch (error) {
                root.find('[role="alert"]').text(error.message || String(error)).prop('hidden', false);
                return false;
            } finally {
                saving = false;
                controls.forEach((control, index) => { control.disabled = disabled[index]; });
            }
        },
    }).show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        await onSaved?.(agents.map(agent => agent.id));
        toastr.success(escapeHtml(bulk ? 'Agent settings saved.' : `Settings saved for ${first.name}.`));
    }
}
