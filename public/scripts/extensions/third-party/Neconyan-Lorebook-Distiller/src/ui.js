import * as api from './api.js';
import {
    buildDistillPrompt,
    chunkLines,
    markDuplicates,
    mergeProposals,
    messageLines,
    normalizeProposals,
    parseProposals,
} from './core.js';

const SETTINGS_KEY = 'SillyBunnyLorebookDistiller';
const NEW_BOOK = '__sbld_new__';
const CURRENT_CHAT = '__sbld_current__';
// ponytail: named profiles expose no context limit; replace this fallback when the host does.
const PROFILE_CONTEXT_FALLBACK = 4096;
const TOKEN_SAFETY_MARGIN = 512;

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
            approved.push({ title, content, keys, card });
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
        el('p', 'sbld-note', 'Reads a chat, proposes one-concept lorebook entries, and writes only the ones you approve. Nothing is saved without your say-so.'),
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
            status.textContent = 'Reading the chat...';
            const messages = source === CURRENT_CHAT
                ? api.currentChatMessages(ctx)
                : await api.readChatFile(ctx, JSON.parse(source), abort.signal);
            const lines = messageLines(messages, { userName: ctx.name1, characterName: ctx.name2 });
            if (!lines.length) {
                status.textContent = 'This chat has no messages to distill.';
                return;
            }
            const target = await api.prepareBook(ctx, requestedBook, { create: createBook, signal: abort.signal });
            if (abort.signal.aborted) {
                return;
            }
            const configuredContext = Number(ctx.maxContext);
            const contextLimit = profileId
                ? PROFILE_CONTEXT_FALLBACK
                : Number.isFinite(configuredContext) && configuredContext > 0
                    ? configuredContext
                    : PROFILE_CONTEXT_FALLBACK;
            const promptBudget = Math.floor(contextLimit - api.MODEL_RESPONSE_TOKENS - TOKEN_SAFETY_MARGIN);
            if (promptBudget < 1) {
                throw new Error('The selected connection context is too small for a distillation response.');
            }
            const chunks = await chunkLines(
                lines,
                text => ctx.getTokenCountAsync(text),
                promptBudget,
                buildDistillPrompt,
            );
            if (abort.signal.aborted) {
                return;
            }
            const collected = [];
            let failedChunks = 0;
            for (const [index, chunk] of chunks.entries()) {
                if (abort.signal.aborted) {
                    return;
                }
                status.textContent = chunks.length === 1
                    ? 'Asking the model for entries...'
                    : `Asking the model for entries (part ${index + 1} of ${chunks.length})...`;
                const prompt = buildDistillPrompt(chunk);
                try {
                    const reply = await api.runModel(ctx, prompt, {
                        profileId,
                        responseLength: api.MODEL_RESPONSE_TOKENS,
                        signal: abort.signal,
                    });
                    if (abort.signal.aborted) {
                        return;
                    }
                    collected.push(...parseProposals(reply));
                } catch (error) {
                    if (abort.signal.aborted || error?.name === 'AbortError') {
                        return;
                    }
                    failedChunks++;
                    console.error('[Lorebook Distiller] chunk failed:', error);
                }
            }

            const { proposals, dropped } = normalizeProposals(collected);
            const reviewed = markDuplicates(mergeProposals(proposals), target.entries);
            if (!reviewed.length) {
                status.textContent = failedChunks
                    ? `No entries came back, and ${failedChunks} of ${chunks.length} parts failed. Try again or pick another connection.`
                    : 'The model found nothing durable worth keeping in this chat.';
                return;
            }
            resultTarget = { name: target.name, create: createBook };
            for (const proposal of reviewed) {
                list.append(proposalCard(proposal));
            }
            applyButton.hidden = false;
            const notes = [];
            if (failedChunks) {
                notes.push(`${failedChunks} of ${chunks.length} parts failed and are not included`);
            }
            if (dropped) {
                notes.push(`${dropped} unusable ${dropped === 1 ? 'proposal was' : 'proposals were'} discarded`);
            }
            status.textContent = `Review ${reviewed.length} proposed ${reviewed.length === 1 ? 'entry' : 'entries'} for "${target.name}". Unticked ones are skipped.${notes.length ? ` (${notes.join('; ')}.)` : ''}`;
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
        const bookName = resultTarget.name;
        busy = true;
        applyButton.disabled = true;
        try {
            status.textContent = `Saving ${approved.length} ${approved.length === 1 ? 'entry' : 'entries'} to "${bookName}"...`;
            const saved = await api.appendEntries(ctx, bookName, approved, { create: resultTarget.create });
            approved.forEach(item => item.card.remove());
            resultTarget = { name: saved.name, create: false };
            saveSettings(ctx, { targetBook: saved.name });
            refreshBooks();
            if (![...bookSelect.options].some(item => item.value === saved.name)) {
                bookSelect.append(option(saved.name, saved.name));
            }
            bookSelect.value = saved.name;
            syncNewBookVisibility();
            status.textContent = `Added ${approved.length} ${approved.length === 1 ? 'entry' : 'entries'} to "${saved.name}".${saved.refreshError ? ' The host lorebook list could not be refreshed.' : ''}`;
            if (!list.children.length) {
                applyButton.hidden = true;
                resultTarget = null;
            }
        } catch (error) {
            status.textContent = `The entries could not be saved: ${error?.message ?? error}`;
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
