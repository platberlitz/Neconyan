/**
 * What deleting or renaming a lorebook does to the places that link it. DOM-free: the places come from
 * `lorebook-links.js`, so the missing-lorebook notice and this cleanup cannot disagree about where a link lives.
 * A rename gives `to` a name; a delete gives `null`.
 */

import { LOREBOOK_LINK_KIND, listLorebookLinks } from './lorebook-links.js';

/**
 * Whether a linked name loads this lorebook. Exact, case counts, no prefix match; the server drops trailing
 * spaces and dots when it looks a name up, so 'Book ' loads 'Book' and moves with it.
 * @param {unknown} linked Name stored in a link
 * @param {string} name Lorebook that is renamed or deleted
 * @returns {boolean}
 */
export function linkPointsAt(linked, name) {
    const stored = String(linked ?? '');
    const target = String(name ?? '');
    if (!target.trim()) return false;
    return stored === target || stored.replace(/[. ]+$/, '') === target;
}

/**
 * A list of linked names after the change. A rename keeps the place of the link and never lists a name twice.
 * @param {unknown} list Linked names
 * @param {string} from Lorebook that is renamed or deleted
 * @param {string|null} to New name, or null for a delete
 * @returns {string[]|null} The new list, or null when nothing in it links `from`
 */
export function rewriteLorebookNames(list, from, to) {
    if (!Array.isArray(list) || !list.some(item => linkPointsAt(item, from))) return null;
    const result = [];
    for (const item of list) {
        const next = linkPointsAt(item, from) ? to : item;
        if (next === null || (next === to && result.includes(to))) continue;
        result.push(next);
    }
    return result;
}

/**
 * World Info's per-card list of extra lorebooks after the change. A card left with no extra lorebooks loses its entry.
 * @param {Array<{name?: string, extraBooks?: string[]}>} charLore
 * @param {string} from
 * @param {string|null} to
 * @returns {{ charLore: Array<{name?: string, extraBooks?: string[]}>, cards: string[] }} `cards` holds the file names that changed
 */
export function rewriteCharLore(charLore, from, to) {
    const cards = [];
    const next = [];
    for (const entry of Array.isArray(charLore) ? charLore : []) {
        const filename = String(entry?.name ?? '');
        const hit = listLorebookLinks({ cards: [{ avatar: `${filename}.png` }], charLore: [entry] })
            .some(link => link.kind === LOREBOOK_LINK_KIND.cardExtra && linkPointsAt(link.name, from));
        const books = hit ? rewriteLorebookNames(entry.extraBooks, from, to) : null;
        if (!books) {
            next.push(entry);
            continue;
        }
        cards.push(filename);
        if (books.length) next.push({ ...entry, extraBooks: books });
    }
    return { charLore: next, cards };
}

/**
 * Which persona lorebooks the change touches: the active persona's copy and the lorebook saved with every persona,
 * active or not. A delete leaves them empty.
 * @param {{ active?: unknown, descriptions?: Record<string, {lorebook?: string}>, avatar?: string }} personas
 * @param {string} from
 * @param {string|null} to
 * @returns {{ lorebook: string, active: boolean, avatars: string[], personas: number }|null} The name to store, whether
 * the active copy changes, the personas whose saved lorebook changes and how many personas that is, or null for none
 */
export function planPersonaLorebookRewrites({ active = '', descriptions = {}, avatar = '' } = {}, from, to) {
    const avatars = Object.entries(descriptions ?? {})
        .filter(([, descriptor]) => descriptor && typeof descriptor === 'object' && linkPointsAt(descriptor.lorebook, from))
        .map(([key]) => key);
    const activeHit = linkPointsAt(active, from);
    const personas = new Set(avatars);
    if (activeHit) personas.add(String(avatar ?? ''));
    if (!personas.size) return null;
    return { lorebook: to ?? '', active: activeHit, avatars, personas: personas.size };
}

/**
 * The cards whose main lorebook is this one, with the field to write so nothing else on the card changes.
 * @param {object[]} cards Character records
 * @param {string} from
 * @param {string|null} to
 * @returns {Array<{ avatar: string, owner: string, update: { extensions: { world: string } } }>}
 */
export function planCardLinkRewrites(cards, from, to) {
    return listLorebookLinks({ cards })
        .filter(link => link.kind === LOREBOOK_LINK_KIND.cardMain && linkPointsAt(link.name, from))
        .map(link => ({ avatar: String(link.avatar), owner: String(link.owner ?? ''), update: { extensions: { world: to ?? '' } } }));
}

/**
 * A chat's lorebook after the change.
 * @param {object|null|undefined} metadata Chat metadata
 * @param {string} from
 * @param {string|null} to
 * @returns {{ changed: boolean, value: string|null }} `value` is the new link, or null when the link goes
 */
export function rewriteChatLorebook(metadata, from, to) {
    const hit = listLorebookLinks({ chatLorebook: metadata?.world_info })
        .some(link => link.kind === LOREBOOK_LINK_KIND.chat && linkPointsAt(link.name, from));
    return { changed: hit, value: hit ? to : (metadata?.world_info ?? null) };
}

/**
 * Rewrites the Conversation lorebook override of every thread (a DM, or one member of a group) in the store, in place.
 * @param {{ characters?: Record<string, { settings?: { lorebook_override?: string } }> }} store
 * @param {string} from
 * @param {string|null} to
 * @returns {string[]} Thread keys that changed
 */
export function rewriteConversationOverrides(store, from, to) {
    const changed = [];
    for (const [key, slot] of Object.entries(store?.characters ?? {})) {
        const settings = slot?.settings;
        if (!settings) continue;
        const hit = listLorebookLinks({ conversationOverrides: [settings.lorebook_override] })
            .some(link => link.kind === LOREBOOK_LINK_KIND.conversation && linkPointsAt(link.name, from));
        if (!hit) continue;
        settings.lorebook_override = to ?? '';
        changed.push(key);
    }
    return changed;
}

/**
 * Runs the steps one after another. A step that throws is recorded and the rest still run, so one card that
 * cannot be saved leaves the others done and the failure in the result for the person to read.
 * @param {Array<{ label: string, run: () => Promise<number|void> }>} steps `run` may return how many links it moved
 * @returns {Promise<{ moved: number, failed: Array<{ label: string, reason: string }> }>}
 */
export async function runLorebookLinkSteps(steps) {
    let moved = 0;
    const failed = [];
    for (const step of steps) {
        try {
            const count = await step.run();
            moved += Number.isFinite(count) ? Number(count) : 0;
        } catch (error) {
            failed.push({ label: step.label, reason: String(error?.message || error || 'unknown error') });
        }
    }
    return { moved, failed };
}
