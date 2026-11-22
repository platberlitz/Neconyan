/** Scene state is chat-scoped. Each message records its audience at creation time. */
export function readGroupScene(metadata, members) {
    const scene = metadata?.group_scene || {};
    const valid = values => Array.isArray(values) ? [...new Set(values)].filter(avatar => members.includes(avatar)) : [];
    const start = readGroupSceneStart(metadata);
    return { away: valid(scene.away), location: String(scene.location || '').slice(0, 300), whisper_to: valid(scene.whisper_to), sees_all: valid(scene.sees_all), ...(start ? { heard_from: start } : {}) };
}

/** The first message members remember in this chat, or 0 when they remember the whole chat. */
export function readGroupSceneStart(metadata) {
    const start = metadata?.group_scene?.heard_from;
    return Number.isSafeInteger(start) && start > 0 ? start : 0;
}

/**
 * Rules a saved chat header applies to every speaker: members who see everything except other people's whispers,
 * and, given the chat's messages, the lines before the chat's memory starting point, which nobody hears.
 * @param {object} metadata Chat metadata
 * @param {object[]|null} [messages] Chat messages, without the saved header
 */
export function readGroupSceneRules(metadata, messages = null) {
    const seesAll = metadata?.group_scene?.sees_all;
    const start = Array.isArray(messages) ? readGroupSceneStart(metadata) : 0;
    return {
        ...(Array.isArray(seesAll) && seesAll.length ? { seesAll: [...seesAll] } : {}),
        ...(start ? { before: new Set(messages.slice(0, start)) } : {}),
    };
}

/** Members whose cards a joined-cards prompt includes: everyone still in the scene, and always the speakers. */
export function groupSceneCardMembers(metadata, members, speakers = []) {
    const away = readGroupScene(metadata, members).away;
    return members.filter(avatar => speakers.includes(avatar) || !away.includes(avatar));
}

export function groupMessageAudience(scene, members, whisperTargets = []) {
    const present = members.filter(avatar => !scene.away.includes(avatar));
    return { present, whisper_to: [...whisperTargets] };
}

/**
 * Missing audience means an older public message, before scene tracking was enabled.
 * `everyone: true` marks a line every member hears, including members away now or added later.
 * `rules.seesAll` lists members who see every message except whispers to someone else;
 * `rules.replyTarget` is the message a speaker is replying to, which they always hear;
 * `rules.before` holds the lines before the chat's memory starting point, which no member hears.
 */
export function canGroupMemberSee(message, avatar, rules = {}) {
    if (rules.before?.has(message)) return false;
    const audience = message?.extra?.group_scene;
    if (!audience) return true;
    if (audience.whisper_to?.length && !audience.whisper_to.includes(avatar)) return false;
    if (audience.everyone === true) return true;
    if (rules.seesAll?.includes(avatar) || (rules.replyTarget && message === rules.replyTarget)) return true;
    return !Array.isArray(audience.present) || audience.present.includes(avatar);
}

/**
 * Records that a member heard a message, on the message and its selected swipe (or every swipe). Whispers to someone else stay private.
 * @param {object} message Chat message
 * @param {string} avatar Member avatar
 * @param {{ everySwipe?: boolean }} [options]
 * @returns {boolean} Whether anything changed
 */
export function addGroupHearer(message, avatar, { everySwipe = false } = {}) {
    const swipes = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
    const chosen = everySwipe ? swipes : [swipes[message?.swipe_id ?? 0]];
    let changed = false;
    for (const audience of new Set([message?.extra?.group_scene, ...chosen.map(info => info?.extra?.group_scene)])) {
        if (!Array.isArray(audience?.present) || audience.everyone === true || audience.present.includes(avatar)) continue;
        if (audience.whisper_to?.length && !audience.whisper_to.includes(avatar)) continue;
        audience.present.push(avatar);
        changed = true;
    }
    return changed;
}

/** Applies `update` to the record on a message and on every swipe with its own record. */
function updateGroupAudiences(message, update) {
    let changed = false;
    const next = update(message.extra?.group_scene);
    if (next) {
        message.extra ??= {};
        message.extra.group_scene = next;
        changed = true;
    }
    for (const info of Array.isArray(message.swipe_info) ? message.swipe_info : []) {
        const own = info?.extra?.group_scene;
        const swipeNext = own ? update(own) : null;
        if (!swipeNext) continue;
        info.extra.group_scene = swipeNext;
        changed = true;
    }
    return changed;
}

/**
 * Changes who heard a message, on the message and on every swipe with its own record.
 * A message without a record, or one every member hears, counts as heard by every member;
 * a change that leaves someone out turns an 'everyone' line into an ordinary list.
 * @param {object} message Chat message
 * @param {{ exact?: string[]|null, add?: string[], remove?: string[] }} change `exact` replaces the list; `add` and `remove` adjust it
 * @param {string[]} members Current group members
 * @returns {boolean} Whether anything changed
 */
export function changeGroupHearers(message, { exact = null, add = [], remove = [] } = {}, members = []) {
    if (!message || typeof message !== 'object') return false;
    return updateGroupAudiences(message, audience => {
        const before = audience?.everyone !== true && Array.isArray(audience?.present) ? audience.present : members;
        const next = exact ? [...new Set(exact)] : [...new Set([...before, ...add])].filter(avatar => !remove.includes(avatar));
        if (next.length === new Set(before).size && next.every(avatar => before.includes(avatar))) return null;
        const changed = { ...(audience || {}), present: next, whisper_to: [...(audience?.whisper_to || [])] };
        delete changed.everyone;
        return changed;
    });
}

