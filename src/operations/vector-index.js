import path from 'node:path';
import sanitize from 'sanitize-filename';
import { roleplayHash, roleplayLease } from '../roleplay-store.js';
import { authoringEvidence, assertAuthoringEvidence, readAuthoringFileLocked, stageAuthoringFileLocked, publishAuthoringFileLocked } from '../authoring-store.js';
import { operationError, withOperation } from './store.js';

export const VECTOR_INDEX_LIMIT = 32 * 1024 * 1024;
const norm = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
const invalid = () => operationError('The saved vector index needs recovery. Its existing contents have been kept.');

export function vectorIndexPath(directories, policy, collectionId, model = policy.settings.model) {
    if (typeof collectionId !== 'string' || !collectionId || collectionId.length > 500 || !sanitize(collectionId)) {
        throw operationError('A valid vector collection is required.', 400);
    }
    return path.join(directories.vectors, sanitize(policy.source), sanitize(collectionId), sanitize(String(model || '')), 'index.json');
}

/** Read Vectra's native format without creating, deleting or repairing an index as a side effect. */
export function captureVectorIndex(lease, policy, collectionId, model) {
    const { scope } = roleplayLease(lease);
    const filename = vectorIndexPath(scope.directories, policy, collectionId, model);
    const file = readAuthoringFileLocked(lease, filename, VECTOR_INDEX_LIMIT);
    let data = { version: 1, metadata_config: {}, items: [] };
    if (file) {
        try { data = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid(); }
    }
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 100000) throw invalid();
    const ids = new Set();
    const dependencies = [];
    data.items = data.items.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !Array.isArray(item.vector)
            || !item.vector.length || item.vector.length > 65536 || item.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
            || !Number.isFinite(norm(item.vector)) || norm(item.vector) <= 0 || !item.metadata || typeof item.metadata !== 'object'
            || Array.isArray(item.metadata)) throw invalid();
        ids.add(item.id);
        let metadata = item.metadata;
        if (item.metadataFile) {
            if (typeof item.metadataFile !== 'string' || path.basename(item.metadataFile) !== item.metadataFile || !item.metadataFile.endsWith('.json')) throw invalid();
            const metadataPath = path.join(path.dirname(filename), item.metadataFile);
            const source = readAuthoringFileLocked(lease, metadataPath, VECTOR_INDEX_LIMIT);
            if (!source) throw invalid();
            try {
                const external = JSON.parse(source.bytes.toString('utf8'));
                if (!external || typeof external !== 'object' || Array.isArray(external)) throw invalid();
                metadata = { ...external, ...metadata };
            } catch { throw invalid(); }
            dependencies.push({ relative: path.relative(scope.directories.root, metadataPath), evidence: authoringEvidence(source) });
        }
        // Inline legacy sidecar metadata so the replacement is published as one native index file.
        const retained = { ...item };
        delete retained.metadataFile;
        return { ...retained, metadata, norm: norm(item.vector) };
    });
    return { collectionId, model: model ?? policy.settings.model, relative: path.relative(scope.directories.root, filename),
        evidence: authoringEvidence(file), dependencies, data };
}

export function assertVectorIndex(lease, snapshot) {
    const { scope } = roleplayLease(lease);
    assertAuthoringEvidence(lease, path.join(scope.directories.root, snapshot.relative), snapshot.evidence, VECTOR_INDEX_LIMIT);
    for (const source of snapshot.dependencies) assertAuthoringEvidence(lease,
        path.join(scope.directories.root, source.relative), source.evidence, VECTOR_INDEX_LIMIT);
}

export function vectorItem(collectionId, metadata, vector, occurrence = 0) {
    const magnitude = norm(vector);
    if (!Number.isFinite(magnitude) || magnitude <= 0) throw invalid();
    return { id: roleplayHash([collectionId, metadata, occurrence]), metadata, vector, norm: magnitude };
}

/** Stage every replacement before publishing any of them; all earlier index files remain until then. */
export function publishVectorIndexes(context, replacements, result, { verifySources = () => {}, afterVectorPublication } = {}) {
    return withOperation(context, ({ lease, value, save, base }) => {
        if (!value.vectorPublicationReady) {
            context.signal.throwIfAborted();
            verifySources(lease);
            for (const replacement of replacements) assertVectorIndex(lease, replacement.snapshot);
            for (const [index, replacement] of replacements.entries()) {
                const key = `vector:${index}`;
                if (value.effects[key]) continue;
                const staged = stageAuthoringFileLocked(lease, path.join(base.directories.root, replacement.snapshot.relative),
                    JSON.stringify(replacement.data), { expected: replacement.snapshot.evidence, limit: VECTOR_INDEX_LIMIT });
                value.effects[key] = { state: 'prepared', staged };
                save();
            }
            value.vectorResult = result;
            value.vectorPublicationReady = true;
            save();
        }
        for (const effect of Object.values(value.effects)) {
            if (effect.state === 'done') continue;
            publishAuthoringFileLocked(lease, effect.staged);
            afterVectorPublication?.(effect.staged);
            effect.state = 'done'; save();
        }
        return value.vectorResult;
    });
}

export function queryVectorIndexes(snapshots, vector, topK, threshold, { accept = () => true, distinctHashes = false } = {}) {
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > 1000 || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
        throw operationError('The vector query limit or similarity threshold is invalid.', 400);
    }
    const magnitude = norm(vector);
    const rows = snapshots.flatMap(snapshot => snapshot.data.items.map(item => {
        if (item.vector.length !== vector.length) throw operationError('The saved vector dimensions do not match the selected model. The old index was kept.');
        const score = item.vector.reduce((sum, value, index) => sum + value * vector[index], 0) / (item.norm * magnitude);
        return { collectionId: snapshot.collectionId, id: item.id, metadata: item.metadata, score };
    })).filter(row => row.score >= threshold && accept(row)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const result = {};
    const seen = new Set();
    let count = 0;
    for (const row of rows) {
        const key = `${row.collectionId}:${row.metadata.hash}`;
        if (distinctHashes && seen.has(key)) continue;
        seen.add(key);
        const collection = result[row.collectionId] ??= { hashes: [], metadata: [], scores: [] };
        collection.hashes.push(row.metadata.hash); collection.metadata.push(row.metadata); collection.scores.push(row.score);
        if (++count >= topK) break;
    }
    return result;
}
