import fs from 'node:fs';
import path from 'node:path';
import { roleplayHash, roleplayLease, readRoleplayFile, withRoleplayAccount } from '../roleplay-store.js';
import { authoringEvidence } from '../authoring-store.js';
import { roleplayChatPath } from '../generation/roleplay-source.js';
import { createMacroEnvironment } from '../macros/index.js';
import { captureLabChat, captureLabConnection, readLabSettings } from '../labs/sources.js';
import { captureLabBookLocked } from '../labs/books.js';
import { captureSavedTranslationPolicy } from '../generation/roleplay-translation.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { captureVectorPolicy } from './vector-provider.js';
import { captureVectorIndex, vectorIndexPath } from './vector-index.js';
import { operationError } from './store.js';

const LIMIT = 12 * 1024 * 1024;
const unique = values => [...new Set(values)];
const number = (value, fallback, min, max) => {
    const result = Number(value ?? fallback);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw operationError('The saved vector limits are invalid.', 400);
    return result;
};

/** Keep recursive splitting bounded even when a delimiter cannot shorten an oversized part. */
export function splitVectorText(text, length, delimiters = ['\n\n', '\n', ' ', '']) {
    if (length <= 0 || text.length <= length) return [text];
    const [delimiter = '', ...rest] = delimiters;
    if (!delimiter) {
        const result = [];
        for (let index = 0; index < text.length; index += length) result.push(text.slice(index, index + length));
        return result;
    }
    const result = [];
    let pending = '';
    for (const part of text.split(delimiter)) {
        if (part.length > length) {
            if (pending) { result.push(pending); pending = ''; }
            result.push(...splitVectorText(part, length, rest));
        } else if (pending && pending.length + delimiter.length + part.length > length) {
            result.push(pending); pending = part;
        } else pending = pending ? pending + delimiter + part : part;
    }
    if (pending) result.push(pending);
    return result;
}

function choices(lease, policy, collectionId) {
    if (policy.source !== 'koboldcpp') return [captureVectorIndex(lease, policy, collectionId)];
    const { scope } = roleplayLease(lease);
    const folder = path.dirname(vectorIndexPath(scope.directories, policy, collectionId, ''));
    readRoleplayFile(path.join(folder, '.path-check'), 1, { allowMissingParent: true });
    const names = fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }) : [];
    if (names.some(item => item.isSymbolicLink())) throw operationError('The saved vector collection contains an unsupported link.');
    return ['', ...names.filter(item => item.isDirectory()).map(item => item.name)].map(model => captureVectorIndex(lease, policy, collectionId, model));
}

function vectorOptions(raw) {
    return {
        chatsEnabled: Boolean(raw.enabled_chats), filesEnabled: Boolean(raw.enabled_files), worldEnabled: Boolean(raw.enabled_world_info),
        protect: number(raw.protect, 5, 0, 100000), insert: number(raw.insert, 3, 1, 1000),
        fileCount: number(raw.chunk_count, 2, 1, 1000), bankCount: number(raw.chunk_count_db, 5, 1, 1000),
        worldCount: number(raw.max_entries, 5, 1, 1000),
        template: String(raw.template ?? 'Past events:\n{{text}}'), bankTemplate: String(raw.file_template_db ?? 'Related information:\n{{text}}'),
        position: number(raw.position, 0, 0, 2), depth: number(raw.depth, 2, 0, 10000), includeWi: Boolean(raw.include_wi),
        bankPosition: number(raw.file_position_db, 0, 0, 2), bankDepth: number(raw.file_depth_db, 4, 0, 10000),
        bankRole: number(raw.file_depth_role_db, 0, 0, 2),
        keepHidden: Boolean(raw.keep_hidden), chunkSize: number(raw.message_chunk_size, 400, 0, 1000000),
        delimiter: String(raw.force_chunk_delimiter || '').slice(0, 10000), customOnly: Boolean(raw.only_custom_boundary),
        fileChunkSize: number(raw.chunk_size_db, 2500, 1, 1000000), fileThreshold: number(raw.size_threshold_db, 5, 0, 1000000),
        fileOverlap: number(raw.overlap_percent_db, 0, 0, 90), translateFiles: Boolean(raw.translate_files),
        chatFileChunkSize: number(raw.chunk_size, 5000, 1, 1000000), chatFileThreshold: number(raw.size_threshold, 10, 0, 1000000),
        chatFileOverlap: number(raw.overlap_percent, 0, 0, 90),
        summarize: Boolean(raw.summarize), summarizeSent: Boolean(raw.summarize_sent),
        summaryThreshold: number(raw.summary_threshold, 200, 0, 1000000), summarySource: raw.summary_source || 'main',
        summaryPrompt: String(raw.summary_prompt || 'Summarize the most important facts in this text in 250 words or less.'),
        queryCount: number(raw.query, 2, 1, 1000), allEntries: Boolean(raw.enabled_for_all),
    };
}

