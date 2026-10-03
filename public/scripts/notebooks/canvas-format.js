// JSON Canvas 1.0, checked against https://jsoncanvas.org/spec/1.0/.
export const CANVAS_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, nodes: 500, edges: 2000, depth: 64, values: 100000 });
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);
const NODE_FIELDS = new Set(['x', 'y', 'width', 'height', 'color', 'text', 'file', 'subpath', 'url', 'label', 'background', 'backgroundStyle']);
const EDGE_FIELDS = new Set(['fromNode', 'toNode', 'fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label']);

export class CanvasFormatError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.code = 'CANVAS_INVALID';
        this.status = status;
    }
}

function fail(message, status) {
    throw new CanvasFormatError(message, status);
}

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value, label, max = 1024) {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`The canvas ${label} must be text up to ${max} characters.`);
}

function colour(value) {
    if (value !== undefined && (typeof value !== 'string' || !/^(?:[1-6]|#[a-f\d]{6})$/i.test(value))) {
        fail('Canvas colours must use a six-digit hex value or a preset from 1 to 6.');
    }
}

function jsonValues(document) {
    const pending = [[document, 0]];
    let count = 0;
    while (pending.length) {
        const [value, depth] = pending.pop();
        if (++count > CANVAS_LIMITS.values || depth > CANVAS_LIMITS.depth) fail('That canvas contains too much nested data to edit safely.', 413);
        if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
            fail('That canvas contains a number that cannot be edited without changing its value. Keep the original file.');
        }
        if (value !== null && typeof value === 'object') {
            if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Canvas data must contain only JSON objects.');
            for (const child of Object.values(value)) pending.push([child, depth + 1]);
        } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
            fail('Canvas data must contain only JSON values.');
        }
    }
}

export function validateCanvasDocument(document) {
    if (!object(document)) fail('The canvas must contain a JSON object.');
    if (document.nodes !== undefined && !Array.isArray(document.nodes)) fail('Canvas nodes must be an array.');
    if (document.edges !== undefined && !Array.isArray(document.edges)) fail('Canvas connections must be an array.');
    const nodes = document.nodes ?? [];
    const edges = document.edges ?? [];
    if (nodes.length > CANVAS_LIMITS.nodes || edges.length > CANVAS_LIMITS.edges) {
        fail(`Canvases can contain up to ${CANVAS_LIMITS.nodes} cards and ${CANVAS_LIMITS.edges} connections.`, 413);
    }
    jsonValues(document);
    if (new TextEncoder().encode(JSON.stringify(document)).length > CANVAS_LIMITS.bytes) fail('Canvas files can be up to 2 MiB.', 413);
    const ids = new Set();
    for (const node of nodes) {
        if (!object(node)) fail('Each canvas card must be an object.');
        string(node.id, 'card ID', 128);
        string(node.type, 'card type', 128);
        if (!node.id || !node.type || ids.has(node.id)) fail('Each canvas card needs a different, non-empty ID.');
        ids.add(node.id);
        for (const key of ['x', 'y', 'width', 'height']) {
            if (!Number.isInteger(node[key]) || Math.abs(node[key]) > 1000000 || (['width', 'height'].includes(key) && node[key] < 0)) {
                fail('Card positions and sizes must be whole numbers within one million pixels; sizes cannot be negative.');
            }
        }
        colour(node.color);
        if (node.type === 'text') string(node.text, 'card text', CANVAS_LIMITS.bytes);
        if (node.type === 'file') {
            string(node.file, 'file path');
            if (node.subpath !== undefined) {
                string(node.subpath, 'heading or block');
                if (!node.subpath.startsWith('#')) fail('A canvas heading or block must start with #.');
            }
        }
        if (node.type === 'link') string(node.url, 'link', 4096);
        if (node.type === 'group') {
            for (const key of ['label', 'background']) if (node[key] !== undefined) string(node[key], key);
            if (node.backgroundStyle !== undefined && !['cover', 'ratio', 'repeat'].includes(node.backgroundStyle)) fail('That group background style is not supported by JSON Canvas 1.0.');
        }
    }
    const edgeIds = new Set();
    for (const edge of edges) {
        if (!object(edge)) fail('Each canvas connection must be an object.');
        for (const key of ['id', 'fromNode', 'toNode']) {
            string(edge[key], 'connection ID', 128);
            if (!edge[key]) fail('Each canvas connection needs its own ID and two card IDs.');
        }
        if (edgeIds.has(edge.id)) fail('Each canvas connection needs a different ID.');
        edgeIds.add(edge.id);
        for (const key of ['fromSide', 'toSide']) if (edge[key] !== undefined && !SIDES.has(edge[key])) fail('Connection sides must be top, right, bottom or left.');
        for (const key of ['fromEnd', 'toEnd']) if (edge[key] !== undefined && !ENDS.has(edge[key])) fail('Connection ends must be none or arrow.');
        if (edge.label !== undefined) string(edge.label, 'connection label', 4096);
        colour(edge.color);
    }
    return document;
}

