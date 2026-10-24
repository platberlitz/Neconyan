import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

/** Inspect the reloaded owner record before any completion/recovery can mask a stale witness. */
export function assertSavedAuthoring(root, effects) {
    const staged = Object.values(effects).filter(effect => effect.staged).map(effect => effect.staged);
    assert.ok(staged.length > 0, 'the saved owner must contain authoring evidence');
    for (const output of staged) {
        const filename = path.join(root, output.relative);
        const stat = fs.lstatSync(filename, { bigint: true });
        assert.deepEqual(output.after, {
            rawHash: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
            physical: { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) },
        });
    }
}

/** Model only the observed exFAT inode transition; bytes and descriptor I/O remain real. */
export function simulateAuthoringRename(t, { field = 'ino', afterRename } = {}) {
    const native = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, renameSync: fs.renameSync };
    const changed = new Map();
    const key = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? BigInt(Math.round(stat.birthtimeMs * 1e6))}`;
    const adjust = stat => {
        if (!stat) return stat;
        const fields = changed.get(key(stat));
        if (fields) for (const [name, increment] of Object.entries(fields)) stat[name] += typeof stat[name] === 'bigint' ? BigInt(increment) : increment;
        return stat;
    };
    const state = { transitions: [], native };
    t.mock.method(fs, 'lstatSync', (...args) => adjust(native.lstatSync(...args)));
    t.mock.method(fs, 'fstatSync', (...args) => adjust(native.fstatSync(...args)));
    t.mock.method(fs, 'renameSync', (from, to) => {
        const authoring = /^\.author-[a-f0-9-]+\.tmp$/.test(path.basename(String(from)));
        const before = authoring ? native.lstatSync(from, { bigint: true }) : null;
        const result = native.renameSync(from, to);
        if (authoring) {
            const stat = native.lstatSync(to, { bigint: true });
            changed.set(key(stat), { [field]: 1000000 });
            state.transitions.push({ from: String(from), to: String(to), before, after: adjust(native.lstatSync(to, { bigint: true })) });
            afterRename?.(from, to, state);
        }
        return result;
    });
    return state;
}

/** Keep the ordinary case as well as the changed-inode replay regression. */
export function authoringRenameTest(name, run) {
    test(name, run);
    test(`${name} (live authoring inode transition)`, async t => {
        const state = simulateAuthoringRename(t);
        await run(t);
        assert.ok(state.transitions.length > 0, 'the case must actually publish through a changed inode');
    });
}
