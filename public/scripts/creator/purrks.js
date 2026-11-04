import {
    MAX_PURRKS_PER_CARD,
    PURRKS_EXTENSION_KEY,
    PURRK_MODES,
    PURRK_PLACEMENTS,
    PURRK_ROLES,
    normalizeCharacterPurrks,
    normalizePurrkItem,
    ensureUniquePurrkId,
    extractHeuristicPurrksFromCard,
    convertOrbFragmentsToPurrks,
    buildAiPurrksGenerationMessages,
    parseAiGeneratedPurrksResponse,
} from '../purrks/model.js';
import { requestCreatorReply } from './assistant.js';
import { button, element } from './fields.js';

const MODE_LABELS = Object.freeze({
    always: 'Always active',
    manual: 'Manual switch',
    keyword: 'Keyword trigger',
    scene: 'Scene AI director',
});

const PLACEMENT_LABELS = Object.freeze({
    depth: '@ Depth in chat',
    system: 'System prompt',
    post_history: 'After chat history',
    description: 'Character description',
});

function getDraftPurrks(draft) {
    const ext = draft?.card?.data?.extensions ?? {};
    return normalizeCharacterPurrks(ext[PURRKS_EXTENSION_KEY] ?? {});
}

function writeDraftPurrks(next, purrks) {
    next.card.data.extensions ??= {};
    next.card.data.extensions[PURRKS_EXTENSION_KEY] = normalizeCharacterPurrks(purrks);
}

/**
 * Appends candidate Purrks to a draft config, skipping prompts already on the card and stopping at the card limit.
 * @returns {number} How many items were added.
 */
function appendPurrks(current, candidates, { source = '', dedupePrompts = false } = {}) {
    const usedIds = new Set(current.items.map(item => item.id));
    const existingPrompts = new Set(current.items.map(item => String(item.prompt || '').trim().toLowerCase()));
    let added = 0;
    for (const candidate of candidates) {
        if (current.items.length >= MAX_PURRKS_PER_CARD) break;
        const key = String(candidate.prompt || '').trim().toLowerCase();
        if (dedupePrompts && (!key || existingPrompts.has(key))) continue;
        const id = ensureUniquePurrkId(candidate.id || candidate.label, usedIds);
        current.items.push({ ...candidate, id, ...(source ? { source } : {}) });
        if (key) existingPrompts.add(key);
        added += 1;
    }
    return added;
}

function field(labelText, control) {
    const wrapper = element('label', 'neconyan-purrk-field');
    wrapper.append(element('span', '', labelText), control);
    return wrapper;
}

function selectControl(options, value) {
    const select = element('select', 'text_pole');
    for (const [optionValue, optionLabel] of options) {
        const option = element('option', '', optionLabel);
        option.value = optionValue;
        option.selected = optionValue === value;
        select.append(option);
    }
    return select;
}

