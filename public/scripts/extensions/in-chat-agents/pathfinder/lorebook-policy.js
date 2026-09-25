/** Pure saved-book checks shared by the browser and the account-bound server worker. */
export function isEntryEligible(entry) {
    return Boolean(entry && !entry.disable && !entry.agentBlacklisted);
}

export function getBookPermission(bookName, permission, settings) {
    const perms = Object.hasOwn(settings.bookPermissions ?? {}, bookName) ? settings.bookPermissions[bookName] : undefined;
    return perms?.[permission] ?? 'readwrite';
}

function isPermissionAllowed(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    return !['none', 'false', 'off', 'deny', 'denied', 'no', '0', 'disabled'].includes(normalized);
}

export function canReadBook(bookName, settings) {
    const perm = getBookPermission(bookName, 'read', settings);
    return settings.bookPermissions?.[bookName]?.enabled !== false && isPermissionAllowed(perm);
}

export function canWriteBook(bookName, settings) {
    return settings.bookPermissions?.[bookName]?.enabled !== false
        && isPermissionAllowed(getBookPermission(bookName, 'write', settings));
}

export function canDeleteBook(bookName, settings) {
    return settings.bookPermissions?.[bookName]?.enabled !== false
        && isPermissionAllowed(getBookPermission(bookName, 'delete', settings));
}
