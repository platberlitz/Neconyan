export const MAX_PINNED_NOTE_BYTES = 16 * 1024;

/** Shared by the preview and server prompt; note text cannot close its reference block. */
export function pinnedNoteContext(note) {
    if (typeof note !== 'string' || !note.trim()) return '';
    const text = JSON.stringify({ note }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    return `<pinned_note>\n${text}\n</pinned_note>`;
}
