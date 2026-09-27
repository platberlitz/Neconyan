import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tryWriteFileSync } from './util.js';
import { checkMeowerReceipts } from '../public/scripts/extensions/third-party/Neconyan-Hopper/server/job-receipts.js';

const STORE_LIMIT = 128 * 1024 * 1024;
const RECORD_LIMIT = 17 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'MEOWER_RECEIPTS_UNAVAILABLE' }); };
const folder = root => path.join(root, 'meower-receipts');

function decode(file) {
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { fail('Saved Meower receipts are unreadable. Nothing was deleted.'); }
    if (value?.version !== 1 || typeof value.accountId !== 'string' || !Number.isSafeInteger(value.dataEpoch) || value.dataEpoch < 1
        || typeof value.resetId !== 'string' || value.hash !== hash(JSON.stringify(value.receipts))) {
        fail('Saved Meower receipts need recovery. Nothing was deleted.');
    }
    checkMeowerReceipts(value.receipts);
    return value;
}

function records(root, readFile) {
    const directory = folder(root);
    readFile(path.join(directory, '.path-check'), 1, { allowMissingParent: true });
    return fs.existsSync(directory) ? fs.readdirSync(directory).map(name => {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('The Meower receipt directory needs recovery. Nothing was deleted.');
        const file = readFile(path.join(directory, name), RECORD_LIMIT);
        if (!file) fail('A saved Meower receipt record disappeared. Nothing was deleted.');
        const value = decode(file);
        const identity = { accountId: value.accountId, dataEpoch: value.dataEpoch, resetId: value.resetId };
        if (name !== `${hash(JSON.stringify(identity))}.json`) fail('A saved Meower receipt record has a different identity.');
        return { file, value };
    }) : [];
}

/** Runs synchronously under the account reset lock, before any user data is removed. */
export function preserveMeowerReceipts(scope, root, state, { readFile, createDirectory }) {
    const identity = { accountId: state.accountId, dataEpoch: state.dataEpoch, resetId: state.pending.id };
    const filename = path.join(folder(root), `${hash(JSON.stringify(identity))}.json`);
    const existing = readFile(filename, RECORD_LIMIT, { allowMissingParent: true });
    const previous = existing && decode(existing);
    if (previous && Object.entries(identity).some(([key, value]) => previous[key] !== value)) fail('The Meower reset receipt has a different owner.');
    const source = readFile(path.join(scope.directories.root, 'hopper', 'store.json'), STORE_LIMIT, { allowMissingParent: true });
    let receipts = {};
    if (source) {
        let store;
        try { store = JSON.parse(source.bytes.toString('utf8')); } catch { fail('The Meower store is unreadable. Restore it before resetting the account.'); }
        if (!store || typeof store !== 'object' || store.account !== undefined && store.account !== scope.owner) fail('The Meower store belongs to a different account.');
        receipts = store.jobReceipts ?? {};
        checkMeowerReceipts(receipts);
    } else if (!previous && readFile(path.join(scope.directories.root, 'hopper', 'store.previous.json'), STORE_LIMIT, { allowMissingParent: true })) {
        fail('The Meower store is missing but its backup exists. Recover it before resetting the account.');
    }
    if (previous) {
        if (source && previous.hash !== hash(JSON.stringify(receipts))) fail('The Meower receipts changed during account reset.');
        readFile(filename, RECORD_LIMIT, { flush: true });
        return;
    }
    const value = { version: 1, ...identity, receipts, hash: hash(JSON.stringify(receipts)) };
    const bytes = JSON.stringify(value);
    const used = records(root, readFile).reduce((total, record) => total + record.file.bytes.length, Buffer.byteLength(bytes));
    if (Buffer.byteLength(bytes) > RECORD_LIMIT || used > TOTAL_LIMIT) fail('Meower receipt storage is full. Existing data and receipts were retained.');
    createDirectory(folder(root), root);
    tryWriteFileSync(filename, bytes, { encoding: 'utf8', mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const written = readFile(filename, RECORD_LIMIT, { flush: true });
    if (!written || written.bytes.toString('utf8') !== bytes) fail('The Meower reset receipt write needs recovery. Nothing was deleted.');
}

/** Retired receipts reject an old operation key without restoring any deleted feed content. */
export function findRetiredMeowerReceipt(root, account, key, readFile) {
    for (const { value } of records(root, readFile)) {
        if (value.accountId === account.accountId && Object.hasOwn(value.receipts, key)) return value.receipts[key];
    }
    return null;
}
