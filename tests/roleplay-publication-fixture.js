import fs from 'node:fs';
import path from 'node:path';

/** Simulates filesystem observations, including descriptors retained through rename. */
export function publicationFilesystem(t, { field = 'ino', beforeRename, afterRename, alterStat } = {}) {
    const original = Object.fromEntries(['openSync', 'closeSync', 'lstatSync', 'fstatSync', 'renameSync'].map(key => [key, fs[key]]));
    const descriptors = new Map();
    const published = new Map();
    let renames = 0;
    const alter = (stat, filename, descriptor = false) => {
        if (stat && published.has(filename)) {
            if (field) stat[field] += BigInt(published.get(filename));
            alterStat?.(stat, filename, descriptor);
        }
        return stat;
    };
    t.mock.method(fs, 'openSync', (filename, ...args) => {
        const fd = original.openSync(filename, ...args);
        descriptors.set(fd, String(filename));
        return fd;
    });
    t.mock.method(fs, 'closeSync', fd => {
        descriptors.delete(fd);
        return original.closeSync(fd);
    });
    t.mock.method(fs, 'lstatSync', (filename, ...args) => alter(original.lstatSync(filename, ...args), String(filename)));
    t.mock.method(fs, 'fstatSync', (fd, ...args) => alter(original.fstatSync(fd, ...args), descriptors.get(fd), true));
    t.mock.method(fs, 'renameSync', (from, to) => {
        beforeRename?.(String(from), String(to), descriptors);
        const result = original.renameSync(from, to);
        if (path.basename(String(from)).startsWith('.neconyan-roleplay-') && String(from).endsWith('.tmp')) {
            published.set(String(to), 1000000000 + ++renames);
            for (const [fd, filename] of descriptors) if (filename === String(from)) descriptors.set(fd, String(to));
            afterRename?.(String(to), descriptors);
        }
        return result;
    });
    return { descriptors, published, get renames() { return renames; } };
}
