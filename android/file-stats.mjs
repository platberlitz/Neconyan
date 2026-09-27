import fs from 'node:fs';
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
            // Virtual system directories can lack btime. Startup separately proves
            // that the private data filesystem supplies it before accepting work.
            if (!physical) return stat;
            if (String(stat.dev) !== physical.dev || String(stat.ino) !== physical.ino) {
                throw Object.assign(new Error('File identity changed while reading its Android creation time.'), { code: 'ESTALE' });
            }
            stat.birthtimeNs = BigInt(physical.birthtimeNs);
            stat.birthtimeMs = stat.birthtimeNs / 1000000n;
            stat.birthtime = new Date(Number(stat.birthtimeMs));
            return stat;
        };
    }
    syncBuiltinESMExports();
}
