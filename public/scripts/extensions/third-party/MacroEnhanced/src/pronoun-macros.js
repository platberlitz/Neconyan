/**
 * JanitorAI-style pronoun macros, for your persona and for the character.
 *
 * Cards written on JanitorAI say "{{sub}} adjusted {{poss}} coat" so they read
 * correctly whoever is chatting. Nothing in Neconyan knows those names, or
 * holds a pronoun anywhere, so imported cards leak the literal text into the
 * prompt. This pack registers the five JanitorAI names against your persona and
 * a matching char* set against the character.
 *
 * Pronouns are read from the most specific place that has them: a
 * {{setpronouns}} override in this chat, then the persona setting or the card,
 * then they/them.
 */
import { safeRegister } from './registration.js';
import { MODULE_NAME, getSettings, saveSettings } from './settings.js';
import { getChatState, touchChatState } from './chat-state.js';
import { capitalizeText } from './utility-impl.js';
import { DEFAULT_SPEC, PRONOUN_SLOTS, defaultPronounSet, parsePronounSet } from './pronoun-impl.js';

export const CATEGORY_PRONOUN = 'enhanced-pronoun';

/**
 * Pronoun macros that WRITE persistent chat state. Like the state and chat-var
 * packs, each must honour env.extra.meSandboxState so the Workbench never
 * touches real data.
 */
export const PRONOUN_STATEFUL_MACRO_NAMES = Object.freeze(['setpronouns', 'setcharpronouns']);

/** The two things that can have pronouns. `prefix` builds every macro name. */
export const SUBJECTS = Object.freeze({
    user: { key: 'user', prefix: '', who: 'your persona' },
    char: { key: 'char', prefix: 'char', who: 'the character' },
});

/** What each slot is called in prose, and what it looks like. */
const SLOT_DOCS = Object.freeze({
    sub: { title: 'subject', examples: 'she, he, they' },
    obj: { title: 'object', examples: 'her, him, them' },
    poss: { title: 'possessive', examples: 'her, his, their' },
    poss_p: { title: 'standalone possessive', examples: 'hers, his, theirs' },
    ref: { title: 'reflexive', examples: 'herself, himself, themself' },
});

const PRESET_HINT = 'she/her, he/him, they/them, it/its, or all five forms separated by "/"';

// ---------- storage ----------

/** Sandboxed state (Workbench overlay) when present, else the real chat state. */
function resolveState(env) {
    const sandboxState = env?.extra?.meSandboxState;
    if (sandboxState) {
        return { state: sandboxState, sandboxed: true };
    }
    return { state: getChatState(), sandboxed: false };
}

/** The per-chat override map, created lazily. Null when there is no chat. */
function overrides(state) {
    if (!state) {
        return null;
    }
    if (!state.pronouns || typeof state.pronouns !== 'object') {
        state.pronouns = { user: '', char: '' };
    }
    return state.pronouns;
}

/** The spec saved against the active persona, or '' when none is set. */
export function getPersonaSpec() {
    const ctx = SillyTavern.getContext();
    return String(getSettings().pronouns.personas[ctx.userAvatar] ?? '');
}

export function savePersonaSpec(spec) {
    const ctx = SillyTavern.getContext();
    if (!ctx.userAvatar) {
        throw new Error('No persona is selected.');
    }
    getSettings().pronouns.personas[ctx.userAvatar] = String(spec ?? '').trim();
    saveSettings();
}

/** The spec saved on the active character's card, or '' when none is set. */
export function getCharacterSpec() {
    const ctx = SillyTavern.getContext();
    const character = ctx.characters?.[ctx.characterId];
    return String(character?.data?.extensions?.[MODULE_NAME]?.pronouns ?? '');
}

export async function saveCharacterSpec(spec) {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined || ctx.characterId === null) {
        throw new Error('No character selected.');
    }
    // writeExtensionField replaces the whole MacroEnhanced field, so everything
    // already on the card has to be carried over. without the spread this wipes
    // the card's custom macros.
    const existing = ctx.characters?.[ctx.characterId]?.data?.extensions?.[MODULE_NAME] ?? {};
    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, { ...existing, pronouns: String(spec ?? '').trim() });
}

/** The saved spec for a subject, ignoring any chat override. */
export function getStoredSpec(subject) {
    return subject.key === 'user' ? getPersonaSpec() : getCharacterSpec();
}

/** The chat-scoped override for a subject, or '' when there is none. */
export function getOverrideSpec(subject) {
    return String(getChatState()?.pronouns?.[subject.key] ?? '').trim();
}

/** Clears a chat override, so the saved setting applies again. */
export function clearOverride(subject) {
    const map = overrides(getChatState());
    if (map) {
        map[subject.key] = '';
        touchChatState();
    }
}

