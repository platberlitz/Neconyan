/**
 * A Pronouns field on the Persona page, under the persona description.
 *
 * It edits the same saved value as the Pronouns section of the settings
 * drawer: both read getPersonaSpec() and write savePersonaSpec(), and both
 * redraw from storage when onPronounsChanged() reports a write from elsewhere.
 */
import { button, el } from './dom.js';
import { PRESETS, parsePronounSet, previewSentence } from './pronoun-impl.js';
import { getSettings } from './settings.js';
import {
    SUBJECTS,
    clearOverride,
    getOverrideSpec,
    getPersonaSpec,
    onPronounsChanged,
    savePersonaSpec,
} from './pronoun-macros.js';

export const PERSONA_PRONOUN_FIELD_ID = 'me-persona-pronouns';
const INPUT_ID = 'me_persona_pronouns_input';
const FIELD_SOURCE = 'persona-field';
const SAVE_DELAY_MS = 400;

let unsubscribe = null;
let pendingSave = null;

function hasSelectedPersona() {
    const ctx = SillyTavern.getContext();
    return Boolean(ctx.userAvatar && ctx.powerUserSettings?.personas?.[ctx.userAvatar]);
}

function cancelPendingSave() {
    if (pendingSave) {
        clearTimeout(pendingSave.timer);
        pendingSave = null;
    }
}

/** Saves now if a delayed save is waiting, so nothing typed is lost. */
function flushPendingSave() {
    if (!pendingSave) {
        return;
    }
    const { spec, avatar } = pendingSave;
    cancelPendingSave();
    // The persona can change between the keystroke and the timer, so the value
    // goes to the persona it was typed for, never the one now selected.
    const stored = String(getSettings().pronouns.personas[avatar] ?? '');
    if (spec === stored) {
        return;
    }
    savePersonaSpec(spec, { source: FIELD_SOURCE, avatarId: avatar });
}

function scheduleSave(spec) {
    cancelPendingSave();
    const avatar = SillyTavern.getContext().userAvatar;
    pendingSave = { spec, avatar, timer: setTimeout(flushPendingSave, SAVE_DELAY_MS) };
}

function renderField(container) {
    flushPendingSave();
    container.replaceChildren();

    container.appendChild(el('h4', 'persona-section-header', 'Pronouns'));

    if (!hasSelectedPersona()) {
        container.appendChild(el('div', 'me-drawer-hint', 'Select a persona to give it pronouns.'));
        return;
    }

    const override = getOverrideSpec(SUBJECTS.user);

    const input = document.createElement('input');
    input.id = INPUT_ID;
    input.className = 'text_pole me-pronoun-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = getPersonaSpec();
    input.placeholder = 'they/them';
    input.setAttribute('aria-label', 'Persona pronouns');

    const preview = el('div', 'me-drawer-hint me-pronoun-preview');
    const problem = el('div', 'me-drawer-warning me-pronoun-problem');
    problem.hidden = true;

    function showProblem(text) {
        problem.hidden = false;
        problem.textContent = `"${text}" is not a pronoun set. Use one of the buttons above, or write all five forms: she/her/her/hers/herself.`;
    }

    function refreshPreview() {
        const set = parsePronounSet(input.value);
        preview.textContent = set ? `${set.spec}. ${previewSentence(set)}` : '';
        if (set) {
            problem.hidden = true;
        }
        return set;
    }

    const presets = el('div', 'me-pronoun-presets');
    for (const key of Object.keys(PRESETS)) {
        presets.appendChild(button('menu_button me-custom-button', key, () => {
            input.value = key;
            refreshPreview();
            cancelPendingSave();
            savePersonaSpec(key, { source: FIELD_SOURCE });
        }));
    }
    container.appendChild(presets);

    const row = el('div', 'me-pronoun-row');
    row.appendChild(input);
    container.appendChild(row);

    // Half-typed values ("she/h") are not sets yet, so typing saves only once
    // the value parses, and the warning waits until the field is left.
    input.addEventListener('input', () => {
        if (refreshPreview()) {
            scheduleSave(input.value.trim());
        } else {
            cancelPendingSave();
        }
    });
    input.addEventListener('change', () => {
        const spec = input.value.trim();
        if (spec && !parsePronounSet(spec)) {
            cancelPendingSave();
            showProblem(spec);
            return;
        }
        if (!pendingSave && spec !== getPersonaSpec()) {
            scheduleSave(spec);
        }
        flushPendingSave();
    });

    refreshPreview();
    container.appendChild(problem);
    container.appendChild(preview);

    container.appendChild(el('div', 'me-drawer-hint',
        'Used by {{sub}}, {{obj}}, {{poss}}, {{poss_p}}, {{ref}} and {{pverb}}. '
        + 'Same setting as Macro Enhanced → Pronouns; changing either changes both. Empty means they/them.'));

    // A {{setpronouns}} override outranks the saved value in this chat, so say
    // so rather than leaving someone editing a value that has no effect here.
    if (override) {
        const notice = el('div', 'me-drawer-warning');
        notice.appendChild(document.createTextNode(
            `This chat is overriding the setting with ${override}. set by {{setpronouns}}. `));
        notice.appendChild(button('menu_button me-custom-button', 'Use the saved setting', () => {
            clearOverride(SUBJECTS.user);
        }));
        container.appendChild(notice);
    }
}

/**
 * Mounts or redraws the field. Safe to call repeatedly; does nothing when the
 * Persona page is not in the document.
 */
export function renderPersonaPronounField() {
    const description = document.getElementById('persona_description');
    if (!description) {
        return;
    }

    let container = document.getElementById(PERSONA_PRONOUN_FIELD_ID);
    if (!container) {
        container = el('div', 'me-persona-pronouns');
        container.id = PERSONA_PRONOUN_FIELD_ID;
        description.insertAdjacentElement('afterend', container);
    }

    // Keep what someone is typing. Their own saves already match storage, and
    // anything else redraws once they leave the field.
    const input = container.querySelector(`#${INPUT_ID}`);
    if (input && document.activeElement === input && input.value.trim() === getPersonaSpec()) {
        return;
    }

    renderField(container);
}

/** Mounts the field and keeps it in step with writes made elsewhere. */
export function mountPersonaPronounField() {
    renderPersonaPronounField();
    if (!unsubscribe) {
        unsubscribe = onPronounsChanged(({ subject, source }) => {
            if (subject !== SUBJECTS.user.key || source === FIELD_SOURCE) {
                return;
            }
            renderPersonaPronounField();
        });
    }
}

export function unmountPersonaPronounField() {
    flushPendingSave();
    unsubscribe?.();
    unsubscribe = null;
    document.getElementById(PERSONA_PRONOUN_FIELD_ID)?.remove();
}
