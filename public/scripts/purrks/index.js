import {
    PURRKS_EXTENSION_KEY,
    PURRKS_CHAT_METADATA_KEY,
    MAX_PURRKS_PER_CARD,
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
    create_save,
    generateRawData,
    getCurrentChatId,
    saveMetadata,
} from '../../script.js';
import { selected_group, groups } from '../group-chats.js';
import { extension_settings, saveMetadataDebounced, writeExtensionField } from '../extensions.js';
import { eventSource, event_types } from '../events.js';
import { ConnectionManagerRequestService } from '../extensions/shared.js';
import { extractProfileResponseText } from '../extensions/in-chat-agents/llm-utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../popup.js';
import { t } from '../i18n.js';

const SCENE_DIRECTOR_TIMEOUT_MS = 20000;
const NORMAL_TURN_TYPES = new Set([undefined, null, '', 'normal']);

const expandedEditorIds = new Set();
let initialized = false;
let editorSaveChain = Promise.resolve();
let pendingTurn = null;
let popoverAnchor = null;

function modeLabel(mode) {
    switch (mode) {
        case 'always': return t`Always active`;
        case 'manual': return t`Manual switch`;
        case 'keyword': return t`Keyword trigger`;
        case 'scene': return t`Scene AI director`;
        default: return String(mode || '');
    }
}

function placementLabel(placement) {
    switch (placement) {
        case 'depth': return t`@ Depth in chat`;
        case 'system': return t`System prompt`;
        case 'post_history': return t`After chat history`;
        case 'description': return t`Character description`;
        default: return String(placement || '');
    }
}

function statusLabel(reason, active, injectNegative) {
    if (active) return t`Active`;
    if (injectNegative) return t`Aftermath`;
    if (reason === 'cooldown') return t`Resting`;
    return t`Off`;
}

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

async function runPurrksLlmRequest(messages, profileId = '', maxTokens = 4096, signal = undefined) {
    const chosenProfile = String(profileId || '').trim();
    if (chosenProfile) {
        const response = await ConnectionManagerRequestService.sendRequest(
            chosenProfile,
            messages,
            maxTokens,
            {
                stream: false,
                signal,
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
        signal,
    });
    return typeof raw === 'string' ? raw : extractProfileResponseText(raw);
}

function isEditingExistingCharacter() {
    const actionType = document.getElementById('form_create')?.getAttribute('actiontype');
    return actionType === 'editcharacter' && this_chid !== undefined && Boolean(characters[this_chid]);
}

/**
 * Identifies the character the editor is showing, so slow work can check it is still the same one.
 * @returns {string} Avatar file name, or '' for a character that has not been created yet.
 */
function getEditorTargetKey() {
    return isEditingExistingCharacter() ? String(characters[this_chid]?.avatar || '') : '';
}

function getEditorCharacterOrDraft() {
    if (isEditingExistingCharacter()) {
        return characters[this_chid];
    }
    const value = (id, fallback) => String(document.getElementById(id)?.value || fallback || '');
    const data = {
        name: value('character_name_pole', create_save.name),
        description: value('description_textarea', create_save.description),
        personality: value('personality_textarea', create_save.personality),
        scenario: value('scenario_pole', create_save.scenario),
        system_prompt: value('system_prompt_textarea', create_save.system_prompt),
        post_history_instructions: value('post_history_instructions_textarea', create_save.post_history_instructions),
        creator_notes: value('creator_notes_textarea', create_save.creator_notes),
        extensions: {
            ...(create_save.extensions || {}),
            depth_prompt: {
                prompt: value('depth_prompt_prompt', create_save.depth_prompt_prompt),
                depth: Number(document.getElementById('depth_prompt_depth')?.value ?? create_save.depth_prompt_depth ?? 4),
                role: value('depth_prompt_role', create_save.depth_prompt_role || 'system'),
            },
        },
    };
    return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: value('firstmessage_textarea', create_save.first_message),
        mes_example: value('mes_example_textarea', create_save.mes_example),
        data,
    };
}

function readEditorPurrks() {
    if (isEditingExistingCharacter()) {
        return readCharacterPurrks(characters[this_chid]);
    }
    create_save.extensions ??= {};
    return normalizeCharacterPurrks(create_save.extensions[PURRKS_EXTENSION_KEY] ?? {});
}

async function writeCharacterPurrks(chid, nextPurrks) {
    const character = characters[chid];
    if (!character) return;
    const normalized = normalizeCharacterPurrks(nextPurrks);
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions[PURRKS_EXTENSION_KEY] = normalized;
    await writeExtensionField(chid, PURRKS_EXTENSION_KEY, normalized);
}

/**
 * Saves the editor's Purrks. Saves run one after another so a quick second edit never overtakes the first.
 * @param {object} nextPurrks Purrks config to store.
 * @param {{ rerender?: boolean }} [options]
 */
