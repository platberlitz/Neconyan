import { characters, chat_metadata, updateChatMetadata, saveMetadata, getThumbnailUrl, eventSource, event_types } from '../script.js';
import { groups, selected_group, updateGroupSpeakerControls } from './group-chats.js';
import { readGroupScene } from './group-chat-visibility.js';
import { t } from './i18n.js';
import { getGroupMemberRole } from './group-chat-roles.js';

let initialised = false;
let sceneExpanded = false;

export function currentGroupScene() {
    const group = groups.find(item => item.id === selected_group);
    return group ? { group, scene: readGroupScene(chat_metadata, group.members) } : null;
}

export async function changeGroupScene(patch) {
    const current = currentGroupScene();
    if (!current) return;
    updateChatMetadata({ group_scene: readGroupScene({ group_scene: { ...current.scene, ...patch } }, current.group.members) });
    renderGroupScene();
    updateGroupSpeakerControls();
    await saveMetadata();
}

export function renderGroupScene() {
    const strip = document.getElementById('group_scene_strip');
    if (!strip) return;
    const current = currentGroupScene();
    const inUse = Boolean(current && (current.scene.location || current.scene.away.length || current.scene.whisper_to.length));
    if (!current) sceneExpanded = false;
    // The strip stays out of the way until it is opened or the scene holds something worth showing.
    strip.classList.toggle('displayNone', !current || !(sceneExpanded || inUse));
    $('#group_scene_panel').toggleClass('displayNone', !sceneExpanded);
    $('#group_scene_toggle').attr('aria-expanded', String(sceneExpanded));
    $('#group_scene_open').attr('aria-pressed', String(sceneExpanded)).toggleClass('has-scene', inUse);
    if (!current) return;
    const { group, scene } = current;
    const present = group.members.length - scene.away.length;
    const summary = scene.location || t`Scene`;
    $('#group_scene_summary').text(`${summary} · ${t`${present} of ${group.members.length} present`}`);
    $('#group_scene_location').val(scene.location);
    const whisper = $('#group_scene_whisper').empty().append($('<option value=""></option>').text(t`To everyone`));
    for (const avatar of group.members) {
        const name = characters.find(item => item.avatar === avatar)?.name || avatar;
        whisper.append($('<option></option>').val(avatar).text(t`Whisper to ${name}`)
            .prop('disabled', scene.away.includes(avatar) || group.disabled_members?.includes(avatar)));
    }
    whisper.val(scene.whisper_to[0] || '');
    const list = $('#group_scene_members').empty();
    for (const avatar of group.members) {
        const character = characters.find(item => item.avatar === avatar);
        if (!character) continue;
        const present = !scene.away.includes(avatar);
        const button = $('<button type="button" class="menu_button group_scene_member"></button>')
            .attr({ 'data-avatar': avatar, 'aria-pressed': String(present), title: present ? t`Mark away` : t`Bring into the scene` });
        button.append($('<img alt="">').attr('src', getThumbnailUrl('avatar', avatar)));
        button.append($('<span class="group_scene_member_name"></span>').text(character.name));
        if (getGroupMemberRole(group, character) === 'narrator') {
            button.append($('<small class="group_scene_member_tag"></small>').text(t`Narrator / GM`));
        }
        if (!present) {
            button.append($('<small class="group_scene_member_tag"></small>').text(t`Away`));
        }
        list.append(button);
    }
}

export function toggleGroupScene(expanded = !sceneExpanded) {
    sceneExpanded = Boolean(expanded);
    renderGroupScene();
}

export function initGroupSceneControls() {
    if (initialised) return;
    initialised = true;
    $('#group_scene_toggle').on('click', () => toggleGroupScene());
    $('#group_speaker_controls').on('click', '#group_scene_open', () => toggleGroupScene());
    $('#group_scene_location').on('change', function () { void changeGroupScene({ location: this.value }); });
    $('#group_scene_whisper').on('change', function () { void changeGroupScene({ whisper_to: this.value ? [this.value] : [] }); });
    $('#group_scene_members').on('click', '[data-avatar]', function () {
        const current = currentGroupScene();
        if (!current) return;
        const avatar = this.dataset.avatar;
        const away = current.scene.away.includes(avatar)
            ? current.scene.away.filter(item => item !== avatar) : [...current.scene.away, avatar];
        void changeGroupScene({ away });
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        sceneExpanded = false;
        renderGroupScene();
    });
    renderGroupScene();
}
