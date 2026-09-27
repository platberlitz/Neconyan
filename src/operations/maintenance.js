import path from 'node:path';
import { readRoleplayFile, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { authoringEvidence } from '../authoring-store.js';
import { captureMaintenanceFiles, captureMaintenancePlan, maintenanceReport, MAINTENANCE_FILE_LIMIT } from './maintenance-scan.js';
import { publishFileDeletions } from './file-deletion.js';
import { registerOperation } from './jobs.js';
import { operationError, readOperation } from './store.js';

function selectedReport(base, key, hash) {
    const record = readOperation(base, key);
    if (!record || record.kind !== 'maintenance-report' || record.state !== 'completed' || record.resultHash !== hash) {
        throw operationError('The saved maintenance report is unavailable or changed.');
    }
    return record;
}

export function captureMaintenanceDeletion(base, account, input) {
    const record = selectedReport(base, input.reportKey, input.resultHash);
    if (!Array.isArray(input.hashes) || !input.hashes.length || input.hashes.length > 100000 || new Set(input.hashes).size !== input.hashes.length) throw operationError('Select distinct files from the saved report.', 400);
    const authorised = new Set(Object.values(record.result.report).flat().map(item => item.hash));
    if (input.hashes.some(hash => !authorised.has(hash))) throw operationError('A selected file is not in the saved report.');
    return withRoleplayAccount(base, account, () => {
        const current = captureMaintenancePlan(base);
        const unused = new Set(Object.values(maintenanceReport(current).report).flat().map(item => item.hash));
        const files = input.hashes.map(hash => {
            const original = record.plan.files.find(file => roleplayHash(file.relative) === hash);
            const latest = current.files.find(file => file.relative === original.relative);
            if (!unused.has(hash) || !latest || roleplayHash(latest.evidence) !== roleplayHash(original.evidence)) throw operationError('A reviewed file changed or is now in use. Start a new maintenance scan.');
            return original;
        });
        return { files, manifest: { files: current.files, directories: current.directories }, reportKey: record.key };
    });
}

export function readMaintenanceView(base, key, hash) {
    const record = readOperation(base, key);
    if (!record || record.kind !== 'maintenance-report' || record.state !== 'completed'
        || !Object.values(record.result.report).flat().some(item => item.hash === hash)) throw operationError('The file is not in this saved report.', 404);
    return withRoleplayAccount(base, record.account, () => {
        const selected = record.plan.files.find(file => roleplayHash(file.relative) === hash);
        const file = readRoleplayFile(path.join(base.directories.root, selected.relative), MAINTENANCE_FILE_LIMIT);
        if (!file || roleplayHash(authoringEvidence(file)) !== roleplayHash(selected.evidence)) throw operationError('This file changed after the report. Start a new scan to view it.');
        return { bytes: file.bytes, name: path.basename(selected.relative) };
    });
}

registerOperation('maintenance-report', { label: 'Scan unused account files',
    capture: (base, account) => withRoleplayAccount(base, account, () => captureMaintenancePlan(base)),
    run: async (context, plan) => { await context.progress({ stage: 'Preparing saved maintenance report', completed: 0, total: 1 }); return maintenanceReport(plan); } });

registerOperation('maintenance-delete', { label: 'Delete reviewed unused files', capture: captureMaintenanceDeletion,
    target: () => ({ kind: 'maintenance', id: 'reviewed-account-files' }), canRecover: value => value.deletionsReady === true,
    run: (context, plan, dependencies) => publishFileDeletions(context, plan.files, { removed: plan.files.length, reportKey: plan.reportKey }, {
        ...dependencies, verify: lease => {
            if (roleplayHash(captureMaintenanceFiles(roleplayLease(lease).scope)) !== roleplayHash(plan.manifest)) {
                throw operationError('The account files changed after deletion was accepted. No new deletion was started.');
            }
        },
    }) });
