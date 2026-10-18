/**
 * My macros: the custom macro list, editor, template packs and pack sharing.
 * The editor replaces the list in place, and its draft lives in uiState so a
 * data refresh cannot wipe it.
 */
import { announce as defaultAnnounce, announceError, button, el } from '../dom.js';
import { createEditorDraft, renderMacroEditor } from '../custom/editor-ui.js';
import { renderTemplateGallery } from '../custom/gallery-ui.js';
import { syncRegistrations } from '../custom/registrar.js';
import {
    SCOPE_BROWSER,
    SCOPE_CHARACTER,
    SCOPE_CHAT,
    SCOPE_GLOBAL,
    getBrowserStoreProblem,
    getDefsForScope,
    saveDefsForScope,
} from '../custom/store.js';
import { SCOPE_COPY, snapshotContext, validateScopeForSave } from '../custom/scopes.js';
import { renderMacroText } from './macro-text.js';
import { uiState } from './ui-state.js';

function scopeName(scope) {
    return SCOPE_COPY[scope]?.title ?? 'that scope';
}

async function persistScope(scope, defs) {
    await saveDefsForScope(scope, defs);
    syncRegistrations();
}

function signatureFor(def) {
    const args = (def.args ?? [])
        .filter(arg => String(arg.name ?? '').trim())
        .map(arg => (arg.optional ? `::[${arg.name.trim()}]` : `::${arg.name.trim()}`))
        .join('');
    return `{{${def.name}${args}}}`;
}

/** The call to try, with required arguments left as visible placeholders. */
export function tryCallFor(def) {
    const required = (def.args ?? []).filter(arg => !arg.optional && String(arg.name ?? '').trim());
    return `{{${def.name}${required.map(arg => `::${arg.name.trim()}`).join('')}}}`;
}

/**
 * @param {object} hooks
 * @param {(text: string) => void} hooks.onTry
 * @param {(text: string) => void} [hooks.announce]
 */