/**
 * The pronoun set in effect for a subject: a {{setpronouns}} override for this
 * chat wins, then the saved persona setting or card value, then they/them.
 *
 * ponytail: in a group chat ctx.characterId is undefined, so the character side
 * falls back to the default. Per-member pronouns need a member picker in the UI
 * and a keyed store. worth it only if someone actually runs into it.
 */
export function resolveSet(subject, { env, warn } = {}) {
    const { state } = resolveState(env);
    const override = String(state?.pronouns?.[subject.key] ?? '').trim();
    const spec = override || getStoredSpec(subject).trim();
    const set = parsePronounSet(spec);
    if (!set) {
        warn?.(`"${spec}" is not a pronoun set. use ${PRESET_HINT}. Falling back to ${DEFAULT_SPEC}.`);
        return defaultPronounSet();
    }
    return set;
}

// ---------- capitalization ----------

/**
 * Whether the author typed the macro capitalized. The host registry lowercases
 * every lookup and refuses an alias that differs from its macro only in case, so
 * {{Sub}} already lands on {{sub}}'s handler and ctx.raw is the only place the
 * spelling that was actually typed survives.
 *
 * ponytail: if the engine ever stops exposing the raw inner text this quietly
 * stops capitalizing rather than breaking; {{capitalize::{{sub}}}} still works.
 */
function invokedCapitalized(ctx) {
    const first = String(ctx.raw ?? '').match(/[A-Za-z]/)?.[0] ?? '';
    return first !== '' && first === first.toUpperCase();
}

function cased(ctx, value) {
    return invokedCapitalized(ctx) ? capitalizeText(value) : String(value);
}

// ---------- registration ----------

export function registerPronounMacros() {
    for (const subject of Object.values(SUBJECTS)) {
        const { prefix, who } = subject;

        for (const slot of PRONOUN_SLOTS) {
            const { title, examples } = SLOT_DOCS[slot];
            safeRegister(`${prefix}${slot}`, {
                category: CATEGORY_PRONOUN,
                description: `The ${title} pronoun for ${who} (${examples}). Capitalize the macro to capitalize the result.`,
                returns: `the ${title} pronoun, or the ${DEFAULT_SPEC} form when none is set`,
                exampleUsage: [`{{${prefix}${slot}}}`, `{{${capitalizeText(prefix + slot)}}}`],
                handler: ctx => cased(ctx, resolveSet(subject, ctx)[slot]),
            });
        }

        safeRegister(`${prefix}pronouns`, {
            category: CATEGORY_PRONOUN,
            description: `The pronoun set in effect for ${who}, for stating it outright in a description.`,
            returns: 'the pronoun set, such as "she/her"',
            exampleUsage: [`{{${prefix}pronouns}}`],
            handler: ctx => resolveSet(subject, ctx).short,
        });

        safeRegister(`${prefix}pverb`, {
            category: CATEGORY_PRONOUN,
            unnamedArgs: [
                { name: 'singular', description: 'The form that goes with he, she, it and neo-pronouns, such as "is".' },
                { name: 'plural', description: 'The form that goes with they, such as "are".' },
            ],
            description: `Picks the verb form that agrees with ${who}'s pronouns, so "she is" and "they are" both come out right.`,
            returns: 'whichever of the two forms agrees',
            exampleUsage: [`{{${prefix}pverb::is::are}}`, `{{${prefix}pverb::has::have}}`],
            handler: (ctx) => {
                const [singular, plural] = ctx.unnamedArgs;
                return cased(ctx, resolveSet(subject, ctx).plural ? plural : singular);
            },
        });

        const setterName = `set${prefix}pronouns`;
        safeRegister(setterName, {
            category: CATEGORY_PRONOUN,
            unnamedArgs: [
                { name: 'pronouns', description: `A set: ${PRESET_HINT}. Leave it empty to go back to the saved setting.` },
            ],
            description: `Overrides ${who}'s pronouns for this chat only, leaving the saved setting alone. Writes nothing to the prompt.`,
            returns: 'nothing',
            exampleUsage: [`{{${setterName}::she/her}}`, `{{${setterName}::xe/xem/xyr/xyrs/xemself}}`],
            handler: (ctx) => {
                const spec = String(ctx.unnamedArgs[0] ?? '').trim();
                if (spec && !parsePronounSet(spec)) {
                    ctx.warn(`{{${setterName}}}: "${spec}" is not a pronoun set. use ${PRESET_HINT}. Nothing changed.`);
                    return '';
                }
                const { state, sandboxed } = resolveState(ctx.env);
                const map = overrides(state);
                if (!map) {
                    ctx.warn(`{{${setterName}}}: no chat is loaded, so there is nowhere to store it.`);
                    return '';
                }
                map[subject.key] = spec;
                if (!sandboxed) {
                    touchChatState();
                }
                return '';
            },
        });
    }
}
