import { chat, characters, Generate, getCurrentChatId, is_send_press, swipe } from '../script.js';
import { groups, is_group_generating, selected_group, updateGroupSpeakerControls } from './group-chats.js';
import { changeGroupScene, currentGroupScene } from './group-chat-scene-ui.js';
import { canGroupMemberSee } from './group-chat-visibility.js';
import { rememberGroupSpeaker } from './group-chat-speakers.js';
import { addLongPressEvent } from './utils.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { SWIPE_DIRECTION } from './constants.js';
import { t } from './i18n.js';

let handlers;

export async function openGroupSpeakerMenu(avatar) {
    const group = groups.find(item => item.id === selected_group);
    const chid = characters.findIndex(character => character.avatar === avatar);
    if (!group?.members.includes(avatar) || chid < 0) return;
    const chatId = getCurrentChatId();
    const name = characters[chid].name;
    const away = currentGroupScene()?.scene.away.includes(avatar);
    const muted = group.disabled_members?.includes(avatar);
    const content = $('<div class="group-speaker-menu"></div>').append($('<h3></h3>').text(name));
    const buttons = [
        { text: muted ? t`Unmute` : t`Mute`, result: 2 },
        { text: away ? t`Bring into the scene` : t`Mark away`, result: 3 },
        { text: t`Edit card`, result: 4 },
    ];
    if (!away && !muted) {
        buttons.push({ text: t`Speak now`, result: 5 });
        if (chat.at(-1) && !chat.at(-1).is_user && !chat.at(-1).is_system && canGroupMemberSee(chat.at(-1), avatar)) {
            buttons.push({ text: t`Regenerate last reply as ${name}`, result: 6 });
        }
    }
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
    } else if (action === 3) {
        const current = currentGroupScene();
        await changeGroupScene({ away: away ? current.scene.away.filter(member => member !== avatar) : [...current.scene.away, avatar] });
    } else if (action === 4) {
        await handlers.editMember($('<div></div>').attr('data-chid', chid));
    } else if (action === 5) {
        await Generate('normal', { force_chid: chid });
    } else if (action === 6) {
        const message = chat.at(-1);
        if (!canGroupMemberSee(message, avatar)) return;
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
