/**
 * Macro volatility classification.
 *
 * Vendored verbatim from SillyBunny-MacroEnhanced (src/auditor/volatility.js),
 * which is AGPL-3.0 licensed, as is this project. It is copied rather than
 * imported because Macro Enhanced is an optional neighbour: it installs under a
 * folder name that does not match its repository, and a hard import would make
 * Prompting Lab fail to load whenever it is absent.
 *
 * Source: https://github.com/SillyBunnyTeam/SillyBunny-MacroEnhanced
 *
 * The file below is unmodified apart from this header. Keep it that way, so a
 * future update can be taken by replacing everything under this comment.
 */


export const CLASS_RANDOM = 'random';
export const CLASS_TIME = 'time';
export const CLASS_CHAT = 'chat';
export const CLASS_STATE = 'state';
export const CLASS_PERIODIC = 'periodic';
export const CLASS_STABLE = 'stable';

/** Higher = worse for prompt caching. */
export const SEVERITY = {
    [CLASS_RANDOM]: 5,
    [CLASS_TIME]: 4,
    [CLASS_CHAT]: 3,
    [CLASS_STATE]: 2,
    [CLASS_PERIODIC]: 1,
    [CLASS_STABLE]: 0,
};

export const CLASS_WHY = {
    [CLASS_RANDOM]: 'different output on every evaluation',
    [CLASS_TIME]: 'changes with the clock',
    [CLASS_CHAT]: 'changes as the chat moves',
    [CLASS_STATE]: 'variable reads/writes can change between generations',
    [CLASS_PERIODIC]: 'changes only on coarse boundaries — cache-friendly by design',
    [CLASS_STABLE]: 'deterministic — cache-safe',
};

/** Extra nuance for names whose class depends on how they are called. */
export const NAME_NOTES = {
    dateformat: 'volatile only when its date argument is empty (empty means "now")',
    listshuffle: 'volatile unless you give it a seed',
    lorecount: 'the default "active" scope changes per generation; "bound"/"all" are steadier',
    loretokens: 'the default "active" scope changes per generation; "bound" is steadier',
};

const VARIABLE_NAMES = [
    'setvar', 'addvar', 'incvar', 'decvar', 'getvar', 'hasvar', 'varexists', 'deletevar', 'flushvar',
    'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'getglobalvar', 'hasglobalvar',
    'globalvarexists', 'deleteglobalvar', 'flushglobalvar',
    'setvarkey', 'getvarkey', 'setglobalvarkey', 'getglobalvarkey',
    'setvarindex', 'getvarindex', 'setglobalvarindex', 'getglobalvarindex',
    'jsonset',
    // Macro Enhanced chat variables: a separate store, but the same volatility --
    // reads and writes can differ between generations. {{foreachChatVar}} counts
    // too, since what it emits follows whatever the store holds.
    'setchatvar', 'addchatvar', 'getchatvar', 'haschatvar', 'chatvarexists',
    'deletechatvar', 'flushchatvar', 'foreachchatvar',
];

/** Known classification of core + Macro Enhanced macros, lowercased. */
export const KNOWN_CLASSES = new Map([
    // core time macros
    ...['time', 'date', 'weekday', 'isotime', 'isodate', 'datetimeformat', 'idleduration', 'idle_duration', 'timediff']
        .map(name => [name, CLASS_TIME]),
    ['dateformat', CLASS_TIME],
    // randomness
    ['random', CLASS_RANDOM],
    ['roll', CLASS_RANDOM],
    ['listshuffle', CLASS_RANDOM],
    // chat-motion macros
    ...['lastmessage', 'lastmessageid', 'lastusermessage', 'lastcharmessage', 'firstincludedmessageid',
        'firstdisplayedmessageid', 'lastswipeid', 'currentswipeid', 'allchatrange', 'input',
        'lastgenerationtype', 'model', 'loreactive', 'lorecount', 'loretokens']
        .map(name => [name, CLASS_CHAT]),
    // variables
    ...VARIABLE_NAMES.map(name => [name, CLASS_STATE]),
    // Macro Enhanced periodic-by-design
    ...['timeofday', 'season', 'daily', 'sticky', 'chatdays', 'usermsgcount', 'charmsgcount', 'swipecount', 'gencount']
        .map(name => [name, CLASS_PERIODIC]),
    // Pronoun overrides write chat state, so they carry the same risk as any
    // other write: what a later read returns depends on when this last ran.
    ...['setpronouns', 'setcharpronouns'].map(name => [name, CLASS_STATE]),
    // deterministic
    ...['pick', 'freeze', 'rollonce', 'listpick', 'lorepick'].map(name => [name, CLASS_STABLE]),
    // Pronoun readers: fixed for a given persona and card, so they re-send
    // byte-identical text every generation.
    ...['sub', 'obj', 'poss', 'poss_p', 'ref', 'pronouns', 'pverb',
        'charsub', 'charobj', 'charposs', 'charposs_p', 'charref', 'charpronouns', 'charpverb']
        .map(name => [name, CLASS_STABLE]),
]);

