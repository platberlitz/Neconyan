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
            shortStrings: [Object.fromEntries(Array.from({ length: 500 }, (_, index) => ['key' + index, 'ab']))],
            emptyStrings: [Object.fromEntries(Array.from({ length: 500 }, (_, index) => ['key' + index, '']))],
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
    assert.ok(report.lengths.shortStrings > 500 && report.lengths.emptyStrings > 500, 'strings that fit are not cut');
});

test('a large object of strings that still fits the caps is stored exactly, and one string more is cut', () => {
    // The snapshot reads at most 600 lines, so this reads the whole buffer. The buffer keeps the last 1,500 lines, so
    // the 4,000 lines of an object with 4,000 empty strings are compared as that many from the end.
    const { status, stderr, report } = runScript(`
        import { formatWithOptions } from 'node:util';
        const root = process.argv.at(-1);
        console.log = () => {};
        await import(root + '/src/server-log-buffer.js');
        const options = { colors: false, depth: 10, breakLength: Infinity, compact: false };
        const strings = (count, text) => Object.fromEntries(Array.from({ length: count }, (_, index) => ['key' + index, text]));
        const cases = {
            thousandShort: strings(1000, 'ab'),
            fourThousandEmpty: strings(4000, ''),
            lastOneThatFits: strings(4999, ''),
            firstOneCut: strings(5000, ''),
        };
        const results = {};
        for (const [name, value] of Object.entries(cases)) {
            const before = globalThis.__neconyanServerLogBuffer.nextId;
            console.log('case', value);
            const stored = globalThis.__neconyanServerLogBuffer.entries.filter(entry => entry.id >= before).map(entry => entry.message);
            const expected = formatWithOptions(options, 'case', value).split('\\n').filter(Boolean);
            results[name] = { exact: JSON.stringify(stored) === JSON.stringify(expected.slice(-1500)), stored: stored.length, expected: expected.length, cut: stored.some(line => line.includes('only its start is kept')) };
        }
        process.stderr.write(JSON.stringify(results) + '\\n');
    `, { silent: true });
    assert.equal(status, 0, stderr);
    assert.deepEqual(report.thousandShort, { exact: true, stored: 1002, expected: 1002, cut: false });
    assert.deepEqual(report.fourThousandEmpty, { exact: true, stored: 1500, expected: 4002, cut: false });
    assert.deepEqual(report.lastOneThatFits, { exact: true, stored: 1500, expected: 5001, cut: false });
    assert.equal(report.firstOneCut.cut, true, 'the 5,001st value is the first one cut');
    assert.ok(report.firstOneCut.stored <= 100);
});

/** One console.log of a single large object after 100 earlier lines: how much of the buffer does that call take? */
function bigCallScript(count, text) {
    return `
        const root = process.argv.at(-1);
        console.log = () => {};
        await import(root + '/src/server-log-buffer.js');
        for (let line = 0; line < 100; line++) console.log('earlier line ' + line);
        const value = Object.fromEntries(Array.from({ length: ${count} }, (_, index) => ['key' + index, ${JSON.stringify(text)}]));
        console.log('big', value);
        const lines = globalThis.__neconyanServerLogBuffer.entries.map(entry => entry.message);
        process.stderr.write(JSON.stringify({ kept: lines.filter(line => line.startsWith('earlier line')).length, total: lines.length, text: lines.slice(100).join('\\n') }) + '\\n');
    `;
}

for (const [title, count, text] of [
    ['20,000 two-character strings', 20000, 'ab'],
    ['200,000 empty strings', 200000, ''],
    ['5,000 empty strings, one more than fits', 5000, ''],
]) {
    test(`an object of ${title} is cut to a small share of the buffer and leaves the earlier lines in place`, () => {
        const { status, stderr, report } = runScript(bigCallScript(count, text), { silent: true });
        assert.equal(status, 0, stderr);
        assert.equal(report.kept, 100, 'no earlier line was evicted');
        assert.ok(report.total - 100 <= 100, `one call added ${report.total - 100} lines`);
        assert.match(report.text, /^big \{/);
        assert.match(report.text, /only its start is kept/);
    });
}

test('a cut argument prints as its text whichever way the format reads it', () => {
    const { status, stderr, report } = runScript(`
        const root = process.argv.at(-1);
        console.log = () => {};
        const { getServerLogSnapshot } = await import(root + '/src/server-log-buffer.js');
        const huge = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => [index === 0 ? '%s %d' : 'k' + index, { k: index }]));
        const stored = (...args) => {
            const before = getServerLogSnapshot({ limit: 600 }).latestId;
            console.log(...args);
            return getServerLogSnapshot({ limit: 600 }).entries.filter(entry => entry.id > before).map(entry => entry.message);
        };
        const calls = {
            plain: stored('value:', huge),
            percentS: stored('value: %s', huge),
            percentO: stored('value: %o', huge),
            percentCapitalO: stored('value: %O', huge),
            percentJ: stored('value: %j', huge),
            numbers: stored('numbers: %d %i %f %c|', huge, huge, huge, huge),
            first: stored(huge, 'then %s', 'tail'),
        };
        process.stderr.write(JSON.stringify(calls) + '\\n');
    `, { silent: true });
    assert.equal(status, 0, stderr);
    for (const [name, lines] of Object.entries(report)) {
        assert.ok(lines.length <= 100, `${name} added ${lines.length} lines`);
    }
    // The cut text is ordinary lines after the text before it, not one quoted string: %o used to inspect the text as a string.
    for (const name of ['plain', 'percentS', 'percentO', 'percentCapitalO']) {
        assert.equal(report[name][0], 'value: {', name);
        assert.ok(report[name].length > 50, `${name} is multi-line`);
        assert.match(report[name][1], /^ {2}'%s %d': \{/, `${name} keeps the text of the keys as it is`);
        assert.match(report[name].at(-1), /only its start is kept/, name);
    }
    assert.equal(report.percentJ.length, 1, 'JSON prints the text as one JSON string');
    assert.match(report.percentJ[0], /^value: "\{\\n/);
    assert.deepEqual(report.numbers, ['numbers: NaN NaN NaN |'], 'a cut value is not a number, and %c prints nothing');
    // A cut first argument is not read as a format string, although its text holds %s and %d.
    assert.equal(report.first[0], '{');
    assert.match(report.first[1], /^ {2}'%s %d': \{/);
    assert.match(report.first.at(-1), /only its start is kept\) then %s tail$/, 'the arguments after it are appended as they are');
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
        const root = process.argv.at(-2);
        if (process.argv.at(-1) === 'with-buffer') await import(root + '/src/server-log-buffer.js');
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