function saveEditorPurrks(nextPurrks, { rerender = true } = {}) {
    const normalized = normalizeCharacterPurrks(nextPurrks);
    const editingExisting = isEditingExistingCharacter();
    const chid = this_chid;
    const avatar = editingExisting ? characters[chid]?.avatar : null;
    if (editingExisting) {
        const character = characters[chid];
        if (character) {
            character.data ??= {};
            character.data.extensions ??= {};
            character.data.extensions[PURRKS_EXTENSION_KEY] = normalized;
        }
    } else {
        create_save.extensions ??= {};
        create_save.extensions[PURRKS_EXTENSION_KEY] = normalized;
    }
    if (rerender) renderCharacterEditorPurrks();
    updateBottomChatPurrksBadge();
    if (!editingExisting) return Promise.resolve();
    editorSaveChain = editorSaveChain
        .catch(() => {})
        .then(() => {
            const index = characters.findIndex(character => character?.avatar === avatar);
            if (index < 0) return;
            // Persist the latest local edit, rather than restoring an older queued snapshot.
            return writeExtensionField(index, PURRKS_EXTENSION_KEY, readCharacterPurrks(characters[index]));
        })
        .catch(error => {
            console.error('Saving Purrks failed:', error);
            toastr.error(t`Could not save Purrks. Check the connection and try again.`);
        });
    return editorSaveChain;
}

function addGeneratedItems(current, generated, source) {
    const usedIds = new Set(current.items.map(item => item.id));
    let added = 0;
    for (const item of generated) {
        if (current.items.length >= MAX_PURRKS_PER_CARD) break;
        const id = ensureUniquePurrkId(item.id || item.label, usedIds);
        current.items.push({ ...item, id, source: source || item.source });
        added += 1;
    }
    return added;
}