function fileCollections(base, settings, chat, input, sources) {
    if (input.scope && !['global', 'chat', 'character', 'attached'].includes(input.scope)) throw operationError('Choose a valid attachment scope.', 400);
    const ext = settings.extension_settings || {};
    const metadata = chat?.records[0].chat_metadata || {};
    const byScope = { global: ext.attachments || [], chat: metadata.attachments || [],
        character: ext.character_attachments?.[chat?.locator.avatar] || [] };
    const attached = chat?.records.slice(1).flatMap(row => row.extra?.files || []) || [];
    const available = [...(input.scope ? byScope[input.scope] ?? [] : Object.values(byScope).flat()),
        ...(!input.scope || input.scope === 'attached' ? attached : [])]
        .filter(file => !ext.disabled_attachments?.includes(file.url));
    const urls = input.urls ?? unique(available.map(file => file.url));
    if (!Array.isArray(urls) || urls.length > 1000 || unique(urls).length !== urls.length) throw operationError('The selected vector files are invalid.', 400);
    return urls.map(url => {
        if (!available.some(file => file.url === url) || typeof url !== 'string' || !url.startsWith('/user/files/')) {
            throw operationError('A selected vector file is no longer attached to this account.');
        }
        let name;
        try { name = decodeURIComponent(url.slice('/user/files/'.length)); } catch { throw operationError('The vector file name is invalid.', 400); }
        if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.includes('\\')) throw operationError('The vector file name is invalid.', 400);
        const attachment = available.find(file => file.url === url);
        const inline = attached.find(file => file.url === url && typeof file.text === 'string');
        if (inline) return { id: `file_${getStringHash(url)}`, kind: 'file', url, bytes: Buffer.byteLength(inline.text), text: inline.text,
            attached: true, dataBank: Object.values(byScope).flat().some(file => file.url === url) };
        const filename = path.join(base.directories.files, name);
        const file = readRoleplayFile(filename, LIMIT);
        if (!file) throw operationError('A selected vector file no longer exists.');
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw operationError('The selected vector file is not readable text.'); }
        sources.push({ relative: path.relative(base.directories.root, filename), evidence: authoringEvidence(file) });
        return { id: `file_${getStringHash(url)}`, kind: 'file', url, bytes: Number(attachment.size) || file.bytes.length, text,
            attached: attached.some(item => item.url === url), dataBank: Object.values(byScope).flat().some(file => file.url === url) };
    });
}

