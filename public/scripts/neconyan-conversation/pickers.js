import {
    characters,
    default_avatar,
    default_user_avatar,
    getThumbnailUrlForViewport,
    name1,
} from '../../script.js';
import { user_avatar } from '../personas.js';
import { power_user } from '../power-user.js';
import { selectConversationThread } from './chrome.js';
import { AVAILABILITY_COPY, CHROME_IDS, DEFAULT_BRANCH_ID, WEEKDAY_LABELS } from './constants.js';
import {
    createConversationBranch,
    createConversationGroupRecord,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getDefaultGroupConversationSettings,
    normalizeConversationBranch,
    persistConversationStore,
} from './context.js';
import { computeConversationGroupMemberEdit, orderConversationGroupPickerAvatars } from './group-member-edits.js';
import { saveCurrentPanelSettings } from './interface.js';
import { getCharacterForAvatar } from './media.js';
import {
    getActiveConversationPersonaAppendixIds,
    getConversationPersonaAppendices,
    getConversationScenarioAvatar,
    getPersonaOptions,
    getUserPersonaStatus,
    getUserStatus,
    safeParseWeeklySchedule,
} from './personas.js';
import { schedulePalsRailRender } from './render-scheduler.js';
import { escapeHtmlAttribute, escapeHtmlText, setUserTextSlot } from './render-utils.js';
import { closePalsRail, setPalsRailOpen } from './settings-panel.js';
import { conversationState } from './state.js';

export function renderWeeklyScheduleEditor(container, scheduleJson) {
    const entries = safeParseWeeklySchedule(scheduleJson);
    container.innerHTML = '';
    for (const entry of entries) {
        container.appendChild(createWeeklyScheduleRow(entry));
    }
}

export function createWeeklyScheduleRow(entry = {}) {
    const row = document.createElement('div');
    row.className = 'sb-conversation-weekly-row';
    const dayPills = WEEKDAY_LABELS.map((label, idx) => {
        const checked = Array.isArray(entry.days) && entry.days.includes(idx) ? ' checked' : '';
        return `<label class="sb-conversation-day-pill"><input type="checkbox" class="sb-conv-day-check" data-day="${idx}"${checked} /><span>${label}</span></label>`;
    }).join('');
    row.innerHTML = `
        <div class="sb-conversation-day-pills">${dayPills}</div>
        <div class="sb-conversation-weekly-row-meta">
            <input type="time" class="text_pole textarea_compact sb-conv-weekly-time" value="${escapeHtmlAttribute(entry.time || '08:00')}" aria-label="Schedule time" />
            <input type="text" class="text_pole textarea_compact sb-conv-weekly-message" value="${escapeHtmlAttribute(entry.message || '')}" placeholder="Good morning selfie!" aria-label="Schedule message" />
            <label class="checkbox_label sb-conv-weekly-enabled">
                <input type="checkbox" class="sb-conv-weekly-enabled-check"${entry.enabled !== false ? ' checked' : ''} />
                <span>On</span>
            </label>
            <button type="button" class="menu_button menu_button_icon sb-conv-weekly-remove" data-sb-conversation-action="weekly-remove" title="Remove slot" aria-label="Remove slot">
                <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            </button>
        </div>
    `;
    return row;
}

export function addWeeklyScheduleRow() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    editor.appendChild(createWeeklyScheduleRow({ days: [], time: '08:00', message: '', enabled: true }));
    saveCurrentPanelSettings();
}

export function readWeeklyScheduleFromEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    if (!(editor instanceof HTMLElement)) {
        return '[]';
    }

    const entries = [];
    for (const row of editor.querySelectorAll('.sb-conversation-weekly-row')) {
        const days = [];
        row.querySelectorAll('.sb-conv-day-check:checked').forEach((cb) => {
            const day = parseInt(cb.dataset.day, 10);
            if (!Number.isNaN(day)) {
                days.push(day);
            }
        });
        const timeEl = row.querySelector('.sb-conv-weekly-time');
        const messageEl = row.querySelector('.sb-conv-weekly-message');
        const enabledEl = row.querySelector('.sb-conv-weekly-enabled-check');
        entries.push({
            days,
            time: timeEl instanceof HTMLInputElement ? timeEl.value : '08:00',
            message: messageEl instanceof HTMLInputElement ? messageEl.value : '',
            enabled: enabledEl instanceof HTMLInputElement ? enabledEl.checked : true,
        });
    }

    return JSON.stringify(entries);
}

export function readPartnersFromList(listId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement)) {
        return '';
    }

    const checked = [];
    list.querySelectorAll('.sb-conversation-partner-checkbox:checked').forEach((cb) => {
        if (cb instanceof HTMLInputElement && cb.value) {
            checked.push(cb.value);
        }
    });
    return checked.join(', ');
}

export function readChimingPartnersFromList() {
    return readPartnersFromList('sb_conv_chiming_partner_list');
}

export function updateUserFooter() {
    const footer = document.getElementById(CHROME_IDS.railFooter);
    if (!(footer instanceof HTMLElement)) {
        return;
    }

    const personaName = name1 || 'You';
    const status = getUserStatus();
    const statusCopy = AVAILABILITY_COPY[status] ?? AVAILABILITY_COPY.online;
    const personaStatus = getUserPersonaStatus();

    const avatarEl = document.getElementById('sb_conv_footer_persona_avatar');
    const nameEl = document.getElementById('sb_conv_footer_persona_name');
    const statusEl = document.getElementById('sb_conv_footer_user_status');
    const activeDot = footer.querySelector('.sb-conversation-rail-footer-dot');

    if (avatarEl instanceof HTMLImageElement) {
        const activeAvatar = typeof user_avatar === 'string' ? user_avatar : null;
        avatarEl.decoding = 'async';
        avatarEl.src = getConversationScenarioAvatar() || (activeAvatar ? getThumbnailUrlForViewport('persona', activeAvatar) : (default_user_avatar || ''));
        avatarEl.alt = personaName;
    }
    if (nameEl instanceof HTMLElement) {
        nameEl.textContent = personaName;
        // The persona's name is as written; the 'You' fallback is the app's own and translates.
        setUserTextSlot(nameEl, Boolean(name1));
    }
    if (statusEl instanceof HTMLElement) {
        statusEl.textContent = personaStatus || statusCopy.label;
        statusEl.dataset.status = status;
        statusEl.title = personaStatus ? `${statusCopy.label}: ${statusCopy.detail}` : statusCopy.detail;
    }
    if (activeDot instanceof HTMLElement) {
        activeDot.dataset.status = status;
    }
}

export function toggleUserStatusPicker() {
    const picker = document.getElementById(CHROME_IDS.userStatusPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.personaPicker)?.setAttribute('hidden', '');
    picker.hidden = !isHidden;
}

