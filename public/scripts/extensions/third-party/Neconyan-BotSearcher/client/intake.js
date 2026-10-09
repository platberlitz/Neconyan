/**
 * The intake screen: what a card actually contains, before it joins the collection.
 *
 * Everything shown here is derived from the card's own bytes, not from what the
 * listing claimed — that distinction is the point of the screen, and the two are
 * shown side by side when they disagree.
 *
 * The same rule as the rest of the extension applies to every value: it was
 * written by a stranger, so it is written to the DOM through setText() and
 * never as markup. Counts and flags are reported; lorebook text, script bodies
 * and macro arguments are the card's content and are not reproduced. The card's
 * own text does reach this screen — the token cost has to be measured with the
 * host tokenizer, which needs the text — but it is counted and discarded, never
 * rendered.
 *
 * Structural validation is not a safety verdict, and the screen says so rather
 * than implying that a card with an empty findings list is safe to run.
 */

import { el, setLinkSafe, setText } from './render.js';
import {
    cleanBytes,
    commitPreparedCardImport,
    fetchUrlCard,
    fetchNativeCardBytes,
    importCard,
    inspectBytes,
    openCharacter,
    prepareCardImport,
    readCharacterRevision,
    readCollection,
    readLocalCardFile,
    removeCharacter,
} from './importer.js';
import { botbooruAccountControl, jannyBrowserControl, saucepanAccountControl } from './settings.js';
import {
    additionalImportContents,
    bulkImportSummary,
    cleanKeeps,
    cleanPlan,
    duplicateMessage,
    formatCount,
    importErrorMessage,
    INTAKE_COPY,
    intakeCompletionMessage,
    JANNY_CARD_ERRORS,
    intakeErrorMessage,
    intakeIdentity,
    intakeSections,
    intakeScanWarning,
    tokenFootprint,
    undoErrorMessage,
} from './copy.js';

/** Fields compared against an installed copy, in the order they are listed. */
const COMPARED_FIELDS = Object.freeze([
    ['description', 'description', 'description'],
    ['personality', 'personality', 'personality'],
    ['scenario', 'scenario', 'scenario'],
    ['firstMessage', 'first_mes', 'first message'],
    ['messageExample', 'mes_example', 'example messages'],
    ['systemPrompt', 'system_prompt', 'system prompt'],
    ['postHistoryInstructions', 'post_history_instructions', 'post-history instructions'],
]);

function context() {
    return globalThis.SillyTavern.getContext();
}

const screens = new WeakMap();
let nextScreenId = 0;

function beginScreen(container, externalSignal) {
    screens.get(container)?.abort();
    const controller = new AbortController();
    screens.set(container, controller);
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    return {
        signal,
        current: () => !signal.aborted && screens.get(container) === controller && container.isConnected,
        abort: () => controller.abort(),
    };
}

function setCommitBusy(container, screen, busy) {
    if (!screen.current()) {
        return;
    }
    container.dataset.committing = String(busy);
    for (const button of container.querySelectorAll('.sbbs-back, .sbbs-intake-back')) {
        button.disabled = busy;
    }
}

/**
 * @param {HTMLElement} container the #sbbs_intake node
 * @param {{ card?: any, source?: any, file?: File }} request where the card is coming from
 * @param {() => void} onBack
 * @param {{ signal?: AbortSignal, direct?: boolean, prepared?: {file: File, kind: string}, onImported?: (receipt: object) => void, onUndone?: (receipt: object) => void }} [options] `direct` skips the
 *   report and imports as soon as the bytes are in hand, unless a character of
 *   the same name is already installed, or inspection/collection state is unknown.
 * `onImported` also receives completed writes after disposal; it must not paint
 * an old screen. Batch review uses it to retain the operation's receipt.
 */