export function parseCanvasDocument(text) {
    if (typeof text !== 'string') fail('The canvas must be JSON text.');
    if (new TextEncoder().encode(text).length > CANVAS_LIMITS.bytes) fail('Canvas files can be up to 2 MiB.', 413);
    let document;
    try {
        document = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        fail('The canvas JSON could not be read. Keep your copy and correct the JSON before saving.');
    }
    return validateCanvasDocument(document);
}

/** Keep formatting when practical, but never export a file this editor cannot read. */
export function serializeCanvasDocument(document, original = '') {
    validateCanvasDocument(document);
    const indent = original.match(/\r?\n([ \t]+)"/)?.[1].slice(0, 10) ?? 2;
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const size = text => new TextEncoder().encode(text).length;
    let text = bom + JSON.stringify(document, null, indent).replace(/\n/g, newline) + newline;
    if (size(text) > CANVAS_LIMITS.bytes) text = bom + JSON.stringify(document) + newline;
    if (size(text) > CANVAS_LIMITS.bytes) text = bom + JSON.stringify(document);
    if (size(text) > CANVAS_LIMITS.bytes) text = JSON.stringify(document);
    if (size(text) > CANVAS_LIMITS.bytes) fail('Canvas files can be up to 2 MiB.', 413);
    return text;
}

export function changeCanvasDocument(document, changes) {
    validateCanvasDocument(document);
    if (!Array.isArray(changes) || !changes.length || changes.length > 32) fail('Choose between one and 32 canvas changes.');
    const result = structuredClone(document);
    for (const change of changes) {
        if (change.type === 'add-node') result.nodes = [...(result.nodes ?? []), structuredClone(change.node)];
        else if (change.type === 'remove-node') {
            result.nodes = (result.nodes ?? []).filter(node => node.id !== change.id);
            if (Array.isArray(result.edges)) result.edges = result.edges.filter(edge => edge.fromNode !== change.id && edge.toNode !== change.id);
        } else if (change.type === 'update-node' || change.type === 'update-edge') {
            const collection = change.type === 'update-node' ? result.nodes : result.edges;
            const allowed = change.type === 'update-node' ? NODE_FIELDS : EDGE_FIELDS;
            const item = collection?.find(entry => entry.id === change.id);
            if (!item || !object(change.set) || Object.keys(change.set).some(key => !allowed.has(key))) fail('That card or connection change could not be applied.');
            for (const [key, value] of Object.entries(change.set)) {
                if (value === undefined) delete item[key];
                else Object.defineProperty(item, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
            }
        } else if (change.type === 'add-edge') result.edges = [...(result.edges ?? []), structuredClone(change.edge)];
        else if (change.type === 'remove-edge') result.edges = (result.edges ?? []).filter(edge => edge.id !== change.id);
        else fail('That canvas change is not supported.');
    }
    return validateCanvasDocument(result);
}

export function canvasFilePath(file, fromPath = '') {
    if (typeof file !== 'string' || !file || /[\0\\]/.test(file) || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(file)) return null;
    const parts = file.startsWith('.') ? String(fromPath).split('/').slice(0, -1) : [];
    for (const part of file.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else if (part.startsWith('.')) return null;
        else parts.push(part);
    }
    return parts.length ? parts.join('/') : null;
}
