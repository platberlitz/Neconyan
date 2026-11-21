const renameList = (values, from, to) => Array.isArray(values) && values.includes(from)
    ? [...new Set(values.map(value => value === from ? to : value))]
    : values;

function renameKey(map, from, to) {
    if (!map || typeof map !== 'object' || !Object.hasOwn(map, from)) return map;
    const renamed = { ...map, [to]: map[from] };
    delete renamed[from];
    return renamed;
}

/**
 * Returns the group fields that name the renamed member, keyed or listed by avatar file.
 * @param {object} group Group record
 * @param {string} from Old avatar file name
 * @param {string} to New avatar file name
 * @returns {{ members?: string[], disabled_members?: string[], member_roles?: object, member_models?: object }}
 */
export function renameGroupMemberFields(group, from, to) {
    const changes = {};
    for (const key of ['members', 'disabled_members']) {
        const renamed = renameList(group?.[key], from, to);
        if (renamed !== group?.[key]) changes[key] = renamed;
    }
    for (const key of ['member_roles', 'member_models']) {
        const renamed = renameKey(group?.[key], from, to);
        if (renamed !== group?.[key]) changes[key] = renamed;
    }
    return changes;
}

function renameScene(scene, keys, from, to) {
    if (!scene || typeof scene !== 'object') return false;
    let changed = false;
    for (const key of keys) {
        const renamed = renameList(scene[key], from, to);
        if (renamed !== scene[key]) {
            scene[key] = renamed;
            changed = true;
        }
    }
    return changed;
}

/**
 * Rewrites scene audiences and the scene header of saved group chat records in place.
 * @param {object[]} records Chat file records, header included
 * @param {string} from Old avatar file name
 * @param {string} to New avatar file name
 * @returns {boolean} Whether anything changed
 */
export function renameGroupSceneRecords(records, from, to) {
    let changed = false;
    for (const record of Array.isArray(records) ? records : []) {
        if (Object.hasOwn(record ?? {}, 'chat_metadata')) {
            changed = renameScene(record.chat_metadata?.group_scene, ['away', 'whisper_to', 'sees_all'], from, to) || changed;
            continue;
        }
        changed = renameScene(record?.extra?.group_scene, ['present', 'whisper_to'], from, to) || changed;
        for (const swipe of Array.isArray(record?.swipe_info) ? record.swipe_info : []) {
            changed = renameScene(swipe?.extra?.group_scene, ['present', 'whisper_to'], from, to) || changed;
        }
    }
    return changed;
}
