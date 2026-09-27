import { roleplayHash } from '../roleplay-store.js';
import { createMacroEnvironment } from '../macros/index.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { vectorBatch } from './vector-provider.js';
import { queryVectorIndexes } from './vector-index.js';

const distinct = values => [...new Set(values)];
const contents = rows => distinct((rows || []).filter(row => row.text).sort((a, b) => a.index - b.index).map(row => row.text)).join('\n');

/** Materialise every vector contribution under the accepted job before publishing any replacement index. */
export async function projectVectorPrompt(context, plan, replacements, chatQuery, verify, dependencies) {
    const output = { extensions: [], removed: [], files: [], worldInfo: [] };
    const options = plan.options;
    const indexes = replacements.map(({ snapshot, data }) => ({ ...snapshot, data }));
    const baseQuery = plan.query || '';
    const embedding = new Map();
    const query = async (ids, text, count, step) => {
        if (!text.trim() || !ids.length) return {};
        if (!embedding.has(text)) embedding.set(text, await vectorBatch(context, plan, `prompt-query:${step}`, [text],
            { ...dependencies, isQuery: true, beforeDispatch: verify }));
        return queryVectorIndexes(indexes.filter(index => ids.includes(index.collectionId)), embedding.get(text).vectors[0], count, plan.threshold);
    };
    const rows = plan.chatRecords;
    const environment = createMacroEnvironment(plan.macros);
    const expand = (template, text) => environment.evaluate(template.split('{{text}}').join(text));
    const descriptor = (row, index) => ({ index, hash: roleplayHash(row), name: row.name, original: row.mes });
    if (options.chatsEnabled && rows.length >= options.protect) {
        const id = plan.collections.find(collection => collection.kind === 'chat')?.id;
        const result = id ? await query([id], chatQuery || '', options.insert, 'chat') : {};
        const hashes = distinct(result[id]?.hashes || []);
        const used = new Set();
        const selected = rows.flatMap((row, index) => {
            if (index >= rows.length - options.protect || !row.mes) return [];
            const hash = getStringHash(environment.evaluate(row.mes));
            if (!hashes.includes(hash) || used.has(hash)) return [];
            used.add(hash);
            return [{ row, index, hash }];
        }).sort((a, b) => hashes.indexOf(b.hash) - hashes.indexOf(a.hash));
        if (selected.length) {
            output.removed = selected.map(({ row, index }) => descriptor(row, index));
            const text = selected.map(({ row }) => `${row.name}: ${row.mes}`.replace(/\n{3,}/g, '\n\n').trim()).join('\n\n');
            output.extensions.push({ key: '3_vectors', value: expand(options.template, text), position: options.position,
                depth: options.depth, scan: options.includeWi, role: 0 });
        }
    }
    if (options.filesEnabled) {
        const banks = plan.collections.filter(collection => collection.kind === 'file' && collection.dataBank);
        const result = await query(banks.map(collection => collection.id), baseQuery, options.bankCount, 'bank');
        const text = Object.values(result).map(value => contents(value.metadata)).filter(Boolean).join('\n\n');
        if (text) output.extensions.push({ key: '4_vectors_data_bank', value: expand(options.bankTemplate, text), position: options.bankPosition,
            depth: options.bankDepth, scan: options.includeWi, role: options.bankRole });
        for (const [index, row] of rows.entries()) {
            if (!row.extra?.files?.length || String(row.mes).slice(0, row.extra.fileLength).trim().length < options.chatFileThreshold * 1024) continue;
            const chunks = [];
            for (const file of row.extra.files) {
                const collection = plan.collections.find(item => item.kind === 'file' && item.url === file.url);
                if (!collection) continue;
                const result = await query([collection.id], baseQuery, options.fileCount, `file:${collection.id}`);
                const text = contents(result[collection.id]?.metadata);
                if (text) chunks.push(text);
            }
            output.files.push({ ...descriptor(row, index), text: `${chunks.join('\n\n')}\n\n${String(row.mes).slice(row.extra.fileLength)}` });
        }
    }
    if (options.worldEnabled) {
        const books = plan.collections.filter(collection => collection.kind === 'world');
        const result = await query(books.map(collection => collection.id), baseQuery, options.worldCount, 'world');
        for (const book of books) for (const item of book.items) {
            if (result[book.id]?.hashes.includes(item.hash)) output.worldInfo.push({ world: book.book, uid: item.index, hash: item.hash });
        }
    }
    return output;
}