export function renderConversationPersonaPicker(picker) {
    picker.innerHTML = '';
    const personas = getPersonaOptions();
    const threadAvatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(threadAvatar);
    if (!personas.length) {
        picker.innerHTML = '<div class="sb-conversation-empty">No personas configured.</div>';
        return;
    }

    for (const { avatarId, personaName } of personas) {
        const entry = document.createElement('div');
        entry.className = 'sb-conversation-persona-entry';
        entry.dataset.personaAvatar = avatarId;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sb-conversation-persona-option';
        btn.dataset.sbConversationAction = 'pick-persona';
        btn.dataset.personaAvatar = avatarId;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(avatarId === user_avatar));

        const img = document.createElement('img');
        img.src = getThumbnailUrlForViewport('persona', avatarId);
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';

        const name = document.createElement('span');
        name.className = 'sb-conversation-persona-option-name';
        name.textContent = personaName;
        btn.append(img, name);
        entry.appendChild(btn);

        const appendices = getConversationPersonaAppendices(avatarId);
        if (appendices.length) {
            const activeIds = new Set(getActiveConversationPersonaAppendixIds(avatarId, {
                avatar: threadAvatar,
                groupId,
                personaId: avatarId,
            }));
            const notes = document.createElement('div');
            notes.className = 'sb-conversation-persona-notes';

            const notesTitle = document.createElement('div');
            notesTitle.className = 'sb-conversation-persona-notes-title';
            notesTitle.textContent = 'Scenario Notes';
            notes.appendChild(notesTitle);

            for (const appendix of appendices) {
                const label = document.createElement('label');
                label.className = 'sb-conversation-persona-note-option';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = appendix.id;
                checkbox.dataset.personaAvatar = avatarId;
                checkbox.className = 'sb-conversation-persona-note-checkbox';
                checkbox.checked = activeIds.has(appendix.id);
                const noteName = document.createElement('span');
                noteName.textContent = appendix.name;
                label.append(checkbox, noteName);
                if (appendix.avatar) {
                    const portrait = document.createElement('img');
                    portrait.src = appendix.avatar;
                    portrait.alt = '';
                    portrait.width = 28;
                    portrait.height = 28;
                    portrait.className = 'persona-appendix-avatar';
                    label.insertBefore(portrait, noteName);
                }
                notes.appendChild(label);
            }

            entry.appendChild(notes);
        }

        picker.appendChild(entry);
    }
}

export function togglePersonaPicker() {
    const picker = document.getElementById(CHROME_IDS.personaPicker);
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const isHidden = picker.hidden;
    document.getElementById(CHROME_IDS.userStatusPicker)?.setAttribute('hidden', '');

    if (isHidden) {
        renderConversationPersonaPicker(picker);
    }

    picker.hidden = !isHidden;
}

export function bindWeeklyScheduleEditor() {
    const editor = document.getElementById('sb_conv_weekly_schedule_editor');
    const hiddenInput = document.getElementById('sb_conv_weekly_schedule');
    if (!(editor instanceof HTMLElement)) {
        return;
    }

    const scheduleJson = hiddenInput instanceof HTMLInputElement ? hiddenInput.value : '[]';
    renderWeeklyScheduleEditor(editor, scheduleJson);

    if (editor.dataset.sbConversationBound !== 'true') {
        editor.dataset.sbConversationBound = 'true';
        editor.addEventListener('change', saveCurrentPanelSettings);
    }
}

export function bindPartnerList(listId, searchId) {
    const list = document.getElementById(listId);
    if (!(list instanceof HTMLElement) || list.dataset.sbConversationBound === 'true') {
        return;
    }

    list.dataset.sbConversationBound = 'true';
    list.addEventListener('change', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.sb-conversation-partner-checkbox')) {
            saveCurrentPanelSettings();
        }
    });

    const searchInput = document.getElementById(searchId);
    if (searchInput instanceof HTMLInputElement) {
        searchInput.addEventListener('input', () => {
            const options = list.querySelectorAll('.sb-conversation-partner-option');
            filterConversationPickerRows(options, searchInput.value.toLowerCase().trim(), 'charName');
        });
    }
}

// Lists are drawn once and typing only hides rows. A class, not inline display or the
// hidden attribute: Chrome restyles the whole page for either because :has() rules watch them.
function filterConversationPickerRows(rows, query, nameKey, empty = null) {
    let shown = 0;
    for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue;
        const filtered = Boolean(query) && !String(row.dataset[nameKey] || '').includes(query);
        if (row.classList.contains('displayNone') !== filtered) {
            row.classList.toggle('displayNone', filtered);
        }
        if (!filtered) shown++;
    }
    if (empty instanceof HTMLElement && empty.classList.contains('displayNone') !== (shown > 0)) {
        empty.classList.toggle('displayNone', shown > 0);
    }
}

