import {
    PURRKS_EXTENSION_KEY,
    PURRKS_CHAT_METADATA_KEY,
    PURRK_MODES,
    PURRK_PLACEMENTS,
    PURRK_ROLES,
    normalizeCharacterPurrks,
    normalizePurrkItem,
    ensureUniquePurrkId,
    readCharacterPurrks,
    normalizeChatPurrksState,
    convertOrbFragmentsToPurrks,
    extractHeuristicPurrksFromCard,
    evaluateCharacterPurrks,
    advanceChatPurrksTurnState,
    buildAiPurrksGenerationMessages,
    parseAiGeneratedPurrksResponse,
    buildSceneDirectorMessages,
    parseSceneDirectorResponse,
} from './model.js';
import {
    characters,
    this_chid,
    chat,
    chat_metadata,
    name1,
    name2,
    create_save,
    generateRawData,
} from '../../script.js';
import { selected_group, groups } from '../group-chats.js';
import { extension_settings, saveMetadataDebounced, writeExtensionField } from '../extensions.js';
import { eventSource, event_types } from '../events.js';
import { ConnectionManagerRequestService } from '../extensions/shared.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import { t } from '../i18n.js';

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

const expandedEditorIds = new Set();
let initialized = false;

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

async function runPurrksLlmRequest(messages, profileId = '', maxTokens = 4096) {
    const chosenProfile = String(profileId || '').trim();
    if (chosenProfile) {
        const response = await ConnectionManagerRequestService.sendRequest(
            chosenProfile,
            messages,
            maxTokens,
            {
                stream: false,
                extractData: false,
                includePreset: false,
                includeInstruct: false,
            },
        );
        return extractProfileResponseText(response);
    }
    const raw = await generateRawData({
        prompt: messages,
        responseLength: maxTokens,
        cacheScope: 'auxiliary',
        literalPrompt: true,
    });
    return typeof raw === 'string' ? raw : extractProfileResponseText(raw);
}

function isEditingExistingCharacter() {
    const actionType = document.getElementById('form_create')?.getAttribute('actiontype');
    return actionType === 'editcharacter' && this_chid !== undefined && Boolean(characters[this_chid]);
}

function getEditorCharacterOrDraft() {
    if (isEditingExistingCharacter()) {
        return characters[this_chid];
    }
    return {
        name: String(document.getElementById('character_name_pole')?.value || create_save.name || ''),
        description: String(document.getElementById('description_textarea')?.value || create_save.description || ''),
        personality: String(document.getElementById('personality_textarea')?.value || create_save.personality || ''),
        scenario: String(document.getElementById('scenario_pole')?.value || create_save.scenario || ''),
        first_mes: String(document.getElementById('firstmessage_textarea')?.value || create_save.first_message || ''),
        mes_example: String(document.getElementById('mes_example_textarea')?.value || create_save.mes_example || ''),
        data: {
            name: String(document.getElementById('character_name_pole')?.value || create_save.name || ''),
            description: String(document.getElementById('description_textarea')?.value || create_save.description || ''),
            personality: String(document.getElementById('personality_textarea')?.value || create_save.personality || ''),
            scenario: String(document.getElementById('scenario_pole')?.value || create_save.scenario || ''),
            system_prompt: String(document.getElementById('system_prompt_textarea')?.value || create_save.system_prompt || ''),
            post_history_instructions: String(document.getElementById('post_history_instructions_textarea')?.value || create_save.post_history_instructions || ''),
            creator_notes: String(document.getElementById('creator_notes_textarea')?.value || create_save.creator_notes || ''),
            extensions: {
                ...(create_save.extensions || {}),
                depth_prompt: {
                    prompt: String(document.getElementById('depth_prompt_prompt')?.value || create_save.depth_prompt_prompt || ''),
                    depth: Number(document.getElementById('depth_prompt_depth')?.value ?? create_save.depth_prompt_depth ?? 4),
                    role: String(document.getElementById('depth_prompt_role')?.value || create_save.depth_prompt_role || 'system'),
                },
            },
        },
    };
}

function readEditorPurrks() {
    if (isEditingExistingCharacter()) {
        return readCharacterPurrks(characters[this_chid]);
    }
    create_save.extensions ??= {};
    return normalizeCharacterPurrks(create_save.extensions[PURRKS_EXTENSION_KEY] ?? {});
}