export async function showIntake(container, request, onBack, options = {}) {
    if (options.signal?.aborted) {
        return;
    }
    const screen = beginScreen(container, options.signal);
    const { signal } = screen;
    const { direct = false } = options;
    container.replaceChildren();
    container.dataset.committing = 'false';

    const leave = () => {
        if (screen.current()) {
            screen.abort();
            onBack();
        }
    };
    const back = backButton(leave);
    // Named after the button that opens it, so the transition explains itself.
    container.append(header(back), el('h2', 'sbbs-intake-title', direct ? 'Import' : 'Review and import'));

    const status = el('div', 'sbbs-state', 'Fetching the card...');
    status.setAttribute('role', 'status');
    container.append(status);
    back.focus();

    let staged;
    try {
        staged = await stage(request, signal, (text) => {
            if (screen.current()) {
                setText(status, text);
            }
        }, options.prepared);
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            return;
        }
        if (screen.current()) {
            showNotInspected(container, status, request, error, leave, screen, {
                ...options,
                retry: () => showIntake(container, request, onBack, options),
            });
        }
        return;
    }

    if (!screen.current()) {
        return;
    }

    const { prepared, inside, found } = staged;

    // Skipping the review is a preference; adding a second copy of an installed
    // character, or importing blind when the collection could not be read, is
    // not one it covers. Those land on the full screen.
    if (direct && found === null && inside.scan?.complete === true) {
        await importDirect(container, status, prepared, inside, request, leave, screen, {
            ...options,
            onReview: () => showIntake(container, request, onBack, { ...options, direct: false, prepared }),
        });
        return;
    }

    status.remove();
    const body = el('div', 'sbbs-intake-body');

    // ---- identity ----
    const name = inside.name || request.card?.name || prepared.file.name;
    body.append(el('h3', 'sbbs-intake-name', name));

    const identity = intakeIdentity(inside);
    if (identity) {
        body.append(el('div', 'sbbs-intake-identity', identity));
    }

    const origin = originLine(request, inside);
    if (origin.length > 0) {
        const list = el('dl', 'sbbs-intake-origin');
        for (const row of origin) {
            list.append(el('dt', undefined, row.label), el('dd', undefined, row.value));
        }
        body.append(list);
    }

    // ---- already installed? ----
    const duplicate = el('p', found ? 'sbbs-intake-duplicate sbbs-intake-warn' : 'sbbs-intake-duplicate');
    setText(duplicate, duplicateMessage(found));
    body.append(duplicate);

    const scanWarning = intakeScanWarning(inside);
    if (scanWarning) {
        const warning = el('p', 'sbbs-intake-warn sbbs-intake-scan-warning', scanWarning);
        warning.setAttribute('role', 'status');
        body.append(warning);
    }

    // ---- what the listing did not mention ----
    // The gap between the two is worth stating on its own. A card carrying a
    // system prompt the listing never advertised is a different proposition from
    // one that said so up front, and the full report below does not make that
    // difference obvious on its own.
    const undisclosed = additionalImportContents(inside, request.card?.inside);
    if (undisclosed) {
        body.append(el('p', 'sbbs-intake-undisclosed', undisclosed));
    }

    // ---- what this card costs ----
    const footprint = el('p', 'sbbs-intake-tokens', 'Measuring token cost...');
    const footprintRows = el('dl', 'sbbs-intake-list');
    body.append(el('h4', 'sbbs-intake-section', 'Token cost'), footprint, footprintRows);
    void countTokens(inside).then((counts) => {
        if (!screen.current()) {
            return;
        }
        const { headline, rows } = tokenFootprint(counts);
        setText(footprint, headline);
        for (const entry of rows) {
            footprintRows.append(el('dt', undefined, entry.label), el('dd', undefined, entry.value));
        }
    });

    // ---- the report ----
    const sections = intakeSections(inside);
    if (sections.length === 0 && inside.scan?.complete === true) {
        body.append(el('p', 'sbbs-intake-empty', 'No lorebook, scripts, prompts or external references were found in these bytes.'));
    }
    for (const section of sections) {
        body.append(el('h4', 'sbbs-intake-section', section.title));
        const list = el('dl', 'sbbs-intake-list');
        for (const row of section.rows) {
            const term = el('dt', row.tone ? `sbbs-intake-${row.tone}` : undefined, row.label);
            list.append(term, el('dd', undefined, row.value));
        }
        body.append(list);
    }

    body.append(el(
        'p',
        'sbbs-trust-note',
        'This describes the bytes that would be imported. It does not establish that the card\'s instructions are safe or appropriate.',
    ));

    container.append(body);
    container.append(actionBar(container, prepared, inside, found, duplicate, leave, screen, options));
}

/**
 * Everything that happens before the user decides: bytes, report, and whether
 * a character of that name is already installed. Nothing here imports.
 *
 * @param {{ card?: any, source?: any, file?: File, url?: string }} request
 * @param {AbortSignal | undefined} signal
 * @param {(text: string) => void} onStep
 * @returns {Promise<{ prepared: { file: File, kind: string }, inside: any, found: any }>}
 */
async function stage(request, signal, onStep, retained) {
    signal?.throwIfAborted();
    const prepared = retained ?? await loadBytes(request, signal);
    signal?.throwIfAborted();
    onStep('Inspecting the card...');
    const report = prepared.report ?? await inspectBytes(prepared.file, { signal });
    signal?.throwIfAborted();
    const inside = report?.inside;
    if (!inside || typeof inside !== 'object' || Array.isArray(inside)) {
        throw new Error('card_invalid');
    }
    const found = await findInstalled(inside, signal);
    signal?.throwIfAborted();
    return { prepared, inside, found };
}

/**
 * The review screen switched off: import as soon as the bytes are in hand.
 * The screen still names the card and offers Open and Undo, so a mistaken
 * import is one click from gone.
 */
async function importDirect(container, status, prepared, inside, request, onBack, screen, options) {
    const name = inside.name || request.card?.name || prepared.file.name;
    container.append(el('h3', 'sbbs-intake-name', name));
    setText(status, 'Importing...');

    const bar = el('div', 'sbbs-detail-actions');
    const result = el('span', 'sbbs-import-status');
    result.setAttribute('role', 'status');
    try {
        const added = await commitPreparedCardImport(prepared, {
            signal: screen.signal,
            requireNewName: inside.name,
            onCommitStart: () => setCommitBusy(container, screen, true),
        });
        options.onImported?.(added);
        if (!screen.current()) {
            return;
        }
        status.remove();
        setText(result, intakeCompletionMessage(added));
        bar.append(...afterImport(added, {
            screen,
            onUndone: () => {
                options.onUndone?.(added);
                if (screen.current()) {
                    setText(result, INTAKE_COPY.undone);
                }
            },
        }));
    } catch (error) {
        if (!screen.current()) {
            return;
        }
        if (['duplicate_detected', 'collection_unavailable'].includes(error?.message)) {
            await options.onReview();
            return;
        }
        setText(status, importErrorMessage(error));
        toastr.error(importErrorMessage(error), 'Import failed');
    } finally {
        setCommitBusy(container, screen, false);
    }
    bar.append(result, backButton(onBack, 'sbbs-intake-back'));
    container.append(bar);
}

function backButton(onBack, className = 'sbbs-back') {
    const back = el('button', `menu_button ${className}`);
    back.type = 'button';
    if (className === 'sbbs-back') {
        const icon = el('i', 'fa-solid fa-arrow-left');
        icon.setAttribute('aria-hidden', 'true');
        back.append(icon);
    }
    back.append(el('span', undefined, 'Back'));
    back.addEventListener('click', onBack);
    return back;
}

function header(back) {
    const bar = el('div', 'sbbs-detail-header');
    bar.append(back);
    return bar;
}

