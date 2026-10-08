import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isBunRuntime, isNativeTermuxEnvironment } from './runtime.js';

// Termux's Node can substitute ctime for birthtime; writing an upload then changes its identity.
if (isNativeTermuxEnvironment() && !isBunRuntime()) {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-file-identity-'));
    let before, after;
    try {
        const filename = path.join(probe, 'before');
        const moved = path.join(probe, 'after');
        fs.writeFileSync(filename, 'before');
        before = fs.statSync(filename, { bigint: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.appendFileSync(filename, 'after');
        fs.renameSync(filename, moved);
        after = fs.statSync(moved, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs === after.ctimeNs) {
            throw new Error('Could not verify Termux file timestamps. Saved data has been left untouched.');
        }
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }

    if (before.birthtimeNs !== after.birthtimeNs) {
        if (before.birthtimeNs !== before.ctimeNs || after.birthtimeNs !== after.ctimeNs) {
            throw new Error('Termux returned inconsistent file creation times. Saved data has been left untouched.');
        }
        for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
            const original = fs[method];
            fs[method] = (...args) => {
                const stat = original(...args);
                // Only the tested filesystem has proven that its creation times are unavailable.
                if (stat && typeof stat.dev === 'bigint' && stat.dev === before.dev) {
                    stat.birthtimeNs = 0n;
                    stat.birthtimeMs = 0n;
                    stat.birthtime = new Date(0);
                }
                return stat;
            };
        }
        syncBuiltinESMExports();
        console.info('Termux file creation times are unavailable; file identity uses device and inode numbers.');
    }
}
