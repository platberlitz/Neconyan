/**
 * Pronouns on the Setup tab: one row of preset chips and a text box per
 * subject, with a sample sentence so the effect is visible before saving. The
 * same saved values are edited on the Persona page.
 *
 * A draft belongs to the persona or character it was typed for. Switching
 * target keeps the draft visible with an explicit notice; Save refuses to write
 * it to the new target. The explicit target id is also captured before an
 * asynchronous character save, so a switch during the write cannot retarget it.
 */
import { announce, announceError, button, el } from './dom.js';
import { PRESETS, parsePronounSet, previewSentence } from './pronoun-impl.js';
import {
    SUBJECTS,
    clearOverride,
    getOverrideSpec,
    getStoredSpec,
    saveCharacterSpec,
    savePersonaSpec,
} from './pronoun-macros.js';

/** Marks writes made here, so the pronoun change listener does not fight the input. */
export const DRAWER_PRONOUN_SOURCE = 'setup';

function personaName(ctx) {
    return ctx.powerUserSettings?.personas?.[ctx.userAvatar] || '';
}

/** The stricter persona check shared with the Persona page. */
export function personaAvailable(ctx = SillyTavern.getContext()) {
    return Boolean(ctx.userAvatar && ctx.powerUserSettings?.personas?.[ctx.userAvatar]);
}

/**
 * The stable target of one pronoun editor. The key is used to keep a draft
 * attached to the persona or character it was typed for.
 *
 * @param {{key: string}} subject
 * @param {object} [ctx]
 * @returns {{key: string, label: string, unavailable: string, avatarId?: string, characterAvatar?: string}}
 */
export function pronounTarget(subject, ctx = SillyTavern.getContext()) {
    if (subject.key === 'user') {
        if (!personaAvailable(ctx)) {
            return {
                key: '',
                label: '',
                unavailable: 'Select a named persona in Persona Management to give it pronouns.',
            };
        }
        return {
            key: `user:${ctx.userAvatar}`,
            label: personaName(ctx) || 'your persona',
            unavailable: '',
            avatarId: ctx.userAvatar,
        };
    }
    if (ctx.groupId) {
        return {
            key: '',
            label: '',
            unavailable: 'Group chats have several characters, so characters use they/them here.',
        };
    }
    const character = ctx.characters?.[ctx.characterId];
    if (!character?.avatar) {
        return {
            key: '',
            label: '',
            unavailable: 'Open a single-character chat to give that character pronouns.',
        };
    }
    return {
        key: `char:${character.avatar}`,
        label: character.name || 'this character',
        unavailable: '',
        characterAvatar: character.avatar,
    };
}

/** Split a target key into its kind and id. */
export function splitPronounTargetKey(key) {
    const text = String(key ?? '');
    const separator = text.indexOf(':');
    if (separator < 0) {
        return { kind: '', id: '' };
    }
    return { kind: text.slice(0, separator), id: text.slice(separator + 1) };
}

export function pronounTargetExists(key, ctx = SillyTavern.getContext()) {
    const { kind, id } = splitPronounTargetKey(key);
    if (kind === 'user') {
        return Boolean(id && ctx.powerUserSettings?.personas?.[id]);
    }
    if (kind === 'char') {
        return Boolean(ctx.characters?.some(character => character.avatar === id));
    }
    return false;
}

function applyPresetState(chips, spec) {
    for (const [key, chip] of chips) {
        chip.setAttribute('aria-pressed', String(key.toLowerCase() === String(spec ?? '').trim().toLowerCase()));
    }
}

/**
 * @param {HTMLElement} container
 * @returns {{refresh: () => void}}
 */