/**
 * Gets the card's bytes, by whichever route this source allows.
 *
 * A native source is downloaded by Neconyan's own importer route, so the
 * bytes described here are the bytes that would be imported.
 */
async function loadBytes(request, signal) {
    if (request.file) {
        return readLocalCardFile(request.file, { signal });
    }
    const bridged = request.source?.capabilities?.browserImport === true;
    const native = request.source?.nativeImport === true;
    if (typeof request.url === 'string') {
        return native && bridged
            ? nativeThenBridge({ importUrl: request.url }, request.source, signal)
            : fetchUrlCard(request.url, request.source, { signal });
    }
    if (bridged && typeof request.card?.importUrl === 'string') {
        return native
            ? nativeThenBridge(request.card, request.source, signal)
            : fetchUrlCard(request.card.importUrl, request.source, { signal });
    }
    if (native) {
        return fetchNativeCardBytes(request.card, request.source, { signal });
    }
    return prepareCardImport(request.card, request.source, { signal });
}

/**
 * The zero-setup native downloader first, the browser bridge as the fallback
 * for hosts Cloudflare blocks and for private cards.
 *
 * Preserve actionable bridge errors, including permissions, restoration,
 * rate limits and reasons about the card itself, rather than hiding them
 * behind the native download failure.
 */
async function nativeThenBridge(card, source, signal) {
    // A native reply is only trusted once it inspects as a real card. A JSON
    // card has no portrait, so the bridge still gets its turn; the JSON stays
    // as the last resort so the text imports with the generic portrait.
    let fallback = null;
    let nativeError;
    try {
        const prepared = await fetchNativeCardBytes(card, source, { signal });
        prepared.report = await inspectBytes(prepared.file, { signal });
        if (prepared.kind === 'png') {
            return prepared;
        }
        fallback = prepared;
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            throw error;
        }
        nativeError = error;
    }
    try {
        return await fetchUrlCard(card.importUrl, source, { signal });
    } catch (bridgeError) {
        if (signal?.aborted || bridgeError?.name === 'AbortError'
            || ['janny_login_required', 'janny_admin_required', 'janny_browser_request_failed', 'janny_restore_failed'].includes(bridgeError?.message)
            || Number.isFinite(bridgeError?.retryAfter)) {
            throw bridgeError;
        }
        if (fallback) {
            return fallback;
        }
        if (JANNY_CARD_ERRORS.includes(bridgeError?.message)) {
            // The bridge reached the card, so its reason beats the native
            // downloader's Cloudflare guess.
            throw bridgeError;
        }
        if (bridgeError?.message === 'janny_browser_unavailable') {
            // Lets the recovery text suggest setting the bridge up.
            nativeError.bridgeUnavailable = true;
        }
        throw nativeError;
    }
}

/**
 * When the card could not be fetched or read.
 *
 * A native card can still be imported the way it always was, so the offer stays
 * — clearly labelled as skipping the inspection rather than passing it. A
 * login failure gets the matching login control inline: sending the user out
 * of this modal to the settings drawer would throw away the URL, the results
 * and their place in the task.
 */
function showNotInspected(container, status, request, error, onBack, screen, options) {
    setText(status, intakeErrorMessage(error, request.source?.id));

    const actions = el('div', 'sbbs-detail-actions');
    const recovery = nativeRecovery(request, error);
    if (recovery) {
        actions.append(recovery);
    }

    const code = error?.code ?? error?.message;
    if (request.source?.id === 'botbooru' && ['botbooru_login_required', 'botbooru_session_expired', 'botbooru_nsfw_disabled'].includes(code)) {
        const account = botbooruAccountControl(`sbbs_intake_botbooru_${++nextScreenId}`);
        account.classList.add('sbbs-intake-account-recovery');
        account.dataset.source = 'botbooru';
        actions.append(account);
    }
    if (request.source?.id === 'saucepan' && ['saucepan_login_required', 'saucepan_session_expired'].includes(code)) {
        actions.append(saucepanAccountControl('sbbs_intake_saucepan'));
    }
    if (request.source?.id === 'jannyai' && code === 'janny_login_required') {
        actions.append(jannyBrowserControl('sbbs_intake_janny'));
    }
    if (request.source?.nativeImport === true && request.card) {
        actions.append(el(
            'p',
            'sbbs-intake-warn',
            'This card was not inspected. Importing now adds it to your collection without a report of its contents.',
        ));

        const anyway = el('button', 'menu_button sbbs-import', 'Import without inspecting');
        anyway.type = 'button';
        const result = el('span', 'sbbs-import-status');
        result.setAttribute('role', 'status');
        anyway.addEventListener('click', async () => {
            if (!screen.current() || anyway.disabled) {
                return;
            }
            anyway.disabled = true;
            tryAgain.disabled = true;
            setText(anyway, 'Importing...');
            try {
                const added = await importCard(request.card, request.source, {
                    signal: screen.signal,
                    onCommitStart: () => setCommitBusy(container, screen, true),
                });
                options.onImported?.(added);
                if (!screen.current()) {
                    return;
                }
                setText(anyway, added.committed === true ? 'Imported' : INTAKE_COPY.nativeFinished);
                setText(result, intakeCompletionMessage(added));
                actions.append(...afterImport(added, {
                    screen,
                    onUndone: () => {
                        options.onUndone?.(added);
                        if (!screen.current()) {
                            return;
                        }
                        anyway.disabled = false;
                        tryAgain.disabled = false;
                        setText(anyway, 'Import without inspecting');
                        setText(result, 'Import undone.');
                    },
                }));
            } catch (importError) {
                if (!screen.current()) {
                    return;
                }
                anyway.disabled = false;
                tryAgain.disabled = false;
                setText(anyway, 'Try import again');
                setText(result, importErrorMessage(importError));
                toastr.error(importErrorMessage(importError), 'Import failed');
            } finally {
                setCommitBusy(container, screen, false);
            }
        });
        actions.append(anyway, result);
    }

    // Worth offering for every failure: transient ones pass on a retry, and a
    // login fixed just above needs one to take effect.
    const tryAgain = el('button', 'menu_button', 'Try again');
    tryAgain.type = 'button';
    tryAgain.addEventListener('click', () => void options.retry());
    actions.append(tryAgain);

    const retry = el('button', 'menu_button', 'Back');
    retry.type = 'button';
    retry.addEventListener('click', onBack);
    actions.append(retry);
    container.append(actions);
}

