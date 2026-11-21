import { characters, chat, is_send_press } from '../script.js';
import { refreshGroupHeardBadges } from './group-chat-heard-editor.js';
import { copyHeard, everyoneHeard, forgetHeard, heardBy, noOneHeard, parseHeardRange, rememberHeard, transferHeard } from './group-chat-heard-tools.js';
import { changeGroupScene, currentGroupScene } from './group-chat-scene-ui.js';
import { findGroupMemberId, getOpenGroupSceneRules, groups, is_group_generating, saveGroupHearers, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { isFalseBoolean, isTrueBoolean } from './utils.js';

let registered = false;

function openGroup() {
    const group = selected_group ? groups.find(item => item.id === selected_group) : null;
    if (!group) toastr.warning(t`Open a group chat first.`);
    return group || null;
}

function idle() {
    if (!is_send_press && !is_group_generating) return true;
    toastr.info(t`Wait for the current reply to finish.`);
    return false;
}

function characterName(avatar) {
    return characters.find(character => character.avatar === avatar)?.name || String(avatar).replace(/\.[^.]+$/, '');
}

/** Avatars on any message's record, which includes members who have since left. */
function recordedAvatars() {
    return new Set(chat.flatMap(message => message?.extra?.group_scene?.present || []));
}

/**
 * Finds a member by avatar or exact name first, so a near match never edits the wrong memory.
 * With `anyone`, also finds characters outside the group and avatars left on old records.
 * @returns {string|null} Avatar
 */
function resolveMember(group, value, { anyone = false } = {}) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    const named = avatar => avatar === text || characterName(avatar).toLowerCase() === lower;
    const member = group.members.find(named);
    if (member) return member;
    if (anyone) {
        const recorded = [...recordedAvatars()].find(named);
        if (recorded) return recorded;
        const character = characters.find(item => item.avatar === text || item.name?.toLowerCase() === lower);
        if (character?.avatar) return character.avatar;
    }
    const fuzzy = findGroupMemberId(text, true);
    return fuzzy?.avatar && group.members.includes(fuzzy.avatar) ? fuzzy.avatar : null;
}

/** Reads `Kit`, `Kit 3-5` or `name=Kit 3-5` into a member and a message range. */
function readMemberAndRange(group, args, value) {
    const text = String(value ?? '').trim();
    const lastIndex = chat.length - 1;
    if (args.name) {
        const range = parseHeardRange(text, lastIndex);
        return { avatar: resolveMember(group, args.name, { anyone: true }), range, rangeText: text };
    }
    const whole = resolveMember(group, text, { anyone: true });
    if (whole) return { avatar: whole, range: parseHeardRange('', lastIndex), rangeText: '' };
    const split = /^(.*?)\s+(\d+(?:\s*-\s*\d+)?)$/.exec(text);
    if (!split) return { avatar: null, range: null, rangeText: '', name: text };
    return { avatar: resolveMember(group, split[1], { anyone: true }), range: parseHeardRange(split[2], lastIndex), rangeText: split[2], name: split[1] };
}

function warnMissingMember(name) {
    toastr.warning(name ? t`No group member called ${name}.` : t`Name a group member.`);
    return '';
}

function warnRange(text) {
    toastr.warning(t`${text} is not a message number or range in this chat.`);
    return '';
}

async function finishEdit(count) {
    if (count > 0) {
        if (!await saveGroupHearers()) {
            toastr.error(t`Who heard this could not be saved.`);
            return '';
        }
        refreshGroupHeardBadges();
    }
    return String(count);
}

function memberEdit(edit) {
    return async (args, value) => {
        const group = openGroup();
        if (!group || !idle()) return '';
        const { avatar, range, rangeText, name } = readMemberAndRange(group, args, value);
        if (!avatar) return warnMissingMember(args.name || name || String(value ?? '').trim());
        if (!range) return warnRange(rangeText || String(value ?? ''));
        return finishEdit(edit(chat, range, avatar, group.members));
    };
}