/** Matches macro names at any nesting depth, past any flags ({{!time}}, {{? x}}). */
export const MACRO_NAME_SCAN = /{{[!?~>#/\s]*([a-zA-Z][\w-]*)/g;
/** Variable shorthand ({{.x = 5}}, {{$y++}}) — bypasses the registry, still stateful. */
export const SHORTHAND_SCAN = /{{\s*[.$][a-zA-Z]/g;

/**
 * Every macro-looking identifier in the text, with occurrence counts.
 * Shorthand variable syntax is reported under the pseudo-name ".shorthand".
 *
 * @returns {Map<string, number>} lowercased name -> count
 */
export function scanMacroNames(text) {
    const counts = new Map();
    const s = String(text ?? '');
    for (const match of s.matchAll(MACRO_NAME_SCAN)) {
        const name = match[1].toLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const shorthand = [...s.matchAll(SHORTHAND_SCAN)].length;
    if (shorthand) {
        counts.set('.shorthand', shorthand);
    }
    return counts;
}

/**
 * Classifies a macro name.
 *
 * @param {string} name - Lowercased macro name (or ".shorthand").
 * @param {object} [deps]
 * @param {(name: string) => string|null} [deps.getRegistryCategory] - Registry category lookup.
 * @param {(name: string) => string|null} [deps.getCustomTemplate] - Custom-def template lookup;
 *        custom macros inherit the WORST class of anything their template references.
 * @param {Set<string>} [visited] - Recursion guard for custom-template chains.
 * @returns {{cls: string, via: string[]}|null} null when the name is unknown.
 */
export function classifyName(name, deps = {}, visited = new Set()) {
    const lower = String(name).toLowerCase();
    if (lower === '.shorthand') {
        return { cls: CLASS_STATE, via: [] };
    }

    const direct = KNOWN_CLASSES.get(lower)
        ?? (lower.startsWith('me-') ? KNOWN_CLASSES.get(lower.slice(3)) : undefined);
    if (direct) {
        return { cls: direct, via: [] };
    }

    if (deps.getRegistryCategory?.(lower) === 'variable') {
        return { cls: CLASS_STATE, via: [] };
    }

    const template = deps.getCustomTemplate?.(lower);
    if (typeof template === 'string' && !visited.has(lower)) {
        visited.add(lower);
        let worst = null;
        for (const inner of scanMacroNames(template).keys()) {
            const innerClass = classifyName(inner, deps, visited);
            if (innerClass && (!worst || SEVERITY[innerClass.cls] > SEVERITY[worst.cls])) {
                worst = { cls: innerClass.cls, via: [inner, ...innerClass.via] };
            }
        }
        return worst ?? { cls: CLASS_STABLE, via: [] };
    }

    return null;
}

/**
 * Static classification of one source text.
 *
 * @returns {{name: string, cls: string, via: string[], count: number}[]} sorted worst-first.
 */
export function classifySource(text, deps = {}) {
    const findings = [];
    for (const [name, count] of scanMacroNames(text)) {
        const classified = classifyName(name, deps);
        if (classified) {
            findings.push({ name, cls: classified.cls, via: classified.via, count });
        }
    }
    findings.sort((a, b) => SEVERITY[b.cls] - SEVERITY[a.cls] || a.name.localeCompare(b.name));
    return findings;
}