function nativeRecovery(request, error) {
    if ((error?.message ?? error?.code) !== 'native_download_failed'
        || request.source?.id !== 'jannyai') {
        return null;
    }

    const recovery = el('div', 'sbbs-intake-recovery');
    const instructions = el(
        'p',
        undefined,
        'Download the card from JannyAI, then return to the browse dialog, open “Inspect a card file” and choose a file.',
    );
    const pageUrl = request.card?.pageUrl;
    if (typeof pageUrl === 'string' && pageUrl !== '') {
        const link = document.createElement('a');
        setText(link, 'Open JannyAI page');
        if (setLinkSafe(link, pageUrl, request.source.clientHosts)) {
            instructions.append(document.createTextNode(' '), link);
        }
    }
    recovery.append(instructions);
    if (error?.bridgeUnavailable === true) {
        recovery.append(el(
            'p',
            undefined,
            'Setting up JannyAI browser import under Extensions > BotSearcher lets the server fetch cards Cloudflare blocks.',
        ));
    }
    return recovery;
}

/** Where the card came from, and who the bytes say made it. */
function originLine(request, inside) {
    const rows = [];
    if (request.source?.label) {
        rows.push({ label: 'Source', value: request.source.label });
    }
    if (request.file) {
        rows.push({ label: 'Source', value: `Local file (${request.file.name})` });
    }
    if (typeof request.card?.pageUrl === 'string' && request.card.pageUrl !== '') {
        rows.push({ label: 'Original address', value: request.card.pageUrl });
    }
    if (typeof request.url === 'string' && request.url !== '') {
        rows.push({ label: 'Original address', value: request.url });
    }
    if (inside.creator) {
        // The listing's creator and the card's own can disagree; both are shown
        // rather than picking one and calling it the creator.
        const reported = request.card?.creator;
        rows.push({
            label: 'Creator in the card',
            value: reported && reported !== inside.creator
                ? `${inside.creator} (the listing says ${reported})`
                : inside.creator,
        });
    }
    if (inside.characterVersion) {
        rows.push({ label: 'Card version', value: inside.characterVersion });
    }
    return rows;
}

/**
 * Name matching finds candidates; file revisions guard destructive actions.
 * The checked list response, not the host's possibly stale UI array, decides
 * whether a copy exists. Only the chosen candidate needs a full comparison.
 * @returns {Promise<{matches: object[]} | {unknown: true} | null>}
 */
async function findInstalled(inside, signal) {
    const wanted = String(inside.name ?? '').trim().toLowerCase();
    if (wanted === '') {
        return { unknown: true };
    }

    let characters;
    try {
        characters = await readCollection({ signal });
    } catch {
        signal?.throwIfAborted();
        return { unknown: true };
    }
    const matches = characters
        .filter((entry) => String(entry.name).trim().toLowerCase() === wanted)
        .map((entry) => ({ name: entry.name, avatar: entry.avatar, character: entry, differences: null, revision: null, loaded: false }));
    if (matches.length === 0) {
        return null;
    }
    await compareInstalled(matches[0], inside, signal);
    return { matches };
}

async function compareInstalled(match, inside, signal) {
    let installed = match.character;
    if (installed.shallow === true) {
        try {
            if (!context().characters?.some((entry) => entry?.avatar === match.avatar)) {
                await context().getCharacters();
                signal?.throwIfAborted();
            }
            const previous = context().characters?.find((entry) => entry?.avatar === match.avatar);
            await context().getOneCharacter(match.avatar);
            signal?.throwIfAborted();
            const full = context().characters?.find((entry) => entry?.avatar === match.avatar);
            installed = full && full !== previous && full.shallow !== true ? full : null;
        } catch {
            signal?.throwIfAborted();
            installed = null;
        }
    }
    match.differences = installed ? differencesFrom(installed, inside) : null;
    try {
        match.revision = await readCharacterRevision(match.avatar, { signal });
    } catch {
        signal?.throwIfAborted();
        match.revision = null;
    }
    signal?.throwIfAborted();
    match.loaded = true;
}

function differencesFrom(installed, inside) {
    if (installed.shallow === true || inside.promptText?.truncated !== false) {
        return null;
    }
    const differences = [];
    const data = installed.data ?? {};
    const read = (key) => {
        const fromData = data[key];
        const value = typeof fromData === 'string' ? fromData : installed[key];
        return typeof value === 'string' ? value : '';
    };

    if (inside.promptText?.truncated !== true) {
        const fields = inside.promptText?.fields ?? {};
        for (const [reportKey, hostKey, label] of COMPARED_FIELDS) {
            if ((fields[reportKey] ?? '') !== read(hostKey)) {
                differences.push(label);
            }
        }
    }

    const entries = Array.isArray(data.character_book?.entries) ? data.character_book.entries.length : 0;
    if (typeof inside.lorebookEntries === 'number' && inside.lorebookEntries !== entries) {
        differences.push('lorebook');
    }

    const greetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : 0;
    if (typeof inside.alternateGreetings === 'number' && inside.alternateGreetings !== greetings) {
        differences.push('set of alternate greetings');
    }

    return differences;
}

