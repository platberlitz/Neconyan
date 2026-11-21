import { canGroupMemberSee, groupMessageAudience, readGroupScene, readGroupSceneRules } from '../../public/scripts/group-chat-visibility.js';

/**
 * A group speaker's prompt keeps every saved position, so prompt bookkeeping
 * (attachments, captions, memory and Agent history indexes) still lines up.
 * Lines the speaker did not hear become empty hidden rows with no extras.
 */
export function blankUnheardGroupRecords(records, source, viewer) {
    if (!source?.locator?.group || typeof viewer !== 'string' || !viewer || !Array.isArray(records)) return records;
    const rules = readGroupSceneRules(records[0]?.chat_metadata);
    let blanked = null;
    records.forEach((record, index) => {
        if (index === 0 || !record || canGroupMemberSee(record, viewer, rules)) return;
        blanked ??= [...records];
        blanked[index] = { name: '', is_user: false, is_system: true, mes: '', send_date: record.send_date ?? '', extra: {} };
    });
    return blanked ?? records;
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
