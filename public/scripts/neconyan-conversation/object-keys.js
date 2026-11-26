const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Keys that would reach Object.prototype (or a constructor) when used as a
 * plain-object property name. Stored data must never write or read them.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isUnsafeObjectKey(key) {
    return UNSAFE_OBJECT_KEYS.has(String(key));
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isSafeObjectKey(key) {
    return (typeof key === 'string' || typeof key === 'number') && String(key) !== '' && !isUnsafeObjectKey(key);
}

/**
 * Reads an own property only, so ids such as 'constructor' or 'toString' never
 * resolve to inherited values.
 * @param {unknown} object
 * @param {unknown} key
 * @returns {any}
 */
export function getOwnValue(object, key) {
    if (!object || typeof object !== 'object' || !isSafeObjectKey(key)) {
        return undefined;
    }
    return Object.hasOwn(object, String(key)) ? object[String(key)] : undefined;
}

/**
 * Entries of a plain object without prototype-polluting keys.
 * @param {unknown} object
 * @returns {Array<[string, any]>}
 */
export function safeObjectEntries(object) {
    if (!object || typeof object !== 'object') {
        return [];
    }
    return Object.entries(object).filter(([key]) => !isUnsafeObjectKey(key));
}
