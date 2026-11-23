/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each scenario runs in its own process: the log buffer patches console and the standard streams for good. */
function runScript(code, { flags = [], args = [], silent = false } = {}) {
    const result = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', code, '--', root, ...args],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(silent ? { stdio: ['ignore', 'ignore', 'pipe'] } : {}) });
    return { ...result, report: result.status === 0 ? JSON.parse(result.stderr.trim().split('\n').at(-1)) : null };
}

test('kept log lines do not pin the long output they were cut from', () => {
    const { status, stderr, report } = runScript(`
        const root = process.argv.at(-1);
        console.log = () => {};
        const { getServerLogSnapshot } = await import(root + '/src/server-log-buffer.js');
        global.gc(); global.gc();
        const before = process.memoryUsage().heapUsed;
        // One long line per call, as a logged response body or a stack of nested JSON would be.
        for (let line = 0; line < 100; line++) console.log('console line ' + line + ' ' + 'x'.repeat(1_000_000));
        // The same through the stream: every line is cut out of the chunk it arrived in.
        for (let line = 0; line < 100; line++) process.stdout.write('stream line ' + line + ' ' + 'y'.repeat(1_000_000) + '\\n');
        global.gc(); global.gc();
        const retainedMB = (process.memoryUsage().heapUsed - before) / 1048576;
        const entries = getServerLogSnapshot({ limit: 600 }).entries;
        process.stderr.write(JSON.stringify({ retainedMB, entries: entries.length, longest: Math.max(...entries.map(entry => entry.message.length)),
            first: entries.at(-1).message.slice(0, 12), truncated: entries.find(entry => entry.message.startsWith('console line 99 ')).message }) + '\\n');
    `, { flags: ['--expose-gc'], silent: true });
    assert.equal(status, 0, stderr);
    // Two hundred lines of one million characters kept 195 MB alive before; the lines themselves are twelve thousand characters each.
    assert.ok(report.retainedMB < 40, `kept ${report.retainedMB} MB`);
    assert.equal(report.entries, 200);
    assert.ok(report.longest <= 12000);
    assert.equal(report.first, 'stream line ');
    assert.equal(report.truncated, 'console line 99 ' + 'x'.repeat(11999 - 'console line 99 '.length) + '…', 'a huge line is stored as its first 11,999 characters');
});

test('the stored text of anything that fits is exactly what util.format produced before the cut existed', () => {
    const { status, stderr, report } = runScript(`
        import { formatWithOptions } from 'node:util';
        const root = process.argv.at(-1);
        console.log = () => {};
        const { getServerLogSnapshot } = await import(root + '/src/server-log-buffer.js');
        const options = { colors: false, depth: 10, breakLength: Infinity, compact: false };
        const circular = { name: 'n' }; circular.x = circular; circular.y = circular;
        const shared = { value: 1 };
        let getterRuns = 0;
        const deep = {}; let level = deep;
        for (let index = 0; index < 13; index++) { level.id = index; level.next = {}; level = level.next; }
        const cases = {
            plain: ['plain', 1, { a: [1, 2, { b: 3 }], text: 'line one\\nline two' }],
            longList: [Array.from({ length: 150 }, (_, index) => index)],
            secondList: ['first', { a: 1 }, Array.from({ length: 50 }, (_, index) => 'item ' + index)],
            collections: [new Map([[1, { a: 1 }]]), new Set([1, 2, 3])],
            circular: [circular],
            shared: [{ p: shared, q: shared, r: [shared, shared] }],
            getter: [{ get boom() { getterRuns++; throw new Error('not run'); }, ok: 1 }],
            depthTen: [deep],
            percent: ['%s is %d', 'Mara', 3, { z: 1 }],
            error: [new Error('boom').message, { code: 'E' }],
            bigButFine: [Object.fromEntries(Array.from({ length: 500 }, (_, index) => ['key' + index, index]))],
            longString: ['x'.repeat(20000)],
        };
        const mismatches = [];
        const lengths = {};
        for (const [name, args] of Object.entries(cases)) {
            const before = getServerLogSnapshot({ limit: 600 }).latestId;
            console.log(...args);
            const stored = getServerLogSnapshot({ limit: 600 }).entries.filter(entry => entry.id > before).map(entry => entry.message);
            const expected = formatWithOptions(options, ...args).split('\\n').filter(Boolean).map(line => line.length > 12000 ? line.slice(0, 11999).trimEnd() + '…' : line);
            lengths[name] = stored.length;
            if (JSON.stringify(stored) !== JSON.stringify(expected)) mismatches.push({ name, stored: stored.slice(0, 6), expected: expected.slice(0, 6) });
        }
        process.stderr.write(JSON.stringify({ mismatches, getterRuns, lengths }) + '\\n');
    `, { silent: true });
    assert.equal(status, 0, stderr);
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.getterRuns, 0, 'a getter is never run');
    assert.equal(report.lengths.circular, 5, 'a circular value stays five lines');
    assert.ok(report.lengths.bigButFine > 500, 'a value that fits is not cut');
});