/**
 * Which card fields land in which bucket.
 *
 * Grouped by when the text is in context rather than by field, because that is
 * the question the screen answers. The first group is there for every request;
 * the greeting is there once, as the opening message; the examples are dropped
 * again as soon as the chat grows past them.
 */
const TOKEN_BUCKETS = Object.freeze([
    ['always', ['description', 'personality', 'scenario', 'systemPrompt', 'postHistoryInstructions']],
    ['greeting', ['firstMessage']],
    ['examples', ['messageExample']],
]);

/**
 * Measures the card with Neconyan's own tokenizer, so the numbers match what
 * the rest of the app would report.
 *
 * The text measured here is never rendered; only these counts are.
 */
async function countTokens(inside) {
    const ctx = context();
    if (inside.promptText?.truncated !== false || typeof ctx.getTokenCountAsync !== 'function') {
        return { measured: false };
    }

    const fields = inside.promptText.fields ?? {};
    const count = async (text) => (text === '' ? 0 : ctx.getTokenCountAsync(text));
    const book = inside.promptText.lorebook;
    const measurableBook = book && book.truncated === false ? book : null;

    try {
        // The buckets are independent, so they are counted together rather than
        // one after another — five round trips to the tokenizer in sequence is a
        // visible pause on a slow one.
        const totals = await Promise.all([
            ...TOKEN_BUCKETS.map(([, keys]) => count(keys.map(key => fields[key] ?? '').filter(Boolean).join('\n'))),
            count(measurableBook?.always ?? ''),
            count(measurableBook?.conditional ?? ''),
        ]);
        if (!totals.every(Number.isFinite)) {
            return { measured: false };
        }

        const counts = { measured: true, lorebook: null };
        TOKEN_BUCKETS.forEach(([bucket], index) => {
            counts[bucket] = totals[index];
        });

        if (book) {
            counts.lorebook = measurableBook
                ? {
                    measured: true,
                    always: totals[TOKEN_BUCKETS.length],
                    conditional: totals[TOKEN_BUCKETS.length + 1],
                    alwaysEntries: book.alwaysEntries ?? 0,
                    conditionalEntries: book.conditionalEntries ?? 0,
                }
                : { measured: false };
        }

        return counts;
    } catch {
        // A tokenizer that is still loading is not worth failing the screen for.
        return { measured: false };
    }
}

function openButton(added, screen) {
    const open = el('button', 'menu_button sbbs-open-character', 'Open character');
    open.type = 'button';
    open.addEventListener('click', async () => {
        if (!screen.current()) {
            return;
        }
        try {
            await openCharacter(added.avatar);
        } catch {
            if (screen.current()) {
                toastr.error(INTAKE_COPY.openFailed);
            }
        }
    });
    return open;
}

/**
 * Open and Undo, offered together after an import that added a character.
 *
 * A replace gets Open only: the character was the user's own before the import,
 * so "undoing" it would delete their copy rather than the imported one.
 *
 * @param {import('./importer.js').ImportReceipt} added
 * @param {{ screen: object, onUndone: () => void }} options
 * @returns {HTMLElement[]}
 */
function afterImport(added, { screen, onUndone }) {
    if (!added.avatar) {
        return [];
    }
    const open = openButton(added, screen);
    if (!added.canUndo || added.replaced) {
        return [open];
    }
    const undo = el('button', 'menu_button sbbs-undo-import', 'Undo import');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
        if (!screen.current() || undo.disabled) {
            return;
        }
        undo.disabled = true;
        open.disabled = true;
        setText(undo, 'Removing...');
        try {
            try {
                await removeCharacter(added.avatar, { expectedRevision: added.revision, signal: screen.signal });
            } catch (error) {
                if (error?.message !== 'character_missing') {
                    throw error;
                }
            }
            onUndone();
            if (!screen.current()) {
                return;
            }
            const returnFocus = document.activeElement === undo || document.activeElement === open;
            const next = undo.parentElement?.querySelector('button:not([disabled]):not(.sbbs-open-character):not(.sbbs-undo-import)');
            open.remove();
            undo.remove();
            if (returnFocus) {
                next?.focus();
            }
        } catch (error) {
            if (!screen.current()) {
                return;
            }
            undo.disabled = false;
            open.disabled = false;
            setText(undo, 'Undo import');
            toastr.error(undoErrorMessage(error), 'Undo failed');
        }
    });
    return [open, undo];
}

/**
 * Exact or clean, plus replace when the card is already installed.
 *
 * Clean import states what it will drop from THIS card and what it will keep,
 * because a fixed profile is only honest if it is itemised at the point of use.
 */
