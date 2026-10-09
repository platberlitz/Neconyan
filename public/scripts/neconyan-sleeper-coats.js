// Every coat is drawn once, facing the side it was painted for; the other side mirrors it.
export const SLEEPER_COAT_GROUPS = Object.freeze([
    { id: 'house', label: 'House cats' },
    { id: 'wild', label: 'Spotted and wild' },
]);

export const SLEEPER_COATS = Object.freeze([
    { id: 'calico', label: 'Calico', side: 'left', group: 'house' },
    { id: 'tiger', label: 'Ginger tabby', side: 'right', group: 'house' },
    { id: 'grey-tabby', label: 'Grey tabby', side: 'left', group: 'house' },
    { id: 'brown-tabby', label: 'Brown tabby', side: 'left', group: 'house' },
    { id: 'cream', label: 'Cream', side: 'left', group: 'house' },
    { id: 'ginger-white', label: 'Ginger and white', side: 'left', group: 'house' },
    { id: 'tortoiseshell', label: 'Tortoiseshell', side: 'left', group: 'house' },
    { id: 'torbie', label: 'Torbie', side: 'left', group: 'house' },
    { id: 'dilute-calico', label: 'Dilute calico', side: 'left', group: 'house' },
    { id: 'tuxedo', label: 'Tuxedo', side: 'left', group: 'house' },
    { id: 'cow', label: 'Cow cat', side: 'left', group: 'house' },
    { id: 'siamese', label: 'Siamese', side: 'left', group: 'house' },
    { id: 'ragdoll', label: 'Ragdoll', side: 'left', group: 'house' },
    { id: 'russian-blue', label: 'Russian Blue', side: 'left', group: 'house' },
    { id: 'lilac', label: 'Lilac', side: 'left', group: 'house' },
    { id: 'chocolate', label: 'Chocolate', side: 'left', group: 'house' },
    { id: 'smoke', label: 'Black smoke', side: 'left', group: 'house' },
    { id: 'black', label: 'Black', side: 'left', group: 'house' },
    { id: 'white', label: 'White', side: 'left', group: 'house' },
    { id: 'abyssinian', label: 'Abyssinian', side: 'left', group: 'house' },
    { id: 'sphynx', label: 'Sphynx', side: 'left', group: 'house' },
    { id: 'leopard', label: 'Leopard', side: 'left', group: 'wild' },
    { id: 'bengal', label: 'Marbled Bengal', side: 'left', group: 'wild' },
    { id: 'egyptian-mau', label: 'Egyptian Mau', side: 'left', group: 'wild' },
    { id: 'cheetah', label: 'Cheetah', side: 'left', group: 'wild' },
    { id: 'serval', label: 'Serval', side: 'left', group: 'wild' },
    { id: 'snow-leopard', label: 'Snow leopard', side: 'left', group: 'wild' },
    { id: 'white-tiger', label: 'White tiger', side: 'left', group: 'wild' },
]);

export const SLEEPER_COAT_DEFAULTS = Object.freeze({ character: 'calico', user: 'tiger' });

/** Ready-made matches; picking one sets both cats, and either cat can still be changed after. */
export const SLEEPER_COAT_PAIRS = Object.freeze([
    { id: 'classic', label: 'Classic: ginger tabby and calico', user: 'tiger', character: 'calico' },
    { id: 'night-and-day', label: 'Night and day: black and white', user: 'black', character: 'white' },
    { id: 'black-tie', label: 'Black tie: tuxedo and cow cat', user: 'tuxedo', character: 'cow' },
    { id: 'tabby-twins', label: 'Tabby twins: grey and brown tabby', user: 'grey-tabby', character: 'brown-tabby' },
    { id: 'tortie-sisters', label: 'Tortie sisters: torbie and tortoiseshell', user: 'torbie', character: 'tortoiseshell' },
    { id: 'pastels', label: 'Pastels: cream and dilute calico', user: 'cream', character: 'dilute-calico' },
    { id: 'soft-greys', label: 'Soft greys: lilac and Russian Blue', user: 'lilac', character: 'russian-blue' },
    { id: 'cafe-au-lait', label: 'Café au lait: chocolate and cream', user: 'chocolate', character: 'cream' },
    { id: 'colourpoints', label: 'Colourpoints: Siamese and Ragdoll', user: 'siamese', character: 'ragdoll' },
    { id: 'orange-club', label: 'Orange club: ginger and white and ginger tabby', user: 'ginger-white', character: 'tiger' },
    { id: 'shadow-and-ghost', label: 'Shadow and ghost: black smoke and Sphynx', user: 'smoke', character: 'sphynx' },
    { id: 'spotted-rivals', label: 'Spotted rivals: cheetah and leopard', user: 'cheetah', character: 'leopard' },
    { id: 'savannah', label: 'Savannah: serval and Abyssinian', user: 'serval', character: 'abyssinian' },
    { id: 'spots-and-marbles', label: 'Spots and marbles: Egyptian Mau and Bengal', user: 'egyptian-mau', character: 'bengal' },
    { id: 'snow-cats', label: 'Snow cats: snow leopard and white tiger', user: 'snow-leopard', character: 'white-tiger' },
]);
export const SLEEPER_COAT_STORAGE_KEYS = Object.freeze({ character: 'sb-sleeper-coat-character', user: 'sb-sleeper-coat-user' });
export const SLEEPER_COAT_CHANGE_EVENT = 'neconyan:sleeper-coat-change';

