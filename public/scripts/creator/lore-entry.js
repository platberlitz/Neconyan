import { compareCreatorChanges } from './conflicts.js';

/** Apply only the advanced editor's changes, retaining newer basic-field edits. */
export function mergeCreatorEntrySettings(before, current, edited) {
    if (!edited || typeof edited !== 'object' || Array.isArray(edited) || String(edited.uid) !== String(current.uid)) {
        throw new Error('Keep the entry UID unchanged.');
    }
    const comparison = compareCreatorChanges(before, edited, current);
    if (comparison.conflicts.length) {
        throw new Error('These entry settings changed in another field. Close and reopen All entry settings to compare the latest values.');
    }
    return comparison.value;
}
