import { describe, expect, test } from '@jest/globals';

import {
    createMemoryEvidence,
    describeChildStop,
    describeFatalStop,
    MEMORY_SAMPLE_LIMIT,
    parseMemorySample,
} from '../src/server-crash-evidence.js';

const MIB = 1024 * 1024;

function sample(overrides = {}) {
    return {
        at: '2026-11-23T10:00:00.000Z',
        uptimeSeconds: 120,
        rss: 300 * MIB,
        heapUsed: 200 * MIB,
        heapTotal: 250 * MIB,
        heapLimit: 1024 * MIB,
        external: 10 * MIB,
        arrayBuffers: 2 * MIB,
        deviceAvailable: 4096 * MIB,
        deviceTotal: 12288 * MIB,
        ...overrides,
    };
}

function fatal(overrides = {}) {
    return {
        event: 'Allocation failed - JavaScript heap out of memory',
        trigger: 'OOMError',
        at: '2026-11-23T10:05:00Z',
        outOfMemory: true,
        heap: { used: 1010 * MIB, total: 1020 * MIB, limit: 1014 * MIB, available: 4 * MIB, spaces: {} },
        rss: 1200 * MIB,
        maxRss: 1250 * MIB,
        device: { free: 2000 * MIB, total: 12288 * MIB },
        nativeStack: [],
        ...overrides,
    };
}

describe('parseMemorySample', () => {
    test('keeps a complete reading and drops any field it does not know', () => {
        const parsed = parseMemorySample({ ...sample(), secret: 'x' });
        expect(parsed).toEqual(sample());
        expect(parsed).not.toHaveProperty('secret');
    });

    test.each([
        ['null', null],
        ['a string', 'sample'],
        ['an array', [sample()]],
        ['a missing time', { ...sample(), at: undefined }],
        ['an unreadable time', sample({ at: 'last Tuesday' })],
        ['an overlong time', sample({ at: `2026-11-23T10:00:00.000Z${' '.repeat(40)}` })],
        ['a negative number', sample({ rss: -1 })],
        ['NaN', sample({ heapUsed: Number.NaN })],
        ['Infinity', sample({ heapLimit: Number.POSITIVE_INFINITY })],
        ['a numeric string', sample({ external: '5' })],
        ['a missing number', { ...sample(), deviceTotal: undefined }],
    ])('drops %s', (_name, value) => {
        expect(parseMemorySample(value)).toBeNull();
    });
});

describe('createMemoryEvidence', () => {
    test('keeps the newest twelve readings and the highest heap reading even after it ages out', () => {
        const evidence = createMemoryEvidence();
        expect(evidence.snapshot()).toBeNull();
        evidence.add(sample({ at: '2026-11-23T10:00:00.000Z', heapUsed: 900 * MIB }));
        for (let index = 1; index <= MEMORY_SAMPLE_LIMIT + 3; index++) {
            evidence.add(sample({ at: new Date(Date.UTC(2026, 10, 23, 10, 0, index * 10)).toISOString(), heapUsed: (100 + index) * MIB }));
        }
        const { samples, peak } = evidence.snapshot();
        expect(samples).toHaveLength(MEMORY_SAMPLE_LIMIT);
        expect(samples.at(-1).heapUsed).toBe(115 * MIB);
        expect(samples[0].heapUsed).toBe(104 * MIB);
        expect(peak.heapUsed).toBe(900 * MIB);
    });

    test('ignores invalid readings without disturbing the valid ones', () => {
        const evidence = createMemoryEvidence();
        expect(evidence.add(sample())).toBe(true);
        expect(evidence.add(sample({ rss: -5 }))).toBe(false);
        expect(evidence.add({ type: 'nonsense' })).toBe(false);
        expect(evidence.snapshot().samples).toHaveLength(1);
    });
});