export function renderCreatorPurrks(workspace, main) {
    const purrks = getDraftPurrks(workspace.session.draft);
    const expandedIds = workspace._expandedPurrkIds instanceof Set
        ? workspace._expandedPurrkIds
        : (workspace._expandedPurrkIds = new Set());
    const atLimit = purrks.items.length >= MAX_PURRKS_PER_CARD;

    const section = element('section', 'creator-purrks-section');
    section.setAttribute('aria-label', 'Purrks');
    section.dataset.testid = 'creator-purrks-section';

    const header = element('div', 'neconyan-purrks-header');
    const titleGroup = element('div', 'neconyan-purrks-title-group');
    const title = element('div', 'neconyan-purrks-title');
    const icon = element('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    title.append(icon, document.createTextNode(' Purrks'));
    const countBadge = element('span', 'neconyan-purrks-count-badge', String(purrks.items.length));
    countBadge.setAttribute('aria-label', `${purrks.items.length} Purrks`);
    titleGroup.append(title, countBadge);

    const toolbar = element('div', 'neconyan-purrks-toolbar');
    const addBtn = button('+ Add Purrk', () => {
        let newId = '';
        workspace.edit(next => {
            const current = getDraftPurrks(next);
            if (current.items.length >= MAX_PURRKS_PER_CARD) return;
            const usedIds = new Set(current.items.map(item => item.id));
            newId = ensureUniquePurrkId(`purrk-${current.items.length + 1}`, usedIds);
            current.items.push(normalizePurrkItem({
                id: newId,
                label: 'New Purrk',
                enabled: true,
                mode: 'manual',
                placement: 'depth',
                depth: 4,
                role: 'system',
                prompt: '',
                source: 'user',
            }, new Set(), current.items.length));
            writeDraftPurrks(next, current);
        }, false);
        if (newId) expandedIds.add(newId);
        workspace.render();
    });
    addBtn.disabled = atLimit;

    const extractBtn = button('Extract from card', () => {
        const draft = workspace.session.draft;
        const orbItems = convertOrbFragmentsToPurrks(draft.card?.data?.extensions?.orb?.fragments);
        const heuristicItems = extractHeuristicPurrksFromCard(draft.card);
        const candidateItems = [...orbItems, ...heuristicItems];
        if (!candidateItems.length) {
            workspace.status('No structured sections, conditional triggers or Orb fragments were found to extract.', true);
            return;
        }
        let added = 0;
        const changed = workspace.edit(next => {
            const current = getDraftPurrks(next);
            added = appendPurrks(current, candidateItems, { dedupePrompts: true });
            writeDraftPurrks(next, current);
        }, true);
        if (!changed) return;
        workspace.status(added
            ? `Extracted ${added} Purrk${added === 1 ? '' : 's'} from the card. Extracted Purrks start switched off; turn on the ones you want.`
            : 'Nothing new to extract: those Purrks are already on this card, or it has reached the limit.');
    });
    extractBtn.disabled = atLimit;

    const aiGenerateBtn = button('Generate Purrks with AI', () => workspace.run(async () => {
        const draft = workspace.session.draft;
        const messages = buildAiPurrksGenerationMessages(draft.card);
        const rawReply = await requestCreatorReply(workspace, draft, messages);
        if (workspace.session.draft.id !== draft.id) throw new Error('The open draft changed. No Purrks were applied.');
        const generated = parseAiGeneratedPurrksResponse(rawReply);
        if (!generated.length) throw new Error('The reply had no usable Purrks. Nothing was applied.');
        let added = 0;
        const changed = workspace.edit(next => {
            const current = getDraftPurrks(next);
            added = appendPurrks(current, generated, { source: 'ai' });
            writeDraftPurrks(next, current);
        }, true);
        if (!changed) return;
        workspace.status(added
            ? `Added ${added} AI-generated Purrk${added === 1 ? '' : 's'} to the draft. Undo removes them.`
            : `This card already has ${MAX_PURRKS_PER_CARD} Purrks, so nothing was added.`);
    }).finally(() => workspace.render()), true);
    aiGenerateBtn.disabled = atLimit || Boolean(workspace.busy);

    toolbar.append(aiGenerateBtn, extractBtn, addBtn);
    header.append(titleGroup, toolbar);

    const subtitle = element(
        'p',
        'neconyan-purrks-subtitle',
        'Switchable character prompts: traits, moods, keyword triggers and Scene AI directives saved with this card.',
    );

    const list = element('div', 'neconyan-purrks-list');
    if (!purrks.items.length) {
        list.append(element(
            'div',
            'neconyan-purrks-empty',
            'No Purrks yet. Use \'Generate Purrks with AI\', \'Extract from card\' or \'+ Add Purrk\' to add switchable traits and scene directives.',
        ));
    } else {
        for (const [index, item] of purrks.items.entries()) {
            list.append(renderCreatorPurrkCard(workspace, item, index, expandedIds));
        }
    }

    section.append(header, subtitle, list);
    main.append(section);
}

function renderCreatorPurrkCard(workspace, item, index, expandedIds) {
    const itemId = item.id;
    const isExpanded = expandedIds.has(itemId);

    const updateItem = (mutator, redraw = false) => workspace.edit(next => {
        const current = getDraftPurrks(next);
        const position = current.items.findIndex(entry => entry.id === itemId);
        if (position < 0) return;
        const target = { ...current.items[position] };
        mutator(target);
        const normalized = normalizePurrkItem(target, new Set(), position);
        if (normalized) current.items[position] = { ...normalized, id: itemId };
        writeDraftPurrks(next, current);
    }, redraw);

    const toggleExpanded = () => {
        if (expandedIds.has(itemId)) expandedIds.delete(itemId);
        else expandedIds.add(itemId);
        workspace.render();
    };

    const card = element('div', 'neconyan-purrk-card');
    card.dataset.purrkId = itemId;
    card.dataset.enabled = String(Boolean(item.enabled));

    const row = element('div', 'neconyan-purrk-row');
    const mainCol = element('div', 'neconyan-purrk-main');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'neconyan-purrk-toggle';
    toggle.checked = Boolean(item.enabled);
    toggle.setAttribute('aria-label', `Enable ${item.label || itemId}`);
    toggle.addEventListener('change', () => {
        updateItem(target => { target.enabled = toggle.checked; });
        card.dataset.enabled = String(toggle.checked);
    });

    const labelBtn = element('button', 'neconyan-purrk-label-btn', item.label || itemId);
    labelBtn.type = 'button';
    labelBtn.setAttribute('aria-expanded', String(isExpanded));
    labelBtn.addEventListener('click', toggleExpanded);
    mainCol.append(toggle, labelBtn);

    const badges = element('div', 'neconyan-purrk-badges');
    const modeBadge = element('span', 'neconyan-purrk-badge', MODE_LABELS[item.mode] || item.mode);
    modeBadge.dataset.tone = 'accent';
    const placeBadge = element(
        'span',
        'neconyan-purrk-badge',
        item.placement === 'depth' ? `@ Depth ${item.depth} (${item.role})` : (PLACEMENT_LABELS[item.placement] || item.placement),
    );
    badges.append(modeBadge, placeBadge);
    if (item.source === 'orb') badges.append(element('span', 'neconyan-purrk-badge', 'Orb'));
    const editBtn = button(isExpanded ? 'Done' : 'Edit', toggleExpanded);
    editBtn.setAttribute('aria-expanded', String(isExpanded));
    badges.append(editBtn);

    row.append(mainCol, badges);
    card.append(row);

    if (!isExpanded) {
        if (item.prompt) card.append(element('div', 'neconyan-purrk-preview', item.prompt));
        return card;
    }

    const details = element('div', 'neconyan-purrk-details');
    const grid = element('div', 'neconyan-purrk-grid');

    const labelInput = element('input', 'text_pole');
    labelInput.type = 'text';
    labelInput.value = item.label;
    labelInput.addEventListener('change', () => {
        updateItem(target => { target.label = labelInput.value; });
        labelBtn.textContent = labelInput.value.trim() || itemId;
    });

    const modeSelect = selectControl(PURRK_MODES.map(mode => [mode, MODE_LABELS[mode] || mode]), item.mode);
    modeSelect.addEventListener('change', () => updateItem(target => { target.mode = modeSelect.value; }, true));

    const placeSelect = selectControl(PURRK_PLACEMENTS.map(placement => [placement, PLACEMENT_LABELS[placement] || placement]), item.placement);
    placeSelect.addEventListener('change', () => updateItem(target => { target.placement = placeSelect.value; }, true));

    grid.append(field('Label', labelInput), field('Activation mode', modeSelect), field('Placement', placeSelect));

    if (item.placement === 'depth') {
        const depthInput = element('input', 'text_pole');
        depthInput.type = 'number';
        depthInput.min = '0';
        depthInput.max = '9999';
        depthInput.value = String(item.depth ?? 4);
        depthInput.addEventListener('change', () => updateItem(target => { target.depth = Number(depthInput.value); }, true));

        const roleSelect = selectControl(PURRK_ROLES.map(role => [role, role.charAt(0).toUpperCase() + role.slice(1)]), item.role);
        roleSelect.addEventListener('change', () => updateItem(target => { target.role = roleSelect.value; }, true));
        grid.append(field('@ Depth', depthInput), field('Role', roleSelect));
    }

    const cooldownInput = element('input', 'text_pole');
    cooldownInput.type = 'number';
    cooldownInput.min = '0';
    cooldownInput.max = '50';
    cooldownInput.value = String(item.cooldownTurns ?? 0);
    cooldownInput.addEventListener('change', () => updateItem(target => { target.cooldownTurns = Number(cooldownInput.value); }));
    grid.append(field('Cooldown turns', cooldownInput));
    details.append(grid);

    if (item.mode === 'keyword') {
        const kwInput = element('input', 'text_pole');
        kwInput.type = 'text';
        kwInput.placeholder = 'flustered, blush, compliment';
        kwInput.value = (item.keywords || []).join(', ');
        kwInput.addEventListener('change', () => updateItem(target => { target.keywords = kwInput.value; }));
        details.append(field('Keywords (comma-separated)', kwInput));
    }

    if (item.mode === 'scene') {
        const condInput = element('input', 'text_pole');
        condInput.type = 'text';
        condInput.placeholder = 'Activate when the conversation becomes tense or defensive';
        condInput.value = item.condition || '';
        condInput.addEventListener('change', () => updateItem(target => { target.condition = condInput.value; }));
        details.append(field('Scene trigger condition (when Scene AI switches this on)', condInput));
    }

    const promptArea = element('textarea', 'text_pole');
    promptArea.rows = 3;
    promptArea.placeholder = 'Instructions added to the prompt while this Purrk is on...';
    promptArea.value = item.prompt || '';
    promptArea.addEventListener('change', () => updateItem(target => { target.prompt = promptArea.value; }));
    details.append(field('Prompt directive', promptArea));

    const negArea = element('textarea', 'text_pole');
    negArea.rows = 2;
    negArea.placeholder = 'Optional transition note for the turn right after this Purrk switches off...';
    negArea.value = item.negativePrompt || '';
    negArea.addEventListener('change', () => updateItem(target => { target.negativePrompt = negArea.value; }));
    details.append(field('Aftermath prompt (optional, used for one turn after it switches off)', negArea));

    const actionsRow = element('div', 'neconyan-purrk-actions-row');
    const deleteBtn = button('Delete Purrk', () => {
        const changed = workspace.edit(next => {
            const current = getDraftPurrks(next);
            current.items = current.items.filter(entry => entry.id !== itemId);
            writeDraftPurrks(next, current);
        }, false);
        if (!changed) return;
        expandedIds.delete(itemId);
        workspace.render();
        workspace.status(`Deleted '${item.label || itemId}'. Undo brings it back.`);
    });
    actionsRow.append(element('span', 'neconyan-purrks-subtitle', `ID: ${itemId}`), deleteBtn);
    details.append(actionsRow);
    card.dataset.index = String(index);
    card.append(details);
    return card;
}