/** Capture whole source sets and every old index before accepting any embedding requests. */
export async function captureVectors(base, account, input, captured = {}) {
    if (!['sync-chat', 'sync-files', 'sync-world-info', 'query', 'list', 'prompt'].includes(input.action)) throw operationError('Choose a valid vector workflow.', 400);
    const settings = readLabSettings(base);
    const policy = captureVectorPolicy(base, settings);
    const options = vectorOptions(settings.extension_settings?.vectors || {});
    const chat = captured.chat ?? (input.locator ? captureLabChat(base, account, input.locator) : null);
    const macros = captured.macros ?? chat?.macros ?? { names: { user: settings.username || 'User', char: 'Character' }, character: {}, variables: {}, extra: {} };
    const environment = createMacroEnvironment(macros);
    const sources = [];
    if (chat) sources.push({ relative: path.relative(base.directories.root, roleplayChatPath(base, chat.locator)),
        evidence: { rawHash: chat.rawHash, physical: chat.physical } });
    let collections = [];
    withRoleplayAccount(base, account, lease => {
        if (input.action === 'sync-chat' || input.action === 'prompt' && options.chatsEnabled) {
            if (!chat) throw operationError('Choose a saved chat before indexing it.', 400);
            const items = chat.records.slice(1).flatMap((row, index) => {
                if (row.is_system && !options.keepHidden) return [];
                const text = environment.evaluate(String(row.mes ?? ''));
                return [{ text, hash: getStringHash(text), index }];
            });
            collections.push({ id: chat.locator.chat, kind: 'chat', items });
        }
        if (input.action === 'sync-files' || input.action === 'prompt' && options.filesEnabled) collections.push(...fileCollections(base, settings, chat, input, sources));
        if (input.action === 'sync-world-info' || input.action === 'prompt' && options.worldEnabled) {
            const world = { ...settings, ...settings.world_info_settings }.world_info || {};
            const character = chat?.macros.character;
            const books = input.books ?? unique([...(world.globalSelect || []), chat?.records[0].chat_metadata?.world_info,
                chat?.persona.lorebook, character?.extensions?.world,
                ...(world.charLore?.find(item => item.name === chat?.locator.avatar?.replace('.png', ''))?.extraBooks || [])].filter(Boolean));
            if (!Array.isArray(books) || books.length > 1000 || unique(books).length !== books.length) throw operationError('Choose valid lorebooks for indexing.', 400);
            collections.push(...books.map(name => {
                const book = captureLabBookLocked(lease, name);
                sources.push({ relative: book.relative, evidence: book.evidence });
                const items = Object.entries(book.book.entries).filter(([, entry]) => !entry.disable && entry.content && (entry.vectorized || options.allEntries))
                    .map(([uid, entry]) => ({ text: String(entry.content), hash: getStringHash(String(entry.content)), index: entry.uid ?? Number(uid) }));
                return { id: `world_${getStringHash(name)}`, kind: 'world', book: name, items };
            }));
        }
        if (input.action === 'query' || input.action === 'list') {
            if (!Array.isArray(input.collectionIds) || input.collectionIds.length > 1000 || unique(input.collectionIds).length !== input.collectionIds.length) {
                throw operationError('Choose valid vector collections to search.', 400);
            }
            collections = input.collectionIds.map(id => ({ id, kind: input.action === 'list' ? 'list' : 'query' }));
        }
        for (const collection of collections) collection.indexes = choices(lease, policy, collection.id);
    });
    let query = input.query ?? null;
    const queryItems = chat ? chat.records.slice(1).map(row =>
        environment.evaluate(String(row.mes ?? '').slice(row.extra?.fileLength || 0).trim())).filter(Boolean).reverse().slice(0, options.queryCount) : [];
    if (query === null && (['query', 'prompt'].includes(input.action) || input.withQuery) && chat) query = queryItems.join('\n');
    if (query !== null && (typeof query !== 'string' || Buffer.byteLength(query) > 1024 * 1024)) throw operationError('The vector search text is too large.', 413);
    if (input.action === 'query' && query === null) throw operationError('Enter text or choose a saved chat to search.', 400);
    const summarizeQuery = options.summarize && options.summarizeSent && (input.queryKind === 'chat' || input.action === 'prompt' && options.chatsEnabled) && query !== null;
    const needsSummary = options.summarize && (collections.some(collection => collection.kind === 'chat'
        && collection.items.some(item => item.text.length >= options.summaryThreshold)) || summarizeQuery);
    let summary = null;
    if (needsSummary && options.summarySource === 'main') {
        const maxTokens = number(settings.amount_gen, 300, 1, 32768);
        summary = captured.summary ?? { ...await captureLabConnection(base, { acknowledgement: input.acknowledgement, maxTokens }, macros), maxTokens };
    } else if (needsSummary && options.summarySource !== 'webllm') throw operationError('The vector summary provider is unavailable.', 400);
    const translation = options.translateFiles && collections.some(collection => collection.kind === 'file')
        ? captureSavedTranslationPolicy(base.directories, settings, { manual: true, target: 'en' }) : null;
    return { account, policy, options, collections, sources, macros, summary, translation, query, action: input.action,
        ...(input.action === 'prompt' ? { chatRecords: chat?.records.slice(1) ?? [] } : {}),
        queryItems: input.query === undefined ? queryItems : [input.query], summarizeQuery,
        topK: number(input.topK, 3, 1, 1000), threshold: Number(input.threshold ?? settings.extension_settings?.vectors?.score_threshold ?? 0.25) };
}

export function assertVectorSources(lease, plan) {
    const { scope } = roleplayLease(lease);
    for (const source of plan.sources) {
        const current = readRoleplayFile(path.join(scope.directories.root, source.relative), 32 * 1024 * 1024, { allowMissingParent: true });
        if (roleplayHash(authoringEvidence(current)) !== roleplayHash(source.evidence)) {
            throw Object.assign(operationError('An indexed source changed. Its existing vector index has been kept.'), { operationRefused: true });
        }
    }
}
