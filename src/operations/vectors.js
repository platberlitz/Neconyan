import path from 'node:path';
import { roleplayHash } from '../roleplay-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { runChatProfile } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { captureSavedTranslationPolicy, translatorCredentials, translateCapturedFields } from '../generation/roleplay-translation.js';
import { readLabSettings } from '../labs/sources.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { trimToStartSentence, trimToEndSentence } from '../../public/scripts/sentence-boundaries.js';
import { captureVectors, assertVectorSources, splitVectorText } from './vector-sources.js';
import { vectorBatch } from './vector-provider.js';
import { assertVectorIndex, vectorIndexPath, vectorItem, publishVectorIndexes, queryVectorIndexes } from './vector-index.js';
import { operationError, withOperation } from './store.js';
import { registerOperation } from './jobs.js';
import { requestBrowserWork } from './browser-work.js';
import { projectVectorPrompt } from './vector-prompt.js';

function cached(context, name, produce) {
    const value = readArtifact(context.directories, context.job.id, name);
    if (value !== undefined) return value;
    return Promise.resolve(produce()).then(result => {
        writeArtifact(context.directories, context.job.id, name, result);
        return result;
    });
}

function snapshotFor(context, plan, collection, model) {
    return collection.indexes.find(index => index.model === model) ?? {
        collectionId: collection.id, model,
        relative: path.relative(context.directories.root, vectorIndexPath(context.directories, plan.policy, collection.id, model)),
        evidence: null, dependencies: [], data: { version: 1, metadata_config: {}, items: [] },
    };
}

function delimiters(options) {
    return [...(options.delimiter ? [options.delimiter] : []), '\n\n', '\n', ' ', ''];
}

async function summarizeText(context, plan, text, step, verify, dependencies) {
    if (text.length < plan.options.summaryThreshold) return text;
    return cached(context, step, async () => {
        const messages = [{ role: 'system', content: plan.options.summaryPrompt }, { role: 'user', content: text }];
        if (plan.options.summarySource === 'webllm') {
            withOperation(context, ({ lease }) => verify(lease));
            return requestBrowserWork(context, step, 'webllm.summary', { messages });
        }
        if (!plan.summary) throw operationError('The accepted vector summary connection is unavailable.');
        const reply = await (dependencies.generate ?? runChatProfile)({
            context: { directories: context.directories, owner: context.owner }, binding: plan.summary.binding, messages,
            maxTokens: plan.summary.maxTokens, signal: context.signal, jobContext: context, stepNamespace: step,
            macroEnvironment: createMacroEnvironment(plan.macros), names: plan.macros.names,
            beforeDispatch: () => withOperation(context, ({ lease }) => verify(lease)),
        });
        const result = typeof reply === 'string' ? reply : reply.text;
        if (typeof result !== 'string' || !result.trim()) throw operationError('The vector summary was empty. Existing vectors have been kept.', 422);
        return result;
    });
}

async function prepareItems(context, plan, collection, collectionIndex, original, verify, dependencies) {
    const options = plan.options;
    if (collection.kind === 'world') return collection.items;
    const savedHashes = new Set(plan.rebuild ? [] : original.data.items.map(item => item.metadata.hash));
    if (collection.kind === 'chat') {
        const items = [];
        for (const [index, item] of collection.items.entries()) {
            if (savedHashes.has(item.hash)) { items.push(item); continue; }
            let text = item.text;
            if (options.summarize && text.length >= options.summaryThreshold) {
                text = await summarizeText(context, plan, text, `vector-summary:${collectionIndex}:${index}`, verify, dependencies);
            }
            items.push(...splitVectorText(text, options.chunkSize, delimiters(options)).map(text => ({ ...item, text })));
        }
        return items;
    }
    let text = collection.text;
    if (plan.translation && text) {
        const base = { owner: context.owner, directories: context.directories };
        const translated = await translateCapturedFields(context, { base, account: plan.account, policy: plan.translation,
            fields: [{ key: `vector-file:${collectionIndex}`, text }], fetchImpl: dependencies.fetchImpl,
            verify: () => withOperation(context, ({ lease }) => {
                verify(lease);
                const settings = readLabSettings(base);
                const current = captureSavedTranslationPolicy(base.directories, settings, { manual: true, target: 'en' });
                if (roleplayHash(current) !== roleplayHash(plan.translation)) throw operationError('The saved file-translation connection changed.');
                return translatorCredentials(base.directories, current.provider, settings.extension_settings?.translate || {});
            }) });
        text = translated[`vector-file:${collectionIndex}`];
    }
    const threshold = collection.attached ? options.chatFileThreshold : options.fileThreshold;
    const chunkSize = collection.attached ? options.chatFileChunkSize : options.fileChunkSize;
    const size = collection.bytes > threshold * 1024 ? chunkSize : -1;
    const overlap = size > 0 ? Math.round(size * (collection.attached ? options.chatFileOverlap : options.fileOverlap) / 100) : 0;
    let chunks = options.customOnly && options.delimiter ? text.split(options.delimiter)
        : splitVectorText(text, size > 0 ? Math.max(1, size - overlap) : -1, delimiters(options));
    if (overlap) {
        const half = Math.floor(overlap / 2);
        chunks = chunks.map((chunk, index, all) => [index ? trimToStartSentence(all[index - 1].slice(-half)) : '', chunk,
            index + 1 < all.length ? trimToEndSentence(all[index + 1].slice(0, half)) : ''].filter(Boolean).join(' '));
    }
    return chunks.filter(text => text.trim()).map((text, index) => ({ text, index, hash: getStringHash(text) }));
}

