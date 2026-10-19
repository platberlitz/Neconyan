function getTrimmedVersionValue(version, key) {
    return String(version?.[key] ?? '').trim();
}

/**
 * Whether the server now serves different code from the code this page loaded.
 * An update without a reload leaves an open tab on the old code, so it keeps
 * the old behaviour until it is reloaded.
 */
export function hasServedCodeChanged(loaded, current) {
    return ['gitRevision', 'pkgVersion'].some(key => {
        const before = getTrimmedVersionValue(loaded, key);
        const now = getTrimmedVersionValue(current, key);
        return Boolean(before && now && before !== now);
    });
}

export function hasServerReturnedAfterRestart(version, {
    expectedRevision = '',
    expectedVersion = '',
    previousServerBootId = '',
    sawOffline = false,
} = {}) {
    const revision = getTrimmedVersionValue(version, 'gitRevision');
    const pkgVersion = getTrimmedVersionValue(version, 'pkgVersion');
    const serverBootId = getTrimmedVersionValue(version, 'serverBootId');
    const previousBootId = String(previousServerBootId ?? '').trim();

    if (expectedRevision && revision === expectedRevision) {
        return true;
    }

    if (expectedVersion && pkgVersion === expectedVersion) {
        return true;
    }

    if (previousBootId && serverBootId && serverBootId !== previousBootId) {
        return true;
    }

    return Boolean(sawOffline);
}