export function toggleAddDmPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    if (!picker.hasAttribute('hidden') && picker.dataset.pickerType === 'solo') {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'solo';
    picker.dataset.selectedMembers = '';
    picker.onchange = null;
    picker.removeAttribute('hidden');
    picker.innerHTML = `
        <div class="sb-conversation-add-dm-header">
            <span style="font-weight: var(--sb-weight-title); font-size: var(--sb-type-meta);">Create a solo DM</span>
            <p class="sb-conversation-field-hint" style="margin: 4px 0 0;">Create a new solo DM with a character card of your choice.</p>
            <input type="text" id="sb_conversation_add_dm_search" class="text_pole textarea_compact" placeholder="Search characters..." style="inline-size: 100%; margin-top: 8px;" />
        </div>
        <div class="sb-conversation-add-dm-list" id="sb_conversation_add_dm_list" style="margin-top: 8px; max-block-size: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
    `;

    const listContainer = document.getElementById('sb_conversation_add_dm_list');
    const searchInput = document.getElementById('sb_conversation_add_dm_search');

    function renderList() {
        if (!listContainer) return;
        const rows = [];
        (Array.isArray(characters) ? characters : []).forEach((character, idx) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';

            const thumb = getThumbnailUrlForViewport('avatar', character.avatar);
            rows.push(`
                <button type="button" class="sb-conversation-add-dm-option" data-sb-conversation-action="add-character-dm" data-character-index="${idx}" data-search-name="${escapeHtmlAttribute(name.toLowerCase())}" style="display: flex; align-items: center; gap: 8px; inline-size: 100%; background: none; border: none; padding: 6px; border-radius: var(--sb-radius-sm); text-align: left; cursor: pointer; color: inherit;">
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" style="inline-size: 24px; block-size: 24px; border-radius: 50%; object-fit: cover;" loading="lazy" decoding="async" />
                    <span${character.name ? ' translate="no"' : ''} style="font-size: var(--sb-type-caption);">${escapeHtmlText(name)}</span>
                </button>
            `);
        });

        const emptyHidden = rows.length ? ' displayNone' : '';
        listContainer.innerHTML = rows.join('')
            + `<div class="sb-conversation-empty${emptyHidden}" data-sb-picker-empty style="padding: 8px; font-size: var(--sb-type-meta); opacity: 0.7;">No matching characters found.</div>`;
    }

    renderList();

    if (searchInput instanceof HTMLInputElement && listContainer) {
        searchInput.focus({ preventScroll: true });
        const options = listContainer.querySelectorAll('.sb-conversation-add-dm-option');
        const empty = listContainer.querySelector('[data-sb-picker-empty]');
        searchInput.addEventListener('input', () => {
            filterConversationPickerRows(options, searchInput.value.toLowerCase().trim(), 'searchName', empty);
        });
    }
}

export function hideConversationStartPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (picker instanceof HTMLElement) {
        picker.setAttribute('hidden', '');
    }
}

export function openPalsRail() {
    setPalsRailOpen(true);
}

export function getUniqueConversationGroupMembers(memberAvatars) {
    const members = [];
    for (const avatar of Array.isArray(memberAvatars) ? memberAvatars : []) {
        if (avatar && !members.includes(avatar) && getCharacterForAvatar(avatar)) {
            members.push(avatar);
        }
    }

    return members;
}

export function getConversationGroupMemberNames(memberAvatars) {
    return getUniqueConversationGroupMembers(memberAvatars)
        .map(avatar => getCharacterForAvatar(avatar)?.name || 'Character')
        .filter(Boolean);
}

export function buildConversationGroupName(memberAvatars) {
    const names = getConversationGroupMemberNames(memberAvatars);
    if (!names.length) {
        return 'Conversation Group';
    }

    const visibleNames = names.slice(0, 3).join(', ');
    const hiddenCount = Math.max(0, names.length - 3);
    return `Group: ${visibleNames}${hiddenCount ? ` +${hiddenCount}` : ''}`;
}

