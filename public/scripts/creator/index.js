import { characters, getOneCharacter } from '../../script.js';
import { CreatorSession } from './session.js';
import { element, button, textField } from './fields.js';
import { editCreatorDraft, setCreatorField, undoCreatorDraft, renderCreatorFacts, creatorProposal, acceptCreatorProposal, FACT_SECTIONS, STYLES } from './model.js';
import { buildDossierRequest, dossierProposal, DOSSIER_FIELDS } from './dossier.js';
import { compareCreatorChanges } from './conflicts.js';
import { restoreCreatorBackup } from './backup.js';

const sections = [['dossier', 'Dossier'], ['identity', 'Identity'], ['facts', 'Guided facts'], ['greetings', 'Greetings & examples'], ['interview', 'Interview'], ['prompts', 'Prompts'], ['lore', 'Lorebooks'], ['macros', 'Macros & pronouns'], ['regex', 'Pretty HTML'], ['game', 'Gamify'], ['portrait', 'Portrait'], ['helper', 'Writing partner'], ['metadata', 'Details'], ['preview', 'Preview & export']];
const labels = { name: 'Display name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First greeting', mes_example: 'Interviewer examples', creator_notes: 'Public creator notes', system_prompt: 'Main prompt', post_history_instructions: 'Post-history instructions', creator: 'Creator', character_version: 'Card version' };
let app;

