import * as api from './api.js';
import { getLabClient, prepareLabConnection, mountLabRecovery } from '../../../../labs-client.js';

const SETTINGS_KEY = 'SillyBunnyLorebookDistiller';
const NEW_BOOK = '__sbld_new__';
const CURRENT_CHAT = '__sbld_current__';

let popup = null;
let closing = null;

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text) {
        node.textContent = text;
    }
    return node;
}

function option(value, label) {
    const node = el('option', '', label);
    node.value = value;
    return node;
}

function labelled(labelText, control) {
    const wrapper = el('label', 'sbld-field');
    wrapper.append(el('span', 'sbld-field-label', labelText), control);
    return wrapper;
}

function getSettings(ctx) {
    const settings = ctx.extensionSettings ?? {};
    const stored = settings[SETTINGS_KEY];
    return stored && typeof stored === 'object' ? stored : (settings[SETTINGS_KEY] = {});
}

function saveSettings(ctx, patch) {
    Object.assign(getSettings(ctx), patch);
    ctx.saveSettingsDebounced?.();
}

function defaultBookName(ctx) {
    const character = ctx.characters?.[ctx.characterId];
    return character?.name ? `Distilled - ${character.name}` : 'Distilled lorebook';
}

function proposalCard(proposal) {
    const card = el('div', 'sbld-card');
    card.dataset.proposalId = String(proposal.id);
    const head = el('div', 'sbld-card-head');
    const include = el('input');
    include.type = 'checkbox';
    include.className = 'sbld-include';
    include.checked = !proposal.duplicateOf;
    include.setAttribute('aria-label', `Include "${proposal.title}"`);
    const title = el('input', 'text_pole sbld-title');
    title.type = 'text';
    title.value = proposal.title;
    title.setAttribute('aria-label', 'Entry title');
    head.append(include, title);
    if (proposal.duplicateOf) {
        head.append(el('span', 'sbld-badge sbld-badge-duplicate', `May duplicate "${proposal.duplicateOf}"`));
    }
    if (proposal.multiConcept) {
        head.append(el('span', 'sbld-badge', 'May mix two concepts'));
    }
    const keys = el('input', 'text_pole sbld-keys');
    keys.type = 'text';
    keys.value = proposal.keys.join(', ');
    keys.setAttribute('aria-label', 'Trigger keys, separated by commas');
    const content = el('textarea', 'text_pole sbld-content');
    content.rows = 3;
    content.value = proposal.content;
    content.setAttribute('aria-label', 'Entry content');
    card.append(head, labelled('Keys', keys), labelled('Content', content));
    return card;
}

function collectApproved(list) {
    const approved = [];
    for (const card of list.querySelectorAll('.sbld-card')) {
        if (!card.querySelector('.sbld-include')?.checked) {
            continue;
        }
        const title = card.querySelector('.sbld-title')?.value.trim() ?? '';
        const content = card.querySelector('.sbld-content')?.value.trim() ?? '';
        const keys = (card.querySelector('.sbld-keys')?.value ?? '')
            .split(',')
            .map(key => key.trim().toLowerCase())
            .filter(Boolean);
        if (title && content && keys.length) {
            approved.push({ id: Number(card.dataset.proposalId), title, content, keys, card });
        }
    }
    return approved;
}