function setExpanded(button, expanded) {
    button.setAttribute('aria-expanded', String(expanded));
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
    title.append(icon, document.createTextNode(` ${t`Purrks`}`));
    const badge = el('span', 'neconyan-purrks-count-badge', String(purrks.items.length));
    badge.setAttribute('aria-label', t`${purrks.items.length} Purrks on this card`);
    titleGroup.append(title, badge);

    const toolbar = el('div', 'neconyan-purrks-toolbar');

    const aiBtn = el('button', 'menu_button menu_button_primary', t`Generate Purrks`);
    aiBtn.type = 'button';
    aiBtn.id = 'character_purrks_generate_ai_btn';
    aiBtn.addEventListener('click', async () => {
        const targetKey = getEditorTargetKey();
        const editingExisting = isEditingExistingCharacter();
        const cardSnapshot = getEditorCharacterOrDraft();
        const profileId = readEditorPurrks().autoSceneProfileId;
        try {
            aiBtn.disabled = true;
            const rawReply = await runPurrksLlmRequest(buildAiPurrksGenerationMessages(cardSnapshot), profileId);
            const generated = parseAiGeneratedPurrksResponse(rawReply);
            if (!generated.length) {
                toastr.warning(t`The reply had no usable Purrks. Nothing was applied.`);
                return;
            }
            if (editingExisting) {
                const chid = characters.findIndex(character => character?.avatar === targetKey);
                if (chid === -1) throw new Error(t`That character is no longer available.`);
                const current = readCharacterPurrks(characters[chid]);
                const added = addGeneratedItems(current, generated, 'ai');
                await writeCharacterPurrks(chid, current);
                toastr.success(t`Generated ${added} Purrk(s) from the character card.`);
            } else if (!getEditorTargetKey()) {
                const current = readEditorPurrks();
                const added = addGeneratedItems(current, generated, 'ai');
                await saveEditorPurrks(current, { rerender: false });
                toastr.success(t`Generated ${added} Purrk(s) from the character card.`);
            }
            if (getEditorTargetKey() === targetKey) renderCharacterEditorPurrks();
            updateBottomChatPurrksBadge();
        } catch (error) {
            console.error('Purrks AI generation failed:', error);
            toastr.error(String(error?.message || error));
        } finally {
            aiBtn.disabled = false;
        }
    });

    const extractBtn = el('button', 'menu_button', t`Extract from card`);
    extractBtn.type = 'button';
    extractBtn.id = 'character_purrks_extract_btn';
    extractBtn.addEventListener('click', async () => {
        const current = readEditorPurrks();
        const cardSnapshot = getEditorCharacterOrDraft();
        const orbItems = convertOrbFragmentsToPurrks(cardSnapshot?.data?.extensions?.orb?.fragments);
        const heuristicItems = extractHeuristicPurrksFromCard(cardSnapshot);
        const existingPrompts = new Set(current.items.map(item => item.prompt.trim().toLowerCase()));
        const candidates = [...orbItems, ...heuristicItems].filter(candidate => {
            const key = String(candidate.prompt || '').trim().toLowerCase();
            if (!key || existingPrompts.has(key)) return false;
            existingPrompts.add(key);
            return true;
        });
        if (!orbItems.length && !heuristicItems.length) {
            toastr.info(t`No structured sections, conditional triggers, or Orb fragments were found on this card.`);
            return;
        }
        if (!candidates.length) {
            toastr.info(t`All extracted Purrks are already listed on this card.`);
            return;
        }
        const added = addGeneratedItems(current, candidates);
        await saveEditorPurrks(current);
        toastr.success(t`Extracted ${added} Purrk(s). They start switched off, so turn on the ones you want.`);
    });

    const addBtn = el('button', 'menu_button', t`+ Add Purrk`);
    addBtn.type = 'button';
    addBtn.id = 'character_purrks_add_btn';
    addBtn.disabled = purrks.items.length >= MAX_PURRKS_PER_CARD;
    addBtn.addEventListener('click', () => {
        const current = readEditorPurrks();
        if (current.items.length >= MAX_PURRKS_PER_CARD) return;
        const usedIds = new Set(current.items.map(item => item.id));
        const id = ensureUniquePurrkId(`purrk-${current.items.length + 1}`, usedIds);
        const newItem = normalizePurrkItem({
            id,
            label: t`New Purrk`,
            enabled: true,
            mode: 'manual',
            placement: 'depth',
            depth: 4,
            role: 'system',
            prompt: '',
            source: 'user',
        }, new Set(), current.items.length);
        if (!newItem) return;
        current.items.push(newItem);
        expandedEditorIds.add(newItem.id);
        void saveEditorPurrks(current);
    });

    toolbar.append(aiBtn, extractBtn, addBtn);
    header.append(titleGroup, toolbar);

    const subtitle = el(
        'p',
        'neconyan-purrks-subtitle',
        t`Switchable prompt traits, moods, keyword triggers and Scene AI directives that travel with this card. System prompt and After chat history Purrks follow the 'Prefer character prompt' settings.`,
    );

    const directorBar = el('div', 'neconyan-purrks-director-bar');
    const directorLabel = el('label', '');
    const enabledCheck = document.createElement('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.checked = purrks.enabled !== false;
    enabledCheck.addEventListener('change', () => {
        const current = readEditorPurrks();
        current.enabled = enabledCheck.checked;
        void saveEditorPurrks(current, { rerender: false });
    });
    directorLabel.append(enabledCheck, document.createTextNode(` ${t`Enable Purrks for this character`}`));

    const profileSelect = el('select', 'text_pole textarea_compact');
    profileSelect.setAttribute('aria-label', t`Scene AI connection profile`);
    const defaultOpt = el('option', '', t`Current connection (for Scene AI & Generate)`);
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
        void saveEditorPurrks(current, { rerender: false });
    });
    directorBar.append(directorLabel, profileSelect);

    const list = el('div', 'neconyan-purrks-list');
    if (!purrks.items.length) {
        list.append(el(
            'div',
            'neconyan-purrks-empty',
            t`No Purrks on this card yet. Use 'Generate Purrks', 'Extract from card' or '+ Add Purrk' to create switchable prompt blocks.`,
        ));
    } else {
        for (const item of purrks.items) {
            list.append(renderEditorPurrkCard(item));
        }
    }

    host.append(header, subtitle, directorBar, list);
}

