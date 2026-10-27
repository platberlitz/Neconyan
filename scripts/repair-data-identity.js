#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { acquireDataRootOwner, describeDataRootOwner, recoverDataRootOwner } from '../src/data-root-owner.js';
import { inspectIdentityRepairRoot } from '../src/data-identity-repair-inspection.js';
import { activatePreparedIdentityRepair, identityRepairStatus, prepareIdentityRepair, publishIdentityRepair, verifyIdentityRepair } from '../src/data-identity-repair-transaction.js';
import { isBunRuntime, isNativeTermuxEnvironment } from '../src/runtime.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

function argumentsFor(argv) {
    const [command, ...args] = argv;
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
        if (!['--dataRoot', '--backupRoot', '--token', '--allServersStopped'].includes(args[index]) || !args[index + 1] || Object.hasOwn(values, args[index])) {
            throw new Error('Use check --dataRoot ROOT --backupRoot BACKUP, or status --dataRoot ROOT.');
        }
        values[args[index]] = args[index + 1];
    }
    if (!values['--dataRoot']) throw new Error('An explicit --dataRoot is required.');
    return { command, root: path.resolve(values['--dataRoot']), backup: values['--backupRoot'], token: values['--token'],
        allServersStopped: values['--allServersStopped'] };
}

async function main() {
    const { command, root, backup, token, allServersStopped } = argumentsFor(process.argv.slice(2));
    if (command === 'status') {
        const canonical = fs.realpathSync(root);
        console.log(JSON.stringify({ dataRoot: canonical, activeRepair: identityRepairStatus(canonical),
            ownership: describeDataRootOwner(canonical) }, null, 2));
        return;
    }
    if (command === 'recover-owner') {
        if (allServersStopped !== 'yes') throw new Error('Stop every Neconyan installation, then pass --allServersStopped yes with the token from status.');
        recoverDataRootOwner(root, token);
        console.log('The checked ownership record was released.');
        return;
    }
    if (!['check', 'apply', 'resume'].includes(command) || ['check', 'apply'].includes(command) && !backup
        || command === 'apply' && !token) throw new Error('Use check/apply --dataRoot ROOT --backupRoot BACKUP, or resume/status --dataRoot ROOT.');
    if (!isNativeTermuxEnvironment() || isBunRuntime()) throw new Error('Run this repair with Node.js in the affected Termux installation.');
    const owner = acquireDataRootOwner(root, 'repair');
    try {
        if (command === 'apply') {
            await prepareIdentityRepair(owner.root, backup, token, owner);
            const result = await publishIdentityRepair(owner.root, owner);
            console.log(JSON.stringify({ dataRoot: owner.root, operationId: result.id, phase: result.phase,
                next: 'Run resume in a new process to verify this repair before starting Neconyan.' }, null, 2));
            return;
        }
        if (command === 'resume') {
            const status = identityRepairStatus(owner.root);
            if (!status || ['needs-inspection', 'preparation-incomplete'].includes(status.phase)) throw new Error(status?.message ?? 'There is no active repair to resume.');
            if (status.phase === 'prepared-candidate') await activatePreparedIdentityRepair(owner.root, owner);
            if (['prepared', 'prepared-candidate', 'publishing'].includes(status.phase)) {
                const result = await publishIdentityRepair(owner.root, owner);
                console.log(JSON.stringify({ dataRoot: owner.root, operationId: result.id, phase: result.phase,
                    next: 'Run resume again in a new process to verify this repair.' }, null, 2));
                return;
            }
            console.log(JSON.stringify(await verifyIdentityRepair(owner.root, owner), null, 2));
            return;
        }
        const result = await inspectIdentityRepairRoot(owner.root, backup, { owner });
        console.log(JSON.stringify({ dataRoot: owner.root, backupRoot: result.input.backupRoot, device: result.input.device,
            accounts: result.input.accounts.map(({ owner: account, status, dataEpoch, report }) => ({ account, status, dataEpoch,
                nextDataEpoch: dataEpoch + 1, counts: report.counts, skipped: report.skipped, warnings: report.warnings, pending: report.pending })),
            files: result.input.inventory.files.length, backupBytes: result.bytes, excluded: result.input.inventory.excluded,
            consequences: 'Repair keeps account identities and statuses, rebuilds protected resource IDs, advances each account epoch and invalidates previously accepted work. Skipped files stay unchanged.',
            token: result.token }, null, 2));
    } finally { owner.release(); }
}

main().catch(error => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
});
