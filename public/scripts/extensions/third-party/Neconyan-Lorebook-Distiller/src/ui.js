import * as api from './api.js';
import { getLabClient, prepareLabConnection, mountLabRecovery } from '../../../../labs-client.js';

const SETTINGS_KEY = 'NeconyanLorebookDistiller';
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

function setShown(node, shown) {
    node.hidden = !shown;
    node.style.display = shown ? '' : 'none';
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
    setShown(applyButton, false);
    const recoveryActions = el('div', 'sbld-actions');
    const technicalDetails = el('details');
    setShown(technicalDetails, false);
    const technicalText = el('p');
    technicalDetails.append(el('summary', '', 'Request details'), technicalText);
    const retryButton = el('button', 'menu_button menu_button_primary', 'Try again with current selections');
    const checkButton = el('button', 'menu_button', 'Check previous request');
    const stopButton = el('button', 'menu_button', 'Stop');
    for (const button of [retryButton, checkButton, stopButton]) button.type = 'button';
    for (const button of [retryButton, checkButton, stopButton]) setShown(button, false);
    recoveryActions.append(retryButton, checkButton, stopButton);
    root.append(controls, status, recoveryActions, technicalDetails, list, applyButton);

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
    let runningController = null;
    let previousRecord = null;
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
        setShown(applyButton, Boolean(proposals.length));
        status.textContent = proposals.length
            ? `Review ${proposals.length} proposed entries for '${record.result.target.name}'. Unticked entries are skipped.`
            : 'There are no remaining proposed entries to add.';
        if (record.result.failedChunks) status.textContent += ` ${record.result.failedChunks} parts returned no readable proposals.`;
        if (record.result.incomplete) status.textContent += ' This is a partial result from the earlier request; other parts were stopped.';
    }
    const observation = { signal: abort.signal, onProgress: progress => {
        if (!abort.signal.aborted) status.textContent = `${progress?.stage || 'Working on the server'}${progress?.total ? ` (${progress.completed}/${progress.total})` : ''}...`;
    } };
    function showPrevious(record) {
        previousRecord = record;
        const uncertain = record?.state !== 'completed' && (record?.lifecycle?.uncertain || record?.state === 'preparing' && !record?.jobId);
        setShown(retryButton, Boolean(uncertain));
        setShown(checkButton, Boolean(record));
        setShown(stopButton, Boolean(record?.jobId) && !record.lifecycle?.retired && record.state !== 'completed');
        distillButton.disabled = busy || Boolean(uncertain);
        if (!record) { setShown(technicalDetails, false); return; }
        const details = [record.lifecycle?.error?.status ? `HTTP ${record.lifecycle.error.status}` : '', record.lifecycle?.error?.code,
            `request ${record.key}`, record.jobId ? `job ${record.jobId}` : ''].filter(Boolean);
        technicalText.textContent = details.join('; ');
        setShown(technicalDetails, true);
        if (record.state === 'completed') { showResult(record); return; }
        if (record.partial?.proposals?.length) {
            list.replaceChildren(...record.partial.proposals.map(proposalCard));
            setShown(applyButton, false);
        }
        status.textContent = uncertain
            ? `${record.state === 'preparing' ? 'The earlier acceptance is incomplete. ' : ''}The previous request may still be processing, or its reply may have been lost. Trying again may use tokens again.`
            : record.lifecycle?.removed ? record.lifecycle.reason === 'cleared' ? 'The previous job was cleared. You can distill with current selections.'
                : 'The previous job is no longer available. You can distill with current selections.'
                : record.lifecycle?.retired ? `Previous distillation: ${record.error || record.lifecycle.reason}. You can distill with current selections.`
                    : 'The previous distillation is still on the server. Check its progress or stop it.';
    }
    function reportDistillError(error) {
        if (abort.signal.aborted || error?.name === 'AbortError') return;
        if (error.record) {
            showPrevious(error.record);
            if (error.phase === 'generation') {
                const message = String(error.generationMessage || error.record.error || 'No completed result was saved').replace(/\.\s*$/, '');
                const guidance = error.record.lifecycle?.uncertain || error.record.lifecycle?.removed
                    ? status.textContent : 'You can distill with current selections.';
                status.textContent = `The distillation failed while generating: ${message}. ${guidance}`;
            }
        } else {
            const prefix = error.phase === 'submission' ? 'The distillation could not be submitted'
                : error.phase === 'generation' ? 'The distillation failed while generating' : 'The previous request could not be checked';
            status.textContent = `${prefix}: ${error.message}`;
            if (error.phase === 'submission' && !error.uncertain) status.textContent += ' Check the selected chat, lorebook and connection, then try Distill again.';
            if (error.uncertain || error.phase === 'observation') {
                status.textContent += ' The previous request may still be processing, or its reply may have been lost. Trying again may use tokens again.';
                setShown(retryButton, true); setShown(checkButton, true);
            }
        }
        const details = [error.status ? `HTTP ${error.status}` : '', error.serverCode || error.code,
            error.requestKey ? `request ${error.requestKey}` : '', error.jobId ? `job ${error.jobId}` : ''].filter(Boolean);
        setShown(technicalDetails, Boolean(details.length));
        technicalText.textContent = details.join('; ');
    }
    async function refreshPrevious() {
        if (busy || abort.signal.aborted) return;
        try {
            const record = await client.distillStatus();
            if (!abort.signal.aborted && !busy) showPrevious(record);
            await refreshSaved();
        } catch (error) { if (!busy) reportDistillError(error); }
    }
    checkButton.addEventListener('click', () => void refreshPrevious());
    stopButton.addEventListener('click', async () => {
        if (runningController) { runningController.abort('user-stop'); return; }
        if (!previousRecord?.jobId) return;
        try {
            await client.request(`/api/jobs/${encodeURIComponent(previousRecord.jobId)}/cancel`, { method: 'POST', body: '{}' });
            await refreshPrevious();
        } catch (error) { reportDistillError(Object.assign(error, { phase: 'observation' })); }
    });
    window.addEventListener('storage', () => void refreshPrevious(), { signal: abort.signal });
    window.addEventListener('focus', () => void refreshPrevious(), { signal: abort.signal });
    savedSelect.addEventListener('change', async () => {
        if (busy || !savedSelect.value) return;
        busy = true;
        distillButton.disabled = true;
        try {
            const saved = await client.read(savedSelect.value);
            if (saved.lifecycle?.retired && saved.state !== 'completed') {
                resultTarget = null;
                setShown(applyButton, false);
                list.replaceChildren(...(saved.partial?.proposals ?? []).map(proposalCard));
                status.textContent = saved.partial?.proposals?.length
                    ? 'Partial proposals from an earlier distillation. They remain saved; this view does not start or replace work.'
                    : `Earlier distillation: ${saved.error || saved.lifecycle.reason}.`;
                if (saved.lifecycle.uncertain) status.textContent += ' Its request may still be processing, or its reply may have been lost.';
            } else showResult(await client.observe(saved, observation));
        } catch (error) { if (!abort.signal.aborted) status.textContent = error.message; } finally { busy = false; distillButton.disabled = !retryButton.hidden; }
    });
    void refreshPrevious();
    async function distill(retryUncertain = false) {
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
        runningController = new AbortController();
        const closeObservation = () => runningController?.abort();
        abort.signal.addEventListener('abort', closeObservation, { once: true });
        resultTarget = null;
        distillButton.disabled = true;
        retryButton.disabled = true;
        setShown(retryButton, false); setShown(checkButton, false); setShown(stopButton, true);
        setShown(applyButton, false);
        list.replaceChildren();
        let finalError = null;
        try {
            status.textContent = 'Submitting saved chat for distillation...';
            setShown(technicalDetails, false);
            const selected = source === CURRENT_CHAT ? null : JSON.parse(source);
            const currentLocator = current => current.groupId != null ? { group: true, chat: current.getCurrentChatId() }
                : { group: false, avatar: current.characters?.[current.characterId]?.avatar, chat: current.getCurrentChatId() };
            const locator = selected ? { group: false, avatar: selected.avatar, chat: selected.fileName.replace(/\.jsonl$/, '') }
                : currentLocator(SillyTavern.getContext());
            const record = await client.runDistill({ locator, book: requestedBook, create: createBook, profileId }, {
                ...observation, signal: runningController.signal, retryUncertain, expectedPreviousKey: previousRecord?.key, prepareInput: async input => {
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
            finalError = error;
            reportDistillError(error);
        } finally {
            abort.signal.removeEventListener('abort', closeObservation);
            runningController = null;
            busy = false;
            retryButton.disabled = false;
            setShown(stopButton, false);
            if (!abort.signal.aborted) {
                distillButton.disabled = !retryButton.hidden;
                if (finalError?.name === 'AbortError') await refreshPrevious();
            }
        }
    }
    distillButton.addEventListener('click', () => void distill());
    retryButton.addEventListener('click', () => void distill(true));

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
                setShown(applyButton, false);
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