export function cloneConversationStoreValue(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

export function copyConversationThreadToGroup(sourceAvatar, targetGroupId, { sourceGroupId = '' } = {}) {
    if (!sourceAvatar || !targetGroupId) {
        return false;
    }

    const sourceStore = getConversationThreadStore(sourceAvatar, { create: false, groupId: sourceGroupId || '' });
    const targetStore = getConversationThreadStore(sourceAvatar, { create: true, groupId: targetGroupId });
    if (!sourceStore?.branches || !targetStore) {
        return false;
    }

    const clonedBranches = cloneConversationStoreValue(sourceStore.branches);
    targetStore.activeBranchId = sourceStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches = clonedBranches && typeof clonedBranches === 'object'
        ? clonedBranches
        : { [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID) };

    const activeBranchId = targetStore.activeBranchId || DEFAULT_BRANCH_ID;
    targetStore.branches[activeBranchId] = normalizeConversationBranch(targetStore.branches[activeBranchId], activeBranchId);
    targetStore.branches[activeBranchId].sessionMarkers = {
        ...(targetStore.branches[activeBranchId].sessionMarkers || {}),
        copied_to_group_at: Date.now(),
    };
    persistConversationStore();
    return true;
}

export async function createConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const members = getUniqueConversationGroupMembers(memberAvatars);
    if (members.length < 2) {
        toastr.warning('Pick at least two characters for a group Conversation.');
        return null;
    }

    const group = createConversationGroupRecord(members, {
        name: buildConversationGroupName(members),
        avatarUrl: default_avatar,
        settings: getDefaultGroupConversationSettings(),
    });
    if (!group?.id) {
        toastr.error('Could not create group Conversation.');
        return null;
    }

    if (sourceAvatar && copySourceGroupId !== null) {
        copyConversationThreadToGroup(sourceAvatar, group.id, { sourceGroupId: copySourceGroupId || '' });
    }

    return group;
}

export async function createAndOpenConversationGroup(memberAvatars, { sourceAvatar = '', copySourceGroupId = null } = {}) {
    const group = await createConversationGroup(memberAvatars, { sourceAvatar, copySourceGroupId });
    if (!group?.id || !Array.isArray(group.members)) {
        return false;
    }

    const targetAvatar = sourceAvatar && group.members.includes(sourceAvatar)
        ? sourceAvatar
        : group.members.find(avatar => getCharacterForAvatar(avatar));
    if (!targetAvatar) {
        toastr.warning('This group does not have any available character cards for Conversation Mode.');
        return false;
    }

    hideConversationStartPicker();
    closePalsRail();
    const opened = await selectConversationThread(targetAvatar, {
        groupId: String(group.id),
        showToast: false,
    });
    if (opened) {
        schedulePalsRailRender();
        if (typeof power_user === 'undefined' || power_user?.auto_focus_chat_input !== false) {
            setTimeout(() => {
                if (typeof power_user === 'undefined' || power_user?.auto_focus_chat_input !== false) {
                    document.getElementById(CHROME_IDS.input)?.focus?.({ preventScroll: true });
                }
            }, 100);
        }
        toastr.success(`Opened group Conversation for ${group.name || 'this group'}.`);
    }

    return opened;
}

export function getCurrentGroupMemberAvatars(groupId) {
    const group = getConversationGroupById(groupId);
    if (!group?.members?.length) {
        return [];
    }

    return group.members.filter(avatar => avatar && !group.disabled_members?.includes(avatar) && getCharacterForAvatar(avatar));
}

