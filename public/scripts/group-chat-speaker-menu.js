import { chat, characters, Generate, getCurrentChatId, is_send_press, swipe } from '../script.js';
import { catchUpGroupMember, forgetGroupMember, groups, is_group_generating, selected_group, updateGroupSpeakerControls } from './group-chats.js';
import { changeGroupScene, currentGroupScene } from './group-chat-scene-ui.js';
import { canGroupMemberSee } from './group-chat-visibility.js';
import { rememberGroupSpeaker } from './group-chat-speakers.js';
import { getGroupMemberRole } from './group-chat-roles.js';
import { refreshGroupHeardBadges } from './group-chat-heard-editor.js';
import { addLongPressEvent, escapeHtml } from './utils.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { SWIPE_DIRECTION } from './constants.js';
import { t } from './i18n.js';

let handlers;
let memoryIds = 0;

function memoryMode(scene, avatar) {
    if (scene?.sees_all.includes(avatar)) return 'all';
    return scene?.with_group?.includes(avatar) ? 'group' : 'heard';
}

/** The member menu's Memory choice: what they heard, only what they heard with the group, or everything. */
function memoryChoice(avatar) {
    const modes = [
        ['heard', t`What they heard`, t`Remembers the lines they were there for.`],
        ['group', t`Only with the group`, t`Remembers a line only while someone else who heard it is in the scene.`],
        ['all', t`Everything`, t`Remembers every line, even ones said while they were away. Whispers to others stay private.`],
    ];
    const label = $('<span class="group_speaker_memory_label"></span>').attr('id', `group_speaker_memory_${++memoryIds}`).text(t`Memory`);
    const options = $('<div class="group_speaker_memory_options" role="group"></div>').attr('aria-labelledby', label.attr('id'));
    const hint = $('<p class="group_speaker_memory_hint" aria-live="polite"></p>');
    for (const [mode, text] of modes) options.append($('<button type="button" class="menu_button group_speaker_memory_option"></button>').attr('data-memory', mode).text(text));
    const sync = () => {
        const mode = memoryMode(currentGroupScene()?.scene, avatar);
        options.children().each(function () { this.setAttribute('aria-pressed', String(this.dataset.memory === mode)); });
        hint.text(modes.find(([value]) => value === mode)[2]);
    };
    options.on('click', 'button', async function () {
        const scene = currentGroupScene()?.scene;
        if (!scene) return;
        const mode = this.dataset.memory;
        const others = list => (list || []).filter(member => member !== avatar);
        await changeGroupScene({
            sees_all: mode === 'all' ? [...others(scene.sees_all), avatar] : others(scene.sees_all),
            with_group: mode === 'group' ? [...others(scene.with_group), avatar] : others(scene.with_group),
        });
        refreshGroupHeardBadges();
        sync();
    });
    sync();
    return $('<div class="group_speaker_memory"></div>').append(label, options, hint);
}

