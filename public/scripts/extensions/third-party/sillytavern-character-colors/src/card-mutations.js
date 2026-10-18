const CARD_SELECTOR = '.character_select, .group_member';
const CARD_CONTAINER_SELECTOR = [
    '#rm_print_characters_block',
    '#rm_group_members',
    '#rm_group_add_members',
    '#groupMemberListPopout',
    '.character_select_container',
].join(', ');
const CARD_CONTAINER_IDS = new Set([
    'rm_print_characters_block',
    'rm_group_members',
    'rm_group_add_members',
    'groupMemberListPopout',
]);

function elementOf(node) {
    return node?.nodeType === 1 ? node : node?.parentElement;
}

/**
 * True when a body-level childList batch can change a rendered character card.
 *
 * Chat messages are rejected before any descendant scan. Wrapper insertions
 * outside the chat are scanned once for card descendants, so a moving-UI
 * pop-out that carries cards still restyles them.
 */
export function mutationTouchesCharacterCards(mutations) {
    return mutations.some(mutation => {
        if (mutation.type !== 'childList') return false;
        const target = elementOf(mutation.target);
        if (target?.closest?.('[data-roleplay-draft]')) return false;
        if (target?.closest?.(`${CARD_SELECTOR}, ${CARD_CONTAINER_SELECTOR}`)) return true;
        // A card cannot sit inside the saved chat itself; skip the expensive
        // descendant checks for every streamed or printed message mutation.
        if (target?.closest?.('#chat')) return false;

        const nodes = Array.from(mutation.addedNodes || []).concat(Array.from(mutation.removedNodes || []));
        for (const node of nodes) {
            // Text nodes cannot carry cards. Using their parent here would scan a
            // large unrelated container on every text mutation.
            if (node?.nodeType !== 1) continue;
            if (node.matches?.(CARD_SELECTOR) || node.matches?.(CARD_CONTAINER_SELECTOR)) return true;
            if (CARD_CONTAINER_IDS.has(node.id)) return true;
            if (node.firstElementChild && node.querySelector?.(CARD_SELECTOR)) return true;
        }
        return false;
    });
}