async function saveEditorPurrks(nextPurrks) {
    const normalized = normalizeCharacterPurrks(nextPurrks);
    if (isEditingExistingCharacter()) {
        const chid = this_chid;
        const character = characters[chid];
        if (!character) return;
        character.data ??= {};
        character.data.extensions ??= {};
        character.data.extensions[PURRKS_EXTENSION_KEY] = normalized;
        await writeExtensionField(chid, PURRKS_EXTENSION_KEY, normalized);
    } else {
        create_save.extensions ??= {};
        create_save.extensions[PURRKS_EXTENSION_KEY] = normalized;
    }
    renderCharacterEditorPurrks();
    updateBottomChatPurrksBadge();
}

export function renderCharacterEditorPurrks() {
    const host = document.getElementById('character_purrks_block');
    if (!(host instanceof HTMLElement)) return;

    const purrks = readEditorPurrks();
    host.replaceChildren();

    const header = el('div', 'neconyan-purrks-header');
    const titleGroup = el('div', 'neconyan-purrks-title-group');
    const title = el('div', 'neconyan-purrks-title');
    const icon = el('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    title.append(icon, document.createTextNode(' Purrks'));
    const badge = el('span', 'neconyan-purrks-count-badge', String(purrks.items.length));
    titleGroup.append(title, badge);

    const toolbar = el('div', 'neconyan-purrks-toolbar');

    const aiBtn = el('button', 'menu_button menu_button_primary', 'Generate Purrks');
    aiBtn.type = 'button';
    aiBtn.id = 'character_purrks_generate_ai_btn';
    aiBtn.addEventListener('click', async () => {
        try {
            aiBtn.disabled = true;
            const current = readEditorPurrks();
            const cardSnapshot = getEditorCharacterOrDraft();
            const messages = buildAiPurrksGenerationMessages(cardSnapshot, {
                existingItems: current.items,
            });
            const rawReply = await runPurrksLlmRequest(messages, current.autoSceneProfileId);
            const generated = parseAiGeneratedPurrksResponse(rawReply);
            const usedIds = new Set(current.items.map(item => item.id));
            for (const item of generated) {
                const id = ensureUniquePurrkId(item.id || item.label, usedIds);
                current.items.push({ ...item, id, source: 'ai' });
            }
            await saveEditorPurrks(current);
            toastr.success(t`Generated ${generated.length} Purrk(s) from the character card.`);
        } catch (error) {
            console.error('Purrks AI generation failed:', error);
            toastr.error(String(error?.message || error));
        } finally {
            aiBtn.disabled = false;
        }
    });

    const extractBtn = el('button', 'menu_button', 'Extract from card');
    extractBtn.type = 'button';
    extractBtn.id = 'character_purrks_extract_btn';
    extractBtn.addEventListener('click', async () => {
        const current = readEditorPurrks();
        const cardSnapshot = getEditorCharacterOrDraft();
        const orbItems = convertOrbFragmentsToPurrks(cardSnapshot?.data?.extensions?.orb?.fragments);
        const heuristicItems = extractHeuristicPurrksFromCard(cardSnapshot);
        const candidates = [...orbItems, ...heuristicItems];
        if (!candidates.length) {
            toastr.info(t`No structured sections, conditional triggers, or Orb fragments were found on this card.`);
            return;
        }
        const usedIds = new Set(current.items.map(item => item.id));
        const existingPrompts = new Set(current.items.map(item => item.prompt.trim().toLowerCase()));
        let added = 0;
        for (const candidate of candidates) {
            const key = String(candidate.prompt || '').trim().toLowerCase();
            if (!key || existingPrompts.has(key)) continue;
            const id = ensureUniquePurrkId(candidate.id || candidate.label, usedIds);
            current.items.push({ ...candidate, id });
            existingPrompts.add(key);
            added += 1;
        }
        await saveEditorPurrks(current);
        if (added > 0) {
            toastr.success(t`Extracted ${added} Purrk(s) from the character card.`);
        } else {
            toastr.info(t`All extracted Purrks are already listed on this card.`);
        }
    });

    const addBtn = el('button', 'menu_button', '+ Add Purrk');
    addBtn.type = 'button';
    addBtn.id = 'character_purrks_add_btn';
    addBtn.addEventListener('click', async () => {
        const current = readEditorPurrks();
        const usedIds = new Set(current.items.map(item => item.id));
        const id = ensureUniquePurrkId(`purrk-${current.items.length + 1}`, usedIds);
        const newItem = normalizePurrkItem({
            id,
            label: 'New Purrk',
            enabled: true,
            mode: 'manual',
            placement: 'depth',
            depth: 4,
            role: 'system',
            prompt: '',
            source: 'user',
        }, current.items.length);
        current.items.push(newItem);
        expandedEditorIds.add(newItem.id);
        await saveEditorPurrks(current);
    });

    toolbar.append(aiBtn, extractBtn, addBtn);
    header.append(titleGroup, toolbar);

    const subtitle = el(
        'p',
        'neconyan-purrks-subtitle',
        'Switchable character-specific prompt traits, moods, keyword triggers, and Scene AI directives that travel with this card.',
    );

    const directorBar = el('div', 'neconyan-purrks-director-bar');
    const directorLabel = el('label', '');
    const enabledCheck = document.createElement('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.checked = purrks.enabled !== false;
    enabledCheck.addEventListener('change', () => {
        const current = readEditorPurrks();
        current.enabled = enabledCheck.checked;
        void saveEditorPurrks(current);
    });
    directorLabel.append(enabledCheck, document.createTextNode(' Enable Purrks for this character'));

    const profileSelect = el('select', 'text_pole textarea_compact');
    profileSelect.setAttribute('aria-label', 'Scene AI connection profile');
    const defaultOpt = el('option', '', 'Current connection (for Scene AI & Generate)');
    defaultOpt.value = '';
    profileSelect.append(defaultOpt);
    for (const profile of getConnectionProfiles()) {
        if (!profile?.id) continue;
        const opt = el('option', '', profile.name || profile.id);
        opt.value = profile.id;
        opt.selected = purrks.autoSceneProfileId === profile.id;
        profileSelect.append(opt);
    }
    profileSelect.addEventListener('change', () => {
        const current = readEditorPurrks();
        current.autoSceneProfileId = profileSelect.value;
        void saveEditorPurrks(current);
    });
    directorBar.append(directorLabel, profileSelect);

    const list = el('div', 'neconyan-purrks-list');
    if (!purrks.items.length) {
        list.append(
            el(
                'div',
                'neconyan-purrks-empty',
                'No Purrks on this card yet. Use "Generate Purrks", "Extract from card", or "+ Add Purrk" to create switchable prompt blocks.',
            ),
        );
    } else {
        for (const [index, item] of purrks.items.entries()) {
            const isExpanded = expandedEditorIds.has(item.id);
            const card = el('div', 'neconyan-purrk-card');
            card.dataset.purrkId = item.id;
            card.dataset.enabled = String(Boolean(item.enabled));

            const row = el('div', 'neconyan-purrk-row');
            const mainCol = el('div', 'neconyan-purrk-main');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'neconyan-purrk-toggle';
            toggle.checked = Boolean(item.enabled);
            toggle.setAttribute('aria-label', `Enable ${item.label}`);
            toggle.addEventListener('change', () => {
                const current = readEditorPurrks();
                if (current.items[index]) {
                    current.items[index].enabled = toggle.checked;
                    void saveEditorPurrks(current);
                }
            });

            const labelBtn = el('button', 'neconyan-purrk-label-btn', item.label || item.id);
            labelBtn.type = 'button';
            labelBtn.addEventListener('click', () => {
                if (expandedEditorIds.has(item.id)) expandedEditorIds.delete(item.id);
                else expandedEditorIds.add(item.id);
                renderCharacterEditorPurrks();
            });

            mainCol.append(toggle, labelBtn);

            const badges = el('div', 'neconyan-purrk-badges');
            const modeBadge = el('span', 'neconyan-purrk-badge', MODE_LABELS[item.mode] || item.mode);
            modeBadge.dataset.tone = 'accent';
            const placeBadge = el(
                'span',
                'neconyan-purrk-badge',
                item.placement === 'depth' ? `@ Depth ${item.depth} (${item.role})` : (PLACEMENT_LABELS[item.placement] || item.placement),
            );
            badges.append(modeBadge, placeBadge);
            if (item.source === 'orb') {
                badges.append(el('span', 'neconyan-purrk-badge', 'Orb'));
            }
            const editBtn = el('button', 'menu_button', isExpanded ? 'Done' : 'Edit');
            editBtn.type = 'button';
            editBtn.addEventListener('click', () => {
                if (expandedEditorIds.has(item.id)) expandedEditorIds.delete(item.id);
                else expandedEditorIds.add(item.id);
                renderCharacterEditorPurrks();
            });
            badges.append(editBtn);

            row.append(mainCol, badges);
            card.append(row);

            if (!isExpanded && item.prompt) {
                card.append(el('div', 'neconyan-purrk-preview', item.prompt));
            }

            if (isExpanded) {
                const details = el('div', 'neconyan-purrk-details');
                const grid = el('div', 'neconyan-purrk-grid');

                const updateField = (mutator) => {
                    const current = readEditorPurrks();
                    if (!current.items[index]) return;
                    mutator(current.items[index]);
                    current.items[index] = normalizePurrkItem(current.items[index], index);
                    void saveEditorPurrks(current);
                };

                const labelField = el('label', 'neconyan-purrk-field');
                labelField.append(el('span', '', 'Label'));
                const labelInput = el('input', 'text_pole');
                labelInput.type = 'text';
                labelInput.value = item.label;
                labelInput.addEventListener('change', () => updateField(target => { target.label = labelInput.value; }));
                labelField.append(labelInput);

                const modeField = el('label', 'neconyan-purrk-field');
                modeField.append(el('span', '', 'Activation mode'));
                const modeSelect = el('select', 'text_pole');
                for (const mode of PURRK_MODES) {
                    const opt = el('option', '', MODE_LABELS[mode] || mode);
                    opt.value = mode;
                    opt.selected = item.mode === mode;
                    modeSelect.append(opt);
                }
                modeSelect.addEventListener('change', () => updateField(target => { target.mode = modeSelect.value; }));
                modeField.append(modeSelect);

                const placeField = el('label', 'neconyan-purrk-field');
                placeField.append(el('span', '', 'Placement'));
                const placeSelect = el('select', 'text_pole');
                for (const placement of PURRK_PLACEMENTS) {
                    const opt = el('option', '', PLACEMENT_LABELS[placement] || placement);
                    opt.value = placement;
                    opt.selected = item.placement === placement;
                    placeSelect.append(opt);
                }
                placeSelect.addEventListener('change', () => updateField(target => { target.placement = placeSelect.value; }));
                placeField.append(placeSelect);

                grid.append(labelField, modeField, placeField);

                if (item.placement === 'depth') {
                    const depthField = el('label', 'neconyan-purrk-field');
                    depthField.append(el('span', '', '@ Depth'));
                    const depthInput = el('input', 'text_pole');
                    depthInput.type = 'number';
                    depthInput.min = '0';
                    depthInput.max = '9999';
                    depthInput.value = String(item.depth ?? 4);
                    depthInput.addEventListener('change', () => updateField(target => { target.depth = Number(depthInput.value); }));
                    depthField.append(depthInput);

                    const roleField = el('label', 'neconyan-purrk-field');
                    roleField.append(el('span', '', 'Role'));
                    const roleSelect = el('select', 'text_pole');
                    for (const role of PURRK_ROLES) {
                        const opt = el('option', '', role.charAt(0).toUpperCase() + role.slice(1));
                        opt.value = role;
                        opt.selected = item.role === role;
                        roleSelect.append(opt);
                    }
                    roleSelect.addEventListener('change', () => updateField(target => { target.role = roleSelect.value; }));
                    roleField.append(roleSelect);

                    grid.append(depthField, roleField);
                }

                const cooldownField = el('label', 'neconyan-purrk-field');
                cooldownField.append(el('span', '', 'Cooldown turns'));
                const cooldownInput = el('input', 'text_pole');
                cooldownInput.type = 'number';
                cooldownInput.min = '0';
                cooldownInput.max = '50';
                cooldownInput.value = String(item.cooldownTurns ?? 0);
                cooldownInput.addEventListener('change', () => updateField(target => { target.cooldownTurns = Number(cooldownInput.value); }));
                cooldownField.append(cooldownInput);
                grid.append(cooldownField);

                details.append(grid);

                if (item.mode === 'keyword') {
                    const kwField = el('label', 'neconyan-purrk-field');
                    kwField.append(el('span', '', 'Keywords (comma-separated)'));
                    const kwInput = el('input', 'text_pole');
                    kwInput.type = 'text';
                    kwInput.placeholder = 'flustered, blush, compliment';
                    kwInput.value = (item.keywords || []).join(', ');
                    kwInput.addEventListener('change', () => updateField(target => { target.keywords = kwInput.value; }));
                    details.append(kwField);
                }

                if (item.mode === 'scene') {
                    const condField = el('label', 'neconyan-purrk-field');
                    condField.append(el('span', '', 'Scene trigger condition'));
                    const condInput = el('input', 'text_pole');
                    condInput.type = 'text';
                    condInput.placeholder = 'Activate when the conversation becomes tense or defensive';
                    condInput.value = item.condition || '';
                    condInput.addEventListener('change', () => updateField(target => { target.condition = condInput.value; }));
                    details.append(condField);
                }

                const promptField = el('label', 'neconyan-purrk-field');
                promptField.append(el('span', '', 'Prompt directive'));
                const promptArea = el('textarea', 'text_pole');
                promptArea.rows = 3;
                promptArea.placeholder = 'Instructions injected while this Purrk is active...';
                promptArea.value = item.prompt || '';
                promptArea.addEventListener('change', () => updateField(target => { target.prompt = promptArea.value; }));
                promptField.append(promptArea);
                details.append(promptField);

                const negField = el('label', 'neconyan-purrk-field');
                negField.append(el('span', '', 'Aftermath / negative prompt (optional, 1 turn after deactivating)'));
                const negArea = el('textarea', 'text_pole');
                negArea.rows = 2;
                negArea.placeholder = 'Optional transition note on the turn immediately after this Purrk turns off...';
                negArea.value = item.negativePrompt || '';
                negArea.addEventListener('change', () => updateField(target => { target.negativePrompt = negArea.value; }));
                negField.append(negArea);
                details.append(negField);

                const actionsRow = el('div', 'neconyan-purrk-actions-row');
                const deleteBtn = el('button', 'menu_button', 'Delete Purrk');
                deleteBtn.type = 'button';
                deleteBtn.addEventListener('click', () => {
                    expandedEditorIds.delete(item.id);
                    const current = readEditorPurrks();
                    current.items.splice(index, 1);
                    void saveEditorPurrks(current);
                });
                actionsRow.append(el('span', 'neconyan-purrks-subtitle', `ID: ${item.id}`), deleteBtn);
                details.append(actionsRow);

                card.append(details);
            }

            list.append(card);
        }
    }

    host.append(header, subtitle, directorBar, list);
}

function getActiveChatCharacters() {
    if (selected_group) {
        const group = groups?.find(item => item.id === selected_group);
        if (!group || !Array.isArray(group.members)) return [];
        const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
        return group.members
            .filter(avatar => !disabled.has(avatar))
            .map(avatar => {
                const index = characters.findIndex(ch => ch?.avatar === avatar);
                return index !== -1 ? { chid: index, character: characters[index], key: avatar } : null;
            })
            .filter(Boolean);
    }
    if (this_chid !== undefined && characters[this_chid]) {
        return [{ chid: this_chid, character: characters[this_chid], key: '' }];
    }
    return [];
}

function ensureChatPurrksMetadata() {
    if (!chat_metadata || typeof chat_metadata !== 'object') return normalizeChatPurrksState({});
    const normalized = normalizeChatPurrksState(chat_metadata[PURRKS_CHAT_METADATA_KEY]);
    chat_metadata[PURRKS_CHAT_METADATA_KEY] = normalized;
    return normalized;
}

export function updateBottomChatPurrksBadge() {
    const btn = document.getElementById('sb-bottom-chat-purrks-btn');
    if (!(btn instanceof HTMLElement)) return;
    let badge = btn.querySelector('.sb-bottom-chat-purrks-badge');
    const targets = getActiveChatCharacters();
    let activeCount = 0;
    let totalCount = 0;
    for (const target of targets) {
        const evaluation = evaluateCharacterPurrks(target.character, {
            chatMetadata: chat_metadata,
            messages: chat,
            characterKey: target.key,
        });
        totalCount += evaluation.evaluatedItems.length;
        activeCount += evaluation.activeItems.length;
    }
    if (totalCount === 0) {
        badge?.remove();
        btn.title = t`Character Purrks`;
        return;
    }
    if (!badge) {
        badge = el('span', 'sb-bottom-chat-purrks-badge');
        btn.append(badge);
    }
    badge.textContent = String(activeCount);
    btn.title = t`Character Purrks (${activeCount} active of ${totalCount})`;
}

export async function runSceneDirectorForActiveChat({ notify = false } = {}) {
    const targets = getActiveChatCharacters();
    if (!targets.length) return false;
    const state = ensureChatPurrksMetadata();
    let updatedAny = false;

    for (const target of targets) {
        const purrks = readCharacterPurrks(target.character);
        if (!purrks.enabled) continue;
        const prefix = target.key ? `${target.key}:` : '';
        const candidateItems = purrks.items.filter(item => {
            if (item.mode !== 'scene') return false;
            const scopedId = `${prefix}${item.id}`;
            if (Object.hasOwn(state.overrides, scopedId)) return false;
            if ((state.cooldowns[scopedId] ?? 0) > 0) return false;
            return true;
        });
        if (!candidateItems.length) continue;

        const directorMessages = buildSceneDirectorMessages(target.character, candidateItems, chat, {
            userName: name1 || 'User',
            charName: target.character.name || name2 || 'Character',
        });
        if (!directorMessages) continue;

        try {
            const rawReply = await runPurrksLlmRequest(directorMessages, purrks.autoSceneProfileId, 1024);
            const activeIds = parseSceneDirectorResponse(rawReply, candidateItems.map(item => item.id));
            const candidateSet = new Set(candidateItems.map(item => `${prefix}${item.id}`));
            state.activeSceneIds = [
                ...state.activeSceneIds.filter(id => !candidateSet.has(id)),
                ...activeIds.map(id => `${prefix}${id}`),
            ];
            updatedAny = true;
        } catch (error) {
            console.warn('Scene Director pass skipped:', error);
            if (notify) {
                toastr.error(String(error?.message || error));
            }
        }
    }

    if (updatedAny) {
        chat_metadata[PURRKS_CHAT_METADATA_KEY] = state;
        saveMetadataDebounced();
        updateBottomChatPurrksBadge();
        renderChatPurrksPopover();
        if (notify) {
            toastr.success(t`Scene AI updated active Purrks for this scene.`);
        }
    } else if (notify) {
        toastr.info(t`No Scene AI Purrks needed updating right now.`);
    }
    return updatedAny;
}

function advanceActiveChatPurrksTurn() {
    const targets = getActiveChatCharacters();
    if (!targets.length || !chat_metadata) return;
    let state = ensureChatPurrksMetadata();
    for (const target of targets) {
        const evaluation = evaluateCharacterPurrks(target.character, {
            chatMetadata: chat_metadata,
            messages: chat,
            characterKey: target.key,
        });
        const prefix = target.key ? `${target.key}:` : '';
        const scopedEvaluation = evaluation.evaluatedItems.map(entry => ({
            item: { ...entry.item, id: `${prefix}${entry.item.id}` },
            active: entry.active,
        }));
        state = advanceChatPurrksTurnState(state, scopedEvaluation);
    }
    chat_metadata[PURRKS_CHAT_METADATA_KEY] = state;
    saveMetadataDebounced();
    updateBottomChatPurrksBadge();
}

function getOrCreatePopover() {
    let popover = document.getElementById('neconyan-purrks-popover');
    if (popover instanceof HTMLElement) return popover;
    popover = el('div', '');
    popover.id = 'neconyan-purrks-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Character Purrks');
    popover.hidden = true;
    document.body.append(popover);
    return popover;
}

function positionPopover(anchor) {
    const popover = getOrCreatePopover();
    if (window.matchMedia('(max-width: 768px)').matches) {
        popover.style.left = '';
        popover.style.top = '';
        popover.style.bottom = '';
        return;
    }
    const rect = anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : { left: window.innerWidth / 2 - 200, top: window.innerHeight - 80, bottom: window.innerHeight - 40 };
    const width = Math.min(420, window.innerWidth - 20);
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.bottom = `${Math.round(bottom)}px`;
    popover.style.top = 'auto';
}

export function closeChatPurrksPopover() {
    const popover = document.getElementById('neconyan-purrks-popover');
    if (popover instanceof HTMLElement) {
        popover.hidden = true;
    }
    document.getElementById('sb-bottom-chat-purrks-btn')?.setAttribute('aria-expanded', 'false');
}

export function toggleChatPurrksPopover(anchor) {
    const popover = getOrCreatePopover();
    if (!popover.hidden) {
        closeChatPurrksPopover();
        return;
    }
    renderChatPurrksPopover();
    popover.hidden = false;
    positionPopover(anchor || document.getElementById('sb-bottom-chat-purrks-btn'));
    document.getElementById('sb-bottom-chat-purrks-btn')?.setAttribute('aria-expanded', 'true');
}

export function renderChatPurrksPopover() {
    const popover = getOrCreatePopover();
    popover.replaceChildren();

    const header = el('div', 'neconyan-purrks-header');
    const titleGroup = el('div', 'neconyan-purrks-title-group');
    const title = el('div', 'neconyan-purrks-title');
    const icon = el('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    title.append(icon, document.createTextNode(' Character Purrks'));
    titleGroup.append(title);

    const toolbar = el('div', 'neconyan-purrks-toolbar');
    const directBtn = el('button', 'menu_button', 'Direct scene');
    directBtn.type = 'button';
    directBtn.title = 'Ask Scene AI to pick matching scene Purrks for the current chat';
    directBtn.addEventListener('click', () => {
        void runSceneDirectorForActiveChat({ notify: true });
    });

    const closeBtn = el('button', 'menu_button neconyan-purrks-popover-close', 'Close');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => closeChatPurrksPopover());

    toolbar.append(directBtn, closeBtn);
    header.append(titleGroup, toolbar);

    const body = el('div', 'neconyan-purrks-popover-body');
    const targets = getActiveChatCharacters();

    if (!targets.length) {
        body.append(el('div', 'neconyan-purrks-empty', 'Open a character or group chat to view and switch its Purrks.'));
        popover.append(header, body);
        return;
    }

    const state = ensureChatPurrksMetadata();

    for (const target of targets) {
        const evaluation = evaluateCharacterPurrks(target.character, {
            chatMetadata: chat_metadata,
            messages: chat,
            characterKey: target.key,
        });
        const prefix = target.key ? `${target.key}:` : '';

        if (targets.length > 1) {
            body.append(el('h4', 'neconyan-purrks-title', target.character.name || target.key));
        }

        if (!evaluation.evaluatedItems.length) {
            const emptyBox = el('div', 'neconyan-purrks-empty');
            emptyBox.append(
                el('div', '', `No Purrks configured for ${target.character.name || 'this character'} yet.`),
            );
            const quickGenBtn = el('button', 'menu_button menu_button_primary', 'Generate Purrks from card');
            quickGenBtn.type = 'button';
            quickGenBtn.style.marginTop = '8px';
            quickGenBtn.addEventListener('click', async () => {
                try {
                    quickGenBtn.disabled = true;
                    const purrks = readCharacterPurrks(target.character);
                    const messages = buildAiPurrksGenerationMessages(target.character, { existingItems: purrks.items });
                    const rawReply = await runPurrksLlmRequest(messages, purrks.autoSceneProfileId);
                    const generated = parseAiGeneratedPurrksResponse(rawReply);
                    const usedIds = new Set(purrks.items.map(item => item.id));
                    for (const item of generated) {
                        const id = ensureUniquePurrkId(item.id || item.label, usedIds);
                        purrks.items.push({ ...item, id, source: 'ai' });
                    }
                    target.character.data ??= {};
                    target.character.data.extensions ??= {};
                    target.character.data.extensions[PURRKS_EXTENSION_KEY] = purrks;
                    await writeExtensionField(target.chid, PURRKS_EXTENSION_KEY, purrks);
                    updateBottomChatPurrksBadge();
                    renderChatPurrksPopover();
                    if (this_chid === target.chid) renderCharacterEditorPurrks();
                    toastr.success(t`Generated ${generated.length} Purrk(s).`);
                } catch (error) {
                    toastr.error(String(error?.message || error));
                } finally {
                    quickGenBtn.disabled = false;
                }
            });
            emptyBox.append(quickGenBtn);
            body.append(emptyBox);
            continue;
        }

        for (const entry of evaluation.evaluatedItems) {
            const { item, active, reason, injectNegative } = entry;
            const scopedId = `${prefix}${item.id}`;
            const hasOverride = Object.hasOwn(state.overrides, scopedId);
            const overrideVal = hasOverride ? state.overrides[scopedId] : null;

            const card = el('div', 'neconyan-purrk-card');
            card.dataset.purrkId = item.id;
            card.dataset.enabled = String(Boolean(active));

            const row = el('div', 'neconyan-purrk-row');
            const mainCol = el('div', 'neconyan-purrk-main');
            const statusBadge = el('span', 'neconyan-purrk-badge', active ? 'Active' : (injectNegative ? 'Aftermath' : 'Off'));
            if (active) statusBadge.dataset.tone = 'active';
            const labelSpan = el('span', 'neconyan-purrk-label-btn', item.label);
            mainCol.append(statusBadge, labelSpan);

            const controls = el('div', 'neconyan-purrks-override-controls');
            const setOverride = (nextValue) => {
                const nextState = ensureChatPurrksMetadata();
                if (nextValue === null) {
                    delete nextState.overrides[scopedId];
                } else {
                    nextState.overrides[scopedId] = Boolean(nextValue);
                }
                chat_metadata[PURRKS_CHAT_METADATA_KEY] = nextState;
                saveMetadataDebounced();
                updateBottomChatPurrksBadge();
                renderChatPurrksPopover();
            };

            const autoBtn = el('button', 'menu_button', 'Auto');
            autoBtn.type = 'button';
            autoBtn.setAttribute('aria-pressed', String(overrideVal === null));
            autoBtn.title = `Follow card rule (${MODE_LABELS[item.mode] || item.mode})`;
            autoBtn.addEventListener('click', () => setOverride(null));

            const onBtn = el('button', 'menu_button', 'On');
            onBtn.type = 'button';
            onBtn.setAttribute('aria-pressed', String(overrideVal === true));
            onBtn.title = 'Force on for this chat';
            onBtn.addEventListener('click', () => setOverride(true));

            const offBtn = el('button', 'menu_button', 'Off');
            offBtn.type = 'button';
            offBtn.setAttribute('aria-pressed', String(overrideVal === false));
            offBtn.title = 'Force off for this chat';
            offBtn.addEventListener('click', () => setOverride(false));

            controls.append(autoBtn, onBtn, offBtn);
            row.append(mainCol, controls);
            card.append(row);

            const metaRow = el('div', 'neconyan-purrk-badges');
            metaRow.append(
                el('span', 'neconyan-purrk-badge', MODE_LABELS[item.mode] || item.mode),
                el('span', 'neconyan-purrk-badge', item.placement === 'depth' ? `@ Depth ${item.depth}` : (PLACEMENT_LABELS[item.placement] || item.placement)),
                el('span', 'neconyan-purrk-badge', `State: ${reason}`),
            );
            card.append(metaRow);

            if (item.prompt) {
                card.append(el('div', 'neconyan-purrk-preview', item.prompt));
            }
            body.append(card);
        }
    }

    popover.append(header, body);
}

export function initCharacterPurrks() {
    if (initialized) return;
    initialized = true;

    renderCharacterEditorPurrks();
    updateBottomChatPurrksBadge();

    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, () => {
        expandedEditorIds.clear();
        renderCharacterEditorPurrks();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeChatPurrksPopover();
        updateBottomChatPurrksBadge();
        renderCharacterEditorPurrks();
    });

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async (type, _params, dryRun) => {
        if (dryRun || type === 'quiet' || type === 'impersonate') return;
        await runSceneDirectorForActiveChat({ notify: false });
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        advanceActiveChatPurrksTurn();
    });

    document.getElementById('option_toggle_purrks')?.addEventListener('click', (e) => {
        e.preventDefault();
        toggleChatPurrksPopover(document.getElementById('sb-bottom-chat-purrks-btn') || e.currentTarget);
    });

    document.addEventListener('click', (e) => {
        const popover = document.getElementById('neconyan-purrks-popover');
        if (!popover || popover.hidden) return;
        const target = e.target;
        if (!(target instanceof Node)) return;
        if (
            popover.contains(target)
            || document.getElementById('sb-bottom-chat-purrks-btn')?.contains(target)
            || document.getElementById('option_toggle_purrks')?.contains(target)
        ) {
            return;
        }
        closeChatPurrksPopover();
    });
}
