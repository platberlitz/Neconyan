/**
 * Match all query fragments across one chat's append-only message buffer.
 * parseChatSummary supplies the accumulated buffer after each message. Remember
 * which messages and fragments were checked so a miss visits each message once,
 * rather than searching the whole prefix again. Create a fresh matcher per file;
 * filename matching stays separate so partial filename/body hits cannot combine.
 * @param {string[]} fragments Lower-case search fragments
 * @returns {(texts: string[]) => boolean}
 */
export function createChatSearchMatcher(fragments) {
    const remaining = new Set(fragments);
    let checked = 0;
    return texts => {
        while (checked < texts.length && remaining.size > 0) {
            const text = String(texts[checked] ?? '').toLowerCase();
            checked++;
            for (const fragment of remaining) {
                if (text.includes(fragment)) remaining.delete(fragment);
            }
        }
        return remaining.size === 0;
    };
}