export function toggleConversationGroupPicker({ sourceAvatar = '', sourceGroupId = '' } = {}) {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return;
    }

    const normalizedSourceGroupId = sourceGroupId || '';
    // A Conversation-owned group is edited in place: its members are ticked and nobody is locked. Solo DMs and Roleplay groups keep the old picker.
    const editGroup = sourceAvatar && normalizedSourceGroupId ? getConversationGroupById(normalizedSourceGroupId) : null;
    const editMode = editGroup?.is_conversation_group === true;
    const sourceMembers = normalizedSourceGroupId ? getCurrentGroupMemberAvatars(normalizedSourceGroupId) : [];
    const lockedMembers = new Set(sourceAvatar && !editMode ? (sourceMembers.length ? sourceMembers : [sourceAvatar]) : []);
    const selectedMembers = new Set(editMode ? sourceMembers : lockedMembers);
    const listedAvatars = editMode
        ? orderConversationGroupPickerAvatars((Array.isArray(characters) ? characters : []).map(character => character?.avatar).filter(Boolean), editGroup.members)
        : [];
    const copyFromCurrentThread = false;

    if (!picker.hasAttribute('hidden')
        && picker.dataset.pickerType === 'group'
        && picker.dataset.sourceAvatar === (sourceAvatar || '')
        && picker.dataset.copySourceGroupId === normalizedSourceGroupId) {
        picker.setAttribute('hidden', '');
        return;
    }

    picker.dataset.pickerType = 'group';
    picker.dataset.sourceAvatar = sourceAvatar || '';
    picker.dataset.copySource = String(copyFromCurrentThread);
    picker.dataset.copySourceGroupId = normalizedSourceGroupId;
    picker.removeAttribute('hidden');

    const title = sourceAvatar
        ? (normalizedSourceGroupId ? 'Add members to this group' : 'Add members to this DM')
        : 'Create a group DM';
    const description = sourceAvatar
        ? 'Selected members will open as a separate group Conversation with its own history and group controls.'
        : 'Create a new group DM with two or more of your character cards.';

    // What the editor was drawn with, read once: saving sends only the difference from this, so a change made elsewhere meanwhile is kept.
    picker.dataset.editGroupId = editMode ? normalizedSourceGroupId : '';
    if (editMode) {
        picker.dataset.visibleMembers = JSON.stringify(listedAvatars);
        picker.dataset.baseMembers = JSON.stringify(editGroup.members);
        picker.dataset.baseDisabled = JSON.stringify(editGroup.disabled_members || []);
        picker.dataset.baseName = editGroup.name || '';
    }

    picker.innerHTML = editMode ? `
        <div class="sb-conversation-add-dm-header">
            <span class="sb-conversation-add-dm-title">Edit group DM members</span>
            <p class="sb-conversation-field-hint sb-conversation-add-dm-description">Tick the pals in this group DM. Its messages and memory stay, and everyone keeps their own DM.</p>
            <input type="text" id="sb_conversation_group_search" class="text_pole textarea_compact sb-conversation-add-dm-search" placeholder="Search characters..." />
        </div>
        <div class="sb-conversation-add-dm-list sb-conversation-group-list" id="sb_conversation_group_list"></div>
        <div class="sb-conversation-group-picker-actions sb-conversation-group-picker-actions-stacked">
            <span id="sb_conversation_group_selected_count" class="sb-conversation-field-hint sb-conversation-group-selected-count"></span>
            <span class="sb-conversation-group-picker-buttons">
                <button type="button" class="menu_button" data-sb-conversation-action="cancel-conversation-group">Cancel</button>
                <button type="button" class="menu_button menu_button_primary" data-sb-conversation-action="save-conversation-group-members">Save members</button>
            </span>
        </div>
        <div class="sb-conversation-group-picker-actions sb-conversation-group-picker-actions-stacked">
            <span class="sb-conversation-field-hint sb-conversation-group-selected-count">Or keep this group as it is and start a separate one with no messages.</span>
            <span class="sb-conversation-group-picker-buttons">
                <button type="button" class="menu_button" data-sb-conversation-action="create-conversation-group">Start a new group instead</button>
            </span>
        </div>
    ` : `
        <div class="sb-conversation-add-dm-header">
            <span class="sb-conversation-add-dm-title">${escapeHtmlText(title)}</span>
            <p class="sb-conversation-field-hint sb-conversation-add-dm-description">${escapeHtmlText(description)}</p>
            <input type="text" id="sb_conversation_group_search" class="text_pole textarea_compact sb-conversation-add-dm-search" placeholder="Search characters..." />
        </div>
        <div class="sb-conversation-add-dm-list sb-conversation-group-list" id="sb_conversation_group_list"></div>
        <div class="sb-conversation-group-picker-actions">
            <span id="sb_conversation_group_selected_count" class="sb-conversation-field-hint sb-conversation-group-selected-count"></span>
            <span class="sb-conversation-group-picker-buttons">
                <button type="button" class="menu_button" data-sb-conversation-action="cancel-conversation-group">Cancel</button>
                <button type="button" class="menu_button" data-sb-conversation-action="create-conversation-group">Create Group</button>
            </span>
        </div>
    `;
    // The same box is reused for every opening, so it keeps its scroll position unless it is put back at the top here (not in the search or count redraws, which keep it).
    picker.scrollTop = 0;

    const listContainer = document.getElementById('sb_conversation_group_list');
    const searchInput = document.getElementById('sb_conversation_group_search');
    const selectedCount = document.getElementById('sb_conversation_group_selected_count');
    const createButton = picker.querySelector('[data-sb-conversation-action="create-conversation-group"]');
    const saveButton = picker.querySelector('[data-sb-conversation-action="save-conversation-group-members"]');

    function syncSelectedMembers() {
        lockedMembers.forEach(avatar => selectedMembers.add(avatar));
        picker.dataset.selectedMembers = JSON.stringify([...selectedMembers]);
        if (editMode) {
            const edit = computeConversationGroupMemberEdit({
                members: editGroup.members,
                disabled: editGroup.disabled_members || [],
                selected: [...selectedMembers],
                visible: listedAvatars,
            });
            if (selectedCount instanceof HTMLElement) {
                selectedCount.textContent = edit.tooFew
                    ? 'A group DM needs at least two pals. To end this one, use its bin button in Pals.'
                    : `${edit.count} selected`;
            }
            if (saveButton instanceof HTMLButtonElement) saveButton.disabled = edit.tooFew || edit.unchanged;
            if (createButton instanceof HTMLButtonElement) createButton.disabled = edit.count < 2;
            return;
        }
        if (selectedCount instanceof HTMLElement) {
            selectedCount.textContent = `${selectedMembers.size} selected`;
        }
        if (createButton instanceof HTMLButtonElement) {
            createButton.disabled = selectedMembers.size < 2;
        }
    }

    function renderList() {
        if (!(listContainer instanceof HTMLElement)) return;
        const rows = [];
        const rowCharacters = editMode
            ? listedAvatars.map(avatar => characters.find(character => character?.avatar === avatar)).filter(Boolean)
            : (Array.isArray(characters) ? characters : []);
        rowCharacters.forEach((character) => {
            if (!character?.avatar) return;
            const name = character.name || 'Character';

            const checked = selectedMembers.has(character.avatar) ? ' checked' : '';
            const disabled = lockedMembers.has(character.avatar) ? ' disabled' : '';
            const thumb = getThumbnailUrlForViewport('avatar', character.avatar);
            rows.push(`
                <label class="sb-conversation-add-dm-option sb-conversation-group-member-option" data-search-name="${escapeHtmlAttribute(name.toLowerCase())}">
                    <input type="checkbox" class="sb-conversation-group-member-checkbox" value="${escapeHtmlAttribute(character.avatar)}"${checked}${disabled} />
                    <img src="${escapeHtmlAttribute(thumb)}" alt="" class="sb-conversation-group-member-avatar" width="24" height="24" loading="lazy" decoding="async" />
                    <span class="sb-conversation-group-member-name">${escapeHtmlText(name)}</span>
                </label>
            `);
        });

        const emptyHidden = rows.length ? ' displayNone' : '';
        listContainer.innerHTML = rows.join('')
            + `<div class="sb-conversation-empty sb-conversation-group-empty${emptyHidden}" data-sb-picker-empty>No matching characters found.</div>`;
        syncSelectedMembers();
    }

    picker.onchange = (event) => {
        const checkbox = event.target instanceof HTMLInputElement && event.target.classList.contains('sb-conversation-group-member-checkbox')
            ? event.target
            : null;
        if (!checkbox) {
            return;
        }

        if (checkbox.checked) {
            selectedMembers.add(checkbox.value);
        } else if (!lockedMembers.has(checkbox.value)) {
            selectedMembers.delete(checkbox.value);
        }
        syncSelectedMembers();
    };

    renderList();

    if (searchInput instanceof HTMLInputElement && listContainer instanceof HTMLElement) {
        searchInput.focus({ preventScroll: true });
        const options = listContainer.querySelectorAll('.sb-conversation-group-member-option');
        const empty = listContainer.querySelector('[data-sb-picker-empty]');
        searchInput.addEventListener('input', () => {
            filterConversationPickerRows(options, searchInput.value.toLowerCase().trim(), 'searchName', empty);
        });
    }
}

