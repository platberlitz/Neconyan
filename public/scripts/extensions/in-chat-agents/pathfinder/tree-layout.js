import { createTreeNode, getRuntimeNodeId } from './tree-store.js';
import { LAYOUT_KEY, isRecord, getLayoutData, isValidLayout, readTreeLayout, getEntryPlacement } from './layout-data.js';

export { LAYOUT_KEY, readTreeLayout, getEntryPlacement };
const MAX_NODES = 2048;
const MAX_DEPTH = 32;

export function createLayoutNode(bookName, name, description = '', localId = null) {
    const node = createTreeNode(name, description);
    node.localId = localId ?? node.id;
    node.id = getRuntimeNodeId(bookName, node.localId);
    return node;
}

export function setEntryPlacement(entry, node) {
    if ((entry.extensions !== undefined && !isRecord(entry.extensions))
        || (entry.extensions && Object.hasOwn(entry.extensions, LAYOUT_KEY) && !getEntryPlacement(entry))) {
        throw new Error('Cannot move unsupported or invalid waypoint placement.');
    }
    entry.extensions ??= {};
    entry.extensions[LAYOUT_KEY] = { ...entry.extensions[LAYOUT_KEY], version: 1, nodeId: node.localId };
}

export function syncBookLayoutMetadata(bookData) {
    const layout = getLayoutData(bookData);
    if (layout === undefined) return;
    if ((bookData.extensions !== undefined && !isRecord(bookData.extensions))
        || (bookData.originalData?.extensions !== undefined && !isRecord(bookData.originalData.extensions))) {
        throw new Error('Invalid format found inside the lorebook\u2019s additional data; unable to save while preserving.');
    }
    bookData.extensions ??= {};
    bookData.extensions[LAYOUT_KEY] = structuredClone(layout);
    if (bookData.originalData) {
        bookData.originalData.extensions ??= {};
        bookData.originalData.extensions[LAYOUT_KEY] = structuredClone(layout);
    }
}

export function writeTreeLayout(bookData, tree) {
    if (readTreeLayout(bookData) === null) throw new Error('The saved waypoint layout is damaged or uses an unsupported format and will not be overwritten.');
    let count = 0;
    const serialize = (node, depth = 0) => {
        if (depth > MAX_DEPTH || ++count > MAX_NODES) throw new Error('The waypoint layout has too many categories or nested levels.');
        return {
            id: node.localId,
            name: node.name,
            description: node.description || '',
            ...(node.generatedCategory === undefined ? {} : { generatedCategory: node.generatedCategory }),
            children: (node.children || []).map(child => serialize(child, depth + 1)),
        };
    };
    const layout = { version: 1, tree: serialize(tree) };
    if (!isValidLayout(layout) || (bookData.extensions !== undefined && !isRecord(bookData.extensions))) throw new Error('The proposed waypoint layout fails and cannot be saved.');
    bookData.extensions ??= {};
    bookData.extensions[LAYOUT_KEY] = layout;
    syncBookLayoutMetadata(bookData);
}