function renderEditorPurrkCard(item) {
    const itemId = item.id;
    const isExpanded = expandedEditorIds.has(itemId);
    const card = el('div', 'neconyan-purrk-card');
    card.dataset.purrkId = itemId;
    card.dataset.enabled = String(Boolean(item.enabled));

    /**
     * Applies a change to this Purrk, found by id so a stale list never edits the wrong item.
     * @param {(target: object) => void} mutator
     * @param {{ rerender?: boolean }} [options]
     */
    const updateItem = (mutator, { rerender = false } = {}) => {
        const current = readEditorPurrks();
        const index = current.items.findIndex(entry => entry.id === itemId);
        if (index === -1) return null;
        const draft = { ...current.items[index] };
        mutator(draft);
        const normalized = normalizePurrkItem(draft, new Set(), index);
        if (!normalized) return null;
        normalized.id = itemId;
        current.items[index] = normalized;
        void saveEditorPurrks(current, { rerender });
        return normalized;
    };

    const toggleExpanded = () => {
        if (expandedEditorIds.has(itemId)) expandedEditorIds.delete(itemId);
        else expandedEditorIds.add(itemId);
        renderCharacterEditorPurrks();
    };

    const row = el('div', 'neconyan-purrk-row');
    const mainCol = el('div', 'neconyan-purrk-main');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'neconyan-purrk-toggle';
    toggle.checked = Boolean(item.enabled);
    toggle.setAttribute('aria-label', t`Enable ${item.label || itemId}`);
    toggle.addEventListener('change', () => {
        updateItem(target => { target.enabled = toggle.checked; });
        card.dataset.enabled = String(toggle.checked);
    });

    const labelBtn = el('button', 'neconyan-purrk-label-btn', item.label || itemId);
    labelBtn.type = 'button';
    setExpanded(labelBtn, isExpanded);
    labelBtn.addEventListener('click', toggleExpanded);

    mainCol.append(toggle, labelBtn);

    const badges = el('div', 'neconyan-purrk-badges');
    const modeBadge = el('span', 'neconyan-purrk-badge', modeLabel(item.mode));
    modeBadge.dataset.tone = 'accent';
    const placeBadge = el(
        'span',
        'neconyan-purrk-badge',
        item.placement === 'depth' ? t`@ Depth ${item.depth} (${item.role})` : placementLabel(item.placement),
    );
    badges.append(modeBadge, placeBadge);
    if (item.source === 'orb') {
        badges.append(el('span', 'neconyan-purrk-badge', 'Orb'));
    }
    const editBtn = el('button', 'menu_button', isExpanded ? t`Done` : t`Edit`);
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', isExpanded ? t`Close ${item.label || itemId}` : t`Edit ${item.label || itemId}`);
    setExpanded(editBtn, isExpanded);
    editBtn.addEventListener('click', toggleExpanded);
    badges.append(editBtn);

    row.append(mainCol, badges);
    card.append(row);

    if (!isExpanded) {
        if (item.prompt) card.append(el('div', 'neconyan-purrk-preview', item.prompt));
        return card;
    }

    const details = el('div', 'neconyan-purrk-details');
    const grid = el('div', 'neconyan-purrk-grid');

    const field = (labelText, control) => {
        const wrapper = el('label', 'neconyan-purrk-field');
        wrapper.append(el('span', '', labelText), control);
        return wrapper;
    };
    const select = (options, selected, labelFor) => {
        const node = el('select', 'text_pole');
        for (const value of options) {
            const opt = el('option', '', labelFor(value));
            opt.value = value;
            opt.selected = selected === value;
            node.append(opt);
        }
        return node;
    };

    const labelInput = el('input', 'text_pole');
    labelInput.type = 'text';
    labelInput.value = item.label;
    labelInput.addEventListener('change', () => {
        const saved = updateItem(target => { target.label = labelInput.value; });
        if (saved) labelBtn.textContent = saved.label || itemId;
    });

    const modeSelect = select(PURRK_MODES, item.mode, modeLabel);
    modeSelect.addEventListener('change', () => updateItem(target => { target.mode = modeSelect.value; }, { rerender: true }));

    const placeSelect = select(PURRK_PLACEMENTS, item.placement, placementLabel);
    placeSelect.addEventListener('change', () => updateItem(target => { target.placement = placeSelect.value; }, { rerender: true }));

    grid.append(
        field(t`Label`, labelInput),
        field(t`Activation mode`, modeSelect),
        field(t`Placement`, placeSelect),
    );

    if (item.placement === 'depth') {
        const depthInput = el('input', 'text_pole');
        depthInput.type = 'number';
        depthInput.min = '0';
        depthInput.max = '9999';
        depthInput.value = String(item.depth ?? 4);
        depthInput.addEventListener('change', () => updateItem(target => { target.depth = Number(depthInput.value); }, { rerender: true }));

        const roleSelect = select(PURRK_ROLES, item.role, role => role.charAt(0).toUpperCase() + role.slice(1));
        roleSelect.addEventListener('change', () => updateItem(target => { target.role = roleSelect.value; }, { rerender: true }));

        grid.append(field(t`@ Depth`, depthInput), field(t`Role`, roleSelect));
    }

    const cooldownInput = el('input', 'text_pole');
    cooldownInput.type = 'number';
    cooldownInput.min = '0';
    cooldownInput.max = '50';
    cooldownInput.value = String(item.cooldownTurns ?? 0);
    cooldownInput.addEventListener('change', () => updateItem(target => { target.cooldownTurns = Number(cooldownInput.value); }));
    grid.append(field(t`Cooldown turns`, cooldownInput));

    details.append(grid);

    if (item.mode === 'keyword') {
        const kwInput = el('input', 'text_pole');
        kwInput.type = 'text';
        kwInput.placeholder = 'flustered, blush, compliment';
        kwInput.value = (item.keywords || []).join(', ');
        kwInput.addEventListener('change', () => updateItem(target => { target.keywords = kwInput.value; }));
        details.append(field(t`Keywords (comma-separated)`, kwInput));
    }

    if (item.mode === 'scene') {
        const condInput = el('input', 'text_pole');
        condInput.type = 'text';
        condInput.placeholder = t`Activate when the conversation becomes tense or defensive`;
        condInput.value = item.condition || '';
        condInput.addEventListener('change', () => updateItem(target => { target.condition = condInput.value; }));
        details.append(field(t`Scene trigger condition`, condInput));
    }

    const promptArea = el('textarea', 'text_pole');
    promptArea.rows = 3;
    promptArea.placeholder = t`Instructions injected while this Purrk is active...`;
    promptArea.value = item.prompt || '';
    promptArea.addEventListener('change', () => updateItem(target => { target.prompt = promptArea.value; }));
    details.append(field(t`Prompt directive`, promptArea));

    const negArea = el('textarea', 'text_pole');
    negArea.rows = 2;
    negArea.placeholder = t`Optional transition note on the turn immediately after this Purrk turns off...`;
    negArea.value = item.negativePrompt || '';
    negArea.addEventListener('change', () => updateItem(target => { target.negativePrompt = negArea.value; }));
    details.append(field(t`Aftermath prompt (optional, one turn after it switches off)`, negArea));

    const actionsRow = el('div', 'neconyan-purrk-actions-row');
    const deleteBtn = el('button', 'menu_button', t`Delete Purrk`);
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', async () => {
        const confirmed = await callGenericPopup(t`Delete the Purrk '${item.label || itemId}'?`, POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        const current = readEditorPurrks();
        const index = current.items.findIndex(entry => entry.id === itemId);
        if (index === -1) return;
        current.items.splice(index, 1);
        expandedEditorIds.delete(itemId);
        void saveEditorPurrks(current);
    });
    actionsRow.append(el('span', 'neconyan-purrks-subtitle', `ID: ${itemId}`), deleteBtn);
    details.append(actionsRow);

    card.append(details);
    return card;
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

