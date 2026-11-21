import fs from 'node:fs';
import path from 'node:path';

// MainActivity shows this note when a start fails, and the iPhone launcher shows it on the
// next launch, so the prefix and the files they read are the contract between the apps and
// the server. Keep them in one place.
export const STARTUP_NOTE_PREFIX = 'Could not start Neconyan:';
const REASSURANCE = 'Saved data has been kept.';

export function startupNoteMessage(error) {
    const message = error?.code === 'EADDRINUSE' && process.env.NECONYAN_ANDROID_APP === '1'
        ? 'The local port is already in use. Choose Use a new port to start the app'
        : (error?.message ? String(error.message) : String(error)).replace(/\.$/, '');
    return `${STARTUP_NOTE_PREFIX} ${message}. ${REASSURANCE}`;
}

function startupNotePath() {
    if (process.env.NECONYAN_ANDROID_APP === '1' && process.env.TMPDIR) {
        return path.join(process.env.TMPDIR, 'startup-status.txt');
    }
    if (process.env.NECONYAN_IOS_APP === '1' && process.env.NECONYAN_STARTUP_NOTE_FILE) {
        return process.env.NECONYAN_STARTUP_NOTE_FILE;
    }
    return null;
}

/** Writes the note the app launchers read. Never throws: the original error must still be logged and the exit must not wait. */
export function writeStartupNote(error) {
    try {
        const file = startupNotePath();
        if (!file) return false;
        fs.writeFileSync(file, startupNoteMessage(error), { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}
