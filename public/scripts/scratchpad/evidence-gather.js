// Collects the 'App diagnostics' evidence in the browser before a Scratchpad reply is requested.
// It is loaded only when the switch is on, so nothing here runs otherwise.
import { getExtensionLoadErrors, getProviderFailures } from '../app-evidence-log.js';
import { withoutRecentRequestText } from '../text-backend-failures.js';
import { isAdmin } from '../user.js';
import { readAdminAppEvidence, readAppEvidence } from './api.js';
import { formatAppEvidence } from './evidence.js';

function describeClient() {
    const host = globalThis;
    if (host.NeconyanAndroid) return 'Android app';
    if (host.neconyanNativeDevice?.platform === 'ios') return 'iPhone app';
    const platform = host.navigator?.userAgentData?.platform || host.navigator?.platform || '';
    const iPhoneSafari = host.NeconyanCrashDiagnostics?.isIOSWebKitBrowser?.() === true;
    return `web browser${iPhoneSafari ? ' (iPhone Safari)' : platform ? ` (${platform})` : ''}`;
}

function browserReports() {
    try {
        const stored = globalThis.NeconyanCrashDiagnostics?.getReports?.();
        const list = value => (Array.isArray(value) ? value : []);
        const unquoted = report => {
            const error = report?.error;
            if (!error || typeof error !== 'object') return report;
            return { ...report, error: { ...error, message: withoutRecentRequestText(error.message, { addresses: 'message' }), stack: withoutRecentRequestText(error.stack, { addresses: 'stack' }) } };
        };
        return { errors: list(stored?.reports).map(unquoted), pageEvents: [...list(stored?.recoveries), ...list(stored?.reloads)] };
    } catch {
        return { errors: [], pageEvents: [] };
    }
}

// The server logs the backend's own error text, which can quote the prompt that was sent from this browser.
function unquotedLogLines(value) {
    const clean = line => (line && typeof line.message === 'string' ? { ...line, message: withoutRecentRequestText(line.message, { addresses: 'message' }) } : line);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object' && Array.isArray(value.items)) return { ...value, items: value.items.map(clean) };
    return value;
}

async function readPart(read, label, notes) {
    try {
        return await read();
    } catch (error) {
        notes.push(`${label} could not be read: ${error?.status ? `the server answered ${error.status}` : 'the request failed'}.`);
        return null;
    }
}

/**
 * Builds the 'App evidence' section. Parts that need an admin account are asked
 * for only by an admin browser, and the server refuses everyone else regardless.
 * @returns {Promise<string>}
 */
export async function gatherAppEvidence() {
    const notes = [];
    const account = await readPart(readAppEvidence, 'The server part of the evidence', notes);
    const admin = isAdmin() ? await readPart(readAdminAppEvidence, 'The admin part of the evidence', notes) : null;
    const browser = browserReports();
    return formatAppEvidence({
        environment: { ...account?.environment, client: describeClient() },
        browserErrors: browser.errors,
        pageEvents: browser.pageEvents,
        extensionErrors: getExtensionLoadErrors(),
        modelFailures: getProviderFailures(),
        requests: account?.requests,
        jobs: account?.jobs,
        serverCrashes: admin?.serverCrashes,
        logLines: unquotedLogLines(admin?.logLines),
        notes,
        gatheredAt: Date.now(),
    });
}
