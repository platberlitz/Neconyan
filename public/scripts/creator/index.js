import { characters, getOneCharacter } from '../../script.js';
import { CreatorSession } from './session.js';
import { element, button, textField } from './fields.js';
import { editCreatorDraft, setCreatorField, undoCreatorDraft, renderCreatorFacts, creatorProposal, acceptCreatorProposal, acceptCreatorGreeting, FACT_SECTIONS, STYLES, creatorTextEditKey } from './model.js';
import { DOSSIER_FIELDS } from './dossier.js';
import { startCreatorConversion, reviseCreatorConversion, creatorStepMessages, mergeCreatorStep } from './conversion.js';
import { renderCreatorQuestionsOption, creatorQuestionMessages, mergeCreatorQuestions, generateCreatorProposal } from './questions.js';
import { compareCreatorChanges } from './conflicts.js';
import { restoreCreatorBackup } from './backup.js';
import { creatorPublicationCard, adoptCreatorComparedCard } from './embedded-book.js';
import { rememberCreatorViewport } from './viewport.js';
import { attachCreatorGenerator } from './field-generator.js';
import { renderCreatorFormat } from './format-picker.js';
import { creatorTargetsSignature } from './formats.js';
import { renderCreatorLiveReply } from './live-reply.js';

const sections = [['dossier', 'Dossier'], ['notebooks', 'Notebook sources'], ['identity', 'Identity'], ['facts', 'Guided facts'], ['greetings', 'Greetings & examples'], ['interview', 'Interview'], ['prompts', 'Prompts'], ['lore', 'Lorebooks'], ['macros', 'Macros & pronouns'], ['regex', 'Pretty HTML'], ['game', 'Gamify'], ['portrait', 'Portrait'], ['helper', 'Writing partner'], ['agents', 'Post-process with agents'], ['instructions', 'Writing instructions'], ['metadata', 'Details'], ['preview', 'Preview & export']];
const labels = { name: 'Display name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First greeting', mes_example: 'Interviewer examples', creator_notes: 'Public creator notes', system_prompt: 'Main prompt', post_history_instructions: 'Post-history instructions', creator: 'Creator', character_version: 'Card version' };
let app;

export async function mountCreator(host, { avatar = null, draftId = null } = {}) {
    if (!host) return;
    if (app?.host === host) app.session.assertOwner();
    else {
        app = new CreatorWorkspace(host);
        if (!avatar && !draftId) {
            try { await app.home(); } catch (error) { app = null; throw error; }
        } else app.shell();
    }
    if (avatar || draftId) await app.run(async () => {
        if (app.session.pending || app.session.publishing) throw new Error('Finish the previous save before opening another character.');
        clearTimeout(app.timer);
        if (app.session.draft) await app.session.save();
        if (draftId) await app.session.open(draftId);
        else await app.session.create(avatar);
        app.render();
    });
}

class CreatorWorkspace {
    constructor(host) {
        this.host = host;
        this.session = new CreatorSession();
        this.message = '';
        this.timer = null;
        this.busy = false;
    }

    async run(action) {
        if (this.busy) return;
        this.busy = true;
        this.host.setAttribute('aria-busy', 'true');
        this.activeAction = (async () => {
            try { await action(); } catch (error) { this.status(error.message, true); } finally { this.busy = false; this.host.removeAttribute('aria-busy'); }
        })();
        return this.activeAction;
    }

    status(message, error = false) {
        this.statusRevision = (this.statusRevision ?? 0) + 1;
        this.message = message;
        this.messageError = error;
        const output = this.host.querySelector('.creator-status');
        if (output) {
            output.replaceChildren(element('span', '', message));
            if (message) {
                const actions = element('div', 'creator-actions');
                actions.append(button('Dismiss', () => this.status(''), false, 'creator-chip-btn'));
                output.append(actions);
            }
            output.dataset.error = String(error);
            output.hidden = !message;
        }
    }

    syncRequestControls() {
        for (const control of this.host.querySelectorAll('[data-creator-cancel-request]')) control.hidden = !this.requestController;
    }

    shell() {
        // The page introduction and Nori's tour invitation belong to the shell, so redraws keep them.
        const intro = this.host.querySelector(':scope > .neconyan-native-page-heading');
        this.host.replaceChildren(...(intro ? [intro] : []));
        const output = element('div', 'creator-status');
        output.setAttribute('role', 'status');
        output.hidden = !this.message;
        this.host.append(output);
        this.status(this.message, this.messageError);
    }

