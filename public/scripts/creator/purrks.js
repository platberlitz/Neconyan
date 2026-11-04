import {
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

export function renderCreatorPurrks(workspace, main) {
    const draft = workspace.session.draft;
    const purrks = getDraftPurrks(draft);
    const expandedIds = workspace._expandedPurrkIds instanceof Set
        ? workspace._expandedPurrkIds
        : (workspace._expandedPurrkIds = new Set());

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
    titleGroup.append(title, countBadge);

    const toolbar = element('div', 'neconyan-purrks-toolbar');
    const addBtn = button('+ Add Purrk', () => {
        workspace.edit(next => {
            next.card.data.extensions ??= {};
            const current = getDraftPurrks(next);
            const usedIds = new Set(current.items.map(item => item.id));
            const newId = ensureUniquePurrkId(`purrk-${current.items.length + 1}`, usedIds);
            const item = normalizePurrkItem({
                id: newId,
                label: 'New Purrk',
                enabled: true,
                mode: 'manual',
                placement: 'depth',
                depth: 4,
                role: 'system',
                prompt: '',
                source: 'user',
            }, current.items.length);
            current.items.push(item);
            next.card.data.extensions[PURRKS_EXTENSION_KEY] = current;
            expandedIds.add(item.id);
        });
    });

    const extractBtn = button('Extract from card', () => {
        const orbItems = convertOrbFragmentsToPurrks(draft.card?.data?.extensions?.orb?.fragments);
        const heuristicItems = extractHeuristicPurrksFromCard(draft.card);
        const candidateItems = [...orbItems, ...heuristicItems];
        if (!candidateItems.length) {
            workspace.status('No structured sections, conditional triggers, or Orb fragments were found to extract.', true);
            return;
        }
        let added = 0;
        workspace.edit(next => {
            next.card.data.extensions ??= {};
            const current = getDraftPurrks(next);
            const usedIds = new Set(current.items.map(item => item.id));
            const existingPrompts = new Set(current.items.map(item => item.prompt.trim().toLowerCase()));
            for (const candidate of candidateItems) {
                const key = String(candidate.prompt || '').trim().toLowerCase();
                if (!key || existingPrompts.has(key)) continue;
                const id = ensureUniquePurrkId(candidate.id || candidate.label, usedIds);
                current.items.push({ ...candidate, id });
                existingPrompts.add(key);
                added += 1;
            }
            next.card.data.extensions[PURRKS_EXTENSION_KEY] = normalizeCharacterPurrks(current);
        });
        workspace.status(added ? `Extracted ${added} Purrk${added === 1 ? '' : 's'} from the card.` : 'All extracted Purrks are already on this card.');
    });

    const aiGenerateBtn = button('Generate Purrks with AI', async () => {
        try {
            aiGenerateBtn.disabled = true;
            const current = getDraftPurrks(workspace.session.draft);
            const messages = buildAiPurrksGenerationMessages(workspace.session.draft.card, {
                existingItems: current.items,
            });
            const rawReply = await requestCreatorReply(workspace, workspace.session.draft, messages);
            const generated = parseAiGeneratedPurrksResponse(rawReply);
            let added = 0;
            workspace.edit(next => {
                next.card.data.extensions ??= {};
                const nextPurrks = getDraftPurrks(next);
                const usedIds = new Set(nextPurrks.items.map(item => item.id));
                for (const item of generated) {
                    const id = ensureUniquePurrkId(item.id || item.label, usedIds);
                    nextPurrks.items.push({ ...item, id, source: 'ai' });
                    added += 1;
                }
                next.card.data.extensions[PURRKS_EXTENSION_KEY] = normalizeCharacterPurrks(nextPurrks);
            });
            workspace.status(`Added ${added} AI-generated Purrk${added === 1 ? '' : 's'} to the draft.`);
        } catch (error) {
            workspace.status(error?.message || String(error), true);
        } finally {
            aiGenerateBtn.disabled = false;
        }
    }, true);

    toolbar.append(aiGenerateBtn, extractBtn, addBtn);
    header.append(titleGroup, toolbar);

    const subtitle = element(
        'p',
        'neconyan-purrks-subtitle',
        'Switchable character-specific prompt traits, moods, keyword triggers, and Scene AI directives stored with this card.',
    );

    const list = element('div', 'neconyan-purrks-list');
    if (!purrks.items.length) {
        list.append(
            element(
                'div',
                'neconyan-purrks-empty',
                'No Purrks yet. Use "Generate Purrks with AI", "Extract from card", or "+ Add Purrk" to add switchable traits and scene directives.',
            ),
        );
    } else {
        for (const [index, item] of purrks.items.entries()) {
            const isExpanded = expandedIds.has(item.id);
            const card = element('div', 'neconyan-purrk-card');
            card.dataset.purrkId = item.id;
            card.dataset.enabled = String(Boolean(item.enabled));

            const row = element('div', 'neconyan-purrk-row');
            const mainCol = element('div', 'neconyan-purrk-main');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'neconyan-purrk-toggle';
            toggle.checked = Boolean(item.enabled);
            toggle.setAttribute('aria-label', `Enable ${item.label}`);
            toggle.addEventListener('change', () => {
                workspace.edit(next => {
                    next.card.data.extensions ??= {};
                    const current = getDraftPurrks(next);
                    if (current.items[index]) {
                        current.items[index].enabled = toggle.checked;
                    }
                    next.card.data.extensions[PURRKS_EXTENSION_KEY] = current;
                });
            });

            const labelBtn = element('button', 'neconyan-purrk-label-btn', item.label || item.id);
            labelBtn.type = 'button';
            labelBtn.addEventListener('click', () => {
                if (expandedIds.has(item.id)) expandedIds.delete(item.id);
                else expandedIds.add(item.id);
                workspace.render();
            });

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
            if (item.source === 'orb') {
                badges.append(element('span', 'neconyan-purrk-badge', 'Orb'));
            }
            const editBtn = button(isExpanded ? 'Done' : 'Edit', () => {
                if (expandedIds.has(item.id)) expandedIds.delete(item.id);
                else expandedIds.add(item.id);
                workspace.render();
            });
            badges.append(editBtn);

            row.append(mainCol, badges);
            card.append(row);

            if (!isExpanded && item.prompt) {
                card.append(element('div', 'neconyan-purrk-preview', item.prompt));
            }

            if (isExpanded) {
                const details = element('div', 'neconyan-purrk-details');
                const grid = element('div', 'neconyan-purrk-grid');

                const updateField = (mutator) => {
                    workspace.edit(next => {
                        next.card.data.extensions ??= {};
                        const current = getDraftPurrks(next);
                        if (!current.items[index]) return;
                        mutator(current.items[index]);
                        current.items[index] = normalizePurrkItem(current.items[index], index);
                        next.card.data.extensions[PURRKS_EXTENSION_KEY] = current;
                    });
                };

                // Label
                const labelField = element('label', 'neconyan-purrk-field');
                labelField.append(element('span', '', 'Label'));
                const labelInput = element('input', 'text_pole');
                labelInput.type = 'text';
                labelInput.value = item.label;
                labelInput.addEventListener('change', () => updateField(target => { target.label = labelInput.value; }));
                labelField.append(labelInput);

                // Mode
                const modeField = element('label', 'neconyan-purrk-field');
                modeField.append(element('span', '', 'Activation mode'));
                const modeSelect = element('select', 'text_pole');
                for (const mode of PURRK_MODES) {
                    const opt = element('option', '', MODE_LABELS[mode] || mode);
                    opt.value = mode;
                    opt.selected = item.mode === mode;
                    modeSelect.append(opt);
                }
                modeSelect.addEventListener('change', () => updateField(target => { target.mode = modeSelect.value; }));
                modeField.append(modeSelect);

                // Placement
                const placeField = element('label', 'neconyan-purrk-field');
                placeField.append(element('span', '', 'Placement'));
                const placeSelect = element('select', 'text_pole');
                for (const placement of PURRK_PLACEMENTS) {
                    const opt = element('option', '', PLACEMENT_LABELS[placement] || placement);
                    opt.value = placement;
                    opt.selected = item.placement === placement;
                    placeSelect.append(opt);
                }
                placeSelect.addEventListener('change', () => updateField(target => { target.placement = placeSelect.value; }));
                placeField.append(placeSelect);

                grid.append(labelField, modeField, placeField);

                if (item.placement === 'depth') {
                    const depthField = element('label', 'neconyan-purrk-field');
                    depthField.append(element('span', '', '@ Depth'));
                    const depthInput = element('input', 'text_pole');
                    depthInput.type = 'number';
                    depthInput.min = '0';
                    depthInput.max = '9999';
                    depthInput.value = String(item.depth ?? 4);
                    depthInput.addEventListener('change', () => updateField(target => { target.depth = Number(depthInput.value); }));
                    depthField.append(depthInput);

                    const roleField = element('label', 'neconyan-purrk-field');
                    roleField.append(element('span', '', 'Role'));
                    const roleSelect = element('select', 'text_pole');
                    for (const role of PURRK_ROLES) {
                        const opt = element('option', '', role.charAt(0).toUpperCase() + role.slice(1));
                        opt.value = role;
                        opt.selected = item.role === role;
                        roleSelect.append(opt);
                    }
                    roleSelect.addEventListener('change', () => updateField(target => { target.role = roleSelect.value; }));
                    roleField.append(roleSelect);
                    grid.append(depthField, roleField);
                }

                // Cooldown
                const cooldownField = element('label', 'neconyan-purrk-field');
                cooldownField.append(element('span', '', 'Cooldown turns'));
                const cooldownInput = element('input', 'text_pole');
                cooldownInput.type = 'number';
                cooldownInput.min = '0';
                cooldownInput.max = '50';
                cooldownInput.value = String(item.cooldownTurns ?? 0);
                cooldownInput.addEventListener('change', () => updateField(target => { target.cooldownTurns = Number(cooldownInput.value); }));
                cooldownField.append(cooldownInput);
                grid.append(cooldownField);

                details.append(grid);

                if (item.mode === 'keyword') {
                    const kwField = element('label', 'neconyan-purrk-field');
                    kwField.append(element('span', '', 'Keywords (comma-separated)'));
                    const kwInput = element('input', 'text_pole');
                    kwInput.type = 'text';
                    kwInput.placeholder = 'flustered, blush, compliment';
                    kwInput.value = (item.keywords || []).join(', ');
                    kwInput.addEventListener('change', () => updateField(target => { target.keywords = kwInput.value; }));
                    details.append(kwField);
                }

                if (item.mode === 'scene') {
                    const condField = element('label', 'neconyan-purrk-field');
                    condField.append(element('span', '', 'Scene trigger condition (when Scene AI activates this)'));
                    const condInput = element('input', 'text_pole');
                    condInput.type = 'text';
                    condInput.placeholder = 'Activate when the conversation becomes tense or defensive';
                    condInput.value = item.condition || '';
                    condInput.addEventListener('change', () => updateField(target => { target.condition = condInput.value; }));
                    details.append(condField);
                }

                const promptField = element('label', 'neconyan-purrk-field');
                promptField.append(element('span', '', 'Prompt directive'));
                const promptArea = element('textarea', 'text_pole');
                promptArea.rows = 3;
                promptArea.placeholder = 'Instructions injected while this Purrk is active...';
                promptArea.value = item.prompt || '';
                promptArea.addEventListener('change', () => updateField(target => { target.prompt = promptArea.value; }));
                promptField.append(promptArea);
                details.append(promptField);

                const negField = element('label', 'neconyan-purrk-field');
                negField.append(element('span', '', 'Aftermath / negative prompt (optional, injected for 1 turn after deactivating)'));
                const negArea = element('textarea', 'text_pole');
                negArea.rows = 2;
                negArea.placeholder = 'Optional transition note on the turn immediately after this Purrk turns off...';
                negArea.value = item.negativePrompt || '';
                negArea.addEventListener('change', () => updateField(target => { target.negativePrompt = negArea.value; }));
                negField.append(negArea);
                details.append(negField);

                const actionsRow = element('div', 'neconyan-purrk-actions-row');
                const deleteBtn = button('Delete Purrk', () => {
                    expandedIds.delete(item.id);
                    workspace.edit(next => {
                        next.card.data.extensions ??= {};
                        const current = getDraftPurrks(next);
                        current.items.splice(index, 1);
                        next.card.data.extensions[PURRKS_EXTENSION_KEY] = current;
                    });
                });
                actionsRow.append(element('span', 'neconyan-purrks-subtitle', `ID: ${item.id}`), deleteBtn);
                details.append(actionsRow);

                card.append(details);
            }

            list.append(card);
        }
    }

    section.append(header, subtitle, list);
    main.append(section);
}