function rangeEdit(edit) {
    return async (_args, value) => {
        const group = openGroup();
        if (!group || !idle()) return '';
        const range = parseHeardRange(value, chat.length - 1);
        if (!range) return warnRange(String(value ?? ''));
        return finishEdit(edit(chat, range, group.members));
    };
}

async function copyCallback(args) {
    const group = openGroup();
    if (!group || !idle()) return '';
    const from = parseHeardRange(args.from ?? args.source_index, chat.length - 1);
    const to = parseHeardRange(args.to ?? args.target_index, chat.length - 1);
    if (!from || from.start !== from.end || String(args.from ?? args.source_index ?? '').trim() === '') return warnRange(String(args.from ?? args.source_index ?? ''));
    if (!to || to.start !== to.end || String(args.to ?? args.target_index ?? '').trim() === '') return warnRange(String(args.to ?? args.target_index ?? ''));
    return finishEdit(copyHeard(chat, from.start, to.start, group.members) ? 1 : 0);
}

async function transferCallback(args, value) {
    const group = openGroup();
    if (!group || !idle()) return '';
    const from = resolveMember(group, args.name, { anyone: true });
    if (!from) return warnMissingMember(args.name);
    const to = resolveMember(group, args.to ?? args.replace, { anyone: true });
    if (!to) return warnMissingMember(args.to ?? args.replace);
    const range = parseHeardRange(value, chat.length - 1);
    if (!range) return warnRange(String(value ?? ''));
    const keep = isTrueBoolean(String(args.keep ?? '')) || isFalseBoolean(String(args.forget ?? ''));
    return finishEdit(transferHeard(chat, range, from, to, group.members, { keep }));
}

function getCallback(_args, value) {
    const group = openGroup();
    if (!group) return '';
    const text = String(value ?? '').trim();
    const range = parseHeardRange(text || String(chat.length - 1), chat.length - 1);
    if (!range || range.start !== range.end) return warnRange(text);
    return heardBy(chat[range.start], group.members, getOpenGroupSceneRules()).map(characterName).join(', ');
}

function sceneMemberCallback(away) {
    return async (_args, value) => {
        const group = openGroup();
        if (!group || !idle()) return '';
        const avatar = resolveMember(group, value);
        if (!avatar) return warnMissingMember(String(value ?? '').trim());
        const scene = currentGroupScene()?.scene;
        if (!scene) return '';
        const others = scene.away.filter(item => item !== avatar);
        await changeGroupScene({ away: away ? [...others, avatar] : others });
        return characterName(avatar);
    };
}

async function locationCallback(args, value) {
    const group = openGroup();
    if (!group) return '';
    const scene = currentGroupScene()?.scene;
    const text = String(value ?? '').trim();
    const clear = isTrueBoolean(String(args.clear ?? ''));
    if (!text && !clear) return scene?.location || '';
    if (!idle()) return '';
    await changeGroupScene({ location: clear ? '' : text });
    return currentGroupScene()?.scene.location || '';
}

const memberArgument = () => SlashCommandArgument.fromProps({
    description: t`group member name, optionally followed by a message number or range; the whole chat if none`,
    typeList: [ARGUMENT_TYPE.STRING],
    isRequired: false,
    enumProvider: commonEnumProviders.groupMembers(),
});
const nameArgument = () => SlashCommandNamedArgument.fromProps({
    name: 'name',
    description: t`group member; the unnamed argument is then the message number or range`,
    typeList: [ARGUMENT_TYPE.STRING],
    isRequired: false,
    enumProvider: commonEnumProviders.groupMembers(),
});
const rangeArgument = () => SlashCommandArgument.fromProps({
    description: t`message number (starts with 0) or range; the whole chat if none`,
    typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
    isRequired: false,
    enumProvider: commonEnumProviders.messages(),
});
const indexArgument = (name, description) => SlashCommandNamedArgument.fromProps({
    name,
    description,
    typeList: [ARGUMENT_TYPE.NUMBER],
    isRequired: false,
    enumProvider: commonEnumProviders.messages(),
});