function hasAnyPurrks(targets) {
    return targets.some(target => readCharacterPurrks(target.character).items.length > 0);
}

function readChatPurrksState() {
    if (!chat_metadata || typeof chat_metadata !== 'object') return normalizeChatPurrksState({});
    return normalizeChatPurrksState(chat_metadata[PURRKS_CHAT_METADATA_KEY]);
}

/**
 * Stores the chat's Purrk state only when it changed.
 * @param {object} nextState
 * @param {{ immediate?: boolean }} [options] Save the chat now instead of after the usual short delay.
 * @returns {boolean} Whether anything changed.
 */
function writeChatPurrksState(nextState, { immediate = false } = {}) {
    if (!chat_metadata || typeof chat_metadata !== 'object') return false;
    const normalized = normalizeChatPurrksState(nextState);
    const before = JSON.stringify(normalizeChatPurrksState(chat_metadata[PURRKS_CHAT_METADATA_KEY]));
    if (before === JSON.stringify(normalized) && Object.hasOwn(chat_metadata, PURRKS_CHAT_METADATA_KEY)) return false;
    chat_metadata[PURRKS_CHAT_METADATA_KEY] = normalized;
    if (immediate) {
        void saveMetadata().catch(error => console.warn('Saving Purrk switches failed:', error));
    } else {
        saveMetadataDebounced();
    }
    return true;
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
    btn.hidden = totalCount === 0;
    if (totalCount === 0) {
        badge?.remove();
        btn.title = t`Character Purrks`;
        btn.setAttribute('aria-label', t`Character Purrks`);
        return;
    }
    if (!badge) {
        badge = el('span', 'sb-bottom-chat-purrks-badge');
        badge.setAttribute('aria-hidden', 'true');
        btn.append(badge);
    }
    badge.textContent = String(activeCount);
    btn.title = t`Character Purrks (${activeCount} active of ${totalCount})`;
    btn.setAttribute('aria-label', btn.title);
}

function combineSignals(signal, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Scene AI took too long.')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        },
    };
}

/**
 * Asks Scene AI which scene Purrks fit the current chat.
 * @param {object} [options]
 * @param {boolean} [options.notify] Show toasts with the result.
 * @param {AbortSignal} [options.signal] Stops the request when the reply is cancelled.
 * @param {Array<{chid:number,character:object,key:string}>} [options.targets] Characters to direct; defaults to everyone in the chat.
 * @returns {Promise<boolean>} Whether the active scene Purrks were updated.
 */
