import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acquireDataRootOwner } = await import('../src/data-root-owner.js');
const { prepareIdentityRepair, publishIdentityRepair, verifyIdentityRepair } = await import('../src/data-identity-repair-transaction.js');
const [root, backup, token, mode] = process.argv.slice(2);
const owner = acquireDataRootOwner(root, 'repair');
if (['prepare', 'gate-before', 'gate-after'].includes(mode)) {
    if (mode !== 'prepare') {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
            const gate = path.basename(to) === '_neconyan-policy-repair' && path.basename(from).startsWith('_neconyan-policy-repair-preparing-');
            if (mode === 'gate-before' && gate) process.kill(process.pid, 'SIGKILL');
            const result = rename(from, to);
            if (mode === 'gate-after' && gate) process.kill(process.pid, 'SIGKILL');
            return result;
        };
    }
    await prepareIdentityRepair(owner.root, backup, token, owner);
    if (mode !== 'prepare') throw new Error('Requested crash point was not reached.');
    owner.release();
} else if (['retire-before', 'retire-after', 'archive-before', 'archive-after'].includes(mode)) {
    const unlink = fs.unlinkSync;
    const rename = fs.renameSync;
    fs.unlinkSync = filename => {
        const journal = String(filename).endsWith('.neconyan-write-recovery');
        if (mode === 'retire-before' && journal) process.kill(process.pid, 'SIGKILL');
        const result = unlink(filename);
        if (mode === 'retire-after' && journal) process.kill(process.pid, 'SIGKILL');
        return result;
    };
    fs.renameSync = (from, to) => {
        const archive = path.basename(from) === '_neconyan-policy-repair' && path.basename(to) === 'operation';
        if (mode === 'archive-before' && archive) process.kill(process.pid, 'SIGKILL');
        const result = rename(from, to);
        if (mode === 'archive-after' && archive) process.kill(process.pid, 'SIGKILL');
        return result;
    };
    await verifyIdentityRepair(owner.root, owner);
    throw new Error('Requested crash point was not reached.');
} else {
    const rename = fs.renameSync;
    let ledgerRenames = 0;
    fs.renameSync = (from, to) => {
        const ledger = path.basename(to) === 'state.json' && String(from).includes(`${path.sep}publication${path.sep}`);
        const marker = path.basename(to) === '_termux-file-identity.json' && path.basename(from) === 'policy';
        if (ledger) ledgerRenames++;
        if (mode === 'second-ledger-before' && ledger && ledgerRenames === 2) process.kill(process.pid, 'SIGKILL');
        if ((mode === 'ledger-before' && ledger) || (mode === 'marker-before' && marker)) process.kill(process.pid, 'SIGKILL');
        const result = rename(from, to);
        if ((mode === 'ledger-after' && ledger) || (mode === 'marker-after' && marker)) process.kill(process.pid, 'SIGKILL');
        return result;
    };
    await publishIdentityRepair(owner.root, owner);
    throw new Error('Requested crash point was not reached.');
}
