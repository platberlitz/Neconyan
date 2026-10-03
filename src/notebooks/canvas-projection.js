import { CANVAS_LIMITS, canvasFilePath, validateCanvasDocument } from '../../public/scripts/notebooks/canvas-format.js';
import { permissionAwareResolver } from './note-index.js';
import { resolveEmbedRegion } from './embeds.js';

export const CANVAS_PREVIEW_BYTES = 256 * 1024;

export function projectCanvas(document, entries, { canRead, path = '' } = {}) {
    const resolver = permissionAwareResolver(entries, canRead);
    validateCanvasDocument(document);
    const cache = new Map();
    const limited = { nodes: false, edges: false, excerpts: false };
    let remaining = CANVAS_PREVIEW_BYTES - 1024;
    function reserve(value) {
        const cost = Buffer.byteLength(JSON.stringify(value)) + 1;
        if (cost > remaining) return false;
        remaining -= cost;
        return true;
    }
    function commonNode(node) {
        return { id: node.id, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height,
            ...(node.color ? { color: node.color } : {}) };
    }
    function previewNode(node) {
        const common = commonNode(node);
        if (node.type === 'file') {
            const target = canvasFilePath(node.file, path);
            const resolved = target && resolver.resolve({ kind: 'markdown', target, fragment: '' }, '');
            if (resolved?.status !== 'resolved') return { ...common, status: 'unavailable', label: 'Note unavailable.' };
            const fragment = node.subpath?.slice(1) ?? '';
            const key = `${resolved.entry.id}:${fragment}`;
            if (!cache.has(key)) cache.set(key, resolveEmbedRegion(resolved.entry.text, fragment));
            const region = cache.get(key);
            if (!region) return { ...common, status: 'unavailable', label: 'Note unavailable.' };
            const excerpt = region.text.slice(0, 1200);
            return { ...common, status: 'note', label: resolved.entry.title.slice(0, 200), noteId: resolved.entry.id,
                path: resolved.entry.path, fragment, excerpt, truncated: region.text.length > excerpt.length };
        }
        if (node.type === 'text') {
            const text = node.text.slice(0, 1200);
            return { ...common, status: 'text', label: 'Text card', excerpt: text, truncated: node.text.length > text.length };
        }
        if (node.type === 'group') return { ...common, status: 'group', label: (node.label || 'Group').slice(0, 200) };
        if (node.type === 'link') {
            let url;
            try {
                const parsed = new URL(node.url);
                if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href;
            } catch { /* Invalid and active links stay data, never navigation. */ }
            return { ...common, status: url ? 'link' : 'unavailable', label: url ? url.slice(0, 200) : 'Link unavailable.', ...(url ? { url } : {}) };
        }
        return { ...common, status: 'unsupported', label: 'Unsupported card type. Kept in the file.' };
    }
    const nodes = [];
    for (const node of document.nodes ?? []) {
        let preview = previewNode(node);
        if (!reserve(preview)) {
            if (Object.hasOwn(preview, 'excerpt')) preview = { ...preview, excerpt: '', truncated: true };
            if (!reserve(preview)) {
                preview = { ...commonNode(node), status: 'limited', label: 'Card preview limit reached.' };
                if (!reserve(preview)) {
                    limited.nodes = true;
                    break;
                }
            }
            limited.excerpts = true;
        }
        nodes.push(preview);
        limited.excerpts ||= preview.truncated === true;
    }
    const ids = new Set(nodes.map(node => node.id));
    const edges = [];
    for (const edge of document.edges ?? []) {
        if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) continue;
        const preview = { id: edge.id, fromNode: edge.fromNode, toNode: edge.toNode, fromSide: edge.fromSide ?? 'right', toSide: edge.toSide ?? 'left',
            fromEnd: edge.fromEnd ?? 'none', toEnd: edge.toEnd ?? 'arrow', label: String(edge.label ?? '').slice(0, 200), ...(edge.color ? { color: edge.color } : {}) };
        if (!reserve(preview)) {
            limited.edges = true;
            break;
        }
        edges.push(preview);
    }
    return { nodes, edges, limited, limits: CANVAS_LIMITS };
}