export async function openDistiller(ctx, opener) {
    if (popup) {
        popup.dlg?.focus();
        return;
    }
    if (closing) {
        await closing;
    }

    const root = el('div', 'sbld-root');
    const heading = el('h2', 'sbld-heading', 'Lorebook Distiller');
    heading.id = 'sbld_heading';
    root.append(
        heading,
        el('p', 'sbld-note', 'Reads a saved chat and keeps proposed entries for review. Only the entries you approve are added to the lorebook.'),
    );

    const sourceSelect = el('select', 'text_pole sbld-select');
    sourceSelect.append(option(CURRENT_CHAT, 'Current chat'));
    const profileSelect = el('select', 'text_pole sbld-select');
    profileSelect.append(option('', 'Current connection'));
    for (const profile of api.listConnectionProfiles(ctx)) {
        profileSelect.append(option(profile.id, profile.name));
    }
    const bookSelect = el('select', 'text_pole sbld-select');
    const newBookName = el('input', 'text_pole sbld-new-name');
    newBookName.type = 'text';
    newBookName.placeholder = 'Name for the new lorebook';
    newBookName.value = defaultBookName(ctx);
    newBookName.setAttribute('aria-label', 'Name for the new lorebook');

    const settings = getSettings(ctx);
    if (settings.profileId && [...profileSelect.options].some(item => item.value === settings.profileId)) {
        profileSelect.value = settings.profileId;
    }

    const controls = el('div', 'sbld-controls');
    const distillButton = el('button', 'menu_button sbld-button', 'Distill this chat');
    distillButton.type = 'button';
    controls.append(
        labelled('Chat to distill', sourceSelect),
        labelled('Connection', profileSelect),
        labelled('Write into', bookSelect),
        labelled('New lorebook name', newBookName),
        distillButton,
    );
    const status = el('p', 'sbld-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Pick a chat and a lorebook, then distill.';
    const list = el('div', 'sbld-list');
    const applyButton = el('button', 'menu_button sbld-button sbld-apply', 'Add selected entries');
    applyButton.type = 'button';
    applyButton.hidden = true;
    root.append(controls, status, list, applyButton);

    function syncNewBookVisibility() {
        newBookName.parentElement.hidden = bookSelect.value !== NEW_BOOK;
    }

    function refreshBooks() {
        const books = api.listBooks(ctx);
        const previous = bookSelect.value || settings.targetBook || '';
        bookSelect.replaceChildren(option(NEW_BOOK, 'New lorebook...'));
        for (const name of books) {
            bookSelect.append(option(name, name));
        }
        bookSelect.value = books.includes(previous) ? previous : NEW_BOOK;
        syncNewBookVisibility();
    }
    refreshBooks();
    bookSelect.addEventListener('change', () => {
        syncNewBookVisibility();
        if (bookSelect.value !== NEW_BOOK) {
            saveSettings(ctx, { targetBook: bookSelect.value });
        }
    });
    profileSelect.addEventListener('change', () => saveSettings(ctx, { profileId: profileSelect.value }));

    const abort = new AbortController();
    const client = await getLabClient();
    mountLabRecovery(root, { signal: abort.signal });
    void api.listReadableChats(ctx, abort.signal).then((rows) => {
        for (const row of rows) {
            const character = (ctx.characters ?? []).find(item => item?.avatar === row.avatar);
            const name = character?.name ?? row.avatar.replace(/\.png$/, '');
            sourceSelect.append(option(
                JSON.stringify({ avatar: row.avatar, fileName: row.file_name }),
                `${name} - ${row.file_name.replace(/\.jsonl$/, '')}`,
            ));
        }
    }).catch((error) => {
        if (error?.name !== 'AbortError') {
            status.textContent = 'Older chats could not be listed; the current chat still works.';
        }
    });

    let busy = false;
    let resultTarget = null;
    const savedSelect = el('select', 'text_pole sbld-select');
    savedSelect.setAttribute('aria-label', 'Saved distillations');
    controls.append(labelled('Saved distillations', savedSelect));
    async function refreshSaved() {
        const records = await client.list('distill');
        if (abort.signal.aborted) return;
        const selected = savedSelect.value;
        savedSelect.replaceChildren(option('', 'Choose a saved distillation'));
        for (const record of records) savedSelect.append(option(record.key, `${new Date(record.createdAt).toLocaleString()} - ${record.state}`));
        savedSelect.value = selected;
    }
    function showResult(record) {
        if (abort.signal.aborted) return;
        resultTarget = record;
        const used = new Set(record.review?.usedIds ?? []);
        const proposals = record.result.proposals.filter(proposal => !used.has(proposal.id));
        list.replaceChildren(...proposals.map(proposalCard));
        applyButton.hidden = !proposals.length;
        status.textContent = proposals.length
            ? `Review ${proposals.length} proposed entries for '${record.result.target.name}'. Unticked entries are skipped.`
            : 'There are no remaining proposed entries to add.';
        if (record.result.failedChunks) status.textContent += ` ${record.result.failedChunks} parts returned no readable proposals.`;
    }
    const observation = { signal: abort.signal, onProgress: progress => {
        if (!abort.signal.aborted) status.textContent = `${progress?.stage || 'Working on the server'}${progress?.total ? ` (${progress.completed}/${progress.total})` : ''}...`;
    } };
    savedSelect.addEventListener('change', async () => {
        if (busy || !savedSelect.value) return;
        busy = true;
        distillButton.disabled = true;
        try { showResult(await client.observe(await client.read(savedSelect.value), observation)); }
        catch (error) { if (!abort.signal.aborted) status.textContent = error.message; }
        finally { busy = false; distillButton.disabled = false; }
    });
    void refreshSaved().catch(error => { if (!abort.signal.aborted) status.textContent = error.message; });
    distillButton.addEventListener('click', async () => {
        if (busy) {
            return;
        }
        const source = sourceSelect.value;
        const profileId = profileSelect.value;
        const createBook = bookSelect.value === NEW_BOOK;
        const requestedBook = createBook ? newBookName.value.trim() : bookSelect.value;
        if (!requestedBook) {
            status.textContent = 'Give the new lorebook a name first.';
            newBookName.focus();
            return;
        }
        busy = true;
        resultTarget = null;
        distillButton.disabled = true;
        applyButton.hidden = true;
        list.replaceChildren();
        try {
            status.textContent = 'Submitting saved chat for distillation...';
            const selected = source === CURRENT_CHAT ? null : JSON.parse(source);
            const currentLocator = current => current.groupId != null ? { group: true, chat: current.getCurrentChatId() }
                : { group: false, avatar: current.characters?.[current.characterId]?.avatar, chat: current.getCurrentChatId() };
            const locator = selected ? { group: false, avatar: selected.avatar, chat: selected.fileName.replace(/\.jsonl$/, '') }
                : currentLocator(SillyTavern.getContext());
            const record = await client.run('distill', { locator, book: requestedBook, create: createBook, profileId }, {
                ...observation, prepareInput: async input => {
                    if (source === CURRENT_CHAT) {
                        const current = SillyTavern.getContext();
                        const before = currentLocator(current);
                        if (JSON.stringify(before) !== JSON.stringify(input.locator)) throw new Error('The selected chat changed. Choose it again.');
                        await current.saveChat();
                        if (JSON.stringify(currentLocator(SillyTavern.getContext())) !== JSON.stringify(before)) {
                            throw new Error('The selected chat changed while saving. Choose it again.');
                        }
                    }
                    return prepareLabConnection(input);
                },
            });
            showResult(record);
            await refreshSaved();
            savedSelect.value = record.key;
        } catch (error) {
            if (!abort.signal.aborted && error?.name !== 'AbortError') {
                status.textContent = `Distilling failed: ${error?.message ?? error}`;
            }
        } finally {
            busy = false;
            if (!abort.signal.aborted) {
                distillButton.disabled = false;
            }
        }
    });

    applyButton.addEventListener('click', async () => {
        if (busy) {
            return;
        }
        const approved = collectApproved(list);
        if (!approved.length) {
            status.textContent = 'Nothing is ticked. Tick the entries you want, or close.';
            return;
        }
        if (!resultTarget) {
            status.textContent = 'Distill the chat again before saving these entries.';
            return;
        }
        const bookName = resultTarget.result.target.name;
        busy = true;
        applyButton.disabled = true;
        let savedResult;
        try {
            status.textContent = `Saving ${approved.length} ${approved.length === 1 ? 'entry' : 'entries'} to "${bookName}"...`;
            const applied = await client.run('apply', { proposalKey: resultTarget.key, resultHash: resultTarget.resultHash,
                selected: approved.map(({ id, title, content, keys }) => ({ id, title, content, keys })) },
            { ...observation, scope: `apply:${resultTarget.key}` });
            const saved = applied.result;
            savedResult = saved;
            showResult(await client.read(resultTarget.key));
            await ctx.updateWorldInfoList?.();
            saveSettings(ctx, { targetBook: saved.name });
            refreshBooks();
            if (![...bookSelect.options].some(item => item.value === saved.name)) {
                bookSelect.append(option(saved.name, saved.name));
            }
            bookSelect.value = saved.name;
            syncNewBookVisibility();
            status.textContent = `Added ${saved.selected.length} entries to '${saved.name}'.`;
            if (!list.children.length) {
                applyButton.hidden = true;
                resultTarget = null;
            }
        } catch (error) {
            status.textContent = savedResult
                ? `The entries were saved to '${savedResult.name}'. Reload the lorebook to see them. ${error?.message ?? error}`
                : `The entries could not be saved: ${error?.message ?? error}`;
        } finally {
            busy = false;
            applyButton.disabled = false;
        }
    });

    const instance = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
    });
    popup = instance;
    instance.dlg?.classList.add('sbld-dialog');
    instance.dlg?.setAttribute('aria-labelledby', 'sbld_heading');
    try {
        await instance.show();
    } finally {
        abort.abort();
        if (popup === instance) {
            popup = null;
        }
        if (opener?.isConnected) {
            opener.focus({ preventScroll: true });
        }
    }
}

export function closeDistiller() {
    const instance = popup;
    if (!instance) {
        return closing ?? Promise.resolve();
    }
    const operation = Promise.resolve(instance.completeCancelled?.()).catch(() => {});
    closing = operation;
    operation.then(() => {
        if (closing === operation) {
            closing = null;
        }
    });
    return operation;
}
