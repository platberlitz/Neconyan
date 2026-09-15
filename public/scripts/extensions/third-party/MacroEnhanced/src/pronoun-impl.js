/**
 * Pure implementations for the pronoun pack. No Neconyan imports —
 * everything in this file is directly testable under `node --test`.
 *
 * A pronoun set is written as a spec string, either a short preset ("she/her")
 * or all five forms spelled out ("xe/xem/xyr/xyrs/xemself"), with an optional
 * trailing "plural" or "singular" that decides verb agreement.
 */

/** The five forms, in spec order. Named as JanitorAI names them. */
export const PRONOUN_SLOTS = Object.freeze(['sub', 'obj', 'poss', 'poss_p', 'ref']);

/** Used whenever nothing is set, matching what JanitorAI does. */
export const DEFAULT_SPEC = 'they/them';

/** The presets a two-part spec can name, keyed by that short form. */
export const PRESETS = Object.freeze({
    'she/her': ['she', 'her', 'her', 'hers', 'herself'],
    'he/him': ['he', 'him', 'his', 'his', 'himself'],
    'they/them': ['they', 'them', 'their', 'theirs', 'themself'],
    'it/its': ['it', 'it', 'its', 'its', 'itself'],
});

const PLURALITY = Object.freeze({ plural: true, singular: false });

function build(parts, plural, presetKey) {
    const set = {};
    PRONOUN_SLOTS.forEach((slot, index) => {
        set[slot] = parts[index];
    });
    // Only "they" takes plural verbs on its own. Neo-pronouns take singular ones
    // ("xe is"), which is why a spec can say so outright.
    set.plural = plural === undefined ? set.sub === 'they' : plural;
    // An explicit plurality has to stay in the spec, or "ae/.../aerself/plural"
    // would come back as singular the next time it is read.
    set.spec = plural === undefined
        ? parts.join('/')
        : `${parts.join('/')}/${plural ? 'plural' : 'singular'}`;
    // The shortest spec that parses back to this set. Never `${sub}/${obj}` for a
    // custom set: "xe/xem" names no preset, and it/its has the same subject and
    // object, so a two-part form built by hand would not round-trip.
    set.short = presetKey ?? set.spec;
    return set;
}

/**
 * Parses a pronoun spec into its five forms plus verb plurality.
 *
 * @param {string} spec - "she/her", "xe/xem/xyr/xyrs/xemself", optionally with a
 *   trailing "/plural" or "/singular". Empty means unset, and yields the default.
 * @returns {{sub: string, obj: string, poss: string, poss_p: string, ref: string,
 *   plural: boolean, short: string, spec: string}|null} null when unparseable,
 *   so the caller can warn in its own words.
 */
export function parsePronounSet(spec) {
    const parts = String(spec ?? '')
        .split('/')
        .map(part => part.trim().toLowerCase())
        .filter(Boolean);

    if (!parts.length) {
        return defaultPronounSet();
    }

    // One or two parts can only ever name a preset. the other three forms are
    // not derivable ("her" and "hers" differ, "his" and "his" do not).
    if (parts.length <= 2) {
        const key = parts.join('/');
        return PRESETS[key] ? build(PRESETS[key], undefined, key) : null;
    }

    if (parts.length < PRONOUN_SLOTS.length || parts.length > PRONOUN_SLOTS.length + 1) {
        return null;
    }

    let plural;
    if (parts.length > PRONOUN_SLOTS.length) {
        plural = PLURALITY[parts[PRONOUN_SLOTS.length]];
        if (plural === undefined) {
            return null;
        }
    }

    return build(parts.slice(0, PRONOUN_SLOTS.length), plural);
}

/** The default set, for callers that need one after a spec failed to parse. */
export function defaultPronounSet() {
    return build(PRESETS[DEFAULT_SPEC], undefined, DEFAULT_SPEC);
}

/** A one-line sample sentence, for the settings drawer's live preview. */
export function previewSentence(set) {
    return `${set.sub} ${set.plural ? 'have' : 'has'} ${set.poss} own way of doing things; `
        + `the choice is ${set.poss_p}, so leave it to ${set.obj} and ${set.sub} will sort it out ${set.ref}.`;
}