export function renderPronounSettings(container) {
    container.replaceChildren();
    const subjects = [];

    for (const subject of Object.values(SUBJECTS)) {
        const section = el('section', 'me-pronoun-subject-section');
        section.dataset.meSubject = subject.key;
        const heading = el('h4', 'me-subject-title');
        heading.tabIndex = -1;
        section.appendChild(heading);
        const unavailable = el('p', 'me-section-note');
        unavailable.hidden = true;
        section.appendChild(unavailable);

        const controls = el('div', 'me-pronoun-controls');
        section.appendChild(controls);

        const stored = () => getStoredSpec(subject);
        const initialTarget = pronounTarget(subject);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole me-pronoun-input';
        input.placeholder = 'they/them';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = stored();
        input.id = `me-pronoun-input-${subject.key}`;
        input.dataset.targetKey = initialTarget.key;
        input.dataset.targetLabel = initialTarget.label;
        input.setAttribute('aria-label', `Pronouns for ${subject.key === 'user' ? 'your persona' : 'this character'}`);

        const preview = el('p', 'me-pronoun-preview');
        const problem = el('p', 'me-warning me-pronoun-problem');
        problem.hidden = true;

        const entry = {
            subject,
            section,
            heading,
            unavailable,
            controls,
            input,
            preview,
            problem,
            saveButton: null,
            draftNotice: null,
            draftText: null,
            saveOldButton: null,
            refreshPreview: null,
            overrideNotice: null,
            overrideText: null,
        };

        const chips = new Map();
        const presetRow = el('div', 'me-chip-row me-pronoun-presets');
        presetRow.setAttribute('role', 'group');
        presetRow.setAttribute('aria-label', 'Pronoun presets');
        for (const key of Object.keys(PRESETS)) {
            const chip = button('me-chip', key, () => {
                input.value = key;
                input.dataset.dirty = 'true';
                refreshPreview();
            });
            chip.setAttribute('aria-pressed', 'false');
            chips.set(key, chip);
            presetRow.appendChild(chip);
        }
        controls.appendChild(presetRow);

        const inputLabel = el('label', 'me-field-label', 'Or write a set');
        inputLabel.htmlFor = input.id;
        controls.appendChild(inputLabel);

        const row = el('div', 'me-pronoun-row');
        row.appendChild(input);
        const saveButton = button('menu_button menu_button_primary', 'Save', async () => {
            const spec = input.value.trim();
            if (spec && !parsePronounSet(spec)) {
                refreshPreview();
                return;
            }
            const target = pronounTarget(subject);
            if (!target.key) {
                problem.hidden = false;
                problem.textContent = target.unavailable;
                return;
            }
            if (input.dataset.targetKey !== target.key) {
                // The visible target changed while this draft was waiting. Do
                // not write it to the new target.
                showDraftNotice(entry, target);
                announceError(`This pronoun draft belongs to ${input.dataset.targetLabel || 'the previous target'}, not ${target.label}.`);
                return;
            }
            // Capture the exact target before any await. A persona or chat
            // switch during the write must not retarget it.
            try {
                await saveForTarget(subject, spec, target.key);
                input.dataset.lastStored = spec;
                input.dataset.dirty = 'false';
                announce(`Saved pronouns for ${target.label}.`);
                refresh();
            } catch (error) {
                problem.hidden = false;
                problem.textContent = `Saving failed: ${error?.message ?? error}`;
                announceError(problem.textContent);
            }
        });
        row.appendChild(saveButton);
        controls.appendChild(row);
        entry.saveButton = saveButton;

        function refreshPreview() {
            const set = parsePronounSet(input.value);
            applyPresetState(chips, input.value);
            if (!set) {
                problem.hidden = false;
                problem.textContent = `"${input.value.trim()}" is not a pronoun set. Use one of the presets, or write all five forms: she/her/her/hers/herself.`;
                preview.textContent = '';
                return;
            }
            problem.hidden = true;
            preview.textContent = previewSentence(set);
        }

        input.addEventListener('input', () => {
            input.dataset.dirty = 'true';
            refreshPreview();
        });
        controls.appendChild(problem);
        controls.appendChild(preview);
        entry.refreshPreview = refreshPreview;

        const draftNotice = el('div', 'me-warning me-pronoun-draft');
        draftNotice.hidden = true;
        const draftText = el('span', 'me-pronoun-draft-text');
        const draftActions = el('div', 'me-actions');
        const saveOldButton = button('menu_button', 'Save old draft', async () => {
            const oldKey = input.dataset.targetKey;
            const oldLabel = input.dataset.targetLabel || 'the previous target';
            const spec = input.value.trim();
            if (spec && !parsePronounSet(spec)) {
                refreshPreview();
                return;
            }
            if (!pronounTargetExists(oldKey)) {
                problem.hidden = false;
                problem.textContent = `${oldLabel} is no longer available. Discard this draft to edit ${pronounTarget(subject).label}.`;
                return;
            }
            try {
                await saveForTarget(subject, spec, oldKey);
                input.dataset.dirty = 'false';
                announce(`Saved pronouns for ${oldLabel}.`);
                refresh();
            } catch (error) {
                problem.hidden = false;
                problem.textContent = `Saving failed: ${error?.message ?? error}`;
                announceError(problem.textContent);
            }
        });
        const discardDraftButton = button('menu_button', 'Discard draft', () => {
            input.dataset.dirty = 'false';
            const target = pronounTarget(subject);
            setTarget(entry, target);
            hideDraftNotice(entry);
            refresh();
            announce('Pronoun draft discarded.');
        });
        draftActions.append(saveOldButton, discardDraftButton);
        draftNotice.append(draftText, draftActions);
        section.appendChild(draftNotice);
        entry.draftNotice = draftNotice;
        entry.draftText = draftText;
        entry.saveOldButton = saveOldButton;

        const overrideNotice = el('div', 'me-warning me-override');
        overrideNotice.hidden = true;
        const overrideText = el('span', 'me-override-text');
        const clearButton = button('menu_button', 'Use the saved setting', () => {
            clearOverride(subject, { source: DRAWER_PRONOUN_SOURCE });
            announce('Cleared the chat pronoun override.');
            refresh();
            heading.focus({ preventScroll: true });
        });
        overrideNotice.append(overrideText, clearButton);
        section.appendChild(overrideNotice);
        entry.overrideNotice = overrideNotice;
        entry.overrideText = overrideText;

        if (subject.key === 'user') {
            section.appendChild(el('p', 'me-section-note', 'Also on the Persona page, under the description. Changing either changes both.'));
        }

        container.appendChild(section);
        subjects.push(entry);
    }

    function setTarget(entry, target) {
        entry.input.dataset.targetKey = target.key;
        entry.input.dataset.targetLabel = target.label;
    }

    function hideDraftNotice(entry) {
        entry.draftNotice.hidden = true;
        entry.saveButton.disabled = false;
        entry.saveButton.removeAttribute('title');
    }

    function showDraftNotice(entry, current) {
        const oldKey = entry.input.dataset.targetKey;
        const oldLabel = entry.input.dataset.targetLabel || 'the previous target';
        const canSaveOld = pronounTargetExists(oldKey);
        entry.draftText.textContent = canSaveOld
            ? `Unsaved pronouns for ${oldLabel} are still here. Save them there, or discard this draft to edit ${current.label}.`
            : `Unsaved pronouns for ${oldLabel} are still here. That target is no longer available; discard this draft to edit ${current.label}.`;
        entry.saveOldButton.hidden = !canSaveOld;
        entry.saveOldButton.setAttribute('aria-label', `Save pronouns for ${oldLabel}`);
        entry.draftNotice.hidden = false;
        entry.saveButton.disabled = true;
        entry.saveButton.title = `This draft belongs to ${oldLabel}. Switch back to save it there.`;
    }

    async function saveForTarget(subject, spec, key) {
        const { kind, id } = splitPronounTargetKey(key);
        if (kind === 'user') {
            savePersonaSpec(spec, { source: DRAWER_PRONOUN_SOURCE, avatarId: id });
            return;
        }
        if (kind === 'char') {
            // The character list can be reloaded or reordered. Resolve the
            // stable avatar to its current position immediately before the
            // asynchronous write.
            const current = SillyTavern.getContext();
            const characterId = current.characters?.findIndex(character => character.avatar === id) ?? -1;
            if (characterId < 0) {
                throw new Error('That character is no longer available.');
            }
            await saveCharacterSpec(spec, { source: DRAWER_PRONOUN_SOURCE, characterId });
            return;
        }
        throw new Error('That pronoun target is no longer available.');
    }

    function refresh() {
        const ctx = SillyTavern.getContext();
        for (const entry of subjects) {
            const target = pronounTarget(entry.subject, ctx);
            const base = entry.subject.key === 'user' ? 'Your persona' : 'This character';
            const dirty = entry.input.dataset.dirty === 'true';
            entry.heading.textContent = target.unavailable ? base : `${base} · ${target.label}`;
            entry.unavailable.hidden = !target.unavailable;
            entry.unavailable.textContent = target.unavailable
                ? `${target.unavailable}${dirty ? ' Your unsaved draft is kept.' : ''}`
                : '';
            entry.controls.hidden = !!target.unavailable;
            if (target.unavailable) {
                hideDraftNotice(entry);
                continue;
            }

            const draftKey = entry.input.dataset.targetKey;
            let targetChanged = false;
            if (draftKey && draftKey !== target.key) {
                if (dirty) {
                    showDraftNotice(entry, target);
                    entry.refreshPreview();
                    const override = getOverrideSpec(entry.subject);
                    entry.overrideNotice.hidden = !override;
                    if (override) {
                        const macro = entry.subject.key === 'user' ? 'setpronouns' : 'setcharpronouns';
                        entry.overrideText.textContent = `This chat is overriding the setting with ${override}, set by {{${macro}}}. `;
                    }
                    continue;
                }
                setTarget(entry, target);
                targetChanged = true;
            } else if (!draftKey) {
                setTarget(entry, target);
                targetChanged = true;
            }

            hideDraftNotice(entry);
            if (targetChanged || document.activeElement !== entry.input) {
                const stored = getStoredSpec(entry.subject);
                if (targetChanged || !dirty || entry.input.value.trim() === stored) {
                    entry.input.value = stored;
                    entry.input.dataset.dirty = 'false';
                }
                if (targetChanged || !dirty || entry.input.value.trim() === stored) {
                    entry.input.dataset.lastStored = stored;
                }
                entry.refreshPreview();
            }
            const override = getOverrideSpec(entry.subject);
            entry.overrideNotice.hidden = !override;
            if (override) {
                const macro = entry.subject.key === 'user' ? 'setpronouns' : 'setcharpronouns';
                entry.overrideText.textContent = `This chat is overriding the setting with ${override}, set by {{${macro}}}. `;
            }
        }
    }

    refresh();
    return { refresh };
}