export async function mountCreator(host, { avatar = null } = {}) {
    if (!host) return;
    if (app?.host === host) app.session.assertOwner();
    else {
        app = new CreatorWorkspace(host);
        if (!avatar) await app.home();
        else app.shell();
    }
    if (avatar) await app.run(async () => {
        if (app.session.pending || app.session.publishing) throw new Error('Finish the previous save before opening another character.');
        clearTimeout(app.timer);
        if (app.session.draft) await app.session.save();
        await app.session.create(avatar);
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
        try { await action(); } catch (error) { this.status(error.message, true); } finally { this.busy = false; this.host.removeAttribute('aria-busy'); }
    }

    status(message, error = false) {
        this.message = message;
        const output = this.host.querySelector('.creator-status');
        if (output) { output.textContent = message; output.dataset.error = String(error); }
    }

    shell() {
        this.host.replaceChildren();
        const output = element('p', 'creator-status', this.message);
        output.setAttribute('role', 'status');
        this.host.append(output);
    }

    async home() {
        clearTimeout(this.timer);
        if (this.session.draft) await this.session.save();
        this.shell();
        const welcome = element('div', 'creator-welcome');
        welcome.append(element('h2', '', 'A character starts here.'), element('p', '', 'Keep a private draft, explore their voice, and review everything before it reaches your library.'));
        welcome.append(button('Create a character', () => this.run(async () => { await this.session.create(); this.render(); }), true));
        this.host.append(welcome);
        const restore = element('label', 'creator-field');
        restore.append(element('span', '', 'Restore a private draft backup'));
        const upload = element('input');
        upload.type = 'file'; upload.accept = '.json,application/json';
        upload.addEventListener('change', () => this.run(async () => {
            const file = upload.files[0];
            if (!file) return;
            if (file.size > 24 * 1024 * 1024) throw new Error('Choose a backup smaller than 24 MiB.');
            const draft = restoreCreatorBackup(JSON.parse(await file.text()));
            await this.session.queue;
            this.session.draft = draft; this.session.revision = null; this.session.pending = null;
            await this.session.save(); this.render();
            this.status('Backup restored as a new draft. External books will be new copies; rename them in Lorebooks if those names already exist.');
        }));
        restore.append(upload); this.host.append(restore);
        const recovery = this.session.recovery();
        if (recovery) this.host.append(button(`Recover ${recovery.draft.card.data.name || 'untitled draft'}`, () => {
            this.session.restore(recovery); this.render(); this.status(recovery.pending ? 'A previous save needs recovery. Resume it from Review & save.' : 'Local draft recovered.');
        }));
        const { drafts } = await this.session.request('list');
        const saved = element('section', 'creator-library');
        saved.append(element('h3', '', 'Your drafts'));
        if (!drafts.length) saved.append(element('p', 'creator-muted', 'Your drafts will appear here, including work saved on another device.'));
        for (const draft of drafts) saved.append(button(draft.name || 'Untitled character', () => this.run(async () => { await this.session.open(draft.id); this.render(); })));
        this.host.append(saved);
        const library = element('section', 'creator-library');
        library.append(element('h3', '', 'Edit an existing character'));
        const list = element('div', 'creator-library-grid');
        const search = textField('Find a character', '', value => {
            for (const item of list.children) item.hidden = !item.textContent.toLocaleLowerCase().includes(value.toLocaleLowerCase());
        }, { rows: 1 });
        for (const card of characters) {
            const open = button(card.name || card.avatar, () => this.run(async () => { await this.session.create(card.avatar); this.render(); }));
            list.append(open);
        }
        library.append(search, list);
        this.host.append(library);
    }

    change(operation, redraw = false) {
        if (this.session.pending || this.session.publishing) { this.status('Finish the previous save before changing this draft.', true); return; }
        try {
            this.session.draft = operation(this.session.draft);
            this.session.remember();
            const heading = this.host.querySelector('.creator-draft-header h2');
            if (heading) heading.textContent = this.session.draft.card.data.name || 'Untitled character';
            const undo = this.host.querySelector('[data-creator-undo]');
            const redo = this.host.querySelector('[data-creator-redo]');
            if (undo) undo.disabled = !this.session.draft.history.length;
            if (redo) redo.disabled = !this.session.draft.future.length;
            clearTimeout(this.timer);
            this.status(this.session.localRecoveryError ? 'Device recovery storage is full. Saving to your account…' : 'Draft changes saved on this device.', this.session.localRecoveryError);
            this.timer = setTimeout(() => {
                void this.session.save().then(() => this.status(this.session.localRecoveryError ? 'Draft saved to your account. Device recovery storage is full.' : 'Draft saved. Your library has not changed.', this.session.localRecoveryError)).catch(error => this.status(error.message, true));
            }, 500);
            if (redraw) this.render();
        } catch (error) { this.status(error.message, true); }
    }

    edit(operation, redraw = false) { this.change(draft => editCreatorDraft(draft, operation), redraw); }

    field(field) {
        const draft = this.session.draft;
        const node = textField(labels[field] || field, draft.card.data[field], value => this.change(current => setCreatorField(current, field, value)), { name: field === 'name', hint: field === 'mes_example' ? 'Use Interviewer: for questions and {{char}}: for the character’s replies.' : '' });
        if (field !== 'name') {
            const locked = draft.locks.includes(field);
            const lock = button(locked ? 'Locked for AI' : 'Lock for AI', () => this.edit(next => {
                next.locks = locked ? next.locks.filter(item => item !== field) : [...next.locks, field];
            }, true));
            lock.setAttribute('aria-pressed', String(locked));
            node.querySelector('.creator-field-heading').append(lock);
        }
        return node;
    }

    render() {
        const draft = this.session.draft;
        this.shell();
        const header = element('header', 'creator-draft-header');
        const heading = element('div');
        heading.append(element('p', 'creator-eyebrow', draft.source.avatar ? 'Editing a library character' : 'New character draft'), element('h2', '', draft.card.data.name || 'Untitled character'));
        const actions = element('div', 'creator-actions');
        const undo = button('Undo', () => this.change(value => undoCreatorDraft(value), true));
        const redo = button('Redo', () => this.change(value => undoCreatorDraft(value, true), true));
        undo.dataset.creatorUndo = '';
        redo.dataset.creatorRedo = '';
        undo.disabled = !draft.history.length;
        redo.disabled = !draft.future.length;
        actions.append(button('Drafts', () => this.run(() => this.home())), undo, redo, button('Review & save', () => this.review(), true));
        header.append(heading, actions);
        const layout = element('div', 'creator-layout');
        const nav = element('nav', 'creator-sections');
        nav.setAttribute('aria-label', 'Creator sections');
        for (const [id, label] of sections) {
            const tab = button(label, () => { this.session.draft.view.section = id; this.session.remember(); this.render(); });
            tab.setAttribute('aria-current', draft.view.section === id ? 'page' : 'false');
            nav.append(tab);
        }
        const main = element('div', 'creator-content');
        const section = draft.view.section;
        if (section === 'identity') main.append(this.field('name'), this.field('description'), this.field('personality'), this.field('scenario'));
        else if (section === 'dossier') this.dossier(main);
        else if (section === 'facts') this.facts(main);
        else if (section === 'greetings') {
            main.append(this.field('first_mes'), this.field('mes_example'));
            this.stringList(main, 'Alternate greetings', 'alternate_greetings');
            this.stringList(main, 'Group greetings', 'group_only_greetings');
        } else if (section === 'prompts') {
            main.append(this.field('system_prompt'), this.field('post_history_instructions'));
            const depth = draft.card.data.extensions?.depth_prompt ?? { prompt: '', depth: 4, role: 'system' };
            main.append(textField('Depth prompt', depth.prompt, value => this.edit(next => { next.card.data.extensions ??= {}; next.card.data.extensions.depth_prompt = { ...depth, ...next.card.data.extensions.depth_prompt, prompt: value }; })));
            this.jsonField(main, 'Depth and role', { depth: depth.depth, role: depth.role }, value => {
                if (!Number.isInteger(value.depth) || value.depth < 0 || !['system', 'user', 'assistant'].includes(value.role)) throw new Error('Use a non-negative depth and system, user or assistant role.');
                this.edit(next => { next.card.data.extensions ??= {}; next.card.data.extensions.depth_prompt = { ...depth, ...next.card.data.extensions.depth_prompt, ...value }; });
            });
        } else if (section === 'metadata') {
            main.append(this.field('creator'), this.field('character_version'), this.field('creator_notes'));
            this.stringList(main, 'Tags', 'tags');
            main.append(textField('Private author notes', draft.privateNotes, value => this.edit(next => { next.privateNotes = value; }), { hint: 'Kept only in this draft. Excluded from character saves and AI requests unless you explicitly include them.' }));
        }
        layout.append(nav, main);
        this.host.append(header, layout);
        if (!['dossier', 'identity', 'facts', 'greetings', 'prompts', 'metadata'].includes(section)) {
            void this.renderTool(section, main).catch(error => this.status(error.message, true));
        }
    }

    async renderTool(section, main) {
        const module = await import('./tools.js');
        if (main.isConnected) await module.renderCreatorTool(this, section, main);
    }

    dossier(main) {
        main.append(element('h3', '', 'Everything about your character, in one place.'), textField('Character dossier', this.session.draft.dossier ?? '', value => this.edit(next => { next.dossier = value; }), {
            rows: 18,
            hint: 'Paste notes, history, appearance, relationships, voice, setting and scene ideas. Convert sends this dossier and the chosen existing fields to your current model. Your original notes stay in this draft, outside the published card.',
        }));
        const selection = new Set(DOSSIER_FIELDS.filter(field => !this.session.draft.locks.includes(field)));
        const choices = element('fieldset', 'creator-actions');
        choices.append(element('legend', '', 'Fields to create'));
        for (const field of DOSSIER_FIELDS) {
            const label = element('label');
            const checkbox = element('input');
            checkbox.type = 'checkbox'; checkbox.checked = selection.has(field);
            checkbox.disabled = this.session.draft.locks.includes(field);
            checkbox.addEventListener('change', () => checkbox.checked ? selection.add(field) : selection.delete(field));
            label.append(checkbox, document.createTextNode(`${labels[field]}${checkbox.disabled ? ' (locked)' : ''}`));
            choices.append(label);
        }
        let controller;
        const cancel = button('Cancel conversion', () => controller?.abort());
        cancel.hidden = true;
        const convert = button('Convert dossier to card', () => this.run(async () => {
            const draft = structuredClone(this.session.draft);
            const request = buildDossierRequest(draft, [...selection]);
            controller = new AbortController(); cancel.hidden = false; convert.disabled = true;
            this.status('Converting your dossier. You will review the fields before applying them.');
            try {
                const { requestPromptTransform } = await import('../extensions/in-chat-agents/agent-runner.js');
                const result = await requestPromptTransform({ category: 'custom', execution: 'inline', connectionProfile: '' }, request.messages, 8192, {
                    signal: controller.signal, preserveWhitespace: true, literalPrompt: true,
                    isCurrent: () => this.session.draft?.id === draft.id && this.session.draft.dossier === draft.dossier,
                });
                this.session.assertOwner();
                if (controller.signal.aborted) throw new Error('Conversion cancelled. Your dossier is unchanged.');
                if (this.session.draft?.id !== draft.id || (this.session.draft.dossier ?? '') !== (draft.dossier ?? '')) throw new Error('The source dossier changed. Convert the updated version.');
                if (result.lengthLimited) throw new Error('The model ran out of output space. Nothing was applied; convert fewer fields at once.');
                const proposal = dossierProposal(draft, result.output, request.fields);
                this.edit(next => { next.proposals.push(proposal); });
                if (main.isConnected) this.proposal(proposal);
                this.status('Conversion ready for review. Your dossier and library are unchanged.');
            } finally { cancel.hidden = true; convert.disabled = false; }
        }), true);
        main.append(choices, convert, cancel);
        for (const proposal of this.session.draft.proposals.filter(item => item.dossierBefore !== undefined)) {
            main.append(button(`Review ${proposal.label}`, () => this.proposal(proposal)));
        }
    }

    stringList(main, title, field) {
        const list = this.session.draft.card.data[field] ?? [];
        main.append(element('h3', '', title));
        list.forEach((text, index) => {
            const row = textField(`${title} ${index + 1}`, text, value => this.edit(next => { next.card.data[field][index] = value; }));
            row.append(button('Remove', () => this.edit(next => { next.card.data[field].splice(index, 1); }, true)));
            main.append(row);
        });
        main.append(button(`Add ${title.toLowerCase()}`, () => this.edit(next => { next.card.data[field] ??= []; next.card.data[field].push(''); }, true)));
    }

    jsonField(main, title, value, accept) {
        main.append(textField(title, JSON.stringify(value, null, 2), text => {
            try { accept(JSON.parse(text)); } catch (error) { this.status(error.message, true); }
        }));
    }

    facts(main) {
        const draft = this.session.draft;
        main.append(element('h3', '', 'Decide who they are'), element('p', 'creator-muted', 'Decided, model-visible facts can become a reviewed writing proposal. Tentative and private facts stay in your draft.'));
        for (const fact of draft.facts) {
            const card = element('section', 'creator-fact');
            card.append(textField(fact.section, fact.text, value => this.edit(next => { next.facts.find(item => item.id === fact.id).text = value; })));
            const actions = element('div', 'creator-actions');
            for (const status of ['decided', 'tentative', 'open']) {
                const toggle = button(status, () => this.edit(next => { next.facts.find(item => item.id === fact.id).status = status; }, true));
                toggle.setAttribute('aria-pressed', String(fact.status === status));
                actions.append(toggle);
            }
            actions.append(button(fact.visibility === 'private' ? 'Private' : 'Model-visible', () => this.edit(next => { next.facts.find(item => item.id === fact.id).visibility = fact.visibility === 'private' ? 'model' : 'private'; }, true)), button('Remove fact', () => this.edit(next => { next.facts = next.facts.filter(item => item.id !== fact.id); }, true)));
            card.append(actions); main.append(card);
        }
        const add = element('div', 'creator-actions');
        for (const section of FACT_SECTIONS) add.append(button(`+ ${section}`, () => this.edit(next => { next.facts.push({ id: crypto.randomUUID(), section, text: '', status: 'decided', visibility: 'model' }); }, true)));
        main.append(add, element('h3', '', 'Writing format'));
        if (draft.rawAhead) main.append(element('p', 'creator-muted', 'Raw text has changed. Review the differences before replacing it with guided facts.'));
        const formats = element('div', 'creator-actions');
        for (const style of STYLES) formats.append(button(style, () => {
            const rendered = renderCreatorFacts(this.session.draft, style);
            this.proposal(creatorProposal(this.session.draft, rendered.fields, `${style}: ${rendered.kept.length} facts kept, ${rendered.excluded.length} excluded`));
        }));
        main.append(formats);
    }

    proposal(proposal) {
        proposal = structuredClone(proposal);
        const persist = () => this.edit(next => {
            const index = next.proposals.findIndex(item => item.id === proposal.id);
            if (index >= 0) next.proposals[index] = structuredClone(proposal);
            else next.proposals.push(structuredClone(proposal));
        });
        if (!this.session.draft.proposals.some(item => item.id === proposal.id)) persist();
        const content = this.host.querySelector('.creator-content');
        const review = element('section', 'creator-proposal');
        review.append(element('h3', '', proposal.label));
        for (const [key, title] of [['coverage', 'How your information was used'], ['questions', 'Questions to resolve']]) {
            if (!proposal[key]?.length) continue;
            review.append(element('h4', '', title));
            for (const note of proposal[key]) review.append(element('p', '', note));
        }
        for (const change of proposal.changes) {
            const group = element('section', 'creator-proposal-field');
            group.append(element('h4', '', labels[change.field] || change.field), element('pre', 'creator-before', change.before || '(empty)'));
            group.append(textField('Proposed text', change.after, value => { change.after = value; persist(); }));
            group.append(button('Accept this field', () => {
                this.change(draft => acceptCreatorProposal(draft, proposal, [change.field]), true);
                const remaining = this.session.draft.proposals.find(item => item.id === proposal.id);
                if (remaining && !review.isConnected) this.proposal(remaining);
            }, true));
            review.append(group);
        }
        review.append(button('Accept all fields', () => this.change(draft => acceptCreatorProposal(draft, proposal), true), true), button('Reject proposal', () => {
            this.edit(next => { next.proposals = next.proposals.filter(item => item.id !== proposal.id); }, true);
        }));
        content.prepend(review);
        review.scrollIntoView({ block: 'start' });
    }

    review() {
        const draft = this.session.draft;
        const content = this.host.querySelector('.creator-content');
        content.replaceChildren(element('h3', '', 'Review your library changes'));
        content.append(element('p', 'creator-muted', 'Lorebooks save first, then the character. If a later step fails, resume this save to finish the remaining steps.'));
        for (const [key, value] of Object.entries(draft.card.data)) {
            const before = draft.source.original?.data?.[key];
            if (JSON.stringify(before) === JSON.stringify(value)) continue;
            const item = element('details', 'creator-review-item');
            item.append(element('summary', '', labels[key] || key), element('pre', '', `Before\n${typeof before === 'string' ? before : JSON.stringify(before ?? null, null, 2)}\n\nAfter\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`));
            content.append(item);
        }
        for (const book of draft.books) content.append(element('p', '', `${book.detached ? 'Detach' : book.mode}: ${book.name}`));
        const publish = copy => this.run(async () => {
            clearTimeout(this.timer);
            const result = await this.session.publish(copy);
            await getOneCharacter(result.avatar, { allowInsert: true });
            this.render(); this.status('Character and reviewed lorebooks saved to your library.');
        });
        content.append(button(this.session.pending ? 'Resume save' : 'Save to library', () => publish(false), true));
        if (!this.session.pending) content.append(button('Save as a new copy', () => publish(true)));
        if (!this.session.pending && draft.source.avatar) content.append(button('Compare with library', () => this.run(() => this.compareLibrary())));
    }

    async compareLibrary() {
        const draft = structuredClone(this.session.draft);
        const source = await this.session.request('character', { avatar: draft.source.avatar });
        const resources = [{ label: 'Character', base: draft.source.original, local: draft.card, remote: source.card, choices: {} },
            { label: 'Additional lorebook links', base: draft.source.extraBooks ?? [], local: draft.additionalBooks ?? [], remote: source.extraBooks, choices: {} }];
        for (const book of draft.books.filter(book => book.mode === 'linked' && !book.detached)) {
            const current = await this.session.request('book', { name: book.name });
            resources.push({ label: book.name, bookId: book.id, base: book.original, local: book.data, remote: current.data, revision: current.revision, choices: {} });
        }
        if (this.session.draft.id !== draft.id) throw new Error('Reopen comparison for the current draft.');
        const content = this.host.querySelector('.creator-content');
        content.replaceChildren(element('h3', '', 'Compare with your library'), element('p', '', 'Independent changes are combined. Choose which version to keep wherever both copies changed. Nothing is published by this comparison.'));
        for (const resource of resources) {
            content.append(element('h4', '', resource.label));
            const compared = compareCreatorChanges(resource.base, resource.local, resource.remote);
            if (!compared.conflicts.length) content.append(element('p', 'creator-muted', 'No conflicting changes.'));
            for (const conflict of compared.conflicts) {
                const group = element('section', 'creator-review-item');
                group.append(element('h4', '', conflict.path.join(' / ') || resource.label));
                const radioName = crypto.randomUUID();
                for (const [key, label] of [['draft', 'Keep draft'], ['library', 'Keep library']]) {
                    const row = element('label');
                    const radio = element('input'); radio.type = 'radio'; radio.name = radioName;
                    radio.addEventListener('change', () => {
                        resource.choices[conflict.id] = key;
                        for (const input of group.querySelectorAll('input')) input.checked = input === radio;
                    });
                    row.append(radio, document.createTextNode(label), element('pre', '', JSON.stringify(conflict[key], null, 2) ?? '(removed)'));
                    group.append(row);
                }
                content.append(group);
            }
        }
        content.append(button('Apply comparison to draft', () => this.run(async () => {
            if (JSON.stringify(this.session.draft) !== JSON.stringify(draft)) throw new Error('The draft changed during comparison. Compare again before applying.');
            const merged = resources.map(resource => compareCreatorChanges(resource.base, resource.local, resource.remote, resource.choices));
            if (merged.some(item => item.conflicts.length)) throw new Error('Choose a version for every conflicting field.');
            this.edit(next => {
                next.card = merged[0].value;
                next.additionalBooks = merged[1].value;
                next.source = { ...next.source, original: structuredClone(source.card), revision: source.revision, extraBooks: source.extraBooks };
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