export async function runSceneDirectorForActiveChat({ notify = false, signal = undefined, targets = undefined } = {}) {
    const directorTargets = targets ?? getActiveChatCharacters();
    if (!directorTargets.length) return false;
    const chatId = getCurrentChatId();
    let updatedAny = false;

    for (const target of directorTargets) {
        const purrks = readCharacterPurrks(target.character);
        if (!purrks.enabled) continue;
        const prefix = target.key ? `${target.key}:` : '';
        const startState = readChatPurrksState();
        const candidateItems = purrks.items.filter(item => {
            if (item.mode !== 'scene' || !item.enabled || !item.prompt) return false;
            const scopedId = `${prefix}${item.id}`;
            if (Object.hasOwn(startState.overrides, scopedId)) return false;
            if ((startState.cooldowns[scopedId] ?? 0) > 0) return false;
            return true;
        });
        if (!candidateItems.length) continue;

        const directorMessages = buildSceneDirectorMessages(target.character, candidateItems, chat);
        if (!directorMessages) continue;

        const request = combineSignals(signal, SCENE_DIRECTOR_TIMEOUT_MS);
        try {
            const rawReply = await runPurrksLlmRequest(directorMessages, purrks.autoSceneProfileId, 1024, request.signal);
            if (getCurrentChatId() !== chatId) return false;
            const activeIds = parseSceneDirectorResponse(rawReply, candidateItems);
            const candidateSet = new Set(candidateItems.map(item => `${prefix}${item.id}`));
            const latest = readChatPurrksState();
            latest.activeSceneIds = [
                ...latest.activeSceneIds.filter(id => !candidateSet.has(id)),
                ...activeIds.map(id => `${prefix}${id}`),
            ];
            if (writeChatPurrksState(latest)) updatedAny = true;
        } catch (error) {
            if (signal?.aborted) return false;
            console.warn('Scene AI pass skipped:', error);
            if (notify) toastr.error(String(error?.message || error));
        } finally {
            request.dispose();
        }
    }

    if (updatedAny) {
        updateBottomChatPurrksBadge();
        refreshOpenPopover();
        if (notify) toastr.success(t`Scene AI updated the active Purrks for this scene.`);
    } else if (notify) {
        toastr.info(t`No Scene AI Purrks needed updating right now.`);
    }
    return updatedAny;
}

/**
 * Moves Purrk cooldowns and aftermath tracking on by one reply, for every character in the chat at once.
 * @param {object[]} messages Chat as it was when the reply was requested.
 */
function advanceActiveChatPurrksTurn(messages) {
    const targets = getActiveChatCharacters();
    if (!targets.length || !chat_metadata) return;
    const hasStoredState = Object.hasOwn(chat_metadata, PURRKS_CHAT_METADATA_KEY);
    if (!hasAnyPurrks(targets) && !hasStoredState) return;
    const entries = [];
    for (const target of targets) {
        const evaluation = evaluateCharacterPurrks(target.character, {
            chatMetadata: chat_metadata,
            messages,
            characterKey: target.key,
        });
        entries.push(...evaluation.evaluatedItems);
    }
    const nextState = advanceChatPurrksTurnState(readChatPurrksState(), entries);
    writeChatPurrksState(nextState);
    updateBottomChatPurrksBadge();
    refreshOpenPopover();
}

function getOrCreatePopover() {
    let popover = document.getElementById('neconyan-purrks-popover');
    if (popover instanceof HTMLElement) return popover;
    popover = el('div', '');
    popover.id = 'neconyan-purrks-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', t`Character Purrks`);
    popover.tabIndex = -1;
    popover.hidden = true;
    popover.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeChatPurrksPopover({ restoreFocus: true });
        }
    });
    document.body.append(popover);
    return popover;
}

function getUsableAnchor(anchor) {
    const candidates = [anchor, document.getElementById('sb-bottom-chat-purrks-btn'), document.getElementById('send_form')];
    for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement)) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return candidate;
    }
    return null;
}

function positionPopover() {
    const popover = getOrCreatePopover();
    if (window.matchMedia('(max-width: 768px)').matches) {
        popover.style.left = '';
        popover.style.top = '';
        popover.style.bottom = '';
        return;
    }
    const width = Math.min(420, window.innerWidth - 20);
    const anchor = getUsableAnchor(popoverAnchor);
    const rect = anchor
        ? anchor.getBoundingClientRect()
        : { left: (window.innerWidth - width) / 2, top: window.innerHeight - 80 };
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.bottom = `${Math.round(bottom)}px`;
    popover.style.top = 'auto';
}

function setPopoverTriggersExpanded(expanded) {
    document.getElementById('sb-bottom-chat-purrks-btn')?.setAttribute('aria-expanded', String(expanded));
}

export function closeChatPurrksPopover({ restoreFocus = false } = {}) {
    const popover = document.getElementById('neconyan-purrks-popover');
    if (popover instanceof HTMLElement) {
        popover.hidden = true;
    }
    setPopoverTriggersExpanded(false);
    if (restoreFocus) {
        const anchor = getUsableAnchor(popoverAnchor);
        anchor?.focus?.();
    }
}

export function toggleChatPurrksPopover(anchor) {
    const popover = getOrCreatePopover();
    if (!popover.hidden) {
        closeChatPurrksPopover();
        return;
    }
    popoverAnchor = anchor instanceof HTMLElement ? anchor : null;
    renderChatPurrksPopover();
    popover.hidden = false;
    positionPopover();
    setPopoverTriggersExpanded(true);
    const firstButton = popover.querySelector('button:not([disabled])');
    (firstButton instanceof HTMLElement ? firstButton : popover).focus({ preventScroll: true });
}