    async home() {
        clearTimeout(this.timer);
        if (this.session.draft) {
            try { await this.session.save(); } catch (error) {
                this.status(`${error.message} Your local draft remains available under Recover.`, true);
            }
        }
        this.shell();
        const hub = element('div', 'creator-hub');
        const welcome = element('div', 'creator-welcome');
        const welcomeCopy = element('div', 'creator-welcome-copy');
        welcomeCopy.append(
            element('p', 'creator-eyebrow', 'Private character studio'),
            element('h2', '', 'A character starts here.'),
            element('p', 'creator-muted', 'Keep a private draft, explore their voice, and review everything before it reaches your library.'),
        );
        const welcomeActions = element('div', 'creator-actions creator-welcome-actions');
        welcomeActions.append(button('Create a character', () => this.run(async () => { await this.session.create(); this.render(); }), true));
        const restore = element('label', 'menu_button creator-file-btn');
        restore.append(element('span', '', 'Restore a private draft backup'));
        const upload = element('input');
        upload.type = 'file'; upload.accept = '.json,application/json';
        upload.addEventListener('change', () => this.run(async () => {
            const file = upload.files[0];
            if (!file) return;
            if (file.size > 24 * 1024 * 1024) throw new Error('Choose a backup smaller than 24 MiB.');
            const draft = restoreCreatorBackup(JSON.parse(await file.text()));
            await this.session.queue;
            if (this.session.draft) await this.session.save();
            this.session.draft = draft; this.session.revision = null; this.session.pending = null;
            await this.session.save(); this.render();
            this.status('Backup restored as a new draft. External books will be new copies; rename them in Lorebooks if those names already exist.');
        }));
        restore.append(upload);
        welcomeActions.append(restore);
        const recovery = this.session.draft ? { draft: this.session.draft, revision: this.session.revision, pending: this.session.pending } : this.session.recovery();
        if (recovery) {
            welcomeActions.append(button(`Recover ${recovery.draft.card.data.name || 'untitled draft'}`, () => {
                this.session.restore(recovery); this.render(); this.status(recovery.pending ? 'A previous save needs recovery. Resume it from Review & save.' : 'Local draft recovered.');
            }));
        }
        const previousRecovery = this.session.recovery(true);
        if (previousRecovery) welcomeActions.append(button('Recover previous local version', () => {
            this.session.restore(previousRecovery); this.render();
            this.status('Previous local version restored. Export a private backup before replacing a newer saved draft.');
        }), button('Clear previous local recovery', event => {
            if (event.currentTarget.dataset.confirm !== 'true') {
                event.currentTarget.dataset.confirm = 'true';
                event.currentTarget.textContent = 'Confirm clear previous local recovery';
                return;
            }
            localStorage.removeItem(`${this.session.recoveryKey}:previous`);
            void this.run(() => this.home());
        }, false, 'creator-chip-btn'));
        welcome.append(welcomeCopy, welcomeActions);
        hub.append(welcome);

        const columns = element('div', 'creator-hub-columns');
        const { drafts } = await this.session.request('list');
        const saved = element('section', 'creator-library creator-card');
        const savedHeader = element('div', 'creator-section-header');
        savedHeader.append(
            element('h3', '', 'Your drafts'),
            element('span', 'creator-badge', `${drafts.length} / 40`),
        );
        saved.append(savedHeader);
        if (!drafts.length) {
            saved.append(element('p', 'creator-muted', 'Your drafts will appear here, including work saved on another device.'));
        } else {
            const draftList = element('div', 'creator-draft-list');
            const ordered = [...drafts].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
            for (const draft of ordered) {
                const row = element('div', 'creator-draft-row');
                const mainRow = element('div', 'creator-draft-row-main');
                const open = button(draft.name || 'Untitled character', () => this.run(async () => { await this.session.open(draft.id); this.render(); }), false, 'creator-draft-open');
                open.title = `${draft.name || 'Untitled character'} (${draft.avatar ? 'Linked to library card' : 'New character draft'})`;
                const meta = element('span', 'creator-draft-meta', draft.avatar ? 'Linked card' : 'New draft');
                const askDiscard = button('Discard', () => {
                    confirmBar.hidden = false;
                    askDiscard.hidden = true;
                }, false, 'creator-chip-btn creator-danger-outline');
                askDiscard.setAttribute('aria-label', `Discard ${draft.name || 'Untitled character'}`);
                mainRow.append(open, meta, askDiscard);
                const confirmBar = element('div', 'creator-confirm-bar');
                confirmBar.hidden = true;
                confirmBar.append(
                    element('span', 'creator-confirm-text', draft.avatar ? 'Discard this draft? Published character stays in your library.' : 'Discard this private draft permanently?'),
                    button('Confirm discard', () => this.run(async () => {
                        if (recovery?.pending && recovery.draft?.id === draft.id) {
                            throw new Error('This draft has an unfinished library save. Recover it before discarding.');
                        }
                        await this.session.request('delete', { id: draft.id, expectedRevision: draft.revision });
                        if (this.session.draft?.id === draft.id) {
                            this.session.draft = null;
                            this.session.revision = null;
                            this.session.pending = null;
                        }
                        if (recovery?.draft?.id === draft.id && !recovery.pending) {
                            try { localStorage.removeItem(this.session.recoveryKey); } catch { /* ignore */ }
                        }
                        await this.home();
                        this.status('Draft discarded. Published library items were not changed.');
                    }), false, 'creator-chip-btn creator-danger-btn'),
                    button('Keep draft', () => {
                        confirmBar.hidden = true;
                        askDiscard.hidden = false;
                    }, false, 'creator-chip-btn'),
                );
                row.append(mainRow, confirmBar);
                draftList.append(row);
            }
            saved.append(draftList);
        }
        columns.append(saved);

        const library = element('section', 'creator-library creator-card');
        const libHeader = element('div', 'creator-section-header');
        libHeader.append(
            element('h3', '', 'Edit an existing character'),
            element('span', 'creator-badge', `${characters.length}`),
        );
        library.append(libHeader);
        const list = element('div', 'creator-library-grid');
        const search = textField('Find a character', '', value => {
            for (const item of list.children) item.hidden = !item.textContent.toLocaleLowerCase().includes(value.toLocaleLowerCase());
        }, { rows: 1, placeholder: 'Type a name to filter...' });
        for (const card of characters) {
            const open = button(card.name || card.avatar, () => this.run(async () => { await this.session.create(card.avatar); this.render(); }), false, 'creator-library-item');
            list.append(open);
        }
        library.append(search, list);
        columns.append(library);
        hub.append(columns);
        this.host.append(hub);
    }

    change(operation, redraw = false) {
        if (this.session.pending || this.session.publishing) { this.status('Finish the previous save before changing this draft.', true); return false; }
        try {
            this.session.draft = operation(this.session.draft);
            clearTimeout(this.recoveryTimer);
            if (creatorTextEditKey()) this.recoveryTimer = setTimeout(() => {
                try { this.session.remember(); } catch (error) { this.status(error.message, true); }
            }, 150);
            else this.session.remember();
            const heading = this.host.querySelector('.creator-draft-header h2');
            if (heading) heading.textContent = this.session.draft.card.data.name || 'Untitled character';
            const undo = this.host.querySelector('[data-creator-undo]');
            const redo = this.host.querySelector('[data-creator-redo]');
            if (undo) undo.disabled = !this.session.draft.history.length;
            if (redo) redo.disabled = !this.session.draft.future.length;
            clearTimeout(this.timer);
            this.status(creatorTextEditKey() ? 'Saving draft changes…' : this.session.localRecoveryError ? 'Device recovery storage is full. Saving to your account…' : 'Draft changes saved on this device.', this.session.localRecoveryError);
            const statusRevision = this.statusRevision;
            this.timer = setTimeout(() => {
                void Promise.resolve().then(() => this.session.save()).then(() => {
                    if (this.statusRevision === statusRevision) this.status(this.session.localRecoveryError ? 'Draft saved to your account. Device recovery storage is full.' : 'Draft saved. Your library has not changed.', this.session.localRecoveryError);
                }).catch(error => { if (this.statusRevision === statusRevision) this.status(error.message, true); });
            }, 500);
            if (redraw) this.render();
            return true;
        } catch (error) { this.status(error.message, true); return false; }
    }

