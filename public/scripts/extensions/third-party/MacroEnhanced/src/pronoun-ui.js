/**
 * The Pronouns section of the settings drawer: one row of presets and a free
 * text box per subject, with a sample sentence so the effect is visible before
 * anything is saved.
 */
import { button, el } from './dom.js';
import { PRESETS, parsePronounSet, previewSentence } from './pronoun-impl.js';
import {
    SUBJECTS,
    clearOverride,
    getOverrideSpec,
    getStoredSpec,
    saveCharacterSpec,
    savePersonaSpec,
} from './pronoun-macros.js';

/** Who each subject currently is, and why its controls might be unavailable. */
function subjectTarget(subject) {
    const ctx = SillyTavern.getContext();
    if (subject.key === 'user') {
        return ctx.userAvatar
            ? { name: ctx.powerUserSettings?.personas?.[ctx.userAvatar] || 'your persona' }
            : { unavailable: 'Select a persona in Persona Management to give it pronouns.' };
    }
    const character = ctx.characters?.[ctx.characterId];
    return character
        ? { name: character.name || 'this character' }
        : { unavailable: 'Open a single-character chat to give that character pronouns. In a group, characters use they/them.' };
}

async function persist(subject, spec) {
    if (subject.key === 'user') {
        savePersonaSpec(spec);
    } else {
        await saveCharacterSpec(spec);
    }
}

function renderSubject(host, subject, rerender) {
    const target = subjectTarget(subject);
    const heading = subject.key === 'user' ? 'Your persona' : 'This character';

    host.appendChild(el('div', 'me-pronoun-subject', target.unavailable ? heading : `${heading}. ${target.name}`));

    if (target.unavailable) {
        host.appendChild(el('div', 'me-drawer-hint', target.unavailable));
        return;
    }

    const stored = getStoredSpec(subject);
    const override = getOverrideSpec(subject);

    const input = document.createElement('input');
    input.className = 'text_pole me-pronoun-input';
    input.type = 'text';
    input.value = stored;
    input.placeholder = 'they/them';
    input.setAttribute('aria-label', `Pronouns for ${target.name}`);

    const preview = el('div', 'me-drawer-hint me-pronoun-preview');
    const problem = el('div', 'me-drawer-warning me-pronoun-problem');
    problem.hidden = true;

    function refreshPreview() {
        const set = parsePronounSet(input.value);
        problem.hidden = !!set;
        if (!set) {
            problem.textContent = `"${input.value.trim()}" is not a pronoun set. Use one of the buttons above, or write all five forms: she/her/her/hers/herself.`;
            preview.textContent = '';
            return;
        }
        preview.textContent = `${set.spec}. ${previewSentence(set)}`;
    }

    const presets = el('div', 'me-pronoun-presets');
    for (const key of Object.keys(PRESETS)) {
        presets.appendChild(button('menu_button me-custom-button', key, () => {
            input.value = key;
            refreshPreview();
        }));
    }
    host.appendChild(presets);

    const row = el('div', 'me-pronoun-row');
    row.appendChild(input);
    row.appendChild(button('menu_button me-custom-button', 'Save', async () => {
        const spec = input.value.trim();
        if (spec && !parsePronounSet(spec)) {
            refreshPreview();
            return;
        }
        try {
            await persist(subject, spec);
        } catch (error) {
            problem.hidden = false;
            problem.textContent = `Saving failed: ${error?.message ?? error}`;
            return;
        }
        rerender();
    }));
    host.appendChild(row);

    input.addEventListener('input', refreshPreview);
    refreshPreview();
    host.appendChild(problem);
    host.appendChild(preview);

    // A {{setpronouns}} override silently outranks the box above it, so say so
    // rather than leaving someone editing a value that has no effect.
    if (override) {
        const notice = el('div', 'me-drawer-warning');
        notice.appendChild(document.createTextNode(
            `This chat is overriding the setting with ${override}. set by {{set${subject.prefix}pronouns}}. `));
        notice.appendChild(button('menu_button me-custom-button', 'Use the saved setting', () => {
            clearOverride(subject);
            rerender();
        }));
        host.appendChild(notice);
    }
}

/**
 * Renders both subjects into the drawer.
 *
 * @param {HTMLElement} container
 * @param {() => void} rerender - Re-renders the whole drawer after a save.
 */
export function renderPronounSettings(container, rerender) {
    container.appendChild(el('div', 'me-drawer-hint',
        'Cards written for JanitorAI use {{sub}}, {{obj}}, {{poss}}, {{poss_p}} and {{ref}}. '
        + 'Those follow your persona; the char* versions ({{charsub}} and friends) follow the character. '
        + 'Capitalize the macro to capitalize the word, and use {{pverb::is::are}} so verbs agree. '
        + 'Anything left unset is they/them.'));

    for (const subject of Object.values(SUBJECTS)) {
        renderSubject(container, subject, rerender);
    }
}
