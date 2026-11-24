import { describe, expect, test } from '@jest/globals';

import { createPromptingStorage } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/storage-core.js';

function createStorage() {
    const storage = createPromptingStorage(null);
    storage.__setStoreForTests(storage.createMemoryStore());
    return storage;
}

describe('Prompting Lab inventory', () => {
    test('reports every count in one read', async () => {
        const storage = createStorage();
        await storage.saveSuite({ id: 'suite', name: 'Suite', caseIds: ['one', 'two'] });
        await storage.saveCase({
            id: 'one',
            name: 'One',
            assertions: [{ type: 'section-present', section: 'system' }],
        });
        await storage.saveCase({ id: 'two', name: 'Two' });
        await storage.saveRun({ id: 'run-1', caseId: 'one', startedAt: '2026-01-01T00:00:00.000Z', status: 'pass' });
        await storage.saveRun({ id: 'run-2', caseId: 'one', startedAt: '2026-01-02T00:00:00.000Z', status: 'pass' });
        await storage.saveRun({ id: 'run-3', caseId: 'two', startedAt: '2026-01-03T00:00:00.000Z', status: 'pass' });

        await expect(storage.getInventory()).resolves.toEqual({
            suites: 1,
            cases: 2,
            checks: 1,
            runs: 3,
            drafts: 0,
            prompts: 0,
            ledger: 0,
        });
    });

    test('counts only runs that still match their index entry', async () => {
        const storage = createStorage();
        await storage.saveCase({ id: 'case', name: 'Case' });
        await storage.saveRun({ id: 'run', caseId: 'case', startedAt: '2026-01-01T00:00:00.000Z', status: 'pass' });
        await storage.deleteRun('case', 'run');

        await expect(storage.countRuns(['case'])).resolves.toBe(0);
    });
});
