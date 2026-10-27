import fs from 'node:fs';

// Chained steps (a reply, then after-reply Agents, then Mewmory) leave short gaps between them;
// waiting this long before letting the phone sleep keeps them from flapping the wake lock.
export const SERVER_WAKE_IDLE_MS = 30_000;

let markerPath = null;
let active = 0;
let idleTimer = null;
let marked = false;

function mark(busy) {
    if (!markerPath || busy === marked) return;
    marked = busy;
    try {
        if (busy) fs.writeFileSync(markerPath, '', { mode: 0o600 });
        else fs.rmSync(markerPath, { force: true });
    } catch (error) {
        console.warn('Could not update the server wake marker:', error.message);
    }
}

/**
 * The Android app keeps the phone awake only while this file exists, so the
 * server can finish its work with the screen off and still let the phone sleep when idle.
 * @param {string|null} filePath Marker file the app watches, or null to stop writing it
 */
export function configureServerWakeMarker(filePath) {
    if (markerPath && markerPath !== filePath) fs.rmSync(markerPath, { force: true });
    markerPath = filePath;
    marked = false;
    if (filePath) fs.rmSync(filePath, { force: true });
    if (active > 0) mark(true);
}

/**
 * Record server work that has to finish even when nobody is looking.
 * @returns {() => void} Ends the work; calling it more than once does nothing
 */
export function beginServerWork() {
    active += 1;
    clearTimeout(idleTimer);
    idleTimer = null;
    mark(true);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        active -= 1;
        if (active > 0) return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (active === 0) mark(false);
        }, SERVER_WAKE_IDLE_MS);
        idleTimer.unref?.();
    };
}

/** @returns {boolean} Whether any server work is still running */
export function isServerWorking() {
    return active > 0;
}

/**
 * Counts each request as work until its response closes. Change streams stay open for as long
 * as a page is, so they are left out; otherwise an open Notes page would keep the phone awake.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('express').NextFunction} next
 */
export function serverWorkMiddleware(request, response, next) {
    if (!markerPath || /\/events\/?$/.test(request.path)) return next();
    response.once('close', beginServerWork());
    next();
}
