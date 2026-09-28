import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform === 'android') {
    const native = process._linkedBinding('neconyan_fs');
    // Every persisted physical proof uses these synchronous BigInt snapshots.
    // Keep Node's inode/mode/size checks and supply the missing stable timestamp.
    for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
        const original = fs[method];
        fs[method] = (...args) => {
            const stat = original(...args);
            if (!stat || typeof stat.dev !== 'bigint') return stat;
            const target = args[0] instanceof URL ? fileURLToPath(args[0]) : typeof args[0] === 'number' ? args[0] : String(args[0]);
            const physical = native.physical(target, method === 'statSync');
            if (physical && (String(stat.dev) !== physical.dev || String(stat.ino) !== physical.ino)) {
                throw Object.assign(new Error('File identity changed while reading its Android creation time.'), { code: 'ESTALE' });
            }
            // Android formats f2fs without inode_crtime, so most phones have no
            // creation time. libuv would report ctime, which changes on rename;
            // a constant zero leaves identity on device and inode instead.
            stat.birthtimeNs = physical ? BigInt(physical.birthtimeNs) : 0n;
            stat.birthtimeMs = stat.birthtimeNs / 1000000n;
            stat.birthtime = new Date(Number(stat.birthtimeMs));
            return stat;
        };
    }
    syncBuiltinESMExports();
}

export function verifyAndroidStorage(statePath, native) {
    const probe = fs.mkdtempSync(path.join(statePath, '.android-storage-check-'));
    try {
        const before = path.join(probe, 'before');
        const after = path.join(probe, 'after');
        fs.writeFileSync(before, 'storage-check');
        const identity = native.physical(before, false);
        const creationTimes = Boolean(identity) && identity.birthtimeNs !== '0';
        const original = fs.statSync(before, { bigint: true });
        fs.renameSync(before, after);
        const renamed = fs.statSync(after, { bigint: true });
        if (String(original.birthtimeNs) !== (creationTimes ? identity.birthtimeNs : '0')
            || original.birthtimeNs !== renamed.birthtimeNs || original.dev !== renamed.dev || original.ino !== renamed.ino) {
            throw new Error('Android file identity verification failed. Saved data has been left untouched.');
        }
        return { creationTimes };
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
}