    edit(operation, redraw = false, options) { return this.change(draft => editCreatorDraft(draft, operation, options), redraw); }

    field(field) {
        const draft = this.session.draft;
        const node = textField(labels[field] || field, draft.card.data[field], value => this.change(current => setCreatorField(current, field, value)), { name: field === 'name', rows: field === 'creator' || field === 'character_version' ? 1 : 4, hint: field === 'mes_example' ? 'Use Interviewer: for questions and {{char}}: for the character’s replies.' : '' });
        if (field !== 'name') {
            const locked = draft.locks.includes(field);
            const lock = button(locked ? 'Locked for AI' : 'Lock for AI', () => this.edit(next => {
                next.locks = locked ? next.locks.filter(item => item !== field) : [...next.locks, field];
            }, true), false, 'creator-chip-btn');
            lock.setAttribute('aria-pressed', String(locked));
            node.querySelector('.creator-field-heading').append(lock);
        }
        return attachCreatorGenerator(this, node, field);
    }

    render() {
        const draft = this.session.draft;
        const key = `${draft.id}:${draft.view.section}`;
        const railLeft = this.renderKey?.startsWith(`${draft.id}:`) ? this.host.querySelector('.creator-sections')?.scrollLeft ?? 0 : 0;
        const restore = this.renderKey === key ? rememberCreatorViewport(this.host) : () => {};
        this.renderKey = key;
        this.shell();
        const header = element('header', 'creator-draft-header');
        const heading = element('div', 'creator-draft-title');
        heading.append(element('p', 'creator-eyebrow', draft.source.avatar ? 'Editing a library character' : 'New character draft'), element('h2', '', draft.card.data.name || 'Untitled character'));
        const actions = element('div', 'creator-actions creator-header-actions');
        const undo = button('Undo', () => this.change(value => undoCreatorDraft(value), true), false, 'creator-chip-btn');
        const redo = button('Redo', () => this.change(value => undoCreatorDraft(value, true), true), false, 'creator-chip-btn');
        undo.dataset.creatorUndo = '';
        redo.dataset.creatorRedo = '';
        undo.disabled = !draft.history.length;
        redo.disabled = !draft.future.length;
        const review = button('Review & save', () => this.review(), true, 'creator-chip-btn');
        review.dataset.creatorReview = '';
        actions.append(button('Drafts', () => this.run(() => this.home()), false, 'creator-chip-btn'), undo, redo, review);
        const cancelRequest = button('Cancel active request', () => this.requestController?.abort(), false, 'creator-chip-btn');
        cancelRequest.dataset.creatorCancelRequest = '';
        cancelRequest.hidden = !this.requestController;
        actions.append(cancelRequest);
        header.append(heading, actions);
        const layout = element('div', 'creator-layout');
        const nav = element('nav', 'creator-sections');
        nav.setAttribute('aria-label', 'Catelier sections');
        for (const [id, label] of sections) {
            const tab = button(label, () => { this.session.draft.view.section = id; this.session.remember(); this.render(); }, false, 'creator-section-tab');
            tab.dataset.creatorSection = id;
            const isCurrent = draft.view.section === id;
            tab.setAttribute('aria-current', isCurrent ? 'page' : 'false');
            tab.setAttribute('tabindex', isCurrent ? '0' : '-1');
            nav.append(tab);
        }
        nav.addEventListener('keydown', event => {
            const target = event.target instanceof HTMLElement ? event.target.closest('.creator-section-tab') : null;
            if (!target) return;
            const tabs = [...nav.querySelectorAll('.creator-section-tab')];
            const index = tabs.indexOf(target);
            if (index < 0) return;
            let nextIndex = -1;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex < 0) return;
            event.preventDefault();
            const nextId = sections[nextIndex]?.[0];
            if (nextId) {
                this.session.draft.view.section = nextId;
                this.session.remember();
                this.render();
                this.host.querySelector('.creator-sections [aria-current="page"]')?.focus({ preventScroll: true });
                const rail = this.host.querySelector('.creator-sections');
                const selected = rail.querySelector('[aria-current="page"]');
                const bounds = rail.getBoundingClientRect();
                const tabBounds = selected.getBoundingClientRect();
                if (tabBounds.left < bounds.left) rail.scrollLeft += tabBounds.left - bounds.left;
                else if (tabBounds.right > bounds.right) rail.scrollLeft += tabBounds.right - bounds.right;
            }
        });
        const main = element('div', 'creator-content creator-card');
        const section = draft.view.section;
        if (section === 'identity') {
            renderCreatorFormat(this, main);
            main.append(element('div', 'creator-section-intro', 'Core character profile sent to the model in chat.'), this.field('name'), this.field('description'), this.field('personality'), this.field('scenario'));
        } else if (section === 'dossier') this.dossier(main);
        else if (section === 'facts') this.facts(main);
        else if (section === 'greetings') {
            main.append(element('div', 'creator-section-intro', 'Opening scenes and dialogue examples using Interviewer: for prompts.'), this.field('first_mes'), this.field('mes_example'));
            this.stringList(main, 'Alt greetings', 'alternate_greetings');
            this.stringList(main, 'Group greetings', 'group_only_greetings');
        } else if (section === 'prompts') {
            main.append(element('div', 'creator-section-intro', 'Optional system and depth instructions for this character.'), this.field('system_prompt'), this.field('post_history_instructions'));
            main.append(textField('Custom User Instructions', draft.writing?.userInstructions ?? '', value => this.edit(next => {
                next.writing ??= {}; next.writing.userInstructions = value;
            }), { hint: 'Your directions for Catelier’s writing, generation and interviews. Sent with those requests, kept in this draft, and not exported as a character prompt.' }));
            const depth = draft.card.data.extensions?.depth_prompt ?? { prompt: '', depth: 4, role: 'system' };
            main.append(attachCreatorGenerator(this, textField('Depth prompt', depth.prompt, value => this.edit(next => { next.card.data.extensions ??= {}; next.card.data.extensions.depth_prompt = { ...depth, ...next.card.data.extensions.depth_prompt, prompt: value }; })), 'depth_prompt'));
            this.jsonField(main, 'Depth and role', { depth: depth.depth, role: depth.role }, value => {
                if (!Number.isInteger(value.depth) || value.depth < 0 || !['system', 'user', 'assistant'].includes(value.role)) throw new Error('Use a non-negative depth and system, user or assistant role.');
                this.edit(next => { next.card.data.extensions ??= {}; next.card.data.extensions.depth_prompt = { ...depth, ...next.card.data.extensions.depth_prompt, ...value }; });
            });
        } else if (section === 'metadata') {
            const metaRow = element('div', 'creator-form-grid');
            metaRow.append(this.field('creator'), this.field('character_version'));
            main.append(metaRow, this.field('creator_notes'));
            this.stringList(main, 'Tags', 'tags');
            main.append(textField('Private author notes', draft.privateNotes, value => this.edit(next => { next.privateNotes = value; }), { hint: 'Kept only in this draft. Excluded from character saves and AI requests unless you explicitly include them.' }));
        }
        // Phones get the shared swipe-rail arrows (mobile-swipe-rails.js), the same as the character tabs.
        const rail = element('div', 'creator-rail');
        rail.append(nav);
        layout.append(rail, main);
        this.host.append(header, layout);
        renderCreatorLiveReply(this, main);
        nav.scrollLeft = railLeft;
        restore();
        if (!['dossier', 'identity', 'facts', 'greetings', 'prompts', 'metadata'].includes(section)) {
            void this.renderTool(section, main).then(() => { if (main.isConnected) restore(); }).catch(error => this.status(error.message, true));
        }
    }

    async renderTool(section, main) {
        const module = await import('./tools.js');
        if (main.isConnected) {
            await module.renderCreatorTool(this, section, main);
            renderCreatorLiveReply(this, main);
        }
    }

    dossier(main) {
        renderCreatorFormat(this, main);
        main.append(element('h3', '', 'Put all your canon info and extra details here'), textField('Character dossier', this.session.draft.dossier ?? '', value => this.edit(next => { next.dossier = value; }), {
            rows: 10,
            hint: 'Paste anything you have: canon wiki notes, history, appearance, relationships, voice, setting, and your own additions or headcanons. Convert turns it into card fields for you to review. This text stays private to the draft and is never published with the card.',
        }));
        const selection = new Set((this.session.draft.writing?.dossierFields ?? DOSSIER_FIELDS).filter(field => DOSSIER_FIELDS.includes(field)));
        const choices = element('fieldset', 'creator-fieldset creator-selector-card');
        choices.append(element('legend', '', 'Fields to create'));
        const unlockedFields = DOSSIER_FIELDS.filter(field => !this.session.draft.locks.includes(field));
        const toolbar = element('div', 'creator-selector-toolbar');
        const summary = element('span', 'creator-selector-summary');
        const actions = element('div', 'creator-selector-actions');
        const selectAllBtn = button('All', () => {
            for (const field of unlockedFields) selection.add(field);
            for (const item of choiceInputs) if (!item.input.disabled) item.input.checked = true;
            syncCreateSummary();
            this.edit(next => { next.writing ??= {}; next.writing.dossierFields = [...selection]; });
        });
        selectAllBtn.classList.add('creator-mini-btn');
        selectAllBtn.setAttribute('aria-label', 'Select all fields to create');
        const clearAllBtn = button('None', () => {
            for (const field of unlockedFields) selection.delete(field);
            for (const item of choiceInputs) if (!item.input.disabled) item.input.checked = false;
            syncCreateSummary();
            this.edit(next => { next.writing ??= {}; next.writing.dossierFields = [...selection]; });
        });
        clearAllBtn.classList.add('creator-mini-btn');
        clearAllBtn.setAttribute('aria-label', 'Clear fields to create');
        actions.append(selectAllBtn, clearAllBtn);
        toolbar.append(summary, actions);
        const choiceGrid = element('div', 'creator-choice-grid creator-choice-grid--fields');
        const choiceInputs = [];
        const syncCreateSummary = () => {
            summary.textContent = `${selection.size} of ${DOSSIER_FIELDS.length} selected`;
            selectAllBtn.disabled = !unlockedFields.length || unlockedFields.every(field => selection.has(field));
            clearAllBtn.disabled = !unlockedFields.some(field => selection.has(field));
        };
        for (const field of DOSSIER_FIELDS) {
            const label = element('label', 'creator-choice-pill creator-field-pill');
            const checkbox = element('input');
            checkbox.type = 'checkbox'; checkbox.checked = selection.has(field);
            checkbox.disabled = this.session.draft.locks.includes(field);
            const fullLabel = `${labels[field]}${checkbox.disabled ? ' (locked)' : ''}`;
            checkbox.setAttribute('aria-label', fullLabel);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selection.add(field); else selection.delete(field);
                syncCreateSummary();
                this.edit(next => { next.writing ??= {}; next.writing.dossierFields = [...selection]; });
            });
            const textSpan = element('span', 'creator-choice-label', labels[field]);
            label.append(checkbox, textSpan);
            if (checkbox.disabled) {
                const meta = element('span', 'creator-choice-meta', 'Locked');
                meta.setAttribute('aria-hidden', 'true');
                label.append(meta);
            }
            choiceInputs.push({ field, input: checkbox });
            choiceGrid.append(label);
        }
        syncCreateSummary();
        choices.append(toolbar, choiceGrid);
        let controller;
        const cancel = button('Cancel conversion', () => controller?.abort());
        cancel.hidden = true;
        const feedback = element('p', 'creator-conversion-status creator-muted');
        feedback.setAttribute('role', 'status');
        feedback.hidden = true;
        const convert = button('Convert dossier to card', () => {
            if (this.busy) { feedback.hidden = false; feedback.textContent = this.requestController ? 'A Catelier request is still running. Use Cancel active request above to stop it, then try again.' : 'Catelier is saving your draft. Try again when the save finishes.'; return; }
            return this.run(async () => {
                try {
                    feedback.hidden = false;
                    const draft = structuredClone(this.session.draft);
                    const proposal = startCreatorConversion(draft, [...selection]);
                    controller = new AbortController(); cancel.hidden = false; convert.disabled = true;
                    convert.textContent = proposal.plan.phase === 'questions' ? 'Asking questions…' : 'Converting…';
                    feedback.textContent = proposal.plan.phase === 'questions' ? 'Checking your dossier for questions before writing.' : 'Sending your Dossier to the current model. The converted fields will appear here for review.';
                    if (!this.edit(next => { next.proposals.push(proposal); })) {
                        feedback.textContent = this.message;
                        return;
                    }
                    await this.continueWriting(proposal.id, controller.signal);
                    feedback.textContent = this.message;
                } catch (error) {
                    feedback.hidden = false;
                    feedback.textContent = error?.message || (typeof error === 'string' ? error : 'Conversion failed. Check your model connection and try again.');
                    throw error;
                } finally { cancel.hidden = true; convert.disabled = false; convert.textContent = 'Convert dossier to card'; }
            });
        }, true);
        convert.dataset.creatorConvert = '';
        const actionRow = element('div', 'creator-actions');
        actionRow.append(convert, cancel);
        for (const proposal of this.session.draft.proposals.filter(item => item.dossierBefore !== undefined)) {
            actionRow.append(button(`Review ${proposal.label}`, () => this.proposal(proposal)));
        }
        main.append(choices);
        renderCreatorQuestionsOption(this, main);
        main.append(actionRow, feedback);
    }

    stringList(main, title, field) {
        const list = this.session.draft.card.data[field] ?? [];
        const sectionHeader = element('div', 'creator-section-header');
        sectionHeader.append(
            element('h3', '', title),
            button(`Add ${title.toLowerCase()}`, () => this.edit(next => { next.card.data[field] ??= []; next.card.data[field].push(''); }, true), false, 'creator-chip-btn'),
        );
        main.append(sectionHeader);
        list.forEach((text, index) => {
            const row = textField(`${title} ${index + 1}`, text, value => this.edit(next => { next.card.data[field][index] = value; }), { rows: field === 'tags' ? 1 : 3, className: field === 'alternate_greetings' ? 'creator-greeting-field' : '' });
            const removeBtn = button('Remove', () => this.edit(next => { next.card.data[field].splice(index, 1); }, true), false, 'creator-chip-btn creator-danger-outline');
            row.querySelector('.creator-field-heading').append(removeBtn);
            main.append(attachCreatorGenerator(this, row, `${field}:${index}`));
        });
    }

    jsonField(main, title, value, accept) {
        main.append(textField(title, JSON.stringify(value, null, 2), text => {
            try { accept(JSON.parse(text)); } catch (error) { this.status(error.message, true); }
        }, { rows: 3, className: 'creator-mono-field' }));
    }

    facts(main) {
        const draft = this.session.draft;
        main.append(element('h3', '', 'Decide who they are'), element('p', 'creator-muted', 'Decided, model-visible facts can become a reviewed writing proposal. Tentative and private facts stay in your draft.'));
        const add = element('div', 'creator-actions creator-chip-strip');
        for (const section of FACT_SECTIONS) add.append(button(`+ ${section}`, () => this.edit(next => { next.facts.push({ id: crypto.randomUUID(), section, text: '', status: 'decided', visibility: 'model' }); }, true), false, 'creator-chip-btn'));
        main.append(add);
        for (const fact of draft.facts) {
            const card = element('section', 'creator-fact');
            const fieldNode = textField(fact.section, fact.text, value => this.edit(next => { next.facts.find(item => item.id === fact.id).text = value; }), { rows: 2 });
            card.append(fieldNode);
            const actions = element('div', 'creator-actions creator-fact-controls');
            for (const status of ['decided', 'tentative', 'open']) {
                const toggle = button(status, () => this.edit(next => { next.facts.find(item => item.id === fact.id).status = status; }, true), false, 'creator-chip-btn');
                toggle.setAttribute('aria-pressed', String(fact.status === status));
                actions.append(toggle);
            }
            actions.append(
                button(fact.visibility === 'private' ? 'Private' : 'Model-visible', () => this.edit(next => { next.facts.find(item => item.id === fact.id).visibility = fact.visibility === 'private' ? 'model' : 'private'; }, true), false, 'creator-chip-btn'),
                button('Remove fact', () => this.edit(next => { next.facts = next.facts.filter(item => item.id !== fact.id); }, true), false, 'creator-chip-btn creator-danger-outline'),
            );
            card.append(actions); main.append(card);
        }
        main.append(element('h3', '', 'Writing format'));
        if (draft.rawAhead) main.append(element('p', 'creator-muted', 'Raw text has changed. Review the differences before replacing it with guided facts.'));
        const formats = element('div', 'creator-actions');
        for (const style of STYLES.filter(style => style !== 'custom')) formats.append(button(style, () => {
            const rendered = renderCreatorFacts(this.session.draft, style);
            this.proposal(creatorProposal(this.session.draft, rendered.fields, `${style}: ${rendered.kept.length} facts kept, ${rendered.excluded.length} excluded`));
        }));
        main.append(formats);
    }

    async continueWriting(id, signal) {
        const { requestCreatorReply } = await import('./assistant.js');
        const source = structuredClone(this.session.draft);
        const content = this.host.querySelector('.creator-content');
        const show = proposal => {
            if (content?.isConnected || [...this.host.querySelectorAll('.creator-proposal')].some(node => node.dataset.proposalId === id)) this.proposal(proposal);
        };
        const current = () => this.session.draft?.id === source.id && this.session.draft.proposals.some(item => item.id === id) && this.session.draft.dossier === source.dossier && this.session.draft.style === source.style && creatorTargetsSignature(this.session.draft) === creatorTargetsSignature(source);
        this.writingProposal = id;
        try {
            while (current()) {
                const proposal = this.session.draft.proposals.find(item => item.id === id);
                if (proposal.plan.phase === 'answers') break;
                if (proposal.plan.next >= proposal.plan.steps.length) break;
                if ((proposal.dossierBefore !== undefined && proposal.dossierBefore !== (source.dossier ?? '')) || (proposal.formatBefore !== undefined && proposal.formatBefore !== source.style) || (proposal.targetsBefore !== undefined && proposal.targetsBefore !== creatorTargetsSignature(source))) throw new Error('The source changed. Request a fresh proposal.');
                show(proposal);
                if (proposal.plan.phase === 'questions') {
                    this.status('Asking questions before writing.');
                    const output = await requestCreatorReply(this, source, creatorQuestionMessages(proposal), { signal, isCurrent: current });
                    const latest = this.session.draft.proposals.find(item => item.id === id);
                    const next = mergeCreatorQuestions(latest, output);
                    if (!this.edit(draft => { draft.proposals[draft.proposals.findIndex(item => item.id === id)] = next; }, false, { record: false })) throw new Error(this.message);
                    break;
                }
                this.status(`Writing ${proposal.plan.next + 1} of ${proposal.plan.steps.length}: ${proposal.plan.steps[proposal.plan.next].label}. Finished steps are saved for review.`);
                const step = proposal.plan.steps[proposal.plan.next];
                const sameStep = () => {
                    const latest = this.session.draft?.proposals.find(item => item.id === id);
                    return current() && latest.plan.next === proposal.plan.next && JSON.stringify(latest.plan.steps[latest.plan.next]) === JSON.stringify(step);
                };
                const output = step.agent
                    ? await (await import('./agent-processing.js')).requestCreatorAgentStep(this, this.session.draft, proposal, { signal, isCurrent: sameStep })
                    : await requestCreatorReply(this, source, creatorStepMessages(this.session.draft, proposal), { signal, isCurrent: sameStep });
                const latest = this.session.draft.proposals.find(item => item.id === id);
                const next = mergeCreatorStep(this.session.draft, latest, output);
                if (!this.edit(draft => { draft.proposals[draft.proposals.findIndex(item => item.id === id)] = next; }, false, { record: false })) throw new Error(this.message);
            }
            if (!current()) throw new Error('The source changed. Request a fresh proposal.');
            this.status(this.session.draft.proposals.find(item => item.id === id)?.plan.phase === 'answers'
                ? 'Questions ready. Answer what you like, then choose Generate.'
                : 'Writing finished. Review the proposed fields before accepting them.');
        } catch (error) {
            if (this.session.draft?.proposals.find(item => item.id === id)?.plan.phase === 'questions') throw new Error(`${error.message} Use Retry questions to try again.`, { cause: error });
            throw new Error(`${error.message} Finished steps remain available. Use Continue writing to retry the unfinished step.`, { cause: error });
        } finally {
            this.writingProposal = null;
            const proposal = this.session.draft?.id === source.id && this.session.draft.proposals.find(item => item.id === id);
            if (proposal) show(proposal);
        }
    }

    async reviseProposal(id, field) {
        if (this.busy) {
            if (this.writingProposal !== id) return;
            this.requestController?.abort();
            await this.activeAction;
        }
        return this.run(async () => {
            const proposal = this.session.draft.proposals.find(item => item.id === id);
            if (!proposal) return;
            const next = reviseCreatorConversion(this.session.draft, proposal, field ? { field, note: proposal.fieldNotes?.[field] ?? '', regenerate: true } : {});
            if (!field) {
                if (!this.edit(draft => { draft.proposals[draft.proposals.findIndex(item => item.id === id)] = next; })) return;
                await this.continueWriting(id);
                return;
            }
            const { requestCreatorReply } = await import('./assistant.js');
            const source = structuredClone(this.session.draft);
            const original = JSON.stringify(proposal.changes.find(change => change.field === field));
            const current = () => this.session.draft?.id === source.id && this.session.draft.dossier === source.dossier && this.session.draft.style === source.style && creatorTargetsSignature(this.session.draft) === creatorTargetsSignature(source) && JSON.stringify(this.session.draft.proposals.find(item => item.id === id)?.changes.find(change => change.field === field)) === original;
            let revised = next;
            this.writingProposal = id;
            try {
                this.proposal(proposal);
                while (revised.plan.next < revised.plan.steps.length) {
                    const output = await requestCreatorReply(this, source, creatorStepMessages(source, revised), { isCurrent: current });
                    revised = mergeCreatorStep(source, revised, output);
                }
                if (!this.edit(draft => {
                    const latest = draft.proposals.find(item => item.id === id);
                    latest.changes = latest.changes.map(change => change.field === field ? revised.changes.find(item => item.field === field) : change);
                })) return;
                this.status('Field regenerated. Review it before accepting.');
            } finally {
                this.writingProposal = null;
                const latest = this.session.draft?.id === source.id && this.session.draft.proposals.find(item => item.id === id);
                if (latest) this.proposal(latest);
            }
        });
    }

    proposal(proposal) {
        proposal = structuredClone(proposal);
        const persist = update => this.edit(next => {
            const current = next.proposals.find(item => item.id === proposal.id);
            if (!current) throw new Error('This proposal is no longer available.');
            update(current);
        });
        if (!this.session.draft.proposals.some(item => item.id === proposal.id) && !this.edit(next => next.proposals.push(structuredClone(proposal)))) return;
        const content = this.host.querySelector('.creator-content');
        if (!content) return;
        for (const node of content.querySelectorAll('.creator-proposal')) if (node.dataset.proposalId !== proposal.id) node.remove();
        const review = element('section', 'creator-proposal');
        review.dataset.proposalId = proposal.id;
        review.append(element('h3', '', proposal.label));
        const unfinished = proposal.plan && proposal.plan.next < proposal.plan.steps.length;
        const writing = this.writingProposal === proposal.id;
        const asking = proposal.plan?.phase === 'questions';
        const answering = proposal.plan?.phase === 'answers';
        if (asking || answering) review.append(element('p', 'creator-muted', asking ? 'Ask questions before generating any fields.' : proposal.questions.length ? 'Answer what you like, then choose Generate. Unanswered questions can be revisited later.' : 'The model has no questions. Choose Generate when you are ready.'));
        else if (proposal.plan) review.append(element('p', 'creator-muted', `Written ${proposal.plan.next} of ${proposal.plan.steps.length} steps.${unfinished ? ` Next: ${proposal.plan.steps[proposal.plan.next].label}.` : ' Ready to review.'}`));
        if (unfinished && !writing && !answering) review.append(button(asking ? 'Retry questions' : 'Continue writing', () => this.run(() => this.continueWriting(proposal.id)), true));
        for (const [key, title] of [['coverage', 'How your information was used']]) {
            if (!proposal[key]?.length) continue;
            review.append(element('h4', '', title));
            for (const note of proposal[key]) review.append(element('p', '', note));
        }
        if (proposal.questions?.length) {
            review.append(element('h4', '', 'Questions to resolve'));
            for (const question of proposal.questions) {
                review.append(textField(question, proposal.answers?.[question] ?? '', value => persist(current => { current.answers ??= {}; current.answers[question] = value; }), { rows: 2, placeholder: 'Your answer' }));
            }
        }
        if (proposal.resolved?.length) {
            const history = element('details');
            history.append(element('summary', '', `Answered questions (${proposal.resolved.length})`));
            for (const answer of proposal.resolved) history.append(element('p', '', `${answer.question}\n${answer.answer}`));
            review.append(history);
        }
        if (answering && !writing) review.append(button('Generate', () => this.run(async () => {
            const next = generateCreatorProposal(this.session.draft.proposals.find(item => item.id === proposal.id));
            if (!this.edit(draft => { draft.proposals[draft.proposals.findIndex(item => item.id === proposal.id)] = next; })) return;
            await this.continueWriting(proposal.id);
        }), true));
        if (proposal.changes.length || proposal.questions?.length) {
            review.append(textField('Anything else to change?', proposal.note ?? '', value => persist(current => { current.note = value; }), { rows: 2 }));
            review.append(button(unfinished || writing ? 'Apply revisions now' : 'Revise with my answers', () => this.reviseProposal(proposal.id), true));
        }
        for (const change of proposal.changes) {
            const group = element('section', 'creator-proposal-field');
            group.dataset.field = change.field;
            const before = Array.isArray(change.before) ? change.before.join('\n\n') : change.before;
            group.append(element('h4', '', change.field === 'depth_prompt' ? 'Character’s Note' : change.field === 'alternate_greetings' ? 'Alternate greetings' : labels[change.field] || change.field));
            group.append(element('pre', 'creator-before', before || '(empty)'));
            if (change.field === 'alternate_greetings') {
                if (!change.after.length) group.append(element('p', 'creator-muted', change.before.length ? `Removes all ${change.before.length} alternate greetings.` : 'No alternate greetings proposed.'));
                change.after.forEach((text, index) => {
                    if (change.acceptedGreetings?.includes(index)) return;
                    const greeting = textField(`Proposed alternate greeting ${index + 1}`, text, value => {
                        persist(current => { current.changes.find(item => item.field === change.field).after[index] = value; });
                    });
                    greeting.append(button(`Accept greeting ${index + 1}`, () => {
                        this.change(draft => acceptCreatorGreeting(draft, draft.proposals.find(item => item.id === proposal.id), index));
                        const remaining = this.session.draft.proposals.find(item => item.id === proposal.id);
                        if (remaining) this.proposal(remaining);
                        else review.remove();
                    }, true));
                    group.append(greeting);
                });
            } else {
                group.append(textField('Proposed text', change.after, value => {
                    persist(current => { current.changes.find(item => item.field === change.field).after = value; });
                }));
            }
            group.append(button('Accept this field', () => {
                this.change(draft => acceptCreatorProposal(draft, draft.proposals.find(item => item.id === proposal.id), [change.field]));
                const remaining = this.session.draft.proposals.find(item => item.id === proposal.id);
                if (remaining) this.proposal(remaining);
                else review.remove();
            }, true));
            const revision = element('details');
            revision.append(element('summary', '', 'Revision notes (optional)'), textField('Revision notes for this field', proposal.fieldNotes?.[change.field] ?? '', value => {
                persist(current => {
                    current.fieldNotes ??= {};
                    current.fieldNotes[change.field] = value;
                });
            }, { rows: 2 }));
            group.append(revision, button('Regenerate this field', () => this.reviseProposal(proposal.id, change.field)));
            review.append(group);
        }
        const footer = element('div', 'creator-actions');
        if (proposal.changes.length) footer.append(button('Accept all fields', () => {
            this.change(draft => acceptCreatorProposal(draft, draft.proposals.find(item => item.id === proposal.id)));
            const remaining = this.session.draft.proposals.find(item => item.id === proposal.id);
            if (remaining) this.proposal(remaining);
            else review.remove();
        }, true));
        if (!writing) footer.append(button('Reject proposal', () => {
            this.edit(next => { next.proposals = next.proposals.filter(item => item.id !== proposal.id); }, true);
        }));
        review.append(footer);
        const previous = [...content.querySelectorAll('.creator-proposal')].find(node => node.dataset.proposalId === proposal.id);
        if (previous) {
            const restore = rememberCreatorViewport(this.host);
            const focused = previous.contains(document.activeElement) ? document.activeElement : null;
            const field = focused?.closest('[data-field]')?.dataset.field;
            const label = focused?.labels?.[0]?.textContent;
            const selection = focused && [focused.selectionStart, focused.selectionEnd];
            previous.replaceWith(review);
            if (label) {
                const replacement = [...review.querySelectorAll('input, textarea')].find(input => input.labels?.[0]?.textContent === label && input.closest('[data-field]')?.dataset.field === field);
                replacement?.focus({ preventScroll: true });
                if (replacement && selection[0] !== null) replacement.setSelectionRange(...selection);
            }
            restore();
        } else { content.prepend(review); review.scrollIntoView({ block: 'start' }); }
    }

    review() {
        const draft = this.session.draft;
        const content = this.host.querySelector('.creator-content');
        content.replaceChildren(element('h3', '', 'Review your library changes'));
        content.append(element('p', 'creator-muted', 'Lorebooks save first, then the character. If a later step fails, resume this save to finish the remaining steps.'));
        for (const [key, value] of Object.entries(creatorPublicationCard(draft).data)) {
            const before = draft.source.original?.data?.[key];
            if (JSON.stringify(before) === JSON.stringify(value)) continue;
            const item = element('details', 'creator-review-item');
            item.append(element('summary', '', labels[key] || key), element('pre', '', `Before\n${typeof before === 'string' ? before : JSON.stringify(before ?? null, null, 2)}\n\nAfter\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`));
            content.append(item);
        }
        for (const book of draft.books) {
            const item = element('details', 'creator-review-item');
            item.append(element('summary', '', `${book.detached ? 'Detach' : book.mode}: ${book.name}`),
                element('pre', '', `Before\n${JSON.stringify(book.original ?? null, null, 2)}\n\nAfter\n${book.detached ? '(detached, library file retained)' : JSON.stringify(book.data, null, 2)}`));
            content.append(item);
        }
        if (draft.selectedMedia) {
            const portrait = draft.media.find(item => item.id === draft.selectedMedia);
            if (portrait) { const image = element('img', 'creator-portrait creator-review-portrait'); image.src = portrait.dataUrl; image.alt = 'Portrait selected for this save'; content.append(image); }
        }
        if (JSON.stringify(draft.additionalBooks) !== JSON.stringify(draft.source.extraBooks)) content.append(element('pre', '', `Additional lorebook links\nBefore: ${JSON.stringify(draft.source.extraBooks ?? [])}\nAfter: ${JSON.stringify(draft.additionalBooks ?? [])}`));
        const publish = copy => this.run(async () => {
            clearTimeout(this.timer);
            const result = await this.session.publish(copy);
            let refreshed = false;
            try { refreshed = await getOneCharacter(result.avatar, { allowInsert: true }); } catch { /* The publication is already saved. */ }
            this.render(); this.status(!refreshed ? 'Saved to your library. Reload the page to refresh the character list.' : result.refreshWarning || 'Character and reviewed lorebooks saved to your library.');
        });
        const actionRow = element('div', 'creator-actions');
        actionRow.append(button(this.session.pending ? 'Resume save' : 'Save to library', () => publish(false), true));
        if (!this.session.pending) actionRow.append(button('Save as a new copy', () => publish(true)));
        if (this.session.pending) actionRow.append(button('Recover for comparison', () => this.run(async () => {
            clearTimeout(this.timer);
            await this.session.recoverPublication();
            await this.compareLibrary();
            this.status('Interrupted save stopped. Saved resources are retained. Compare the remaining changes before saving again.');
        })));
        else actionRow.append(button('Compare with library', () => this.run(() => this.compareLibrary())));
        content.append(actionRow);
    }

    async compareLibrary() {
        const draft = structuredClone(this.session.draft);
        const localCard = creatorPublicationCard(draft);
        const source = draft.source.avatar ? await this.session.request('character', { avatar: draft.source.avatar }) : null;
        const resources = [{ label: 'Character', base: draft.source.original ?? localCard, local: localCard, remote: source?.card ?? localCard, choices: {} },
            { label: 'Additional lorebook links', base: draft.source.extraBooks ?? [], local: draft.additionalBooks ?? [], remote: source?.extraBooks ?? draft.additionalBooks ?? [], choices: {} }];
        for (const book of draft.books.filter(book => book.mode === 'linked' && !book.detached)) {
            const current = await this.session.request('book', { name: book.name });
            resources.push({ label: book.name, bookId: book.id, base: book.original, local: book.data, remote: current.data, revision: current.revision, choices: {} });
        }
        if (this.session.draft.id !== draft.id) throw new Error('Reopen comparison for the current draft.');
        const content = this.host.querySelector('.creator-content');
        content.replaceChildren(element('h3', '', 'Compare with your library'), element('p', '', 'Independent changes are combined. Choose which version to keep wherever both copies changed. Nothing is published by this comparison.'));
        const draftChoices = [];
        const selectAll = button('Keep all draft changes', () => {
            for (const radio of draftChoices) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change'));
            }
        });
        content.append(selectAll);
        for (const resource of resources) {
            content.append(element('h4', '', resource.label));
            const compared = compareCreatorChanges(resource.base, resource.local, resource.remote);
            if (!compared.conflicts.length) content.append(element('p', 'creator-muted', 'No conflicting changes.'));
            for (const conflict of compared.conflicts) {
                const group = element('section', 'creator-review-item');
                group.append(element('h4', '', conflict.path.join(' / ') || resource.label));
                const radioName = crypto.randomUUID();
                for (const [key, label] of [['draft', 'Keep draft'], ['library', 'Keep library']]) {
                    const optionWrap = element('div', 'creator-conflict-option');
                    const pill = element('label', 'creator-choice-pill');
                    const radio = element('input'); radio.type = 'radio'; radio.name = radioName;
                    radio.addEventListener('change', () => {
                        resource.choices[conflict.id] = key;
                        for (const input of group.querySelectorAll('input')) input.checked = input === radio;
                    });
                    if (key === 'draft') draftChoices.push(radio);
                    pill.append(radio, document.createTextNode(label));
                    optionWrap.append(pill, element('pre', '', JSON.stringify(conflict[key], null, 2) ?? '(removed)'));
                    group.append(optionWrap);
                }
                content.append(group);
            }
        }
        selectAll.hidden = !draftChoices.length;
        content.append(button('Apply comparison to draft', () => this.run(async () => {
            if (JSON.stringify(this.session.draft) !== JSON.stringify(draft)) throw new Error('The draft changed during comparison. Compare again before applying.');
            const merged = resources.map(resource => compareCreatorChanges(resource.base, resource.local, resource.remote, resource.choices));
            if (merged.some(item => item.conflicts.length)) throw new Error('Choose a version for every conflicting field.');
            const { convertCharacterBook } = await import('../world-info.js');
            this.edit(next => {
                adoptCreatorComparedCard(next, merged[0].value, convertCharacterBook);
                next.additionalBooks = merged[1].value;
                if (source) next.source = { ...next.source, original: structuredClone(source.card), revision: source.revision, extraBooks: source.extraBooks };
                for (let index = 2; index < resources.length; index++) {
                    const resource = resources[index];
                    const book = next.books.find(item => item.id === resource.bookId);
                    book.data = merged[index].value; book.original = structuredClone(resource.remote); book.revision = resource.revision;
                }
            }, true);
            this.status('Comparison applied to your draft. Review it before saving to the library.');
        }), true));
    }
}
