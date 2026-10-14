export const TIMESTAMP_CACHE_MAX_ENTRIES = 2048;

export function isCacheableScalarTimestamp(timestamp) {
    return typeof timestamp === 'string'
        || (typeof timestamp === 'number' && Number.isFinite(timestamp));
}

export function createTimestampCache({
    moment,
    getMoment = () => moment,
    parseTimestamp,
    getCurrentLocale = () => 'en',
    maxEntries = TIMESTAMP_CACHE_MAX_ENTRIES,
    cache = new Map(),
} = {}) {
    const bound = Math.max(1, Math.floor(Number(maxEntries) || TIMESTAMP_CACHE_MAX_ENTRIES));
    let activeLocale = null;

    function read(timestamp) {
        const locale = String(getCurrentLocale() || '');
        if (activeLocale !== locale) {
            cache.clear();
            activeLocale = locale;
        }

        const canCache = isCacheableScalarTimestamp(timestamp);
        if (canCache && cache.has(timestamp)) {
            const cached = cache.get(timestamp);
            cache.delete(timestamp);
            cache.set(timestamp, cached);
            return cached;
        }

        const momentFn = getMoment();
        const iso8601 = parseTimestamp(timestamp);
        const objMoment = iso8601 ? momentFn(iso8601).locale(locale) : momentFn.invalid();

        if (canCache) {
            while (cache.size >= bound) {
                const oldestKey = cache.keys().next().value;
                cache.delete(oldestKey);
            }
            cache.set(timestamp, objMoment);
        }

        return objMoment;
    }

    return Object.freeze({
        read,
        size: () => cache.size,
        clear: () => {
            cache.clear();
        },
        has: key => cache.has(key),
        keys: () => Array.from(cache.keys()),
    });
}