function actionBar(container, prepared, inside, found, duplicate, onBack, screen, options) {
    const bar = el('div', 'sbbs-detail-actions');
    const status = el('span', 'sbbs-import-status');
    status.setAttribute('role', 'status');

    const removals = cleanPlan(inside);
    const keeps = cleanKeeps(inside);
    let canClean = removals.length > 0 && inside.scan?.complete === true;

    const exact = el('button', 'menu_button sbbs-import', 'Import exactly');
    exact.type = 'button';

    const clean = el('button', 'menu_button sbbs-import-clean', 'Clean import');
    clean.type = 'button';
    const matches = found?.matches ?? [];
    let selected = matches[0] ?? null;
    let addInput = null;
    let replaceInput = null;
    let matchSelect = null;
    let pending = false;
    let completed = false;
    let comparing = false;
    let selectionGeneration = 0;
    const replaceWarning = el('p', 'sbbs-intake-warn sbbs-intake-replace-note', INTAKE_COPY.replaceWarning);
    const revisionWarning = el('p', 'sbbs-intake-warn', INTAKE_COPY.revisionUnknown);

    const updateControls = () => {
        const replacing = replaceInput?.checked === true;
        exact.disabled = pending || completed || comparing;
        clean.disabled = exact.disabled || !canClean;
        for (const input of [addInput, replaceInput, matchSelect]) {
            if (input) {
                input.disabled = pending || completed || comparing;
            }
        }
        if (replaceInput) {
            replaceInput.disabled ||= !selected?.revision;
        }
        replaceWarning.hidden = !replacing;
        revisionWarning.hidden = selected?.revision !== null || comparing;
        setText(exact, replacing ? INTAKE_COPY.replaceExactly : (selected ? INTAKE_COPY.importCopyExactly : 'Import exactly'));
        setText(clean, replacing ? INTAKE_COPY.replaceClean : 'Clean import');
    };

    if (matches.length > 0) {
        const choice = el('fieldset', 'sbbs-intake-choice');
        choice.append(el('legend', undefined, INTAKE_COPY.importTarget));
        const name = `sbbs_intake_destination_${++nextScreenId}`;
        const addLabel = el('label', 'checkbox_label sbbs-intake-add-copy');
        addInput = el('input');
        addInput.type = 'radio';
        addInput.name = name;
        addInput.checked = true;
        addLabel.append(addInput, el('span', undefined, INTAKE_COPY.addCopy));
        const replaceLabel = el('label', 'checkbox_label sbbs-intake-replace');
        replaceInput = el('input');
        replaceInput.type = 'radio';
        replaceInput.name = name;
        replaceWarning.id = `${name}_warning`;
        replaceInput.setAttribute('aria-describedby', replaceWarning.id);
        replaceLabel.append(replaceInput, el('span', undefined, INTAKE_COPY.replaceCopy));
        choice.append(addLabel, replaceLabel);
        addInput.addEventListener('change', updateControls);
        replaceInput.addEventListener('change', updateControls);

        if (matches.length > 1) {
            matchSelect = el('select', 'text_pole sbbs-intake-match');
            matchSelect.id = `${name}_copy`;
            const label = el('label', undefined, INTAKE_COPY.installedCopy);
            label.htmlFor = matchSelect.id;
            for (const match of matches) {
                const option = el('option', undefined, `${match.name} (${match.avatar})`);
                option.value = match.avatar;
                matchSelect.append(option);
            }
            matchSelect.addEventListener('change', async () => {
                selected = matches.find((match) => match.avatar === matchSelect.value);
                if (!selected || pending || completed) {
                    return;
                }
                const generation = ++selectionGeneration;
                comparing = true;
                updateControls();
                setText(duplicate, INTAKE_COPY.comparing);
                try {
                    if (!selected.loaded) {
                        await compareInstalled(selected, inside, screen.signal);
                    }
                    if (!screen.current() || generation !== selectionGeneration) {
                        return;
                    }
                    if (!selected.revision) {
                        addInput.checked = true;
                    }
                    setText(duplicate, duplicateMessage(selected));
                } catch {
                    // Cancellation discards the old selection's comparison.
                } finally {
                    if (screen.current() && generation === selectionGeneration) {
                        comparing = false;
                        updateControls();
                    }
                }
            });
            choice.append(label, matchSelect);
        } else {
            choice.append(el('div', 'sbbs-intake-filename', selected.avatar));
        }
        choice.append(replaceWarning, revisionWarning);
        bar.append(choice);
    }

    const run = async (button, cleaned) => {
        if (pending || completed || comparing || !screen.current()
            || (cleaned && !canClean)) {
            return;
        }
        const replacing = replaceInput?.checked === true;
        const replaceAvatar = replacing ? selected?.avatar : undefined;
        const expectedRevision = replacing ? selected?.revision : undefined;
        pending = true;
        updateControls();
        setText(status, '');
        setText(button, 'Importing...');

        try {
            const bytes = cleaned ? await cleanBytes(prepared, { signal: screen.signal }) : prepared;
            screen.signal.throwIfAborted();
            const added = await commitPreparedCardImport(bytes, {
                replaceAvatar,
                expectedRevision,
                signal: screen.signal,
                onCommitStart: () => setCommitBusy(container, screen, true),
            });
            options.onImported?.(added);
            if (!screen.current()) {
                return;
            }
            completed = true;
            setText(button, added.committed ? (replacing ? INTAKE_COPY.replaced : 'Imported') : INTAKE_COPY.nativeFinished);
            setText(status, intakeCompletionMessage(added));
            bar.append(...afterImport(added, {
                screen,
                onUndone: () => {
                    options.onUndone?.(added);
                    if (screen.current()) {
                        completed = false;
                        updateControls();
                        setText(status, INTAKE_COPY.undone);
                        exact.focus();
                    }
                },
            }));
        } catch (error) {
            if (screen.current()) {
                if (error?.message === 'clean_incomplete') {
                    canClean = false;
                }
                setText(status, importErrorMessage(error));
                toastr.error(importErrorMessage(error), 'Import failed');
            }
        } finally {
            pending = false;
            setCommitBusy(container, screen, false);
            if (screen.current() && !completed) {
                updateControls();
            }
        }
    };

    exact.addEventListener('click', () => void run(exact, false));
    clean.addEventListener('click', () => void run(clean, true));

    // The explanation of what Clean import will do sits ABOVE the two look-alike
    // buttons, so the choice is informed before it is offered rather than after.
    const explanation = el('div', 'sbbs-intake-clean-note');
    if (inside.scan?.complete !== true) {
        explanation.append(el('p', undefined, INTAKE_COPY.cleanUnavailable));
    } else if (removals.length === 0) {
        explanation.append(el('p', undefined, 'Clean import has nothing to remove from this card.'));
    } else {
        explanation.append(el('p', undefined, `Clean import removes ${removals.join(', ')}.`));
        if (keeps.length > 0) {
            explanation.append(el('p', undefined, `It keeps ${keeps.join(', ')}.`));
        }
    }
    bar.append(explanation);

    bar.append(exact, clean);
    bar.append(status);

    // Returning to the grid has to stay reachable from the bottom of a long report.
    bar.append(backButton(onBack, 'sbbs-intake-back'));
    updateControls();
    return bar;
}


