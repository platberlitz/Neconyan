export const LAYOUT_KEY = 'sillybunny_pathfinder';
const MAX_NODES = 2048;
const MAX_DEPTH = 32;
const MAX_SIZE = 262144;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getLayoutData(bookData) {
    const native = bookData?.extensions;
    return native && Object.hasOwn(native, LAYOUT_KEY)
        ? native[LAYOUT_KEY]
        : bookData?.originalData?.extensions?.[LAYOUT_KEY];
}

// Unknown versions/fields remain opaque: reading can fall back, but writing must
// not replace an imported layout we cannot faithfully round-trip.
export function isValidLayout(layout) {
    if (!isRecord(layout) || layout.version !== 1 || Object.keys(layout).some(key => !['version', 'tree'].includes(key))) return false;
    const ids = new Set();
    const pending = [[layout.tree, 0]];
    let size = 0;
    while (pending.length) {
        const [node, depth] = pending.pop();
        if (!isRecord(node) || depth > MAX_DEPTH || ids.size >= MAX_NODES
            || typeof node.id !== 'string' || !ID_PATTERN.test(node.id) || ids.has(node.id)
            || typeof node.name !== 'string' || node.name.length > 1024
            || typeof node.description !== 'string' || node.description.length > 4096
            || !Array.isArray(node.children) || node.children.length > MAX_NODES
            || (node.generatedCategory !== undefined && (typeof node.generatedCategory !== 'string' || node.generatedCategory.length > 128))
            || Object.keys(node).some(key => !['id', 'name', 'description', 'children', 'generatedCategory'].includes(key))) return false;
        ids.add(node.id);
        size += node.id.length + node.name.length + node.description.length + 64;
        if (size > MAX_SIZE) return false;
        for (const child of node.children) pending.push([child, depth + 1]);
    }
    return JSON.stringify(layout).length <= MAX_SIZE;
}

// undefined means absent; null means present but unsafe to rewrite.
export function readTreeLayout(bookData) {
    const layout = getLayoutData(bookData);
    if (layout === undefined) return undefined;
    return isValidLayout(layout) ? layout.tree : null;
}

export function getEntryPlacement(entry) {
    const placement = entry?.extensions?.[LAYOUT_KEY];
    return isRecord(placement) && placement.version === 1 && typeof placement.nodeId === 'string' && ID_PATTERN.test(placement.nodeId)
        ? placement.nodeId : null;
}