function refreshOpenPopover() {
    const popover = document.getElementById('neconyan-purrks-popover');
    if (popover instanceof HTMLElement && !popover.hidden) {
        renderChatPurrksPopover();
    }
}

function renderEmptyPopoverTarget(target) {
    const emptyBox = el('div', 'neconyan-purrks-empty');
    emptyBox.append(el('div', '', t`No Purrks configured for ${target.character.name || t`this character`} yet.`));
    const quickGenBtn = el('button', 'menu_button menu_button_primary', t`Generate Purrks from card`);
    quickGenBtn.type = 'button';
    quickGenBtn.style.marginTop = '8px';
    quickGenBtn.addEventListener('click', async () => {
        const avatar = target.character?.avatar;
        try {
            quickGenBtn.disabled = true;
            const profileId = readCharacterPurrks(target.character).autoSceneProfileId;
            const rawReply = await runPurrksLlmRequest(buildAiPurrksGenerationMessages(target.character), profileId);
            const generated = parseAiGeneratedPurrksResponse(rawReply);
            if (!generated.length) {
                toastr.warning(t`The reply had no usable Purrks. Nothing was applied.`);
                return;
            }
            const chid = characters.findIndex(character => character?.avatar === avatar);
            if (chid === -1) throw new Error(t`That character is no longer available.`);
            const purrks = readCharacterPurrks(characters[chid]);
            const added = addGeneratedItems(purrks, generated, 'ai');
            await writeCharacterPurrks(chid, purrks);
            updateBottomChatPurrksBadge();
            refreshOpenPopover();
            if (getEditorTargetKey() === avatar) renderCharacterEditorPurrks();
            toastr.success(t`Generated ${added} Purrk(s).`);
        } catch (error) {
            toastr.error(String(error?.message || error));
        } finally {
            quickGenBtn.disabled = false;
        }
    });
    emptyBox.append(quickGenBtn);
    return emptyBox;
}

