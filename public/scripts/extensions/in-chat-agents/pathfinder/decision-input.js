/** Candidate identity stays distinct even when books reuse names and entry numbers. */
export function entryDecisionCandidates(entries, settings, includeContent) {
    return [...entries].map(([id, entry]) => ({ id, text: [id, (entry.key || []).join(', '),
        includeContent ? (settings.entryContentMode === 'truncated' ? String(entry.content || '').slice(0, settings.truncateLength || 500) : entry.content || '') : ''].filter(Boolean).join('\n') }));
}

export function waypointDecisionCandidates(trees) {
    const candidates = [];
    const visit = (node, book, depth) => {
        if ((depth || node.entries?.length) && node.id) candidates.push({ id: node.id,
            text: `${book}: ${node.name}\n${node.description || ''}\n${node.entries?.length || 0} entries` });
        for (const child of node.children || []) visit(child, book, depth + 1);
    };
    for (const [book, tree] of trees) if (tree) visit(tree, book, 0);
    return candidates;
}
