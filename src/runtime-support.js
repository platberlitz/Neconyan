/**
 * Neconyan runtime requirements.
 *
 * Bun releases before 1.4.0 used one JavaScriptCore watchdog for node:vm
 * timeouts. A timeout can stay armed after the guarded run and terminate the
 * server during later work in the same JavaScript turn. Upstream PR #38660
 * replaced it with a per-run deadline, first released in Bun 1.4.0.
 */
export const MINIMUM_BUN_VERSION = '1.4.0';

const NUMERIC_PART = /^(0|[1-9]\d*)$/;
const IDENTIFIER_PART = /^[0-9A-Za-z-]+$/;

function parseVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(value ?? ''));
    if (!match) return null;
    const numeric = match.slice(1, 4);
    if (!numeric.every(part => NUMERIC_PART.test(part))) return null;
    const numbers = numeric.map(Number);
    if (!numbers.every(Number.isSafeInteger)) return null;
    const prerelease = match[4] ? match[4].split('.') : [];
    const build = match[5] ? match[5].split('.') : [];
    if (prerelease.some(part => !IDENTIFIER_PART.test(part) || (/^\d+$/.test(part) && !NUMERIC_PART.test(part)))) return null;
    if (build.some(part => !IDENTIFIER_PART.test(part))) return null;
    return { numbers, prerelease };
}

function comparePrerelease(left, right) {
    if (!left.length && !right.length) return 0;
    // A stable release sorts after any prerelease of the same base version.
    if (!left.length) return 1;
    if (!right.length) return -1;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        const a = left[index]; const b = right[index];
        const aNumeric = /^\d+$/.test(a);
        const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) {
            const aNumber = a.replace(/^0+/, '') || '0';
            const bNumber = b.replace(/^0+/, '') || '0';
            if (aNumber.length !== bNumber.length) return aNumber.length < bNumber.length ? -1 : 1;
            if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
        } else if (aNumeric !== bNumeric) {
            return aNumeric ? -1 : 1;
        } else if (a !== b) {
            return a < b ? -1 : 1;
        }
    }
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return 0;
}

/** Compare semver-shaped versions. Returns -1, 0, 1, or null for invalid input. Build metadata is ignored. */
export function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index += 1) {
        if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
    }
    return comparePrerelease(a.prerelease, b.prerelease);
}

/** Missing version means Node or another supported runtime. Malformed Bun versions are unsupported. */
export function bunVersionSupportsStructuredPrefill(version = process.versions?.bun) {
    if (!version) return true;
    const comparison = compareVersions(version, MINIMUM_BUN_VERSION);
    return comparison !== null && comparison >= 0;
}

export function unsupportedBunMessage(version = process.versions?.bun) {
    if (bunVersionSupportsStructuredPrefill(version)) return null;
    return `Neconyan needs Node 24 or Bun ${MINIMUM_BUN_VERSION} or later. This server is running Bun ${version}, which has a known crash in Structured Prefill. Install Bun ${MINIMUM_BUN_VERSION} or later, or start with Node 24 (Start-Node.bat on Windows, npm run start:node elsewhere), then try again.`;
}

export function structuredPrefillRuntimeMessage(version = process.versions?.bun) {
    if (bunVersionSupportsStructuredPrefill(version)) return null;
    return `Structured Prefill needs Node 24 or Bun ${MINIMUM_BUN_VERSION} or later. This server is running Bun ${version}. Start Neconyan with Node 24, or install Bun ${MINIMUM_BUN_VERSION} or later, then try again. Your settings and chat were not changed.`;
}

export function assertSupportedBun(version = process.versions?.bun) {
    const message = unsupportedBunMessage(version);
    if (!message) return;
    const error = new Error(message);
    error.code = 'UNSUPPORTED_BUN_RUNTIME';
    throw error;
}

export function assertStructuredPrefillRuntime(version = process.versions?.bun) {
    const message = structuredPrefillRuntimeMessage(version);
    if (!message) return;
    const error = new Error(message);
    error.code = 'STRUCTURED_PREFILL_UNSUPPORTED_RUNTIME';
    throw error;
}

/** Refuse to start the server on an unsupported Bun instead of failing later. */
export function enforceSupportedBun(version = process.versions?.bun) {
    const message = unsupportedBunMessage(version);
    if (!message) return;
    console.error(`\n[Neconyan] ${message}\n`);
    process.exit(1);
}
