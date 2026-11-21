import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'scripts', 'extensions',
    'third-party', 'Neconyan-Time-Machine', 'index.js'), 'utf8');

describe('Time Machine start-up', () => {
    test('preset snapshots wait for browser idle time', () => {
        expect(source).toContain('function scheduleHistoryPreparation()');
        expect(source).toContain('requestIdleCallback(run, { timeout: 4000 })');
        expect(source).toContain('setTimeout(run, 1500)');
        expect(source).toContain('if (active) prepareHistory();');
    });

    test('both UI paths schedule the background check instead of running it inline', () => {
        expect(source.match(/^        scheduleHistoryPreparation\(\);$/gm)).toHaveLength(1);
        expect(source.match(/^    scheduleHistoryPreparation\(\);$/gm)).toHaveLength(1);
    });
});