/** Registers the group scene commands once. They work in the open group chat. */
export function registerGroupSceneSlashCommands() {
    if (registered) return;
    registered = true;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-forget',
        aliases: ['presenceForget', 'presenceForgetAll'],
        callback: memberEdit(forgetHeard),
        returns: t`how many messages changed`,
        namedArgumentList: [nameArgument()],
        unnamedArgumentList: [memberArgument()],
        helpString: t`A group member forgets the messages in a range, or the whole chat. Example: /heard-forget Kit 4-9`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-remember',
        aliases: ['presenceRemember', 'presenceRememberAll'],
        callback: memberEdit(rememberHeard),
        returns: t`how many messages changed`,
        namedArgumentList: [nameArgument()],
        unnamedArgumentList: [memberArgument()],
        helpString: t`A group member remembers the messages in a range, or the whole chat. Whispers to someone else stay private. Example: /heard-remember Kit 4-9`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-all',
        aliases: ['presenceForceAllPresent'],
        callback: rangeEdit(everyoneHeard),
        returns: t`how many messages changed`,
        unnamedArgumentList: [rangeArgument()],
        helpString: t`Every group member heard the messages in a range, or the whole chat. Whispers stay private.`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-none',
        aliases: ['presenceForceNonePresent'],
        callback: rangeEdit(noOneHeard),
        returns: t`how many messages changed`,
        unnamedArgumentList: [rangeArgument()],
        helpString: t`No group member heard the messages in a range, or the whole chat.`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-copy',
        aliases: ['presenceCopy'],
        callback: copyCallback,
        returns: t`1 if the second message changed, otherwise 0`,
        namedArgumentList: [
            indexArgument('from', t`message whose listeners are copied`),
            indexArgument('to', t`message that gains them`),
            indexArgument('source_index', t`same as from`),
            indexArgument('target_index', t`same as to`),
        ],
        helpString: t`Everyone who heard one message also hears another. Example: /heard-copy from=3 to=8`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-transfer',
        aliases: ['presenceReplace'],
        callback: transferCallback,
        returns: t`how many messages changed`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'name', description: t`member whose memory moves`, typeList: [ARGUMENT_TYPE.STRING], isRequired: true, enumProvider: commonEnumProviders.groupMembers() }),
            SlashCommandNamedArgument.fromProps({ name: 'to', description: t`member who gains it`, typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumProvider: commonEnumProviders.groupMembers() }),
            SlashCommandNamedArgument.fromProps({ name: 'replace', description: t`same as to`, typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumProvider: commonEnumProviders.groupMembers() }),
            SlashCommandNamedArgument.fromProps({ name: 'keep', description: t`the first member also keeps their memory`, typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false', isRequired: false }),
            SlashCommandNamedArgument.fromProps({ name: 'forget', description: t`false keeps the first member's memory too`, typeList: [ARGUMENT_TYPE.BOOLEAN], isRequired: false }),
        ],
        unnamedArgumentList: [rangeArgument()],
        helpString: t`Moves one member's memory to another: wherever the first heard a message, the second now has. Example: /heard-transfer name=Kit to=Mira keep=true`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'heard-get',
        callback: getCallback,
        returns: t`names of the members who heard the message`,
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: t`message number (starts with 0); the last message if none`,
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: false,
            enumProvider: commonEnumProviders.messages(),
        })],
        helpString: t`Lists who heard a message in the open group chat.`,
    }));
    for (const [name, away] of [['away', true], ['back', false]]) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            callback: sceneMemberCallback(away),
            returns: t`the member's name`,
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: t`group member name`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.groupMembers(),
            })],
            helpString: away
                ? t`Marks a group member away. They miss what is said until they are back.`
                : t`Brings an away group member back into the scene.`,
        }));
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'scene-location',
        callback: locationCallback,
        returns: t`the scene location`,
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'clear', description: t`clears the location`, typeList: [ARGUMENT_TYPE.BOOLEAN], isRequired: false })],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: t`where the scene is; leave out to read it`, typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: t`Sets or reads where the open group scene takes place.`,
    }));
}
