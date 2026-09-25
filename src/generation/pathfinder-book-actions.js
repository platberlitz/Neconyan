import { createHash } from 'node:crypto';
import { deleteLorebookOriginalEntry, syncLorebookOriginalEntry } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { getEntryPlacement, isRecord, isValidLayout, LAYOUT_KEY, readTreeLayout } from '../../public/scripts/extensions/in-chat-agents/pathfinder/layout-data.js';
import { isEntryEligible } from '../../public/scripts/extensions/in-chat-agents/pathfinder/lorebook-policy.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { pathfinderTreeForBook } from './pathfinder-retrieval.js';

const invalid = message => roleplayError('PATHFINDER_TOOL_INVALID', message, 409);
const MAX_BOOK_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

function text(value, name, { required = true } = {}) {
    if (typeof value !== 'string' || value.length > MAX_TEXT || required && !value.trim()) throw invalid(`The ${name} must be bounded text.`);
    return value.trim();
}

function uidOf(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
        throw invalid('The lorebook entry UID is invalid.');
    }
    return number;
}

function findEntry(book, uid, { eligible = true } = {}) {
    const wanted = uidOf(uid);
    const match = Object.entries(book.entries).find(([, entry]) => entry?.uid === wanted);
    if (!match || match[1].agentBlacklisted || eligible && !isEntryEligible(match[1])) throw invalid('The selected lorebook entry is unavailable.');
    return { key: match[0], entry: match[1], uid: wanted };
}

function nextUid(book) {
    for (let uid = 0; uid <= 999999; uid++) {
        if (!Object.hasOwn(book.entries, String(uid)) && !Object.values(book.entries).some(entry => entry?.uid === uid)) return uid;
    }
    throw invalid('The lorebook has no available entry UID.');
}

// Match the upstream template without loading the browser editor or its mutable caches.
function newEntry(uid) {
    return { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
        selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false,
        agentBlacklisted: false, excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false,
        matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
        matchScenario: false, matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100, useProbability: true,
        depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
        matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null,
        delay: null, triggers: [] };
}

function createEntry(book, title, content, keys) {
    const uid = nextUid(book);
    const entry = newEntry(uid);
    entry.comment = text(title, 'title');
    entry.content = text(content, 'content');
    entry.key = keys?.length ? keys.map(key => text(key, 'keyword')) : [entry.comment.replace(/^\[.*?\]\s*/, '').split(/[:|]/)[0].trim().toLowerCase()];
    entry.selective = false;
    entry.constant = false;
    book.entries[uid] = entry;
    syncLorebookOriginalEntry(book, uid);
    return entry;
}

function treeForWrite(bookName, book, hash) {
    if (readTreeLayout(book) === null) throw invalid('The stored waypoint layout cannot be safely edited.');
    return pathfinderTreeForBook(bookName, book, hash);
}

function findNode(tree, id) {
    if (tree.id === id) return tree;
    for (const child of tree.children) {
        const match = findNode(child, id);
        if (match) return match;
    }
    return null;
}

function writeLayout(book, tree) {
    const layout = { version: 1, tree: (() => {
        const serialize = node => ({ id: node.localId, name: node.name, description: node.description || '',
            ...(node.generatedCategory === undefined ? {} : { generatedCategory: node.generatedCategory }),
            children: node.children.map(serialize) });
        return serialize(tree);
    })() };
    if (!isValidLayout(layout) || book.extensions !== undefined && !isRecord(book.extensions)
        || book.originalData?.extensions !== undefined && !isRecord(book.originalData.extensions)) {
        throw invalid('The saved waypoint layout cannot be safely replaced.');
    }
    book.extensions ??= {};
    book.extensions[LAYOUT_KEY] = layout;
    if (book.originalData) {
        book.originalData.extensions ??= {};
        book.originalData.extensions[LAYOUT_KEY] = structuredClone(layout);
    }
}

function placeEntry(entry, node) {
    if (entry.extensions !== undefined && !isRecord(entry.extensions)
        || entry.extensions && Object.hasOwn(entry.extensions, LAYOUT_KEY) && !getEntryPlacement(entry)) {
        throw invalid('The imported entry placement cannot be safely changed.');
    }
    entry.extensions ??= {};
    entry.extensions[LAYOUT_KEY] = { ...entry.extensions[LAYOUT_KEY], version: 1, nodeId: node.localId };
}

