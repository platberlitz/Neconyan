import { getRequestHeaders, adoptServerSettingsWrite, saveSettings } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { createCreatorDraft, validateCreatorDraft } from './model.js';

/** Each workspace owns its account, source and request queue, independently of the active chat. */
export class CreatorSession {
    constructor() {
        this.owner = getCurrentUserHandle();
        this.draft = null;
        this.revision = null;
        this.pending = null;
        this.queue = Promise.resolve();
    }

    assertOwner() {
        if (this.owner !== getCurrentUserHandle()) throw new Error('The account changed. Reopen Creator before continuing.');
    }

    async request(path, body = {}) {
        this.assertOwner();
        const response = await fetch(`/api/creator/${path}`, {
            method: 'POST', cache: 'no-store',
            headers: { ...getRequestHeaders(), 'X-Neconyan-Account': this.owner },
            body: JSON.stringify(body),
        });
        this.assertOwner();
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.message || 'Creator could not finish this request.'), { status: response.status, code: result.code });
        if (result.owner !== this.owner) throw new Error('The account changed. Reopen Creator.');
        return result;
    }

    get recoveryKey() { return `neconyan.creator.recovery:${encodeURIComponent(this.owner)}`; }

    remember() {
        this.assertOwner();
        // A browser quota failure must not prevent the account-scoped server save.
        try {
            localStorage.setItem(this.recoveryKey, JSON.stringify({ draft: this.draft, revision: this.revision, pending: this.pending }));
            this.localRecoveryError = false;
        } catch {
            this.localRecoveryError = true;
        }
    }

    recovery(previous = false) {
        this.assertOwner();
        const value = JSON.parse(localStorage.getItem(`${this.recoveryKey}${previous ? ':previous' : ''}`) || 'null');
        if (value?.draft) validateCreatorDraft(value.draft);
        return value;
    }

    async open(id) {
        await this.queue;
        const openingDraft = this.draft;
        const openingRevision = this.revision;
        const recovery = this.draft ? { draft: this.draft, revision: this.revision, pending: this.pending } : this.recovery();
        const result = await this.request('get', { id });
        let savedRecovery = result;
        if (recovery?.draft && recovery.draft.id !== id) {
            try { savedRecovery = await this.request('get', { id: recovery.draft.id }); } catch (error) { if (error.status !== 404) throw error; savedRecovery = null; }
        }
        const content = draft => JSON.stringify(draft ? { ...draft, view: undefined } : null);
        if (this.draft !== openingDraft || this.revision !== openingRevision) throw new Error('Your local draft changed while opening another version. Save it or export a backup, then try again.');
        if (recovery?.draft && content(recovery.draft) !== content(savedRecovery?.draft)) {
            // Keep the previous local version separately before replacing the only
            // recovery slot, including when opening another account draft.
            try {
                const previous = this.recovery(true);
                if (previous && JSON.stringify(previous) !== JSON.stringify(recovery)) throw new Error('A previous local version is already retained.');
                localStorage.setItem(`${this.recoveryKey}:previous`, JSON.stringify(recovery));
            } catch { throw new Error('Export your local draft and recover or clear the previous local version before opening another version; recovery storage could not retain both.'); }
        }
        this.draft = result.draft;
        this.revision = result.revision;
        this.pending = result.publication ?? null;
        this.remember();
    }

    async create(avatar = null) {
        await this.queue;
        if (this.draft) await this.save();
        if (avatar) {
            const { drafts } = await this.request('list');
            const existing = drafts.filter(item => item.avatar === avatar).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
            if (existing) { await this.open(existing.id); return; }
        }
        if (avatar && !await saveSettings(0, { returnResult: true })) throw new Error('Save your current settings before opening this character.');
        const source = avatar ? await this.request('character', { avatar }) : {};
        const draft = createCreatorDraft({ id: crypto.randomUUID(), ...source });
        const embedded = draft.card.data.character_book;
        if (Array.isArray(embedded?.entries)) {
            const { convertCharacterBook } = await import('../world-info.js');
            const data = convertCharacterBook(embedded);
            draft.books.push({ id: crypto.randomUUID(), name: embedded.name || 'Portable lorebook', mode: 'embedded', data, original: structuredClone(data), revision: null });
        }
        const linkedName = draft.card.data.extensions?.world;
        if (linkedName) {
            try {
                const linked = await this.request('book', { name: linkedName });
                draft.books.push({ id: crypto.randomUUID(), ...linked, mode: 'linked', original: structuredClone(linked.data) });
            } catch (error) {
                if (error.status !== 404) throw error;
                draft.missingBooks = [linkedName];
            }
        }
        for (const name of draft.additionalBooks) {
            if (draft.books.some(book => book.name === name && book.mode !== 'embedded')) continue;
            try {
                const linked = await this.request('book', { name });
                draft.books.push({ id: crypto.randomUUID(), ...linked, mode: 'linked', original: structuredClone(linked.data) });
            } catch (error) {
                if (error.status !== 404) throw error;
                (draft.missingBooks ??= []).push(name);
            }
        }
        this.draft = draft;
        this.revision = null;
        this.pending = null;
        this.remember();
        await this.save();
    }

    restore(value) {
        this.assertOwner();
        this.draft = validateCreatorDraft(structuredClone(value.draft));
        this.revision = value.revision;
        this.pending = value.pending;
    }

    save() {
        this.assertOwner();
        this.remember();
        const draft = structuredClone(this.draft);
        const action = async () => {
            if (this.draft?.id !== draft.id) throw new Error('The draft changed before it could be saved.');
            const result = await this.request('save', { draft, expectedRevision: this.revision });
            this.revision = result.revision;
            this.remember();
            return result;
        };
        const task = this.queue.then(action);
        this.queue = task.catch(() => {});
        return task;
    }

    async publish(copy = false) {
        if (this.publishing) throw new Error('A save is already in progress.');
        this.publishing = true;
        try {
            return await this.publishFrozen(copy);
        } finally { this.publishing = false; }
    }

    async recoverPublication() {
        if (!this.pending || this.publishing) throw new Error('Wait for the current save before recovering it.');
        await this.queue;
        const result = await this.request('recover', { id: this.draft.id, operationId: this.pending.operationId, expectedRevision: this.revision });
        this.draft = result.draft;
        this.revision = result.revision;
        this.pending = null;
        this.remember();
        await this.refreshPublishedResources(result.draft.journal);
    }

    async refreshPublishedResources(result) {
        if (!result) return;
        try {
            const { world_info, invalidateWorldInfoCache, updateWorldInfoList } = await import('../world-info.js');
            this.assertOwner();
            if (result.binding?.state === 'done') {
                const filename = result.avatar.replace(/\.[^.]+$/, '');
                const entries = world_info.charLore ??= [];
                const index = entries.findIndex(item => item.name === filename);
                if (!result.binding.books.length) {
                    if (index >= 0) entries.splice(index, 1);
                } else if (index >= 0) entries[index].extraBooks = [...result.binding.books];
                else entries.push({ name: filename, extraBooks: [...result.binding.books] });
                if (result.binding.settingsWrite) adoptServerSettingsWrite({ account: this.owner, ...result.binding.settingsWrite });
            }
            const books = (result.books ?? []).filter(book => book.state === 'done');
            for (const book of books) invalidateWorldInfoCache(book.name);
            if (books.length && await updateWorldInfoList() === false) throw new Error('The lorebook list could not be refreshed.');
        } catch {
            result.refreshWarning = 'Saved resources retained. Reload the page to refresh the lorebook list.';
        }
        this.assertOwner();
    }

    async publishFrozen(copy) {
        if (this.pending && this.revision !== this.pending.expectedRevision) {
            const journal = this.draft.journal;
            if (journal?.operationId === this.pending.operationId && this.draft.source.avatar === journal.avatar && this.draft.source.revision === journal.revision) {
                // Adoption already succeeded before an acknowledgement was lost.
                // Acknowledge that identity without replacing any subsequent edits.
                await this.refreshPublishedResources(journal);
                await this.request('acknowledge', { id: this.draft.id, operationId: journal.operationId });
                this.pending = null;
                this.remember();
                return journal;
            }
            throw new Error('This draft contains edits made after the library save started. Use Recover for comparison to keep those edits.');
        }
        if (!this.pending) {
            if (!await saveSettings(0, { returnResult: true })) throw new Error('Save your current settings before publishing this character.');
            await this.save();
            this.pending = { id: this.draft.id, expectedRevision: this.revision, operationId: crypto.randomUUID(), copy };
            this.remember();
        }
        const adoptingRevision = this.revision;
        let result;
        try {
            result = await this.request('publish', this.pending);
            this.pending.operationId = result.operationId;
            this.remember();
            await this.refreshPublishedResources(result);
        } catch (error) {
            // Only a definitive missing receipt proves that no resource was committed.
            try {
                const receipt = await this.request('receipt', this.pending);
                this.pending.operationId = receipt.operationId;
                this.remember();
                await this.refreshPublishedResources(receipt);
            } catch (receiptError) {
                if (receiptError.status === 404) { this.pending = null; this.remember(); }
            }
            throw error;
        }
        // Read every committed resource before changing the local baseline. A later
        // library edit must never acquire a fresh revision beside our older text.
        const source = await this.request('character', { avatar: result.avatar });
        if (source.revision !== result.revision) throw new Error('The save completed, but the character changed again. Your draft and save receipt are retained. Reopen the library character to compare it.');
        const next = structuredClone(this.draft);
        for (const book of next.books) {
            if (!book.detached && (book.mode === 'copy' || book.mode === 'linked')) {
                const committed = result.books.find(item => item.id ? item.id === book.id : item.name === book.name);
                const current = await this.request('book', { name: committed?.name ?? book.name });
                if (!committed || current.revision !== committed.revision) throw new Error(`The save completed, but ${book.name} changed again. Your draft and save receipt are retained.`);
                book.mode = 'linked';
                book.name = current.name;
                book.revision = current.revision;
                book.original = structuredClone(current.data);
            }
        }
        // Keep the operation until the source and draft acknowledge the committed identity.
        next.source = { avatar: source.avatar, revision: source.revision, original: structuredClone(source.card), extraBooks: source.extraBooks };
        next.card = structuredClone(source.card);
        next.additionalBooks = structuredClone(source.extraBooks ?? []);
        next.journal = result;
        next.history = [];
        next.future = [];
        // Conditional server adoption happens before replacing local work. A remote
        // edit during readback remains recoverable and cannot acquire our receipt.
        const adopted = await this.request('save', { draft: next, expectedRevision: adoptingRevision });
        this.draft = next;
        this.revision = adopted.revision;
        this.remember();
        await this.request('acknowledge', { id: next.id, operationId: result.operationId });
        this.pending = null;
        this.remember();
        return result;
    }
}