const coatsById = new Map(SLEEPER_COATS.map(coat => [coat.id, coat]));

function readStored(key) {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

export function normalizeSleeperCoat(value, role) {
    return coatsById.has(value) ? value : SLEEPER_COAT_DEFAULTS[role === 'user' ? 'user' : 'character'];
}

export function getSleeperCoat(role) {
    const key = role === 'user' ? 'user' : 'character';
    return normalizeSleeperCoat(readStored(SLEEPER_COAT_STORAGE_KEYS[key]), key);
}

/** Image and mirroring for one coat on the user ('right') or character ('left') side. */
export function sleeperCoatArt(coatId, isUser) {
    const coat = coatsById.get(normalizeSleeperCoat(coatId, isUser ? 'user' : 'character'));
    const side = isUser ? 'right' : 'left';
    return { coat: coat.id, src: `/img/neconyan/sleeping-${coat.id}-${coat.side}.webp`, mirrored: coat.side !== side };
}

/** Points a sleeper image at the chosen coat for its side and returns the base frame's path. */
export function dressSleeper(img, isUser = img?.classList?.contains('is-user')) {
    if (!img) return null;
    const art = sleeperCoatArt(getSleeperCoat(isUser ? 'user' : 'character'), isUser);
    img.classList.toggle('is-user', Boolean(isUser));
    img.classList.toggle('is-mirrored', art.mirrored);
    img.dataset.sleeperCoat = art.coat;
    if (img.getAttribute('src') !== art.src) img.setAttribute('src', art.src);
    return art.src;
}

export function dressAllSleepers(root = globalThis.document) {
    for (const img of root?.querySelectorAll?.('img.neconyan-message-sleeper') ?? []) dressSleeper(img);
}

export function setSleeperCoat(role, coatId) {
    const key = role === 'user' ? 'user' : 'character';
    const coat = normalizeSleeperCoat(coatId, key);
    try {
        globalThis.localStorage?.setItem(SLEEPER_COAT_STORAGE_KEYS[key], coat);
    } catch {
        // Private browsing can refuse storage; the cats still change for this page.
    }
    dressAllSleepers();
    globalThis.document?.dispatchEvent(new CustomEvent(SLEEPER_COAT_CHANGE_EVENT, { detail: { role: key, coat } }));
    return coat;
}

/** The pair the two saved coats currently match, or null for a custom mix. */
export function getSleeperCoatPair() {
    const user = getSleeperCoat('user');
    const character = getSleeperCoat('character');
    return SLEEPER_COAT_PAIRS.find(pair => pair.user === user && pair.character === character)?.id ?? null;
}

export function setSleeperCoatPair(pairId) {
    const pair = SLEEPER_COAT_PAIRS.find(item => item.id === pairId);
    if (!pair) return null;
    setSleeperCoat('user', pair.user);
    setSleeperCoat('character', pair.character);
    return pair.id;
}

// Bundled extensions such as Meower build their own rows without importing core modules.
globalThis.NeconyanSleepers = Object.freeze({ dress: dressSleeper, coats: SLEEPER_COATS });