describe('describeFatalStop', () => {
    test('states an out-of-memory stop with the figures Node reported', () => {
        const stop = describeFatalStop(fatal());
        expect(stop.kind).toBe('server-out-of-memory');
        expect(stop.explanation).toBe('The server ran out of JavaScript memory and stopped. It was using 1010 MB of its 1014 MB limit when Node reported: Allocation failed - JavaScript heap out of memory.');
        expect(stop.headline).toBe('it ran out of JavaScript memory (1010 MB of 1014 MB)');
    });

    test('leaves the figures out when Node did not report them', () => {
        const stop = describeFatalStop(fatal({ heap: { used: null, total: null, limit: null, available: null, spaces: {} } }));
        expect(stop.explanation).toBe('The server ran out of JavaScript memory and stopped. Node reported: Allocation failed - JavaScript heap out of memory.');
    });

    test('quotes the event for a fatal error that is not out of memory', () => {
        const stop = describeFatalStop(fatal({ event: 'Check failed: node->IsReady()', trigger: 'FatalError', outOfMemory: false }));
        expect(stop.kind).toBe('server-fatal-error');
        expect(stop.explanation).toBe('The server stopped after Node reported a fatal error: Check failed: node->IsReady().');
        expect(stop.explanation).not.toMatch(/memory/);
    });
});

describe('describeChildStop', () => {
    const memory = { samples: [sample()], peak: sample() };

    test('an out-of-memory report names the cause, the readings and a next step', () => {
        const stop = describeChildStop({ pid: 4242, code: null, signal: 'SIGABRT', fatal: fatal(), memory, heapLimitArgument: '--max-old-space-size=1024' });
        expect(stop.kind).toBe('server-out-of-memory');
        expect(stop.extra.child).toEqual({ pid: 4242, signal: 'SIGABRT', exitCode: null, heapLimitArgument: '--max-old-space-size=1024', fatal: fatal(), memory });
        expect(stop.extra.nextStep).toContain('Server Memory (Node.js)');
        expect(stop.extra.nextStep).toContain('NODE_OPTIONS=--max-old-space-size=<MB>');
        expect(stop.extra.nextStep).toContain('above 1014');
        expect(stop.extra.limitation).toContain('surviving supervisor');
        expect(stop.extra.limitation).toContain('child.memory');
    });

    test('a signal with no fatal report keeps the honest wording and claims no cause', () => {
        const stop = describeChildStop({ pid: 7, code: null, signal: 'SIGABRT', memory: { samples: [sample({ heapUsed: 100 * MIB })], peak: sample() }, stoppedAt: Date.parse('2026-11-23T10:00:30.000Z') });
        expect(stop.kind).toBe('child-process-signal');
        expect(stop.explanation).toBe('The operating system terminated the server with SIGABRT. A signal alone does not establish why it was sent.');
        expect(stop.extra.nextStep).toBeUndefined();
        expect(stop.extra.child.fatal).toBeUndefined();
        expect(stop.headline).toBe('it was terminated by SIGABRT');
    });

    test('adds an observation, not a cause, when the last reading showed a nearly full heap', () => {
        const stop = describeChildStop({
            pid: 7, code: null, signal: 'SIGKILL', stoppedAt: Date.parse('2026-11-23T10:00:07.000Z'),
            memory: { samples: [sample({ heapUsed: 950 * MIB, heapLimit: 1000 * MIB })], peak: sample() },
        });
        expect(stop.kind).toBe('child-process-signal');
        expect(stop.explanation).toContain('The last reading, 7 seconds before it stopped, showed the JavaScript heap at 95% of its 1000 MB limit.');
        expect(stop.explanation).not.toMatch(/ran out|out of memory/i);
    });

    test('adds an observation when the device was almost out of memory', () => {
        const stop = describeChildStop({
            pid: 7, code: 3, signal: null, stoppedAt: Date.parse('2026-11-23T10:00:01.000Z'),
            memory: { samples: [sample({ deviceAvailable: 100 * MIB, deviceTotal: 12288 * MIB })], peak: sample() },
        });
        expect(stop.kind).toBe('child-process-exit');
        expect(stop.explanation).toContain('The server exited with code 3 without completing its exit handler. No further cause was supplied.');
        expect(stop.explanation).toContain('The last reading, 1 second before it stopped, showed 100 MB of 12288 MB of device memory available.');
    });

    test('adds nothing when the readings looked ordinary, and says when none arrived', () => {
        const ordinary = describeChildStop({ pid: 7, code: null, signal: 'SIGKILL', memory: { samples: [sample()], peak: sample() } });
        expect(ordinary.explanation).toBe('The operating system terminated the server with SIGKILL. A signal alone does not establish why it was sent.');
        const none = describeChildStop({ pid: 7, code: null, signal: 'SIGKILL' });
        expect(none.extra.child).toEqual({ pid: 7, signal: 'SIGKILL', exitCode: null });
        expect(none.extra.child).not.toHaveProperty('memory');
        expect(none.extra.limitation).toContain('No memory reading arrived');
    });
});