export function createMyMacrosPanel({ onTry, announce = defaultAnnounce } = {}) {
    const element = el('div', 'me-macros');

    const head = el('div', 'me-macros-head');
    const actions = el('div', 'me-actions');
    const newButton = button('menu_button menu_button_primary', 'New macro', () => openNew());
    const importButton = button('menu_button', 'Import a pack', () => gallery?.openImport());
    actions.append(newButton, importButton);
    head.appendChild(actions);
    element.appendChild(head);

    const listHost = el('div', 'me-macro-list');
    element.appendChild(listHost);

    const editorHost = el('div', 'me-macro-editor-host');
    editorHost.hidden = true;
    element.appendChild(editorHost);

    const templatesSection = el('section', 'me-section me-templates');
    const templatesHead = el('div', 'me-section-head');
    templatesHead.appendChild(el('h3', 'me-section-title', 'Add from a template'));
    templatesHead.appendChild(el('p', 'me-section-note', 'Starter packs become ordinary macros you can edit. Name collisions get a -2 suffix.'));
    templatesSection.appendChild(templatesHead);
    const galleryHost = el('div', 'me-gallery');
    templatesSection.appendChild(galleryHost);
    element.appendChild(templatesSection);

    const gallery = renderTemplateGallery(galleryHost, {
        announce,
        onInstalled: () => {
            renderList();
            gallery.refresh();
        },
    });

    let editorController = null;
    let lastFocusedEditId = null;

    function focusEdit(id) {
        requestAnimationFrame(() => {
            const target = listHost.querySelector(`[data-me-def-id="${CSS.escape(id)}"] [data-me-action="edit"]`);
            if (target instanceof HTMLElement) {
                target.focus({ preventScroll: true });
            } else {
                newButton.focus({ preventScroll: true });
            }
        });
    }

    function focusAfterDelete(preferredId) {
        requestAnimationFrame(() => {
            const target = preferredId
                ? listHost.querySelector(`[data-me-def-id="${CSS.escape(preferredId)}"] [data-me-action="edit"]`)
                : null;
            const first = listHost.querySelector('[data-me-action="edit"]');
            (target ?? first ?? newButton).focus({ preventScroll: true });
        });
    }

    function focusSwitch(id) {
        requestAnimationFrame(() => {
            const target = listHost.querySelector(`[data-me-def-id="${CSS.escape(id)}"] input[type="checkbox"]`);
            target?.focus?.({ preventScroll: true });
        });
    }

    function findCurrentDef(def, scope) {
        try {
            return getDefsForScope(scope).find(candidate => candidate.id === def.id) ?? null;
        } catch {
            return null;
        }
    }

    function renderCard(def, scope) {
        const card = el('article', 'me-macro-card');
        card.dataset.meDefId = def.id;
        const cardHead = el('div', 'me-card-head');
        cardHead.appendChild(renderMacroText(signatureFor(def), { tag: 'code', className: 'me-mt me-macro-signature' }));
        cardHead.appendChild(el('span', 'me-pill', scopeName(scope)));
        card.appendChild(cardHead);
        if (def.description) {
            card.appendChild(el('p', 'me-card-description', def.description));
        }

        const footer = el('div', 'me-macro-footer');
        const useRow = el('label', 'me-switch-row');
        useRow.appendChild(el('span', 'me-switch-label', `Use {{${def.name}}}`));
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = def.enabled !== false;
        enabled.setAttribute('aria-label', `Use {{${def.name}}}`);
        enabled.addEventListener('change', async () => {
            // Read the list once: the browser scope parses a new array on every
            // read, so a mutation on a separately read copy would not be saved.
            let defs;
            try {
                defs = getDefsForScope(scope);
            } catch (error) {
                enabled.checked = def.enabled !== false;
                announceError(`Could not read this scope to change {{${def.name}}}: ${error?.message ?? error}`);
                return;
            }
            const current = defs.find(candidate => candidate.id === def.id);
            if (!current) {
                enabled.checked = def.enabled !== false;
                announceError('That macro belongs to another character, chat or account. Open it again to change it.');
                return;
            }
            const previous = current.enabled;
            current.enabled = enabled.checked;
            try {
                await persistScope(scope, defs);
                announce(`${enabled.checked ? 'Turned on' : 'Turned off'} {{${def.name}}}.`);
                focusSwitch(def.id);
            } catch (error) {
                current.enabled = previous;
                enabled.checked = previous !== false;
                announceError(`Could not save the switch for {{${def.name}}}: ${error?.message ?? error}`);
            }
        });
        useRow.appendChild(enabled);
        footer.appendChild(useRow);

        const cardActions = el('div', 'me-actions');
        const edit = button('menu_button', 'Edit', () => openEditor(def, scope));
        edit.dataset.meAction = 'edit';
        const remove = button('menu_button', 'Delete', () => {
            void deleteMacro(def, scope);
        });
        remove.dataset.meAction = 'delete';
        cardActions.append(edit, remove);
        footer.appendChild(cardActions);
        card.appendChild(footer);
        return card;
    }

    async function deleteMacro(def, scope) {
        // Capture the open target before the popup. The account, chat or card can
        // change while it is up, and the confirmed click must not follow it.
        const snapshot = snapshotContext();
        const cards = [...listHost.querySelectorAll('[data-me-def-id]')];
        const index = cards.findIndex(card => card.dataset.meDefId === def.id);
        const nextId = cards[index + 1]?.dataset.meDefId ?? cards[index - 1]?.dataset.meDefId ?? null;
        const ctx = SillyTavern.getContext();
        const confirmFn = ctx.Popup?.show?.confirm;
        const confirmed = confirmFn
            ? !!(await confirmFn('Delete custom macro', `Delete {{${def.name}}}?`))
            : globalThis.confirm(`Delete {{${def.name}}}?`);
        if (!confirmed) {
            return;
        }
        const problem = validateScopeForSave({ scope, persistedScope: scope, snapshot });
        if (problem) {
            announceError(problem);
            return;
        }
        if (!findCurrentDef(def, scope)) {
            announceError('That macro belongs to another character, chat or account. Open it again to delete it.');
            return;
        }
        try {
            await persistScope(scope, getDefsForScope(scope).filter(other => other.id !== def.id));
            announce(`Deleted {{${def.name}}}.`);
            renderList();
            gallery.refresh();
            focusAfterDelete(nextId);
        } catch (error) {
            announceError(`Deleting {{${def.name}}} failed: ${error?.message ?? error}`);
        }
    }

    function renderList() {
        listHost.replaceChildren();
        let browserDefs = [];
        let browserProblem = getBrowserStoreProblem();
        try {
            browserDefs = getDefsForScope(SCOPE_BROWSER);
        } catch (error) {
            browserProblem = browserProblem || error?.message || String(error);
        }
        if (browserProblem) {
            listHost.appendChild(el('p', 'me-form-problem', browserProblem));
        }
        const groups = [
            [SCOPE_GLOBAL, getDefsForScope(SCOPE_GLOBAL)],
            [SCOPE_BROWSER, browserDefs],
            [SCOPE_CHARACTER, getDefsForScope(SCOPE_CHARACTER)],
            [SCOPE_CHAT, getDefsForScope(SCOPE_CHAT)],
        ];
        let any = false;
        for (const [scope, defs] of groups) {
            for (const def of defs) {
                any = true;
                listHost.appendChild(renderCard(def, scope));
            }
        }
        if (!any) {
            const empty = el('div', 'me-empty-state');
            empty.appendChild(el('p', 'me-empty-title', 'No macros of your own yet.'));
            empty.appendChild(el('p', 'me-section-note', 'A custom macro is a name plus a template. The Playground can try it without saving anything.'));
            const emptyActions = el('div', 'me-actions');
            emptyActions.appendChild(button('menu_button menu_button_primary', 'New macro', () => openNew()));
            emptyActions.appendChild(button('menu_button', 'Add from a template', () => {
                templatesSection.scrollIntoView({ block: 'nearest' });
                templatesSection.querySelector('.me-gallery-pack-header')?.focus();
            }));
            empty.appendChild(emptyActions);
            listHost.appendChild(empty);
        }
    }

    function closeEditor({ saved = false, focus = true } = {}) {
        const focusId = uiState.editorDraft?.def?.id ?? lastFocusedEditId;
        editorController?.destroy?.();
        uiState.editorDraft = null;
        editorController = null;
        editorHost.replaceChildren();
        editorHost.hidden = true;
        listHost.hidden = false;
        templatesSection.hidden = false;
        head.hidden = false;
        renderList();
        gallery.refresh();
        if (!focus) {
            return;
        }
        if (focusId) {
            focusEdit(focusId);
        } else {
            newButton.focus({ preventScroll: true });
        }
        if (!saved) {
            announce('Draft discarded.');
        }
    }

    function showEditor() {
        listHost.hidden = true;
        templatesSection.hidden = true;
        head.hidden = true;
        editorHost.hidden = false;
        editorController = renderMacroEditor(editorHost, uiState.editorDraft, {
            onClose: info => closeEditor(info),
            onSaved: (def, scope, { tryAfter }) => {
                lastFocusedEditId = def.id;
                closeEditor({ saved: true, focus: !tryAfter });
                if (tryAfter) {
                    onTry?.(tryCallFor(def));
                }
            },
        });
    }

    function openNew() {
        lastFocusedEditId = null;
        uiState.editorDraft = createEditorDraft();
        showEditor();
    }

    function openEditor(def, scope) {
        lastFocusedEditId = def.id;
        uiState.editorDraft = createEditorDraft({ existingDef: def, existingScope: scope });
        showEditor();
    }

    function refresh(kind) {
        if (uiState.editorDraft) {
            editorController?.refreshAvailability?.();
            return;
        }
        if (kind === 'macros' || kind === 'chat' || kind === 'all') {
            renderList();
            gallery.refresh();
        }
    }

    renderList();
    if (uiState.editorDraft) {
        lastFocusedEditId = uiState.editorDraft.def.id;
        showEditor();
    }

    return {
        element,
        refresh,
        openNew,
        handleChatChanged() {
            if (uiState.editorDraft) {
                editorController?.refreshAvailability?.();
            } else {
                renderList();
                gallery.refresh();
            }
        },
        destroy() {
            editorController?.destroy?.();
        },
    };
}