/**
 * Marks a message as heard by every member, now and later, or turns that back into the list it had.
 * Whispers stay private.
 * @param {object} message Chat message
 * @param {string[]} members Current group members
 * @param {boolean} [everyone]
 * @returns {boolean} Whether anything changed
 */
export function setGroupEveryoneHears(message, members, everyone = true) {
    if (!message || typeof message !== 'object') return false;
    return updateGroupAudiences(message, audience => {
        if (audience?.whisper_to?.length || (audience?.everyone === true) === everyone) return null;
        if (!everyone) {
            const listed = { ...audience };
            delete listed.everyone;
            return listed;
        }
        const present = Array.isArray(audience?.present) ? audience.present : [];
        return { ...(audience || {}), present: [...new Set([...present, ...members])], whisper_to: [], everyone: true };
    });
}

/** How many current members heard a message, or null when all of them did. Whispers have their own badge; the memory starting point does not change who heard a line. */
export function groupHeardCount(message, members, rules = {}) {
    const audience = message?.extra?.group_scene;
    if (!audience || audience.whisper_to?.length || !members?.length) return null;
    const heardRules = { ...rules };
    delete heardRules.before;
    const heard = members.filter(avatar => canGroupMemberSee(message, avatar, heardRules)).length;
    return heard < members.length ? { heard, total: members.length } : null;
}

export function groupScenePrompt(scene, members) {
    const present = members.filter(member => !scene.away.includes(member.avatar)).map(member => member.name);
    const away = members.filter(member => scene.away.includes(member.avatar)).map(member => member.name);
    return `[Scene: ${scene.location ? `Location: ${scene.location}. ` : ''}Present: ${present.join(', ') || 'nobody'}.${away.length ? ` Away: ${away.join(', ')}. They cannot hear or react to this exchange.` : ''}]`;
}

/** The line a whispered reply carries in its prompt, or '' when nobody is whispered to. */
export function groupWhisperPrompt(userName, targetNames = []) {
    return targetNames.length ? `[Private whisper between ${userName} and ${targetNames.join(', ')}. Other members cannot hear or react to it. Keep the reply private.]` : '';
}

/**
 * Whether a group turn has to be written in the page rather than on the
 * server. The server only picks speakers who are in the scene, so a chosen
 * speaker who is away stays in the page.
 */
export function groupSceneTurnNeedsPage(metadata, members, speakers) {
    const away = readGroupScene(metadata, members).away;
    return speakers.some(avatar => away.includes(avatar));
}

let promptScope = null;

/** Scope every prompt reader to the same audience, without changing the saved chat. */
export function beginGroupPromptScope(avatars, messages, rules = {}) {
    const previous = promptScope;
    const scope = { avatars: [...avatars], messages, rules };
    promptScope = scope;
    return () => { if (promptScope === scope) promptScope = previous; };
}

export function isGroupPromptMessageVisible(message) {
    return !promptScope || promptScope.avatars.every(avatar => canGroupMemberSee(message, avatar, promptScope.rules));
}

export function filterGroupPromptMessages(messages) {
    return promptScope ? messages.filter(isGroupPromptMessageVisible) : messages;
}

/** Avatars the current prompt is written for, or null outside a group turn. */
export function getGroupPromptViewers() {
    return promptScope ? [...promptScope.avatars] : null;
}

/** Shared summaries have no audience provenance, so cannot be used on a restricted turn. */
export function hasRestrictedGroupHistory() {
    return Boolean(promptScope?.messages.some(message => !isGroupPromptMessageVisible(message)));
}

/** Counts prompt messages the scoped speaker missed, so chat-wide counters stay the same for every speaker. */
export function countGroupPromptHiddenMessages() {
    return promptScope ? promptScope.messages.filter(message => !message?.is_system && !isGroupPromptMessageVisible(message)).length : 0;
}

/** Members a background Agent writes for: its source message's speaker or audience, or null to follow the current prompt. */
export function groupTargetViewers(target) {
    const audience = target?.extra?.group_scene;
    const avatars = target?.original_avatar ? [target.original_avatar]
        : audience?.whisper_to?.length ? audience.whisper_to : audience?.present;
    return avatars ? [...avatars] : null;
}

/** Whether two audiences are the same members, null meaning the whole chat. */
export function sameGroupViewers(left, right) {
    if (!left || !right) return !left && !right;
    const wanted = new Set(right);
    return new Set(left).size === wanted.size && left.every(avatar => wanted.has(avatar));
}

/** Background Agent work follows its source message even after the active speaker changes. */
export function canGroupTargetSee(message, target, rules = {}) {
    const avatars = groupTargetViewers(target);
    return avatars ? avatars.every(avatar => canGroupMemberSee(message, avatar, rules)) : isGroupPromptMessageVisible(message);
}

export function filterGroupTargetMessages(messages, target, rules = {}) {
    return messages.filter(message => canGroupTargetSee(message, target, rules));
}

/** Synchronous macro expansion for background work must use its own target's audience. */
export function withGroupTargetPrompt(target, messages, callback, rules = {}) {
    const avatars = groupTargetViewers(target);
    if (!avatars) return callback();
    const restore = beginGroupPromptScope(avatars, messages, rules);
    try { return callback(); } finally { restore(); }
}
