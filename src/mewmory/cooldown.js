// When a model service says it is busy (rate limited, overloaded or timing out), Mewmory stops sending it
// requests for a while instead of retrying at once. Every role and story that uses the same service shares the pause.

const BUSY_STATUSES = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const BASE_WAIT = 30 * 1000;
const MAX_WAIT = 15 * 60 * 1000;
const MAX_RETRY_AFTER = 60 * 60 * 1000;
const services = new Map();

export function isBusyStatus(status) {
    return BUSY_STATUSES.has(Number(status));
}

/** Retry-After is either a number of seconds or an HTTP date; anything else means 'not given'. */
export function parseRetryAfter(value, now = Date.now()) {
    const textValue = String(value ?? '').trim();
    if (!textValue) return 0;
    if (/^\d+(?:\.\d+)?$/.test(textValue)) return Math.min(MAX_RETRY_AFTER, Math.round(Number(textValue) * 1000));
    const date = Date.parse(textValue);
    return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER, Math.max(0, date - now)) : 0;
}

export function serviceBusyUntil(key, now = Date.now()) {
    const entry = services.get(key);
    return entry && entry.until > now ? entry.until : 0;
}

/** Each busy answer in a row doubles the pause, from 30 seconds up to 15 minutes, unless the service asks for longer. */
export function markServiceBusy(key, retryAfter = 0, now = Date.now()) {
    const previous = services.get(key);
    const strikes = previous && now - previous.until < MAX_WAIT ? previous.strikes + 1 : 1;
    const wait = Math.max(Math.min(MAX_WAIT, BASE_WAIT * 2 ** (strikes - 1)), Math.min(MAX_RETRY_AFTER, retryAfter || 0));
    const until = Math.max(previous?.until || 0, now + wait);
    services.set(key, { strikes, until });
    return until;
}

export function markServiceWorking(key) {
    services.delete(key);
}

export function resetServiceCooldowns() {
    services.clear();
}

export function waitLabel(milliseconds) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    if (seconds < 90) return seconds + (seconds === 1 ? ' second' : ' seconds');
    const minutes = Math.ceil(seconds / 60);
    return minutes + (minutes === 1 ? ' minute' : ' minutes');
}