export async function runVectors(context, plan, dependencies = {}) {
    if (withOperation(context, ({ value }) => value.vectorPublicationReady)) return publishVectorIndexes(context, [], null, dependencies);
    let model = plan.policy.settings.model;
    if (plan.policy.source === 'koboldcpp') model = (await vectorBatch(context, plan, 'discover-model', [], {
        ...dependencies, beforeDispatch: lease => assertVectorSources(lease, plan),
    })).model;
    const snapshots = plan.collections.map(collection => snapshotFor(context, plan, collection, model));
    const prefixVersion = roleplayHash([plan.policy.settings.queryPrefix || '', plan.policy.settings.documentPrefix || '']);
    const compatible = snapshot => (snapshot.data.prefixVersion || roleplayHash(['', ''])) === prefixVersion;
    const verify = lease => { assertVectorSources(lease, plan); for (const snapshot of snapshots) assertVectorIndex(lease, snapshot); };
    withOperation(context, ({ lease }) => verify(lease));
    if (plan.action === 'list') return Object.fromEntries(snapshots.map(snapshot => {
        const hashes = [...new Set(snapshot.data.items.map(item => item.metadata.hash))];
        return [snapshot.collectionId, plan.details ? { hashes, chunks: snapshot.data.items.length, model: snapshot.model } : hashes];
    }));
    let query = plan.query;
    if (plan.summarizeQuery) {
        const parts = [];
        for (const [index, text] of plan.queryItems.entries()) parts.push(await summarizeText(context, plan, text, `vector-query-summary:${index}`, verify, dependencies));
        query = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (plan.action === 'query') {
        if (snapshots.some(snapshot => snapshot.data.items.length && !compatible(snapshot))) throw operationError('Vector prefixes changed. Re-index these sources before searching.');
        if (!query.trim() || !snapshots.length) return {};
        const result = await vectorBatch(context, plan, 'query', [query], { ...dependencies, isQuery: true, beforeDispatch: verify });
        withOperation(context, ({ lease }) => verify(lease));
        const matches = queryVectorIndexes(snapshots, result.vectors[0], plan.topK, plan.threshold);
        for (const collection of plan.collections) {
            if (matches[collection.id]) matches[collection.id].label = collection.book || collection.url || collection.id;
        }
        return matches;
    }
    const replacements = [];
    for (const [collectionIndex, collection] of plan.collections.entries()) {
        context.signal.throwIfAborted();
        const snapshot = snapshots[collectionIndex];
        const rebuild = plan.rebuild || !compatible(snapshot);
        const metadata = await cached(context, `vector-items:${collectionIndex}`,
            () => prepareItems(context, { ...plan, rebuild }, collection, collectionIndex, snapshot, verify, dependencies));
        if (metadata.length > 100000) throw operationError('This vector collection exceeds the saved item limit.', 413);
        const key = item => collection.kind === 'chat' ? item.hash : `${item.hash}:${item.index}`;
        const keys = new Set(metadata.map(key));
        const oldKeys = new Set(rebuild ? [] : snapshot.data.items.map(item => key(item.metadata)));
        const fresh = metadata.filter(item => !oldKeys.has(key(item)));
        const positions = new Map(metadata.map(item => [key(item), item.index]));
        const items = rebuild ? [] : snapshot.data.items.filter(item => keys.has(key(item.metadata))).map(item => ({
            ...item, metadata: { ...item.metadata, index: positions.get(key(item.metadata)) },
        }));
        const batchSize = plan.batchSize ?? 10;
        for (let offset = 0; offset < fresh.length; offset += batchSize) {
            const batch = fresh.slice(offset, offset + batchSize);
            const vectors = await vectorBatch(context, plan, `collection:${collectionIndex}:${offset}`, batch.map(item => item.text), {
                ...dependencies, beforeDispatch: verify,
            });
            if (vectors.model !== model) throw operationError('The vector provider changed its model during indexing. The previous index was kept.');
            items.push(...batch.map((item, index) => vectorItem(collection.id, item, vectors.vectors[index], offset + index)));
            await context.progress({ stage: `Indexing ${collection.id}`, completed: offset + batch.length, total: fresh.length });
        }
        replacements.push({ snapshot, data: { ...snapshot.data, prefixVersion, metadata_config: {}, items } });
    }
    const result = { remaining: 0, collections: replacements.map(({ snapshot, data }) => ({ collectionId: snapshot.collectionId,
        model: snapshot.model, count: data.items.length, hashes: [...new Set(data.items.map(item => item.metadata.hash))] })) };
    if (plan.action === 'prompt') {
        result.projection = await projectVectorPrompt(context, plan, replacements, query, verify, dependencies);
    } else if (query?.trim()) {
        const embedded = await vectorBatch(context, plan, 'query', [query], { ...dependencies, isQuery: true, beforeDispatch: verify });
        result.query = queryVectorIndexes(replacements.map(({ snapshot, data }) => ({ ...snapshot, data })), embedded.vectors[0], plan.topK, plan.threshold);
    }
    return publishVectorIndexes(context, replacements, result, { ...dependencies, verifySources: lease => assertVectorSources(lease, plan) });
}

registerOperation('vectors', { label: 'Index and search saved vector sources', capture: captureVectors, run: runVectors,
    canRecover: value => value.vectorPublicationReady === true,
    target: () => ({ kind: 'vectors', id: 'account-vector-indexes' }) });