export async function openGroupSpeakerMenu(avatar) {
    const group = groups.find(item => item.id === selected_group);
    const chid = characters.findIndex(character => character.avatar === avatar);
    if (!group?.members.includes(avatar) || chid < 0) return;
    const chatId = getCurrentChatId();
    const name = characters[chid].name;
    const scene = currentGroupScene()?.scene;
    const away = scene?.away.includes(avatar);
    const seesAll = scene?.sees_all.includes(avatar);
    const rules = { seesAll: scene?.sees_all || [] };
    const muted = group.disabled_members?.includes(avatar);
    const narrator = getGroupMemberRole(group, characters[chid]) === 'narrator';
    // Lines before the chat's memory starting point are out of everyone's memory, so there is nothing to catch up on.
    const start = scene?.heard_from || 0;
    const missed = chat.some((message, index) => index >= start && !message?.is_system && !canGroupMemberSee(message, avatar, rules));
    const heardAny = chat.some(message => !message?.is_system && canGroupMemberSee(message, avatar, rules));
    const content = $('<div class="group-speaker-menu"></div>').append($('<h3></h3>').text(name), memoryChoice(avatar));
    const buttons = [];
    if (!away && !muted) {
        buttons.push({ text: t`Speak now`, result: 5, icon: 'fa-comment-dots', classes: ['menu_button_primary', 'group-speaker-menu-primary'] });
        if (chat.at(-1) && !chat.at(-1).is_user && !chat.at(-1).is_system && canGroupMemberSee(chat.at(-1), avatar, rules)) {
            buttons.push({ text: t`Regenerate last reply as ${name}`, result: 6, icon: 'fa-rotate' });
        }
    }
    buttons.push(
        { text: muted ? t`Unmute` : t`Mute`, result: 2, icon: muted ? 'fa-volume-high' : 'fa-volume-xmark' },
        { text: away ? t`Bring into the scene` : t`Mark away`, result: 3, icon: away ? 'fa-door-open' : 'fa-door-closed' },
    );
    if (missed && !seesAll) buttons.push({ text: t`Catch up on what was said`, result: 9, icon: 'fa-forward' });
    if (heardAny && !seesAll) buttons.push({ text: t`Forget everything so far`, result: 10, icon: 'fa-eraser', classes: ['group-speaker-menu-danger'] });
    buttons.push(
        { text: narrator ? t`Use as character` : t`Use as Narrator / GM`, result: 7, icon: 'fa-feather' },
        { text: t`Edit card`, result: 4, icon: 'fa-pen' },
    );
    const action = await callGenericPopup(content, POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: t`Close`, customButtons: buttons });
    if (selected_group !== group.id || getCurrentChatId() !== chatId) return;
    if (is_send_press || is_group_generating) {
        if (Number(action) >= 2) toastr.info(t`Wait for the current reply to finish.`);
        return;
    }
    if (action === 2) {
        group.disabled_members = muted ? (group.disabled_members || []).filter(member => member !== avatar) : [...(group.disabled_members || []), avatar];
        await handlers.saveGroup(group.id);
        updateGroupSpeakerControls();
    } else if (action === 7) {
        group.member_roles = { ...group.member_roles, [avatar]: narrator ? 'character' : 'narrator' };
        await handlers.saveGroup(group.id);
        updateGroupSpeakerControls();
    } else if (action === 3) {
        const current = currentGroupScene();
        await changeGroupScene({ away: away ? current.scene.away.filter(member => member !== avatar) : [...current.scene.away, avatar] });
    } else if (action === 9) {
        const count = await catchUpGroupMember(avatar);
        if (count) toastr.success(t`${name} now remembers what was said.`);
    } else if (action === 10) {
        const confirmed = await callGenericPopup(t`${escapeHtml(name)} will no longer remember anything said in this chat so far. You can give it back with Catch up on what was said.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Forget`, cancelButton: t`Cancel` });
        if (!confirmed || selected_group !== group.id || getCurrentChatId() !== chatId) return;
        if (is_send_press || is_group_generating) {
            toastr.info(t`Wait for the current reply to finish.`);
            return;
        }
        const count = await forgetGroupMember(avatar);
        if (count) toastr.success(t`${name} has forgotten what was said.`);
    } else if (action === 4) {
        await handlers.editMember($('<div></div>').attr('data-chid', chid));
    } else if (action === 5) {
        await Generate('normal', { force_chid: chid });
    } else if (action === 6) {
        const message = chat.at(-1);
        if (!canGroupMemberSee(message, avatar, { seesAll: currentGroupScene()?.scene.sees_all || [] })) return;
        rememberGroupSpeaker(message);
        await swipe(null, SWIPE_DIRECTION.RIGHT, { forceSwipeId: message.swipes?.length || 1, generationOptions: { force_chid: chid, skipNativeRoleplay: true } });
    }
}

export function initGroupSpeakerMenu(actions) {
    if (handlers) return;
    handlers = actions;
    const selector = '.group_speaker_avatar, .group_scene_member';
    addLongPressEvent(selector, function () { void openGroupSpeakerMenu(this.dataset.avatar); });
    $(document).on('contextmenu', selector, function (event) {
        event.preventDefault();
        void openGroupSpeakerMenu(this.dataset.avatar);
    });
    $(document).on('keydown', selector, function (event) {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            void openGroupSpeakerMenu(this.dataset.avatar);
        }
    });
}
