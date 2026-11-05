import fs from 'node:fs';
import path from 'node:path';

// MainActivity shows this note when a start fails, so the prefix and the file it reads
// are the contract between the Android app and the server. Keep them in one place.
export const STARTUP_NOTE_PREFIX = 'Could not start Neconyan:';
const REASSURANCE = 'Saved data has been kept.';

export function startupNoteMessage(error) {
    const message = (error?.message ? String(error.message) : String(error)).replace(/\.$/, '');
    return `${STARTUP_NOTE_PREFIX} ${message}. ${REASSURANCE}`;
}

/** Writes the note the Android app reads. Never throws: the original error must still be logged and the exit must not wait. */
export function writeStartupNote(error) {
    try {
        const directory = process.env.TMPDIR;
        if (process.env.NECONYAN_ANDROID_APP !== '1' || !directory) return false;
        fs.writeFileSync(path.join(directory, 'startup-status.txt'), startupNoteMessage(error), { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}
