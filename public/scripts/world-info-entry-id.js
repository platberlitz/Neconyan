/** Whether the editor can address this record without editing a different entry. */
export function hasEditableWorldInfoId(slot, entry) {
    const uid = entry?.uid;
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
        && (typeof uid === 'number' || typeof uid === 'string')
        && String(uid) === slot
        && Number.isSafeInteger(Number(uid)) && Number(uid) >= 0 && String(Number(uid)) === slot);
}
