import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimestamp } from '../public/scripts/message-timestamp.js';
import {
    TIMESTAMP_CACHE_MAX_ENTRIES,
    createTimestampCache,
    isCacheableScalarTimestamp,
} from '../public/scripts/util/timestamp-cache.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const moment = require('moment');

function loadUtilsTimestampHelper(getLocale = () => 'en') {
    const utilsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'utils.js'), 'utf8');
    expect(utilsSource).toContain('import { createTimestampCache } from \'./util/timestamp-cache.js\';');
    const dateSource = utilsSource.slice(
        utilsSource.indexOf('const dateCache = createTimestampCache({'),
        utilsSource.indexOf('/** Split string to parts'),
    );
    const factory = new Function(
        'createTimestampCache',
        'moment',
        'parseTimestamp',
        'getCurrentLocale',
        `${dateSource.replace('export function', 'function')}\nreturn { read: timestampToMoment, size: () => dateCache.size(), keys: () => dateCache.keys(), clear: () => dateCache.clear() };`,
    );
    return factory(createTimestampCache, moment, parseTimestamp, getLocale);
}

describe('bounded timestampToMoment cache', () => {
    test('caps retained entries at 2048 across both the helper factory and utils.js timestampToMoment', () => {
        expect(TIMESTAMP_CACHE_MAX_ENTRIES).toBe(2048);

        const helper = loadUtilsTimestampHelper(() => 'en');
        for (let i = 0; i < 5000; i++) {
            const result = helper.read(1700000000000 + i * 1000);
            expect(result.isValid()).toBe(true);
        }
        expect(helper.size()).toBe(2048);
        expect(helper.keys()[0]).toBe(1700000000000 + (5000 - 2048) * 1000);
        expect(helper.keys().at(-1)).toBe(1700000000000 + 4999 * 1000);
    });

    test('refreshes recency on cache hits and recomputes evicted entries identically', () => {
        let parseCount = 0;
        const cache = createTimestampCache({
            moment,
            parseTimestamp: value => {
                parseCount += 1;
                return parseTimestamp(value);
            },
            getCurrentLocale: () => 'en',
            maxEntries: 3,
        });

        const first = cache.read('2026-10-14T08:00:00.000Z');
        cache.read('2026-10-14T09:00:00.000Z');
        cache.read('2026-10-14T10:00:00.000Z');
        expect(cache.keys()).toEqual([
            '2026-10-14T08:00:00.000Z',
            '2026-10-14T09:00:00.000Z',
            '2026-10-14T10:00:00.000Z',
        ]);
        expect(parseCount).toBe(3);

        // Accessing the oldest entry refreshes its recency without re-parsing.
        expect(cache.read('2026-10-14T08:00:00.000Z')).toBe(first);
        expect(parseCount).toBe(3);
        expect(cache.keys()).toEqual([
            '2026-10-14T09:00:00.000Z',
            '2026-10-14T10:00:00.000Z',
            '2026-10-14T08:00:00.000Z',
        ]);

        // Inserting a fourth entry evicts the least recently used entry (09:00).
        cache.read('2026-10-14T11:00:00.000Z');
        expect(cache.has('2026-10-14T09:00:00.000Z')).toBe(false);
        expect(cache.has('2026-10-14T08:00:00.000Z')).toBe(true);

        // Reading the evicted entry recomputes the same Moment value.
        const recomputed = cache.read('2026-10-14T09:00:00.000Z');
        expect(recomputed.toISOString()).toBe('2026-10-14T09:00:00.000Z');
        expect(parseCount).toBe(5);
    });

    test('clears cached Moment instances when the active display locale changes', () => {
        let activeLocale = 'en';
        const helper = loadUtilsTimestampHelper(() => activeLocale);

        const enMoment = helper.read('2026-10-14T12:30:00.000Z');
        expect(enMoment.locale()).toBe('en');
        expect(helper.size()).toBe(1);

        activeLocale = 'fr';
        const frMoment = helper.read('2026-10-14T12:30:00.000Z');
        expect(frMoment).not.toBe(enMoment);
        expect(frMoment.locale()).toBe('fr');
        expect(helper.size()).toBe(1);
    });

    test('caches only scalar string and finite number keys, never mutable Date objects, and preserves invalid-date behaviour', () => {
        expect(isCacheableScalarTimestamp('2026-10-14T12:00:00Z')).toBe(true);
        expect(isCacheableScalarTimestamp(1700000000000)).toBe(true);
        expect(isCacheableScalarTimestamp(new Date(1700000000000))).toBe(false);
        expect(isCacheableScalarTimestamp(null)).toBe(false);
        expect(isCacheableScalarTimestamp(undefined)).toBe(false);
        expect(isCacheableScalarTimestamp(Number.NaN)).toBe(false);
        expect(isCacheableScalarTimestamp({})).toBe(false);

        const helper = loadUtilsTimestampHelper(() => 'en');
        const dateObj = new Date('2026-10-14T12:00:00.000Z');
        const fromDate = helper.read(dateObj);
        expect(helper.size()).toBe(0);
        expect(fromDate.isValid()).toBe(true);
        expect(fromDate.year()).toBe(2026);

        // Mutating the Date instance must not return a stale cached 2026 Moment.
        dateObj.setUTCFullYear(2020);
        expect(helper.read(dateObj).year()).toBe(2020);
        expect(helper.size()).toBe(0);

        const invalidScalar = helper.read('not-a-valid-timestamp');
        expect(invalidScalar.isValid()).toBe(false);
        expect(helper.size()).toBe(1);
        expect(helper.read('not-a-valid-timestamp')).toBe(invalidScalar);

        const validScalar = helper.read('October 14, 2026 3:45pm');
        expect(validScalar.isValid()).toBe(true);
        expect(validScalar.year()).toBe(2026);
    });
});
