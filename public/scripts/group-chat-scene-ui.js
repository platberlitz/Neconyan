import { characters, chat_metadata, updateChatMetadata, saveMetadata, getThumbnailUrl, eventSource, event_types } from '../script.js';
import { groups, selected_group, updateGroupSpeakerControls } from './group-chats.js';
import { readGroupScene } from './group-chat-visibility.js';
import { t } from './i18n.js';

let initialised = false;

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
    strip.classList.toggle('displayNone', !current);
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
        button.append($('<span></span>').text(`${character.name} · ${present ? t`Present` : t`Away`}`));
        list.append(button);
    }
}

export function initGroupSceneControls() {
    if (initialised) return;
    initialised = true;
    $('#group_scene_toggle').on('click', function () {
        const expanded = this.getAttribute('aria-expanded') !== 'true';
        this.setAttribute('aria-expanded', String(expanded));
        $('#group_scene_panel').toggleClass('displayNone', !expanded);
    });
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
    eventSource.on(event_types.CHAT_CHANGED, renderGroupScene);
    renderGroupScene();
}