/** How many times one card is retried after the server asks it to wait. */
const BULK_RETRY_LIMIT = 3;

/**
 * Imports several selected cards in turn, on one screen, one line each.
 *
 * Every card still gets fetched and inspected, so a damaged file is refused
 * and a character already in the collection is skipped rather than duplicated —
 * that decision (replace, or add a copy) is one the review screen offers and a
 * batch cannot. What the batch drops is the report itself.
 *
 * Cards go one at a time. The host serializes imports anyway, and the server's
 * per-user download limit is obeyed rather than raced: when it says wait, the
 * line says so and the card is retried after that many seconds.
 *
 * @param {HTMLElement} container the #sbbs_intake node
 * @param {{ item: any, source: any }[]} entries the selected cards
 * @param {() => void} onBack
 * @param {{ signal?: AbortSignal, autoStart?: boolean, mode?: 'exact' | 'clean' }} [options]
 */
export async function showBulkImport(container, entries, onBack, { signal: externalSignal, autoStart = true, mode = 'exact' } = {}) {
    if (externalSignal?.aborted) {
        return;
    }
    const screen = beginScreen(container, externalSignal);
    const { signal } = screen;
    container.replaceChildren();
    container.dataset.committing = 'false';
    let running = false;
    let stopping = false;
    let stopped = false;
    let removing = false;
    const batch = el('div', 'sbbs-bulk');
    // First in DOM order so the browser's Esc/back lookup finds review's Back.
    const review = el('section', 'sbbs-bulk-review');
    review.setAttribute('aria-label', INTAKE_COPY.batchReview);
    review.hidden = true;
    container.append(review, batch);

    const leaveOrStop = () => {
        if (!screen.current() || removing) {
            return;
        }
        if (running) {
            stopping = true;
            setText(status, INTAKE_COPY.batchStopping);
            updateControls();
        } else {
            screen.abort();
            onBack();
        }
    };
    const back = backButton(leaveOrStop);
    const bottomBack = backButton(leaveOrStop, 'sbbs-intake-back');
    batch.append(header(back), el('h2', 'sbbs-intake-title', `Import ${formatCount(entries.length, 'card')}`));
    batch.append(el('p', 'sbbs-trust-note', mode === 'clean' ? INTAKE_COPY.batchCleanPolicy : INTAKE_COPY.batchExactPolicy));

    const status = el('div', 'sbbs-state', 'Starting...');
    status.setAttribute('role', 'status');

    const list = el('ol', 'sbbs-bulk-list');
    const rows = entries.map(({ item, source }) => {
        const node = el('li', 'sbbs-bulk-row');
        node.append(el('span', 'sbbs-bulk-name', item?.name || 'Untitled'));
        if (source?.label) {
            node.append(el('span', 'sbbs-bulk-source', source.label));
        }
        const outcome = el('span', 'sbbs-bulk-outcome', INTAKE_COPY.batchNotStarted);
        outcome.setAttribute('role', 'status');
        const reviewButton = el('button', 'menu_button sbbs-bulk-review-card', INTAKE_COPY.batchReview);
        reviewButton.type = 'button';
        reviewButton.setAttribute('aria-label', `${INTAKE_COPY.batchReview}: ${item?.name || 'Untitled'}`);
        node.append(outcome, reviewButton);
        list.append(node);
        const row = { item, source, node, outcome, reviewButton, state: 'waiting', prepared: null, receipt: null };
        reviewButton.addEventListener('click', () => void openReview(row));
        return row;
    });

    const bar = el('div', 'sbbs-detail-actions');
    const start = el('button', 'menu_button sbbs-bulk-start', INTAKE_COPY.batchStart);
    const retry = el('button', 'menu_button sbbs-bulk-retry', INTAKE_COPY.batchRetry);
    const undo = el('button', 'menu_button sbbs-undo-import');
    for (const button of [start, retry, undo]) {
        button.type = 'button';
    }
    start.addEventListener('click', () => void run(rows.filter((row) => row.state === 'waiting')));
    retry.addEventListener('click', () => void run(rows.filter((row) => row.state === 'failed')));
    bar.append(start, retry, undo, bottomBack);
    batch.append(status, list, bar);

    function summary() {
        const count = (state) => rows.filter((row) => row.state === state).length;
        return bulkImportSummary({
            imported: rows.filter((row) => row.state === 'imported' && !row.receipt?.replaced).length,
            replaced: rows.filter((row) => row.state === 'imported' && row.receipt?.replaced).length,
            installed: count('installed'),
            failed: count('failed'),
            unknown: count('unknown'),
            review: count('review'),
            pending: count('waiting'),
            uncertain: count('uncertain'),
            stopped,
        });
    }

    function undoableRows() {
        return rows.filter((row) => row.state === 'imported' && row.receipt?.canUndo && !row.receipt.replaced);
    }

    function updateControls() {
        if (!screen.current()) {
            return;
        }
        for (const button of [back, bottomBack]) {
            setText(button.querySelector('span'), running ? (stopping ? INTAKE_COPY.batchStopping : INTAKE_COPY.batchStop) : 'Back');
            button.disabled = removing || (running && stopping);
        }
        start.hidden = !rows.some((row) => row.state === 'waiting');
        setText(start, stopped ? INTAKE_COPY.batchContinue : INTAKE_COPY.batchStart);
        start.disabled = running || removing;
        retry.hidden = !rows.some((row) => row.state === 'failed');
        retry.disabled = running || removing;
        undo.hidden = undoableRows().length === 0;
        undo.disabled = running || removing;
        setText(undo, `Undo ${formatCount(undoableRows().length, 'import')}`);
        for (const row of rows) {
            row.node.dataset.state = row.state;
            row.reviewButton.hidden = row.state === 'imported';
            row.reviewButton.disabled = running || removing;
        }
    }

    async function openReview(row) {
        if (running || removing || !screen.current()) {
            return;
        }
        batch.hidden = true;
        review.hidden = false;
        await showIntake(review, { card: row.item, source: row.source }, () => {
            if (!screen.current()) {
                return;
            }
            review.replaceChildren();
            review.hidden = true;
            batch.hidden = false;
            setText(status, summary());
            updateControls();
            (row.reviewButton.hidden ? back : row.reviewButton).focus();
        }, {
            signal,
            prepared: row.prepared,
            onImported(receipt) {
                row.receipt = receipt;
                row.state = receipt.committed === true ? 'imported' : 'uncertain';
                if (screen.current()) {
                    setText(row.outcome, intakeCompletionMessage(receipt));
                }
            },
            onUndone() {
                row.state = 'removed';
                row.receipt = null;
                if (screen.current()) {
                    setText(row.outcome, INTAKE_COPY.undone);
                }
            },
        });
    }

    async function run(selectedRows) {
        if (running || removing || !screen.current() || selectedRows.length === 0) {
            return;
        }
        running = true;
        stopping = false;
        stopped = false;
        updateControls();
        for (let index = 0; index < selectedRows.length; index++) {
            if (signal.aborted || stopping) {
                break;
            }
            const row = selectedRows[index];
            row.state = 'working';
            row.node.dataset.state = row.state;
            setText(status, `Importing ${index + 1} of ${selectedRows.length}...`);
            setText(row.outcome, 'Fetching...');
            let phase = 'inspect';
            try {
                const staged = await stageWithRetry({ card: row.item, source: row.source }, signal, (text) => {
                    if (screen.current()) {
                        setText(row.outcome, text);
                    }
                }, row.prepared);
                signal.throwIfAborted();
                // Retain bytes for review/retry, not the report's prompt text.
                row.prepared = { file: staged.prepared.file, kind: staged.prepared.kind };
                if (staged.found) {
                    row.state = staged.found.unknown ? 'unknown' : 'installed';
                    setText(row.outcome, `${duplicateMessage(staged.found)} Not imported.`);
                } else if (staged.inside.scan?.complete !== true) {
                    row.state = 'review';
                    setText(row.outcome, INTAKE_COPY.batchInspectionUnknown);
                } else {
                    phase = 'import';
                    const prepared = mode === 'clean' ? await cleanBytes(staged.prepared, { signal }) : staged.prepared;
                    signal.throwIfAborted();
                    row.receipt = await commitPreparedCardImport(prepared, {
                        signal,
                        requireNewName: staged.inside.name,
                        onCommitStart: () => {
                            if (screen.current()) {
                                container.dataset.committing = 'true';
                            }
                        },
                    });
                    row.state = row.receipt.committed === true ? 'imported' : 'uncertain';
                    if (screen.current()) {
                        setText(row.outcome, intakeCompletionMessage(row.receipt));
                    }
                }
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                row.state = error?.message === 'duplicate_detected' ? 'installed'
                    : error?.message === 'collection_unavailable' ? 'unknown'
                        : error?.message === 'clean_incomplete' ? 'review' : 'failed';
                if (screen.current()) {
                    setText(row.outcome, `Not imported: ${phase === 'import'
                        ? importErrorMessage(error)
                        : intakeErrorMessage(error, row.source?.id)}`);
                }
            } finally {
                if (screen.current()) {
                    container.dataset.committing = 'false';
                    row.node.dataset.state = row.state;
                }
            }
        }
        running = false;
        stopped = stopping;
        if (screen.current()) {
            setText(status, summary());
            updateControls();
            if (stopped) {
                back.focus();
            }
        }
    }

    undo.addEventListener('click', async () => {
        if (running || removing || !screen.current()) {
            return;
        }
        removing = true;
        const targets = undoableRows().reverse();
        updateControls();
        setText(undo, 'Removing...');
        let removed = 0;
        for (const row of targets) {
            try {
                try {
                    await removeCharacter(row.receipt.avatar, { expectedRevision: row.receipt.revision, signal });
                } catch (error) {
                    if (error?.message !== 'character_missing') {
                        throw error;
                    }
                }
                row.state = 'removed';
                row.receipt = null;
                removed++;
                if (screen.current()) {
                    setText(row.outcome, 'Removed again');
                }
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                if (error?.message === 'character_changed') {
                    row.receipt.canUndo = false;
                }
                if (screen.current()) {
                    setText(row.outcome, `Still in your collection: ${undoErrorMessage(error)}`);
                }
            }
        }
        removing = false;
        if (screen.current()) {
            setText(status, `Removed ${removed} of ${formatCount(targets.length, 'imported card')}.`);
            updateControls();
            if (undo.hidden) {
                back.focus();
            }
        }
    });

    setText(status, summary());
    updateControls();
    (autoStart ? back : start).focus();
    if (autoStart) {
        await run(rows);
    }
}

/** stage(), retried when the server answered with a wait rather than a refusal. */
async function stageWithRetry(request, signal, onStep, prepared) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await stage(request, signal, onStep, prepared);
        } catch (error) {
            signal?.throwIfAborted();
            const wait = error?.retryAfter;
            if (!Number.isFinite(wait) || attempt >= BULK_RETRY_LIMIT) {
                throw error;
            }
            const seconds = Math.min(wait, 120);
            onStep(`Waiting ${formatCount(Math.ceil(seconds), 'second')} for the server's download limit...`);
            await sleep(seconds * 1000, signal);
            onStep('Fetching...');
        }
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}
