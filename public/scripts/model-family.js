/**
 * Model families derived from model IDs, so new releases land in the right group
 * (gemini-3.5-flash -> 'Gemini 3.5') without a hand-maintained list.
 */

const FAMILY_NAMES = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    deepseek: 'DeepSeek',
    gemini: 'Gemini',
    gemma: 'Gemma',
    glm: 'GLM',
    gpt: 'GPT',
    grok: 'Grok',
    kimi: 'Kimi',
    llama: 'Llama',
    minimax: 'MiniMax',
    mistral: 'Mistral',
    mixtral: 'Mixtral',
    o: 'o',
    qwen: 'Qwen',
    qwq: 'QwQ',
};

const VERSION = /^v?[1-9]\d?(?:\.\d+)*[a-z]?$/;
const PARAMETER_SIZE = /^\d+(?:\.\d+)?[bkm]$/;
const LETTER_VERSION = /^[a-z]\d+(?:\.\d+)?$/;
const EMBEDDED_VERSION = /^([a-z]+?)(\d+(?:\.\d+)*[a-z]?)$/;

function capitalise(word) {
    return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function formatVersion(version) {
    return /^[a-z]\d/.test(version) ? version[0].toUpperCase() + version.slice(1) : version;
}

/**
 * @param {string} id Model ID, optionally with a 'source/' prefix or ':variant' suffix.
 * @returns {{ key: string, label: string, family: string, version: number[] } | null}
 */
export function getModelFamilyGroup(id) {
    const base = String(id ?? '').trim().split('/').pop().replace(/:.*$/, '');
    const tokens = base.toLowerCase().split(/[\s_-]+/).filter(Boolean);
    const [first, ...rest] = tokens;
    if (!first || !/^[a-z]/.test(first)) return null;

    let family = first;
    let version = '';
    let embedded = false;
    const inline = first.match(EMBEDDED_VERSION);
    if (inline && !PARAMETER_SIZE.test(inline[2])) {
        [, family, version] = inline;
        embedded = true;
    } else if (!/^[a-z]+$/.test(first)) {
        return null;
    } else {
        for (let index = 0; index < Math.min(rest.length, 3); index++) {
            const token = rest[index];
            if (index === 0 && LETTER_VERSION.test(token)) {
                version = token;
                break;
            }
            if (VERSION.test(token) && !PARAMETER_SIZE.test(token)) {
                version = token;
                // Dash-separated minor versions: claude-opus-4-5 -> 4.5
                if (/^\d+$/.test(token) && /^\d$/.test(rest[index + 1] ?? '')) version += `.${rest[index + 1]}`;
                break;
            }
            if (!/^[a-z]+$/.test(token)) break;
        }
    }

    const name = FAMILY_NAMES[family] ?? capitalise(family);
    const shown = formatVersion(version);
    const label = !version ? name : embedded ? `${name}${shown}` : family === 'gpt' ? `${name}-${shown}` : `${name} ${shown}`;
    const numbers = (version.match(/\d+/g) ?? []).map(Number);
    return { key: `${family}:${version}`, label, family, version: numbers };
}

function compareVersionsDescending(a, b) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (b[index] ?? -1) - (a[index] ?? -1);
        if (difference) return difference;
    }
    return 0;
}

/**
 * Groups items by model family. Families keep the order they first appear in;
 * versions within a family run newest first. Unrecognised IDs go last.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getId
 * @returns {{ key: string, label: string | null, items: T[] }[]}
 */
export function groupByModelFamily(items, getId) {
    const groups = new Map();
    const familyOrder = new Map();
    const other = [];
    for (const item of items) {
        const family = getModelFamilyGroup(getId(item));
        if (!family) {
            other.push(item);
            continue;
        }
        if (!familyOrder.has(family.family)) familyOrder.set(family.family, familyOrder.size);
        if (!groups.has(family.key)) groups.set(family.key, { ...family, items: [] });
        groups.get(family.key).items.push(item);
    }
    const sorted = [...groups.values()].sort((a, b) => familyOrder.get(a.family) - familyOrder.get(b.family) || compareVersionsDescending(a.version, b.version));
    const result = sorted.map(({ key, label, items: groupItems }) => ({ key, label, items: groupItems }));
    if (other.length) result.push({ key: 'other', label: null, items: other });
    return result;
}