function truthyDeletion(value) {
    if (value === undefined || value === false || value === 0 || typeof value === 'string' && /^(0|false|no)$/i.test(value.trim())) return false;
    if (value === true || value === 1 || typeof value === 'string' && /^(1|true|yes)$/i.test(value.trim())) return true;
    throw invalid('The permanent deletion choice is invalid.');
}

function scoreDuplicate(first, second) {
    const triples = content => new Set([...String(content).toLowerCase()].map((_, index, letters) => letters.slice(index, index + 3).join('')).filter(value => value.length === 3));
    const left = triples(first), right = triples(second);
    if (!left.size && !right.size) return 1;
    let matches = 0;
    for (const value of left) if (right.has(value)) matches++;
    return matches / Math.max(left.size, right.size, 1);
}

/** Pure edit of the exact captured lorebook, with browser-compatible entry and waypoint semantics. */
export function applyPathfinderBookAction(source, { bookName, tool, args, callId, sourceHash, settings = {} }) {
    if (!isRecord(source) || !isRecord(source.entries) || !isRecord(args) || typeof bookName !== 'string' || !bookName
        || typeof callId !== 'string' || !callId || roleplayHash(source) !== sourceHash) throw invalid('The accepted lorebook action is incomplete.');
    const book = structuredClone(source);
    let result;
    if (tool === 'pathfinder_remember' || tool === 'pathfinder_summarize') {
        const summary = tool === 'pathfinder_summarize';
        const title = text(args.title, 'title'), content = text(args.content, 'content');
        const significance = summary ? (args.significance ?? 'medium') : '';
        if (summary && !['low', 'medium', 'high', 'critical'].includes(significance)) throw invalid('The summary significance is invalid.');
        if (!summary && settings.dedupDetection) {
            const threshold = Number(settings.dedupThreshold) || 0.85;
            const duplicate = Object.values(book.entries).find(entry => isEntryEligible(entry) && scoreDuplicate(entry.content, content) >= threshold);
            if (duplicate) return { book: source, result: { uid: duplicate.uid, duplicate: true, bookName }, changed: false };
        }
        const arc = summary && args.arc ? text(args.arc, 'arc') : '';
        const entry = createEntry(book, summary ? `[Summary] ${title}${arc ? `: ${arc}` : ''}` : title,
            summary ? `Significance: ${significance}\n\n${content}` : content,
            summary ? ['summary', significance.toLowerCase()] : []);
        if (arc) {
            const tree = treeForWrite(bookName, book, sourceHash);
            let parent = tree.children.find(node => node.name === 'Summaries' || node.name === 'Summary');
            if (!parent) {
                parent = { localId: 'category_Summaries', id: '', name: 'Summaries', description: '', children: [], entries: [] };
                tree.children.push(parent);
            }
            let node = parent.children.find(item => item.name.replace(/^Arc:\s*/i, '').toLowerCase() === arc.toLowerCase());
            if (!node) {
                node = { localId: `arc_${createHash('sha256').update(JSON.stringify([sourceHash, callId, arc])).digest('hex').slice(0, 20)}`,
                    id: '', name: `Arc: ${arc}`, description: `Narrative arc: ${arc}`, entries: [], children: [] };
                parent.children.push(node);
            }
            placeEntry(entry, node);
            writeLayout(book, tree);
            syncLorebookOriginalEntry(book, entry.uid);
        }
        result = { uid: entry.uid, title: entry.comment, bookName };
    } else if (tool === 'pathfinder_update' || tool === 'pathfinder_forget' || tool === 'pathfinder_reorganize') {
        const { entry, key, uid } = findEntry(book, args.uid, { eligible: tool === 'pathfinder_reorganize' });
        if (tool === 'pathfinder_update') {
            if (typeof args.content !== 'string' && typeof args.title !== 'string') throw invalid('Update needs a title or content.');
            if (typeof args.content === 'string' && args.content.trim()) entry.content = text(args.content, 'content');
            if (typeof args.title === 'string' && args.title.trim()) entry.comment = text(args.title, 'title');
            syncLorebookOriginalEntry(book, uid);
            result = { uid, bookName };
        } else if (tool === 'pathfinder_forget') {
            const hard = truthyDeletion(args.hard_delete);
            if (hard) {
                deleteLorebookOriginalEntry(book, uid);
                delete book.entries[key];
            } else {
                entry.disable = true;
                syncLorebookOriginalEntry(book, uid);
            }
            result = { uid, deleted: hard, disabled: !hard, bookName };
        } else {
            const tree = treeForWrite(bookName, book, sourceHash);
            const target = findNode(tree, args.target_node_id);
            if (!target) throw invalid('The selected waypoint is no longer available.');
            placeEntry(entry, target);
            writeLayout(book, tree);
            syncLorebookOriginalEntry(book, uid);
            result = { uid, targetNodeId: target.id, bookName };
        }
    } else if (tool === 'pathfinder_merge_split') {
        if (args.action === 'merge') {
            const first = findEntry(book, args.uid1), second = findEntry(book, args.uid2);
            if (first.uid === second.uid) throw invalid('An entry cannot be merged with itself.');
            first.entry.content = `${first.entry.content}\n\n---\n\n${second.entry.content}`;
            first.entry.comment = typeof args.merged_title === 'string' && args.merged_title.trim()
                ? text(args.merged_title, 'merged title') : `${first.entry.comment || ''} + ${second.entry.comment || ''}`;
            deleteLorebookOriginalEntry(book, second.uid);
            delete book.entries[second.key];
            syncLorebookOriginalEntry(book, first.uid);
            result = { mergedUid: first.uid, removedUid: second.uid, bookName };
        } else if (args.action === 'split') {
            const first = findEntry(book, args.uid), second = createEntry(book, args.title2 || 'Split entry', args.content2, []);
            const originals = book.originalData?.entries, previous = originals?.[book.originalDataUidMap?.[first.uid]];
            if (previous && Number.isInteger(book.originalDataUidMap?.[second.uid])) {
                const index = book.originalDataUidMap[second.uid];
                originals[index] = { ...structuredClone(previous), id: originals[index].id };
            }
            Object.assign(second, structuredClone(first.entry), { uid: second.uid, comment: args.title2 || 'Split entry', content: text(args.content2, 'content2') });
            first.entry.content = text(args.content1, 'content1');
            if (args.title1) first.entry.comment = text(args.title1, 'title1');
            syncLorebookOriginalEntry(book, first.uid);
            syncLorebookOriginalEntry(book, second.uid);
            result = { originalUid: first.uid, newUid: second.uid, bookName };
        } else throw invalid('Choose a merge or split action.');
    } else if (tool === 'pathfinder_create_waypoint') {
        const tree = treeForWrite(bookName, book, sourceHash);
        const parent = args.parent_node_id ? findNode(tree, args.parent_node_id) : tree;
        if (!parent) throw invalid('The selected parent waypoint is unavailable.');
        const name = text(args.name, 'waypoint name');
        const localId = `waypoint_${createHash('sha256').update(JSON.stringify([sourceHash, callId, name, parent.localId])).digest('hex').slice(0, 20)}`;
        const allNodes = [tree];
        for (let index = 0; index < allNodes.length; index++) allNodes.push(...allNodes[index].children);
        if (allNodes.some(item => item.localId === localId)) throw invalid('The waypoint ID is already taken.');
        const node = { localId, id: '', name, description: typeof args.description === 'string' ? text(args.description, 'description', { required: false }) : '',
            entries: [], children: [] };
        parent.children.push(node);
        writeLayout(book, tree);
        result = { nodeId: `node_${createHash('sha256').update(JSON.stringify([bookName, sourceHash, localId])).digest('hex').slice(0, 20)}`, name, bookName };
    } else throw invalid('This lorebook action is not supported.');
    const saved = JSON.stringify(book);
    if (Buffer.byteLength(saved) > MAX_BOOK_BYTES) throw invalid('The updated lorebook exceeds its saved limit.');
    // The Character Book serializer includes optional undefined fields; save and hash only actual JSON bytes.
    const persisted = JSON.parse(saved);
    return { book: persisted, result, changed: roleplayHash(persisted) !== sourceHash };
}

/** Read-only search uses the same deterministic waypoint IDs as native retrieval. */
export function searchPathfinderBook(bookName, book, bookHash, nodeId = '') {
    if (!isRecord(book) || !isRecord(book.entries) || roleplayHash(book) !== bookHash) throw invalid('The selected lorebook changed.');
    const tree = pathfinderTreeForBook(bookName, book, bookHash);
    const node = nodeId ? findNode(tree, nodeId) : tree;
    if (!node) throw invalid('The selected waypoint is unavailable.');
    const entries = node.entries.map(uid => Object.values(book.entries).find(entry => entry?.uid === uid)).filter(entry => isEntryEligible(entry))
        .map(entry => ({ uid: entry.uid, title: entry.comment || entry.key?.[0] || '', content: entry.content || '' }));
    return { bookName, nodeId: node.id, children: node.children.map(child => ({ id: child.id, name: child.name, count: child.entries.length })), entries };
}