test('a value too large to keep is cut to a small share of the buffer and leaves the other lines in place', () => {
    const { status, stderr, report } = runScript(`
        const root = process.argv.at(-1);
        console.log = () => {};
        const { getServerLogSnapshot } = await import(root + '/src/server-log-buffer.js');
        for (let line = 0; line < 100; line++) console.log('earlier line ' + line);
        const circular = { name: 'n', list: Array.from({ length: 9000 }, () => Object.fromEntries(Array.from({ length: 60 }, (_, key) => ['p' + key, key]))) };
        circular.self = circular;
        const nested = {};
        for (let index = 0; index < 8000; index++) nested['k' + index] = { index, again: circular };
        let getterRuns = 0;
        Object.defineProperty(nested, 'trap', { enumerable: true, get() { getterRuns++; throw new Error('not run'); } });
        console.log('a call with several arguments', nested, 'a small one', { fine: Array.from({ length: 50 }, (_, index) => index) }, circular);
        const after = getServerLogSnapshot({ limit: 600 }).entries.map(entry => entry.message);
        const kept = after.filter(line => line.startsWith('earlier line')).length;
        process.stderr.write(JSON.stringify({ kept, total: after.length, getterRuns, text: after.join('\\n') }) + '\\n');
    `, { silent: true });
    assert.equal(status, 0, stderr);
    assert.equal(report.kept, 100, 'no earlier line was evicted');
    // At most 100 lines for the two cut arguments together, plus the 52 lines the small argument always prints.
    assert.ok(report.total - 100 <= 100 + 52, `one call added ${report.total - 100} lines`);
    assert.equal(report.getterRuns, 0);
    assert.match(report.text, /a small one/);
    assert.match(report.text, /49\b/, 'the small argument still shows all 50 items');
    assert.match(report.text, /only its start is kept/);
});

test('a huge logged object is cut down before it is formatted, not after', () => {
    // The object holds 20,000 keys that share one 8,000 character string. Formatting all of it takes
    // over a hundred megabytes, so a 96 MB heap only survives a buffer that formats a bounded part.
    const { status, stderr, report } = runScript(`
        const root = process.argv.at(-1);
        console.log = () => {};
        const { getServerLogSnapshot } = await import(root + '/src/server-log-buffer.js');
        const text = 'z'.repeat(8000);
        const huge = {};
        for (let key = 0; key < 20000; key++) huge['key' + key] = text;
        const hugeList = Array.from({ length: 300000 }, (_, index) => index);
        console.log('huge object', huge);
        console.log('huge list', hugeList);
        const entries = getServerLogSnapshot({ limit: 600 }).entries;
        process.stderr.write(JSON.stringify({ entries: entries.length, longest: Math.max(...entries.map(entry => entry.message.length)),
            list: entries.some(entry => entry.message.includes('huge list')) }) + '\\n');
    `, { flags: ['--max-old-space-size=96'], silent: true });
    assert.equal(status, 0, stderr);
    assert.ok(report.entries > 100 && report.longest <= 12000);
    assert.equal(report.list, true);
});

test('what reaches the terminal is exactly what it was without the buffer', () => {
    const script = `
        const root = process.argv.at(-1);
        if (process.argv.at(-2) === 'with-buffer') await import(root + '/src/server-log-buffer.js');
        const big = {};
        for (let key = 0; key < 3000; key++) big['k' + key] = { key, text: 'value ' + key };
        console.log('plain', 1, { a: [1, 2, { b: new Map([[1, 2]]) }] }, Array.from({ length: 150 }, (_, index) => index));
        console.error(new Error('boom').message, { nested: { deeper: { deepest: { value: 1 } } } });
        console.log('big', big);
        console.log('%s is %d years', 'Mara', 3, 'extra', { z: 1 });
        console.warn(Object.create(null, { hidden: { value: 1, enumerable: true } }));
        process.stdout.write('raw write\\n');
        process.stderr.write(JSON.stringify({ done: true }) + '\\n');
    `;
    const bare = runScript(script, { args: ['bare'] });
    const buffered = runScript(script, { args: ['with-buffer'] });
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(buffered.status, 0, buffered.stderr);
    assert.equal(buffered.stdout, bare.stdout);
    assert.equal(buffered.stderr, bare.stderr);
    assert.ok(bare.stdout.includes('k2999'), 'the terminal still shows every key');
});
