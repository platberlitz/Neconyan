import { chat, characters, getCurrentChatId, getThumbnailUrlForViewport, is_send_press, updateMessageMetaBadges } from '../script.js';
import { getOpenGroupSceneRules, groups, is_group_generating, saveGroupHearers, selected_group } from './group-chats.js';
import { changeGroupHearers } from './group-chat-visibility.js';
import { getGroupMemberRole } from './group-chat-roles.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';

let initialized = false;

function isBusy() {
    return is_send_press || is_group_generating;
}

/** Redraws the heard-by badges of every message on screen. */
export function refreshGroupHeardBadges() {
    for (const element of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(element.getAttribute('mesid'));
        if (chat[index]) updateMessageMetaBadges($(element), chat[index]);
    }
}

function memberButton(avatar, { pressed, disabled, tags }) {
    const character = characters.find(item => item.avatar === avatar);
    const button = $('<button type="button" class="menu_button group_heard_member"></button>')
        .attr('data-avatar', avatar)
        .attr('aria-pressed', String(pressed))
        .prop('disabled', disabled);
    button.append($('<img alt="">').attr('src', getThumbnailUrlForViewport('avatar', avatar)));
    button.append($('<span class="group_heard_member_name"></span>').text(character?.name || avatar.replace(/\.[^.]+$/, '')));
    for (const tag of tags) button.append($('<small class="group_scene_member_tag"></small>').text(tag));
    return button;
}

function choiceButton(text, value, pressed) {
    return $('<button type="button" class="menu_button group_heard_range_option"></button>')
        .attr('data-range', value)
        .attr('aria-pressed', String(pressed))
        .text(text);
}

/**
 * Opens the sheet that shows and changes who heard one message of the open group chat.
 * @param {number} messageId Message index
 */
export async function openGroupHeardEditor(messageId) {
    const group = groups.find(item => item.id === selected_group);
    const message = chat[messageId];
    if (!group || !message || message.is_system) return;
    if (isBusy()) {
        toastr.info(t`Wait for the current reply to finish.`);
        return;
    }
    const chatId = getCurrentChatId();
    const members = [...group.members];
    const seesAll = getOpenGroupSceneRules().seesAll || [];
    const audience = message.extra?.group_scene;
    const original = Array.isArray(audience?.present) ? [...new Set(audience.present)] : [...members];
    const whisperTo = Array.isArray(audience?.whisper_to) ? audience.whisper_to : [];
    const listed = [...members, ...original.filter(avatar => !members.includes(avatar))];
    const selected = new Set(original);
    let range = 'one';

    const content = $('<div class="group_heard_editor"></div>');
    content.append($('<h3></h3>').text(t`Who heard this`));
    content.append($('<p class="group_heard_hint"></p>').text(t`Members only remember the lines they heard, and their replies are written from those.`));
    if (whisperTo.length) {
        content.append($('<p class="group_heard_hint"></p>').text(t`This was a whisper, so only the people it was for can hear it.`));
    }
    const list = $('<div class="group_heard_members" role="group"></div>').attr('aria-label', t`Who heard this`);
    for (const avatar of listed) {
        const character = characters.find(item => item.avatar === avatar);
        const left = !members.includes(avatar);
        const allSeeing = !left && seesAll.includes(avatar);
        const excluded = whisperTo.length > 0 && !whisperTo.includes(avatar);
        const tags = [];
        if (!left && character && getGroupMemberRole(group, character) === 'narrator') tags.push(t`Narrator / GM`);
        if (allSeeing) tags.push(t`Sees everything`);
        if (left) tags.push(t`Left the group`);
        list.append(memberButton(avatar, {
            pressed: allSeeing ? !excluded : !excluded && selected.has(avatar),
            disabled: allSeeing || excluded,
            tags,
        }));
    }
    content.append(list);

    const quick = $('<div class="group_heard_quick"></div>')
        .append($('<button type="button" class="menu_button" data-heard-all></button>').text(t`Everyone`))
        .append($('<button type="button" class="menu_button" data-heard-none></button>').text(t`No one`));
    content.append(quick);

    const later = chat.slice(messageId + 1).some(item => !item?.is_system);
    if (later) {
        const rangeRow = $('<div class="group_heard_range" role="group"></div>').attr('aria-label', t`Change`);
        rangeRow.append(choiceButton(t`This message`, 'one', true), choiceButton(t`From here on`, 'later', false));
        content.append(rangeRow);
    }

    const syncButtons = () => {
        list.find('.group_heard_member:not(:disabled)').each(function () {
            this.setAttribute('aria-pressed', String(selected.has(this.dataset.avatar)));
        });
    };
    content.on('click', '.group_heard_member', function () {
        if (this.disabled) return;
        const avatar = this.dataset.avatar;
        if (selected.has(avatar)) selected.delete(avatar);
        else selected.add(avatar);
        syncButtons();
    });
    content.on('click', '[data-heard-all]', () => {
        list.find('.group_heard_member:not(:disabled)').each(function () { selected.add(this.dataset.avatar); });
        syncButtons();
    });
    content.on('click', '[data-heard-none]', () => {
        list.find('.group_heard_member:not(:disabled)').each(function () { selected.delete(this.dataset.avatar); });
        syncButtons();
    });
    content.on('click', '.group_heard_range_option', function () {
        range = this.dataset.range;
        content.find('.group_heard_range_option').each(function () {
            this.setAttribute('aria-pressed', String(this.dataset.range === range));
        });
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        allowVerticalScrolling: true,
        onClosing: popupInstance => {
            if (popupInstance.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            if (selected_group !== group.id || getCurrentChatId() !== chatId || chat[messageId] !== message) {
                toastr.warning(t`This chat changed, so the action was cancelled.`);
                return true;
            }
            if (isBusy()) {
                toastr.info(t`Wait for the current reply to finish.`);
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (selected_group !== group.id || getCurrentChatId() !== chatId || chat[messageId] !== message || isBusy()) return;

    // Members who see everything keep their saved place in the list, since tapping them does nothing.
    const exact = listed.filter(avatar => seesAll.includes(avatar) && members.includes(avatar) ? original.includes(avatar) : selected.has(avatar));
    const add = exact.filter(avatar => !original.includes(avatar));
    const remove = original.filter(avatar => !exact.includes(avatar));
    const changed = new Set();
    if (changeGroupHearers(message, { exact }, members)) changed.add(messageId);
    if (range === 'later' && (add.length || remove.length)) {
        for (let index = messageId + 1; index < chat.length; index++) {
            if (chat[index]?.is_system) continue;
            if (changeGroupHearers(chat[index], { add, remove }, members)) changed.add(index);
        }
    }
    if (!changed.size) return;
    if (!await saveGroupHearers()) {
        toastr.error(t`Who heard this could not be saved.`);
        return;
    }
    refreshGroupHeardBadges();
}

/** Opens the heard-by sheet from the message menu and the message badges. */
export function initGroupHeardEditor() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('.mes_heard, .group-heard-badge, .group-whisper-badge') : null;
        const index = Number(target?.closest('.mes')?.getAttribute('mesid'));
        if (!target || !Number.isSafeInteger(index) || !selected_group) return;
        event.preventDefault();
        event.stopPropagation();
        void openGroupHeardEditor(index);
    });
}
