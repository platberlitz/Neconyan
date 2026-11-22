// Collects the 'App diagnostics' evidence in the browser before a Scratchpad reply is requested.
// It is loaded only when the switch is on, so nothing here runs otherwise.
import { getExtensionLoadErrors, getProviderFailures } from '../app-evidence-log.js';
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
        const reports = globalThis.NeconyanCrashDiagnostics?.getReports?.()?.reports;
        return Array.isArray(reports) ? reports : [];
    } catch {
        return [];
    }
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
    return formatAppEvidence({
        environment: { ...account?.environment, client: describeClient() },
        browserErrors: browserReports(),
        extensionErrors: getExtensionLoadErrors(),
        modelFailures: getProviderFailures(),
        requests: account?.requests,
        jobs: account?.jobs,
        serverCrashes: admin?.serverCrashes,
        logLines: admin?.logLines,
        notes,
    });
}
