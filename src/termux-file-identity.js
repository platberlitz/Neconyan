import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const zeroDevices = new Set();
let installed = false;

/** Pass the data policy only to Neconyan's file workers, without changing other child processes. */
export function termuxWorkerOptions() {
    if (!process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE) return {};
    const preload = `--import=${new URL('./termux-file-stats.js', import.meta.url).href}`;
    return { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${preload}`.trim() } };
}

/** Prove whether creation time survives a write and rename on this filesystem. */
export async function probeTermuxFileIdentity(directory) {
    const probe = fs.mkdtempSync(path.join(directory, '.neconyan-file-identity-'));
    try {
        const filename = path.join(probe, 'before');
        const moved = path.join(probe, 'after');
        fs.writeFileSync(filename, 'before');
        const before = fs.statSync(filename, { bigint: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.appendFileSync(filename, 'after');
        fs.renameSync(filename, moved);
        const after = fs.statSync(moved, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs === after.ctimeNs) {
            throw new Error('Could not verify Termux file timestamps. Saved data has been left untouched.');
        }
        const fallback = before.birthtimeNs !== after.birthtimeNs;
        if (fallback && (before.birthtimeNs !== before.ctimeNs || after.birthtimeNs !== after.ctimeNs)) {
            throw new Error('Termux returned inconsistent file creation times. Saved data has been left untouched.');
        }
        return { device: String(before.dev), fallback, zero: before.birthtimeNs === 0n && after.birthtimeNs === 0n };
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}

/** Preserve the chosen identity policy even if a later runtime gains creation-time support. */
export function useZeroTermuxBirthtime(device) {
    if (typeof device !== 'string' || !/^\d{1,30}$/.test(device)) throw new Error('Invalid Termux filesystem identity.');
    zeroDevices.add(device);
    if (installed) return;
    installed = true;
    for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
        const original = fs[method];
        fs[method] = (...args) => {
            const stat = original(...args);
            if (stat && typeof stat.dev === 'bigint' && zeroDevices.has(String(stat.dev))) {
                stat.birthtimeNs = 0n;
                stat.birthtimeMs = 0n;
                stat.birthtime = new Date(0);
            }
            return stat;
        };
    }
    syncBuiltinESMExports();
}
