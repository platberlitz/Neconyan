import { addGroupHearer, canGroupMemberSee, groupMessageAudience, readGroupScene, readGroupSceneRules } from '../../public/scripts/group-chat-visibility.js';

/**
 * A group speaker's prompt keeps every saved position, so prompt bookkeeping
 * (attachments, captions, memory and Agent history indexes) still lines up.
 * Lines the speaker did not hear become empty hidden rows that keep only a
 * mark saying so, which `{{groupHeard}}` reads.
 * `viewer` is the speaker's avatar, or `{ avatar, hears }` for a speaker who
 * answers the saved line at chat index `hears` and so hears it, as in the page.
 */
export function blankUnheardGroupRecords(records, source, viewer) {
    const avatar = typeof viewer === 'string' ? viewer : viewer?.avatar;
    if (!source?.locator?.group || typeof avatar !== 'string' || !avatar || !Array.isArray(records)) return records;
    const target = Number.isSafeInteger(viewer?.hears) ? records[viewer.hears + 1] : null;
    const rules = { ...readGroupSceneRules(records[0]?.chat_metadata), ...(target ? { replyTarget: target } : {}) };
    let blanked = null;
    records.forEach((record, index) => {
        if (index === 0 || !record || canGroupMemberSee(record, avatar, rules)) return;
        blanked ??= [...records];
        blanked[index] = { name: '', is_user: false, is_system: true, mes: '', send_date: record.send_date ?? '', extra: { group_scene_unheard: true } };
    });
    return blanked ?? records;
}

/** Whether a group speaker missed any saved line, so chat-wide extras could give it away. */
export function groupViewerMissedLines(records, source, viewer) {
    return blankUnheardGroupRecords(records, source, viewer) !== records;
}

/** The group viewer a captured speaker prompt reads saved lines as. */
export function roleplayGroupViewer(worldInfo) {
    return Number.isSafeInteger(worldInfo?.groupHears) ? { avatar: worldInfo.avatar, hears: worldInfo.groupHears } : worldInfo?.avatar;
}

/**
 * The chat index of the saved line a server group turn's first speaker
 * answers, when the page would record that they heard it: the last line that
 * is not hidden, which they did not hear and is not a whisper to someone else.
 * Later speakers answer the reply before them, which they always hear.
 */
export function savedGroupReplyTarget(records, avatar) {
    const index = records.findLastIndex((record, position) => position > 0 && record && !record.is_system);
    if (index < 1) return null;
    const probe = structuredClone(records[index]);
    return addGroupHearer(probe, avatar) ? index - 1 : null;
}

/** Records on a reply's target that its speaker heard it, as `stampGroupReply` does in the page. */
export function recordGroupReplyHearing(records, avatar, hears) {
    if (!Number.isSafeInteger(hears) || !records[hears + 1]) return records;
    const next = [...records];
    next[hears + 1] = structuredClone(records[hears + 1]);
    return addGroupHearer(next[hears + 1], avatar) ? next : records;
}

/** Members marked away in the saved scene cannot be chosen to speak. */
export function savedGroupAwayMembers(metadata, members) {
    return readGroupScene(metadata, members).away;
}

/** The audience a server-written group reply records, read from the saved scene. */
export function savedGroupReplyAudience(metadata, members, speaker) {
    const scene = readGroupScene(metadata, members);
    const audience = groupMessageAudience(scene, members, scene.whisper_to);
    if (speaker && members.includes(speaker) && !audience.present.includes(speaker)) audience.present.push(speaker);
    return audience;
}
