import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDirectory, tryWriteFileSync } from './util.js';
import { AGENT_STORAGE_LIMITS, getAgentRecordError, isAgentRecordId, isAgentSetupId, normalizeAgentGroup, normalizeAgentSetupPreset, serializeAgentRecord } from '../public/scripts/extensions/in-chat-agents/setup-presets.js';

export function agentRecordRevision(record) {
    return crypto.createHash('sha256').update(serializeAgentRecord(record)).digest('hex');
}

function validate(record, kind) {
    return kind === 'agent' ? !getAgentRecordError(record)
        : Boolean(kind === 'group' ? normalizeAgentGroup(record) : normalizeAgentSetupPreset(record));
}

function storageError(status, message) {
    return Object.assign(new Error(message), { status });
}

function listRecordFiles(directory, kind) {
    const files = [];
    const limit = AGENT_STORAGE_LIMITS[`${kind}Count`];
    let inspected = 0;
    const entries = fs.opendirSync(directory);
    try {
        for (let entry; (entry = entries.readSync());) {
            if (++inspected > limit * 2 || files.length > limit) return { files: files.sort(), overflow: true };
            if (entry.name.toLowerCase().endsWith('.json')) files.push(entry.name);
        }
    } finally { entries.closeSync(); }
    return { files: files.sort(), overflow: files.length > limit };
}

export function readAgentCollection(directory, kind = 'agent') {
    const records = [], errors = [], revisions = {};
    if (!fs.existsSync(directory)) return { records, errors, revisions };
    const { files, overflow } = listRecordFiles(directory, kind);
    if (overflow) errors.push({ file: 'Collection', message: 'Too many records to load safely. Existing files were kept.' });
    let bytes = 0;
    for (const file of files.slice(0, AGENT_STORAGE_LIMITS[`${kind}Count`])) {
        try {
            const filename = path.join(directory, file);
            const size = fs.statSync(filename).size;
            if (size > AGENT_STORAGE_LIMITS[`${kind}Bytes`] || bytes + size > AGENT_STORAGE_LIMITS.collectionBytes) throw new Error('Storage size limit exceeded.');
            bytes += size;
            const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!validate(record, kind) || `${record.id}.json` !== file) throw new Error('Invalid record or mismatched file identifier.');
            if (Object.hasOwn(revisions, record.id)) throw new Error('Duplicate record identifier.');
            records.push(record);
            Object.defineProperty(revisions, record.id, { value: agentRecordRevision(record), enumerable: true });
        } catch (error) {
            errors.push({ file, message: error.message });
        }
    }
    return { records, errors, revisions };
}

/** Compare and write synchronously: another request cannot enter between the comparison and atomic replacement. */
export function writeAgentRecord(request, directory, kind, record, { remove = false } = {}) {
    const id = record?.id;
    if (!(kind === 'preset' ? isAgentSetupId(id) : isAgentRecordId(id))) throw storageError(400, 'Invalid record identifier.');
    const account = request.get('X-Neconyan-Account');
    if (account !== undefined && account !== request.user.profile.handle) throw storageError(409, 'The signed-in account changed. Reload the agent library.');
    const text = remove ? '' : JSON.stringify(record);
    const size = Buffer.byteLength(text);
    if (size > AGENT_STORAGE_LIMITS[`${kind}Bytes`]) throw storageError(413, 'Record storage size limit exceeded.');
    if (!remove && !validate(record, kind)) throw storageError(400, 'Invalid agent, kit or setup data.');
    const filename = path.join(directory, `${id}.json`);
    const expected = request.get('If-Match');
    if (expected !== undefined) {
        let revision = 'missing';
        if (fs.existsSync(filename)) {
            if (fs.statSync(filename).size > AGENT_STORAGE_LIMITS[`${kind}Bytes`]) throw storageError(409, 'The existing record needs recovery before it can be replaced.');
            revision = agentRecordRevision(JSON.parse(fs.readFileSync(filename, 'utf8')));
        }
        if (revision !== expected) throw storageError(409, 'This record changed in another tab or device. Reload it before saving.');
    }
    if (remove) {
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
        return 'missing';
    }
    ensureDirectory(directory);
    const { files, overflow } = listRecordFiles(directory, kind);
    if (overflow) throw storageError(413, 'The collection exceeds its loading limit. Existing files were kept.');
    if (!files.includes(`${id}.json`) && files.length >= AGENT_STORAGE_LIMITS[`${kind}Count`]) throw storageError(413, 'Collection item limit exceeded.');
    const total = files.filter(name => name !== `${id}.json`).reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, size);
    if (total > AGENT_STORAGE_LIMITS.collectionBytes) throw storageError(413, 'Collection storage limit exceeded.');
    tryWriteFileSync(filename, text);
    return agentRecordRevision(record);
}
