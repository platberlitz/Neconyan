import { canGroupMemberSee, changeGroupHearers } from './group-chat-visibility.js';

/** The SillyTavern Presence extension marks a message every member may see with this pseudo-member. */
const PRESENCE_UNIVERSAL_TRACKER = 'presence_universal_tracker';

/**
 * Reads what the SillyTavern Presence extension saved in a chat into Neconyan's own records.
 * Each message's `present` list becomes who heard it, and members the extension let see everything
 * become members who see everything. Messages that already have a Neconyan record keep it, and the
 * extension's own fields stay in place.
 * @param {object[]} messages Chat messages, without the header
 * @param {object} metadata Chat metadata
 * @returns {boolean} Whether anything changed
 */
export function importPresenceRecords(messages, metadata) {
    let changed = false;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object' || !Array.isArray(message.present) || message.extra?.group_scene) continue;
        if (message.present.includes(PRESENCE_UNIVERSAL_TRACKER)) continue;
        const present = [...new Set(message.present.filter(avatar => typeof avatar === 'string' && avatar))];
        if (!message.extra || typeof message.extra !== 'object') message.extra = {};
        message.extra.group_scene = { present, whisper_to: [] };
        changed = true;
    }
    if (!metadata || typeof metadata !== 'object' || metadata.group_scene) return changed;
    const modes = metadata.presence_extension?.char_mode;
    const seesAll = new Set([
        ...(Array.isArray(metadata.ignore_presence) ? metadata.ignore_presence : []),
        ...(modes && typeof modes === 'object' ? Object.keys(modes).filter(avatar => modes[avatar] === 'ignore') : []),
    ].filter(avatar => typeof avatar === 'string' && avatar));
    if (!seesAll.size) return changed;
    metadata.group_scene = { away: [], location: '', whisper_to: [], sees_all: [...seesAll] };
    return true;
}

/**
 * Reads a message number or range such as `4` or `2-7`. Empty means the whole chat.
 * @param {unknown} value Command argument
 * @param {number} lastIndex Last message number
 * @returns {{ start: number, end: number } | null} Inclusive range, or null when it is not a range
 */
export function parseHeardRange(value, lastIndex) {
    if (lastIndex < 0) return null;
    const text = String(value ?? '').trim();
    if (!text) return { start: 0, end: lastIndex };
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(text);
    if (!match) return null;
    const first = Number(match[1]);
    const second = match[2] === undefined ? first : Number(match[2]);
    const start = Math.min(first, second);
    const end = Math.min(Math.max(first, second), lastIndex);
    return start > end ? null : { start, end };
}

function eachInRange(messages, range, callback) {
    let count = 0;
    for (let index = range.start; index <= range.end; index++) {
        const message = messages[index];
        if (message && typeof message === 'object' && callback(message, index)) count++;
    }
    return count;
}

/** Whether a message's record lists the member, counting a message without a record as heard by every member. */
function listsHearer(message, avatar, members) {
    const present = message?.extra?.group_scene?.present;
    return Array.isArray(present) ? present.includes(avatar) : members.includes(avatar);
}

/** Removes a member from who heard each message in the range. Returns how many messages changed. */
export function forgetHeard(messages, range, avatar, members) {
    return eachInRange(messages, range, message => changeGroupHearers(message, { remove: [avatar] }, members));
}

/** Adds a member to who heard each message in the range. Whispers to someone else stay private. */
export function rememberHeard(messages, range, avatar, members) {
    return eachInRange(messages, range, message => {
        const whisper = message.extra?.group_scene?.whisper_to;
        if (whisper?.length && !whisper.includes(avatar)) return false;
        return changeGroupHearers(message, { add: [avatar] }, members);
    });
}

/** Every current member heard each message in the range. Whispers stay with the people they were for. */
export function everyoneHeard(messages, range, members) {
    return eachInRange(messages, range, message => changeGroupHearers(message, { exact: members }, members));
}

/** No member heard any message in the range. */
export function noOneHeard(messages, range, members) {
    return eachInRange(messages, range, message => changeGroupHearers(message, { exact: [] }, members));
}

/** Everyone who heard one message also hears another. Returns whether the target changed. */
export function copyHeard(messages, fromIndex, toIndex, members) {
    const source = messages[fromIndex];
    const target = messages[toIndex];
    if (!source || !target || source === target) return false;
    const present = source.extra?.group_scene?.present;
    return changeGroupHearers(target, { add: Array.isArray(present) ? present : members }, members);
}

/**
 * Gives one member's memory of the range to another: wherever `from` heard a message, `to` hears it too,
 * and `from` forgets it unless `keep` is set. Whispers stay with the people they were for.
 */
export function transferHeard(messages, range, from, to, members, { keep = false } = {}) {
    return eachInRange(messages, range, message => {
        if (!listsHearer(message, from, members)) return false;
        const whisper = message.extra?.group_scene?.whisper_to;
        const add = whisper?.length && !whisper.includes(to) ? [] : [to];
        return changeGroupHearers(message, { add, remove: keep ? [] : [from] }, members);
    });
}

/**
 * Who can hear a message: current members it reaches, plus anyone on its record who has left the group.
 * @returns {string[]} Avatars
 */
export function heardBy(message, members, rules = {}) {
    if (!message || typeof message !== 'object') return [];
    const present = message.extra?.group_scene?.present;
    const listed = [...new Set([...members, ...(Array.isArray(present) ? present : [])])];
    return listed.filter(avatar => canGroupMemberSee(message, avatar, members.includes(avatar) ? rules : {}));
}