export function renderChatPurrksPopover() {
    const popover = getOrCreatePopover();
    const focusedKey = document.activeElement instanceof HTMLElement && popover.contains(document.activeElement)
        ? document.activeElement.dataset.focusKey
        : '';
    popover.replaceChildren();

    const header = el('div', 'neconyan-purrks-header');
    const titleGroup = el('div', 'neconyan-purrks-title-group');
    const title = el('div', 'neconyan-purrks-title');
    const icon = el('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    title.append(icon, document.createTextNode(` ${t`Character Purrks`}`));
    titleGroup.append(title);

    const toolbar = el('div', 'neconyan-purrks-toolbar');
    const directBtn = el('button', 'menu_button', t`Direct scene`);
    directBtn.type = 'button';
    directBtn.dataset.focusKey = 'direct';
    directBtn.title = t`Ask Scene AI to pick matching scene Purrks for the current chat`;
    directBtn.addEventListener('click', async () => {
        directBtn.disabled = true;
        try {
            await runSceneDirectorForActiveChat({ notify: true });
        } finally {
            directBtn.disabled = false;
        }
    });

    const closeBtn = el('button', 'menu_button neconyan-purrks-popover-close', t`Close`);
    closeBtn.type = 'button';
    closeBtn.dataset.focusKey = 'close';
    closeBtn.addEventListener('click', () => closeChatPurrksPopover({ restoreFocus: true }));

    toolbar.append(directBtn, closeBtn);
    header.append(titleGroup, toolbar);

    const body = el('div', 'neconyan-purrks-popover-body');
    const targets = getActiveChatCharacters();

    if (!targets.length) {
        body.append(el('div', 'neconyan-purrks-empty', t`Open a character or group chat to view and switch its Purrks.`));
        popover.append(header, body);
        return;
    }

    const state = readChatPurrksState();

    for (const target of targets) {
        const evaluation = evaluateCharacterPurrks(target.character, {
            chatMetadata: chat_metadata,
            messages: chat,
            characterKey: target.key,
        });
        const prefix = target.key ? `${target.key}:` : '';

        if (targets.length > 1) {
            body.append(el('div', 'neconyan-purrks-title', target.character.name || target.key));
        }

        if (!evaluation.evaluatedItems.length) {
            body.append(renderEmptyPopoverTarget(target));
            continue;
        }

        for (const entry of evaluation.evaluatedItems) {
            const { item, active, reason, injectNegative } = entry;
            const scopedId = `${prefix}${item.id}`;
            const overrideVal = Object.hasOwn(state.overrides, scopedId) ? state.overrides[scopedId] : null;

            const card = el('div', 'neconyan-purrk-card');
            card.dataset.purrkId = item.id;
            card.dataset.enabled = String(Boolean(active));

            const row = el('div', 'neconyan-purrk-row');
            const mainCol = el('div', 'neconyan-purrk-main');
            const statusBadge = el('span', 'neconyan-purrk-badge', statusLabel(reason, active, injectNegative));
            if (active) statusBadge.dataset.tone = 'active';
            const labelSpan = el('span', 'neconyan-purrk-label-btn', item.label);
            mainCol.append(statusBadge, labelSpan);

            const controls = el('div', 'neconyan-purrks-override-controls');
            controls.setAttribute('role', 'group');
            controls.setAttribute('aria-label', t`Switch for ${item.label}`);
            const setOverride = (nextValue) => {
                const nextState = readChatPurrksState();
                if (nextValue === null) {
                    delete nextState.overrides[scopedId];
                } else {
                    nextState.overrides[scopedId] = Boolean(nextValue);
                }
                writeChatPurrksState(nextState, { immediate: true });
                updateBottomChatPurrksBadge();
                renderChatPurrksPopover();
            };

            const overrideButton = (label, value, titleText) => {
                const button = el('button', 'menu_button', label);
                button.type = 'button';
                button.dataset.focusKey = `${scopedId}:${String(value)}`;
                button.setAttribute('aria-pressed', String(overrideVal === value));
                button.title = titleText;
                button.addEventListener('click', () => setOverride(value));
                return button;
            };

            controls.append(
                overrideButton(t`Auto`, null, t`Follow the card rule (${modeLabel(item.mode)})`),
                overrideButton(t`On`, true, t`Force on for this chat`),
                overrideButton(t`Off`, false, t`Force off for this chat`),
            );
            row.append(mainCol, controls);
            card.append(row);

            const metaRow = el('div', 'neconyan-purrk-badges');
            metaRow.append(
                el('span', 'neconyan-purrk-badge', modeLabel(item.mode)),
                el('span', 'neconyan-purrk-badge', item.placement === 'depth' ? t`@ Depth ${item.depth}` : placementLabel(item.placement)),
            );
            if (reason === 'cooldown' && entry.cooldownRemaining > 0) {
                metaRow.append(el('span', 'neconyan-purrk-badge', t`Resting for ${entry.cooldownRemaining} turn(s)`));
            }
            card.append(metaRow);

            if (item.prompt) {
                card.append(el('div', 'neconyan-purrk-preview', item.prompt));
            }
            body.append(card);
        }
    }

    popover.append(header, body);
    if (focusedKey) {
        const restored = popover.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`);
        if (restored instanceof HTMLElement) restored.focus({ preventScroll: true });
    }
}

function isNormalTurn(type) {
    return NORMAL_TURN_TYPES.has(type);
}

async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
    if (dryRun || !isNormalTurn(type) || params?.isAuxiliaryGeneration || params?.quiet_prompt) return;
    // A group send first runs once for the whole group, then once per speaker; only the speaker runs matter.
    if (selected_group && this_chid === undefined) return;
    const targets = getActiveChatCharacters();
    if (!targets.length || !hasAnyPurrks(targets)) return;

    pendingTurn = { chatId: getCurrentChatId(), length: chat.length };

    const speakers = selected_group
        ? targets.filter(target => target.chid === this_chid)
        : targets;
    if (!speakers.length) return;
    await runSceneDirectorForActiveChat({ notify: false, signal: params?.signal, targets: speakers });
}

function onMessageReceived(_messageId, type) {
    if (!pendingTurn || !isNormalTurn(type)) return;
    const turn = pendingTurn;
    pendingTurn = null;
    if (turn.chatId !== getCurrentChatId()) return;
    advanceActiveChatPurrksTurn(chat.slice(0, turn.length));
}

function onChatChanged() {
    closeChatPurrksPopover();
    // Server Roleplay replies arrive by reloading the saved chat instead of MESSAGE_RECEIVED.
    if (pendingTurn) {
        const turn = pendingTurn;
        const lastMessage = chat[chat.length - 1];
        if (turn.chatId !== getCurrentChatId()) {
            pendingTurn = null;
        } else if (chat.length > turn.length && lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            pendingTurn = null;
            advanceActiveChatPurrksTurn(chat.slice(0, turn.length));
        }
    }
    updateBottomChatPurrksBadge();
    renderCharacterEditorPurrks();
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
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    document.getElementById('option_toggle_purrks')?.addEventListener('click', (e) => {
        e.preventDefault();
        toggleChatPurrksPopover(document.getElementById('sb-bottom-chat-purrks-btn'));
    });

    window.addEventListener('resize', () => {
        const popover = document.getElementById('neconyan-purrks-popover');
        if (popover instanceof HTMLElement && !popover.hidden) positionPopover();
    });

    document.addEventListener('click', (e) => {
        const popover = document.getElementById('neconyan-purrks-popover');
        if (!popover || popover.hidden) return;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const insideAny = [
            popover,
            document.getElementById('sb-bottom-chat-purrks-btn'),
            document.getElementById('option_toggle_purrks'),
        ].some(node => node && (path.includes(node) || (e.target instanceof Node && node.contains(e.target))));
        if (insideAny) return;
        closeChatPurrksPopover();
    });
}
