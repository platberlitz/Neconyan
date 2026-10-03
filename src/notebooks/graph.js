import { permissionAwareResolver } from './note-index.js';
import { foldKey } from './paths.js';

export const GRAPH_LIMITS = Object.freeze({ nodes: 300, edges: 1200, links: 12000, totalBytes: 512 * 1024 });

function matchesFilter(entry, folder, tag) {
    if (folder !== null) {
        const actual = foldKey(entry.folder);
        const wanted = foldKey(folder);
        if (folder === '' ? actual !== '' : actual !== wanted && !actual.startsWith(`${wanted}/`)) return false;
    }
    const wanted = tag === null ? null : foldKey(tag.replace(/^#/, '').trim());
    return !wanted || entry.tags.some(value => foldKey(value) === wanted || foldKey(value).startsWith(`${wanted}/`));
}

/** A graph contains only already-visible notes. Display filters never change link resolution. */
export function buildNoteGraph(entries, { canRead, folder = null, tag = null, limit = GRAPH_LIMITS.nodes } = {}) {
    const resolver = permissionAwareResolver(entries, canRead);
    const folderFilter = typeof folder === 'string' ? folder : null;
    const tagFilter = typeof tag === 'string' && tag.trim() ? tag.trim().slice(0, 100) : null;
    const nodeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(GRAPH_LIMITS.nodes, Math.floor(Number(limit)))) : GRAPH_LIMITS.nodes;
    const matching = resolver.entries.filter(entry => matchesFilter(entry, folderFilter, tagFilter))
        .sort((first, second) => first.title.localeCompare(second.title) || first.path.localeCompare(second.path) || first.id.localeCompare(second.id));
    const nodes = [];
    const chosen = [];
    let bytes = 0;
    for (const entry of matching) {
        if (nodes.length >= nodeLimit) break;
        const node = { id: entry.id, title: entry.title.slice(0, 200), path: entry.path.slice(0, 240),
            folder: entry.folder.slice(0, 240), tags: entry.tags.slice(0, 8).map(value => value.slice(0, 80)) };
        const size = Buffer.byteLength(JSON.stringify(node), 'utf8');
        if (bytes + size > GRAPH_LIMITS.totalBytes - 128 * 1024) break;
        bytes += size;
        nodes.push(node);
        chosen.push(entry);
    }
    const ids = new Set(nodes.map(node => node.id));
    const edges = new Map();
    let inspected = 0;
    let linksLimited = false;
    let edgesLimited = false;
    scan: for (const entry of chosen) {
        for (const link of entry.links) {
            if (inspected++ >= GRAPH_LIMITS.links) { linksLimited = true; break scan; }
            if (link.external) continue;
            const resolved = resolver.resolve(link, entry.path);
            if (resolved.status !== 'resolved' || !ids.has(resolved.entry.id) || resolved.entry.id === entry.id) continue;
            const [source, target] = [entry.id, resolved.entry.id].sort();
            const key = `${source}:${target}`;
            const prior = edges.get(key);
            if (prior) {
                prior.references++;
                prior.embedded ||= Boolean(link.embed);
            } else if (edges.size < GRAPH_LIMITS.edges) edges.set(key, { source, target, references: 1, embedded: Boolean(link.embed) });
            else edgesLimited = true;
        }
    }
    return { status: 'success', nodes, edges: [...edges.values()], total: matching.length,
        filters: { folder: folderFilter, tag: tagFilter }, limits: { ...GRAPH_LIMITS, nodes: nodeLimit },
        truncated: { nodes: nodes.length < matching.length, edges: linksLimited || edgesLimited } };
}
