/**
 * Adds the open character's file identity to local tracker portrait URLs.
 * Runs at display time so saved regex scripts also follow the current chat.
 * @param {string} html Message HTML
 * @param {{ name?: string, avatar?: string }} [character] The open character
 * @returns {string}
 */
export function bindPortraitUrls(html, character) {
    if (!html.includes('/thumbnail/portrait?') || !character?.name || !character?.avatar || character.avatar === 'none') {
        return html;
    }

    // Both HTML attributes and inline CSS use quotes; CSS quotes may be HTML entities.
    return html.replace(/(["']|&quot;|&#39;)(\/thumbnail\/portrait\?)(.*?)\1/g, (_match, quote, endpoint, query) => {
        const params = new URLSearchParams(query.replaceAll('&amp;', '&'));
        params.set('char', character.name);
        params.set('avatar', character.avatar);
        return `${quote}${endpoint}${params.toString().replaceAll('&', '&amp;')}${quote}`;
    });
}
