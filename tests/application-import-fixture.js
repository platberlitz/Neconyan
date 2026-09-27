import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Drive a real complete native import when an existing storage test needs one imported file. */
export async function importTestFile(account, destination, bytes) {
    const { captureAccountImport } = await import('../src/operations/account-import.js');
    const { admitOperation, finalizeOperation, readOperation } = await import('../src/operations/store.js');
    const { runOperation } = await import('../src/operations/jobs.js');
    const base = { owner: account.owner, directories: account.directories };
    const sourceRoot = fs.mkdtempSync(path.join(path.dirname(base.directories.root), 'import-fixture-'));
    try {
        fs.mkdirSync(path.join(sourceRoot, 'characters'));
        const source = path.join(sourceRoot, path.relative(base.directories.root, destination));
        fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, bytes);
        const input = { mode: 'folder', path: sourceRoot };
        const plan = await captureAccountImport(base, account, input, { defaults: { directories: [], files: [] } });
        const key = randomUUID();
        const accepted = admitOperation(base, account, { key, kind: 'account-import', input, plan, label: 'Import fixture' });
        finalizeOperation({ ...base, job: accepted.job });
        await runOperation({ ...base, job: accepted.job, signal: new AbortController().signal, progress: async () => {} });
        return readOperation(base, key);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
}
