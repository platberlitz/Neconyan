function getTrimmedVersionValue(version, key) {
    return String(version?.[key] ?? '').trim();
}

// The server reports git's abbreviated hash, which grows as the repository gains objects.
const MIN_COMPARABLE_REVISION_LENGTH = 7;

function isSameRevision(before, now) {
    if (before === now) return true;
    if (before.length < MIN_COMPARABLE_REVISION_LENGTH || now.length < MIN_COMPARABLE_REVISION_LENGTH) return false;
    if (!/^[0-9a-f]+$/i.test(before) || !/^[0-9a-f]+$/i.test(now)) return false;
    const shorter = before.length <= now.length ? before : now;
    const longer = shorter === before ? now : before;
    return longer.toLowerCase().startsWith(shorter.toLowerCase());
}

// The server reports 'UNKNOWN' when it cannot read package.json, which says nothing about the code.
function isSamePackageVersion(before, now) {
    return before === now || before.toUpperCase() === 'UNKNOWN' || now.toUpperCase() === 'UNKNOWN';
}

const SERVED_CODE_CHECKS = [['gitRevision', isSameRevision], ['pkgVersion', isSamePackageVersion]];

/**
 * Whether the server now serves different code from the code this page loaded.
 * An update without a reload leaves an open tab on the old code, so it keeps
 * the old behaviour until it is reloaded.
 */
export function hasServedCodeChanged(loaded, current) {
    return SERVED_CODE_CHECKS.some(([key, isSame]) => {
        const before = getTrimmedVersionValue(loaded, key);
        const now = getTrimmedVersionValue(current, key);
        return Boolean(before && now && !isSame(before, now));
    });
}

/**
 * The old and new commit (or release, when the commit did not change) behind a
 * served-code change, for the note that a reload leaves in the crash diagnostics.
 * @returns {{ from?: string, to?: string }}
 */
export function describeServedCodeChange(loaded, current) {
    for (const [key, isSame] of SERVED_CODE_CHECKS) {
        const from = getTrimmedVersionValue(loaded, key);
        const to = getTrimmedVersionValue(current, key);
        if (from && to && !isSame(from, to)) return { from, to };
    }
    return {};
}

/**
 * Whether a package version is a stand-in rather than a real release: the server's 'UNKNOWN',
 * or the page's own '0.0.0' before /version answered. A change to or from one is not an update.
 */
export function isPlaceholderPackageVersion(value) {
    const text = String(value ?? '').trim();
    return text === '0.0.0' || text.toUpperCase() === 'UNKNOWN';
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
