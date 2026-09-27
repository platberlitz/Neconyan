import { getOperationClient } from '../../../operations-client.js';

export const ORGANIZATION_FILE_NAME = '_sbca_organization.json';
export const ARCHIVE_PAGE_SIZE = 250;
const revisions = new WeakMap();

function rowsFrom(record) {
    if (!Array.isArray(record.result?.rows)) throw new Error('The saved archive result is incomplete.');
    return record.result.rows.map(row => ({ ...row, archive_record: record.key }));
}

/** One server inventory completes independently; these pages only display its saved result. */
export async function* iterateArchiveInventoryPages(_ctx, scope, signal) {
    if (!['archive', 'orphans'].includes(scope)) throw new TypeError(`Unsupported archive inventory scope: ${String(scope)}`);
    const client = await getOperationClient();
    const record = await client.run('archive-inventory', { scope }, { scope: `archive:${scope}`, signal });
    const rows = rowsFrom(record);
    for (let offset = 0; offset < rows.length || offset === 0; offset += ARCHIVE_PAGE_SIZE) {
        signal?.throwIfAborted();
        const batch = rows.slice(offset, offset + ARCHIVE_PAGE_SIZE);
        yield { rows: batch, loaded: offset + batch.length, errors: record.result.errors, pageErrors: 0,
            total: rows.length, cursor: offset + batch.length < rows.length ? `${record.key}:${offset + batch.length}` : null,
            readToken: record.key };
    }
}

export async function fetchArchiveInventory(ctx, scope, signal, onPage = null) {
    const rows = []; let errors = 0; let readToken = null;
    for await (const page of iterateArchiveInventoryPages(ctx, scope, signal)) {
        rows.push(...page.rows); errors = page.errors; readToken = page.readToken; onPage?.(page);
    }
    return { rows, errors, readToken };
}

export async function searchArchive(_ctx, query, signal, onProgress) {
    const client = await getOperationClient();
    const record = await client.run('archive-search', { query }, { scope: 'archive:search', signal, onProgress });
    return { rows: rowsFrom(record), errors: record.result.errors };
}

export async function exportChat(_ctx, body, signal) {
    const client = await getOperationClient();
    return (await client.run('archive-export', body, { scope: `archive:export:${body.avatar_url || 'group'}:${body.file}`, signal })).result;
}

export async function fetchOrganization(ctx, signal) {
    signal?.throwIfAborted();
    const client = await getOperationClient();
    const saved = await client.request('/api/operations/archive/organization');
    signal?.throwIfAborted(); revisions.set(ctx, saved.revision);
    return saved.organization;
}

export async function saveOrganization(ctx, organization, signal) {
    const revision = revisions.get(ctx);
    if (typeof revision !== 'string') throw new Error('Load the archive organisation before saving changes.');
    const client = await getOperationClient();
    const record = await client.run('archive-organization', { revision, organization }, { scope: 'archive:organization', signal });
    revisions.set(ctx, record.result.revision);
    return record.result;
}

export async function fetchArchiveFile(ctx, key, hash, signal) {
    const response = await fetch(`/api/operations/records/${encodeURIComponent(key)}/archive/${encodeURIComponent(hash)}`, {
        headers: ctx.getRequestHeaders(), signal, cache: 'no-store',
    });
    if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw Object.assign(new Error(value.error || 'The saved archive file could not be read.'), { status: response.status });
    }
    return response.text();
}

/** Closing a view only releases browser references; accepted inventories and their evidence persist. */
export async function releaseArchiveSession() {}
