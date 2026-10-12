export const DEFAULT_TRACKER_REPAIR_TIMEOUT_SECONDS = 180;
export const MAX_TRACKER_REPAIR_TIMEOUT_SECONDS = 3600;

/**
 * Seconds a Fix Trackers request may run before it is abandoned and the next fallback is
 * tried. 0 means wait as long as the connection takes.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeTrackerRepairTimeoutSeconds(value) {
    const seconds = Number(value);
    if (value === '' || value === null || value === undefined || typeof value === 'boolean' || !Number.isFinite(seconds)) {
        return DEFAULT_TRACKER_REPAIR_TIMEOUT_SECONDS;
    }
    return Math.trunc(Math.min(MAX_TRACKER_REPAIR_TIMEOUT_SECONDS, Math.max(0, seconds)));
}

/**
 * Returns a run-only copy of an Agent marked as a Fix Trackers repair, so its request uses
 * the tracker repair connection, fallbacks and time limit. The mark is never saved.
 * @template T
 * @param {T} agent
 * @returns {T}
 */
export function markTrackerRepairRunAgent(agent) {
    return agent ? { ...agent, trackerRepairRun: true } : agent;
}

export function isTrackerRepairRunAgent(agent) {
    return agent?.trackerRepairRun === true;
}

/**
 * The connection saved for Fix Trackers repairs, or '' when repairs use each Agent's usual one.
 * @param {object} globalSettings
 * @returns {string}
 */
export function getTrackerRepairConnectionProfile(globalSettings) {
    const profileId = globalSettings?.trackerRepairConnectionProfile;
    return typeof profileId === 'string' ? profileId.trim() : '';
}

/**
 * @param {object} globalSettings
 * @returns {number} Milliseconds, or 0 for no limit.
 */
export function getTrackerRepairTimeoutMs(globalSettings) {
    return normalizeTrackerRepairTimeoutSeconds(globalSettings?.trackerRepairTimeoutSeconds) * 1000;
}