/**
 * DM settings of an owned group: draw the real members as a read-only list under 'Group DM Members', with one 'Edit members' button.
 * Returns true when it drew the summary and false when it changed nothing (a solo DM or a Roleplay group keeps its checklist).
 */
export function renderConversationGroupMemberSummary(list, groupId) {
    if (!(list instanceof HTMLElement) || !groupId) {
        return false;
    }
    const group = getConversationGroupById(groupId);
    if (!group || group.is_conversation_group !== true) {
        return false;
    }

    list.replaceChildren();
    list.dataset.sbMemberSummary = 'true';
    for (const avatar of getCurrentGroupMemberAvatars(groupId)) {
        const name = getCharacterForAvatar(avatar)?.name || 'Character';
        const row = document.createElement('div');
        row.className = 'sb-conversation-partner-option';
        row.dataset.charName = name.toLowerCase();
        const pick = document.createElement('span');
        pick.className = 'sb-conversation-partner-pick';
        const image = document.createElement('img');
        image.className = 'sb-conversation-partner-avatar';
        image.src = getThumbnailUrlForViewport('avatar', avatar);
        image.alt = '';
        image.width = 24;
        image.height = 24;
        image.loading = 'lazy';
        image.decoding = 'async';
        const label = document.createElement('span');
        label.className = 'sb-conversation-partner-name';
        label.textContent = name;
        setUserTextSlot(label, true);
        pick.append(image, label);
        row.append(pick);
        list.append(row);
    }

    const hint = document.getElementById('sb_conv_group_members_hint');
    if (hint instanceof HTMLElement) {
        hint.textContent = 'The pals in this group DM. Type @Name, such as @Kaveh, to tag one of them.';
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.dataset.sbConversationAction = 'open-add-member';
    button.textContent = 'Edit members';
    list.after(button);
    const search = document.getElementById('sb_conv_multi_char_search');
    if (search instanceof HTMLElement) {
        search.classList.add('displayNone');
    }
    return true;
}

export async function handleCreateConversationGroupFromPicker() {
    const picker = document.getElementById('sb_conversation_add_dm_picker');
    if (!(picker instanceof HTMLElement)) {
        return false;
    }

    let members = [];
    try {
        members = JSON.parse(picker.dataset.selectedMembers || '[]');
    } catch {
        members = [];
    }

    const sourceAvatar = picker.dataset.sourceAvatar || '';
    const copySourceGroupId = picker.dataset.copySource === 'true' ? picker.dataset.copySourceGroupId || '' : null;
    return createAndOpenConversationGroup(members, { sourceAvatar, copySourceGroupId });
}

export function openAddMemberPicker() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        toastr.warning('Open a Conversation before adding members.');
        return;
    }

    openPalsRail();
    toggleConversationGroupPicker({
        sourceAvatar: avatar,
        sourceGroupId: conversationState.conversationSelectedGroupId || '',
    });
}
