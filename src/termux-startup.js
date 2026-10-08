import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isBunRuntime, isNativeTermuxEnvironment } from './runtime.js';
import { serverDirectory } from './server-directory.js';
import { tryWriteFileSync } from './util.js';
import { probeTermuxFileIdentity, useZeroTermuxBirthtime } from './termux-file-identity.js';

const modeFilename = '_termux-file-identity.json';
const zeroMode = { version: 1, birthtime: 'zero' };

function readSmallFile(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error(`Termux startup file needs inspection: ${filename}`);
        return fs.readFileSync(fd, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function normalDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Termux data path is not a normal directory: ${directory}`);
}

/** Read the plain-path choice made by the 1.2.1 recovery launcher without creating another one. */
function savedRecovery(home) {
    const saved = readSmallFile(path.join(home, '.neconyan-import-folder'));
    if (saved === undefined) return undefined;
    const root = saved.trim();
    if (path.dirname(root) !== path.resolve(home) || !/^neconyan-import-[a-zA-Z0-9_-]+$/.test(path.basename(root))) {
        throw new Error('The saved Termux recovery folder needs inspection. No other data folder was selected.');
    }
    try { normalDirectory(root); } catch {
        throw new Error(`The saved Termux recovery folder is missing or unsafe: ${root}. No other data folder was selected.`);
    }
    return root;
}

/** An explicit data choice wins; a normal launch of the original installation follows its saved recovery. */
export function resolveTermuxRecovery(
    { dataRoot, port, explicitDataRoot = false, explicitPort = false, global = false },
    { home = os.homedir(), installation = serverDirectory, termux = isNativeTermuxEnvironment() } = {},
) {
    const unchanged = { dataRoot, port, recovery: false };
    if (!termux || global) return unchanged;
    const standardInstallation = path.join(home, 'Neconyan');
    if (!fs.existsSync(standardInstallation) || fs.realpathSync(installation) !== fs.realpathSync(standardInstallation)) return unchanged;
    const root = path.resolve(dataRoot);
    const defaultData = !explicitDataRoot && root === path.join(installation, 'data');
    const recoveryCandidate = path.dirname(root) === path.resolve(home) && /^neconyan-import-[a-zA-Z0-9_-]+$/.test(path.basename(root));
    if (!defaultData && !recoveryCandidate) return unchanged;
    const saved = savedRecovery(home);
    if (saved && defaultData) return { dataRoot: saved, port: explicitPort ? port : 5534, recovery: true };
    return { ...unchanged, recovery: saved === root };
}

/** Configure identities before protected storage opens and carry that policy into workers. */
export async function configureTermuxStartup({ dataRoot, termuxRecovery = false }, {
    termux = isNativeTermuxEnvironment(), bun = isBunRuntime(),
    wakeLock = () => spawnSync('termux-wake-lock', [], { stdio: 'ignore', timeout: 10000 }),
    log = console.info, warn = console.warn,
} = {}) {
    if (!termux) return { mode: 'unchanged' };
    const root = path.resolve(dataRoot);
    normalDirectory(root);
    const marker = path.join(root, modeFilename);
    const saved = readSmallFile(marker);
    let mode;
    if (saved !== undefined) {
        try { mode = JSON.parse(saved); } catch { /* Refuse an unreadable policy below. */ }
        if (!mode || mode.version !== 1 || mode.birthtime !== 'zero' || Object.keys(mode).length !== 2) {
            throw new Error('The saved Termux file-identity policy needs inspection. Saved data has been left untouched.');
        }
    }
    if (bun) {
        if (mode || termuxRecovery) throw new Error('This Termux recovery uses Node.js file identities. Start Neconyan with Node.js to keep using this data.');
        return { mode: 'unchanged' };
    }
    const probe = await probeTermuxFileIdentity(root);
    const protectedRoot = path.join(root, '_roleplay');
    let existing = false;
    if (fs.existsSync(protectedRoot)) {
        normalDirectory(protectedRoot);
        existing = fs.readdirSync(protectedRoot).length > 0;
    }
    const useZero = Boolean(mode || termuxRecovery || (!existing && (probe.fallback || probe.zero)));
    if (useZero) {
        useZeroTermuxBirthtime(probe.device);
        if (!mode) tryWriteFileSync(marker, JSON.stringify(zeroMode), { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE = probe.device;
        log('Termux file identity compatibility is active for this data folder.');
    } else if (existing && probe.fallback) {
        warn('This older Termux data folder uses existing file identities. They were kept unchanged. For failed imports, use the Termux recovery launcher described in docs/termux-import-recovery.md.');
    }
    const wake = wakeLock();
    if (wake?.error || wake?.status !== 0) warn('The Termux wake lock could not be acquired. Use Acquire wakelock in the Termux notification during long operations.');
    if (termuxRecovery) log(`Continuing the saved Termux recovery data folder: ${root}`);
    return { mode: useZero ? 'zero' : existing && probe.fallback ? 'legacy' : 'native' };
}
