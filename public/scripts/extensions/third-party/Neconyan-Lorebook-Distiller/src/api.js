/** Read-only host controls. Native Labs owns generation and reviewed writes. */
export async function listReadableChats(ctx, signal) {
    const response = await fetch('/api/chats/recent', {
        method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ max: 100 }), signal,
    });
    if (!response.ok) throw new Error(`Recent chats could not be read (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('The recent chat list is invalid.');
    return rows.filter(row => row && typeof row === 'object' && row.avatar && row.file_name);
}

export function listBooks(ctx) {
    const names = ctx.getWorldInfoNames?.();
    return Array.isArray(names) ? [...names] : [];
}

export function listConnectionProfiles(ctx) {
    try {
        const profiles = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.();
        return Array.isArray(profiles) ? profiles.filter(profile => profile?.id && profile?.name) : [];
    } catch { return []; }
}
