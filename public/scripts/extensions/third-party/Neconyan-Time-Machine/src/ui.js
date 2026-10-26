/**
 * The Time Machine popup: pick a thing, pick a version, see what changed, put it
 * back.
 *
 * Everything is written to the DOM with textContent. Snapshot payloads are the
 * user's own cards and books rather than a stranger's, but a diff view is
 * exactly where a card full of markup would get rendered by accident.
 */
import {
    captureEverything,
    hostSnapshotParts,
    listHostSnapshots,
    liveCharacterState,
    liveLorebook,
    loadHostSnapshot,
    readAllPresets,
    restoreCharacter,
    restoreExtensionBlock,
    restoreLorebook,
    restorePreset,
} from './api.js';
import { canonicalJson, diffFields, diffLorebook, formatBytes, formatWhen, sortSnapshots } from './core.js';
import {
    commitSettings,
    getSettings,
    listSnapshots,
    load,
    pinSnapshots,
    prune,
    remove,
    save,
    unpinSnapshots,
} from './store.js';

let openPopup = null;
const pendingWork = new Set();
const activeConfirmations = new Set();
let uiGeneration = 0;

function trackWork(promise) {
    pendingWork.add(promise);
    void promise.then(
        () => pendingWork.delete(promise),
        () => pendingWork.delete(promise),
    );
    return promise;
}

function ctx() {
    return globalThis.SillyTavern.getContext();
}

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

function button(className, label, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

let confirmationId = 0;

async function confirmAction(title, message) {
    const context = ctx();
    const generation = uiGeneration;
    const content = el('div');
    const heading = el('h3', '', title);
    heading.id = `sbctm-confirm-${++confirmationId}`;
    content.append(heading, el('p', '', message));
    const popup = new context.Popup(content, context.POPUP_TYPE.CONFIRM);
    popup.dlg?.setAttribute('aria-labelledby', heading.id);
    activeConfirmations.add(popup);
    try {
        const result = await popup.show();
        return generation === uiGeneration && result;
    } finally {
        activeConfirmations.delete(popup);
    }
}

function invalidateUi(generation) {
    if (generation !== uiGeneration) {
        return;
    }
    uiGeneration++;
    for (const popup of activeConfirmations) {
        void Promise.resolve().then(() => popup.completeCancelled?.()).catch(() => {});
    }
}

/** A value shown in a diff: whole enough to read, capped so a huge card stays usable. */
function preview(value) {
    if (value === undefined) {
        return '(not set)';
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text === '') {
        return '(empty)';
    }
    return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

function icon(name) {
    const node = el('i', `fa-solid ${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function iconButton(className, iconName, label, onClick) {
    const node = button(className, '', onClick);
    node.append(icon(iconName), el('span', '', label));
    return node;
}

const KIND_LABELS = { character: 'Characters', lorebook: 'Lorebooks', preset: 'Presets' };
const KIND_ICONS = { character: 'fa-user', lorebook: 'fa-book-open', preset: 'fa-sliders' };
const CHANGE_LABELS = { added: 'Comes back', removed: 'Goes away', changed: 'Changes' };
const SEARCH_THRESHOLD = 8;

const CHARACTER_FIELD_LABELS = {
    name: 'Name',
    description: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    first_mes: 'First message',
    mes_example: 'Example messages',
    alternate_greetings: 'Alternate greetings',
    creator_notes: 'Creator\'s notes',
    creatorcomment: 'Creator\'s notes',
    system_prompt: 'System prompt',
    post_history_instructions: 'Post-history instructions',
    tags: 'Card tags',
    creator: 'Creator',
    character_version: 'Character version',
    character_book: 'Embedded lorebook',
    extensions: 'Extensions',
    talkativeness: 'Talkativeness',
    fav: 'Favourite',
};

function characterFieldLabel(key) {
    return CHARACTER_FIELD_LABELS[key] ?? key;
}

function versionCount(count) {
    return `${count} version${count === 1 ? '' : 's'}`;
}

export async function openTimeMachine() {
    if (openPopup) {
        return;
    }
    const context = ctx();
    const generation = ++uiGeneration;
    const root = el('div', 'sbctm');
    root.dataset.view = 'list';
    const state = { selected: null, comparison: 0, restoring: false, kind: 'all' };

    // ---- header ----
    const header = el('header', 'sbctm-header');
    const heading = el('h2', 'sbctm-title', 'Time Machine');
    heading.id = 'sbctm-title';
    const lede = el('p', 'sbctm-lede', 'Older versions of your characters, lorebooks and presets, saved automatically. Compare one with what you have now and put it back if you need it.');
    const intro = el('div', 'sbctm-intro');
    intro.append(heading, lede);

    const actions = el('div', 'sbctm-actions');
    const status = el('p', 'sbctm-status');
    status.setAttribute('role', 'status');
    const snapshotNow = iconButton('menu_button menu_button_primary sbctm-snapshot', 'fa-camera', 'Snapshot everything now', async () => {
        if (state.restoring) {
            return;
        }
        snapshotNow.disabled = true;
        try {
            const result = await trackWork(captureEverything(message => {
                status.textContent = message;
            }));
            if (result.failed > 0) {
                status.textContent = `Stored ${result.taken} snapshot${result.taken === 1 ? '' : 's'}; ${result.failed} failed.`;
                globalThis.toastr?.warning('Some items could not be snapshotted.');
            } else {
                status.textContent = result.taken === 0
                    ? 'Nothing has changed since the last snapshot.'
                    : `Stored ${result.taken} new snapshot${result.taken === 1 ? '' : 's'}.`;
            }
            renderTargets();
            state.comparison++;
            renderTimeline();
        } catch (error) {
            console.error('[Time Machine] snapshot failed', error);
            status.textContent = 'Could not finish the snapshot. See the console.';
        } finally {
            snapshotNow.disabled = false;
        }
    });
    actions.append(snapshotNow);
    header.append(intro, actions, status);
    root.append(header);

    // ---- body ----
    const body = el('div', 'sbctm-body');
    const targets = el('nav', 'sbctm-targets');
    targets.setAttribute('aria-label', 'Snapshot targets');
    const filters = el('div', 'sbctm-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Show');
    const search = el('input', 'text_pole sbctm-search');
    search.type = 'search';
    search.placeholder = 'Search snapshots';
    search.setAttribute('aria-label', 'Search snapshots');
    search.addEventListener('input', () => renderTargetList());
    const targetList = el('div', 'sbctm-target-list');
    targets.append(filters, search, targetList);
    const detail = el('section', 'sbctm-detail');
    body.append(targets, detail);
    root.append(body);

    let latestRows = [];

    function setView(view) {
        root.dataset.view = view;
    }

    function renderTargets() {
        const rows = listSnapshots();
        const grouped = new Map();
        for (const row of rows) {
            const key = `${row.kind}:${row.target}`;
            const existing = grouped.get(key);
            if (!existing) {
                grouped.set(key, { row, count: 1 });
            } else {
                existing.count++;
                if (row.ts > existing.row.ts) {
                    existing.row = row;
                }
            }
        }
        latestRows = [...grouped.values()].sort((a, b) => a.row.label.localeCompare(b.row.label));

        const kinds = ['character', 'lorebook', 'preset'].filter(kind => latestRows.some(item => item.row.kind === kind));
        if (state.kind !== 'all' && !kinds.includes(state.kind)) {
            state.kind = 'all';
        }
        filters.replaceChildren();
        filters.hidden = kinds.length < 2;
        for (const kind of ['all', ...kinds]) {
            const count = kind === 'all' ? latestRows.length : latestRows.filter(item => item.row.kind === kind).length;
            const chip = button('sbctm-filter', '', () => {
                state.kind = kind;
                renderTargets();
            });
            chip.append(el('span', '', kind === 'all' ? 'All' : KIND_LABELS[kind]), el('span', 'sbctm-count', String(count)));
            chip.setAttribute('aria-pressed', String(state.kind === kind));
            filters.append(chip);
        }
        search.hidden = latestRows.length <= SEARCH_THRESHOLD;
        if (search.hidden) {
            search.value = '';
        }
        renderTargetList();
    }

    function renderTargetList() {
        targetList.replaceChildren();
        if (latestRows.length === 0) {
            const empty = el('div', 'sbctm-empty sbctm-empty-start');
            empty.append(icon('fa-clock-rotate-left'), el('span', '',
                'No snapshots yet. Editing a character or lorebook takes one automatically, or use the button above.'));
            targetList.append(empty);
            return;
        }
        const query = search.value.trim().toLocaleLowerCase();
        const visible = latestRows.filter(item =>
            (state.kind === 'all' || item.row.kind === state.kind)
            && (!query || item.row.label.toLocaleLowerCase().includes(query)));
        if (visible.length === 0) {
            targetList.append(el('div', 'sbctm-empty', 'Nothing matches that search.'));
            return;
        }
        for (const kind of ['character', 'lorebook', 'preset']) {
            const inKind = visible.filter(item => item.row.kind === kind);
            if (inKind.length === 0) {
                continue;
            }
            if (state.kind === 'all') {
                targetList.append(el('h3', 'sbctm-group', KIND_LABELS[kind]));
            }
            for (const item of inKind) {
                targetList.append(targetCard(item));
            }
        }
    }

    function targetCard({ row, count }) {
        const card = button('sbctm-target', '', () => selectTarget(row.kind, row.target));
        card.dataset.kind = row.kind;
        const art = el('span', 'sbctm-target-art');
        const thumbnail = row.kind === 'character' ? thumbnailUrl(row.target) : '';
        if (thumbnail) {
            const image = el('img');
            image.alt = '';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.addEventListener('error', () => image.replaceWith(icon(KIND_ICONS[row.kind])), { once: true });
            image.src = thumbnail;
            art.append(image);
        } else {
            art.append(icon(KIND_ICONS[row.kind]));
        }
        const text = el('span', 'sbctm-target-text');
        const meta = el('span', 'sbctm-target-meta', `${versionCount(count)} · ${formatWhen(row.ts)}`);
        meta.title = new Date(row.ts).toLocaleString();
        text.append(el('span', 'sbctm-target-name', row.label), meta);
        const chevron = icon('fa-chevron-right');
        chevron.classList.add('sbctm-target-chevron');
        card.append(art, text, chevron);
        if (state.selected?.kind === row.kind && state.selected?.target === row.target) {
            card.classList.add('sbctm-target-current');
            card.setAttribute('aria-current', 'true');
        }
        return card;
    }

    function thumbnailUrl(avatar) {
        try {
            return ctx().getThumbnailUrl?.('avatar', avatar) ?? '';
        } catch {
            return '';
        }
    }

    function selectTarget(kind, target) {
        if (state.restoring) {
            return;
        }
        state.selected = { kind, target };
        state.comparison++;
        renderTargets();
        renderTimeline();
        focusDetailHeading();
    }

    function showList() {
        if (state.restoring) {
            return;
        }
        state.comparison++;
        setView('list');
        const current = targetList.querySelector('.sbctm-target-current') ?? targetList.querySelector('.sbctm-target');
        current?.focus();
    }

    function focusDetailHeading() {
        if (root.dataset.view === 'list' && !state.selected) {
            // Deleting the last version removes the focused button, and focus
            // must not silently drop out of the dialog.
            const node = targetList.querySelector('.sbctm-target') ?? targetList.querySelector('.sbctm-empty');
            if (node) {
                if (!node.matches('button')) {
                    node.tabIndex = -1;
                }
                node.focus();
                return;
            }
        }
        const node = detail.querySelector('.sbctm-heading') ?? detail.querySelector('.sbctm-empty');
        if (node) {
            node.tabIndex = -1;
            node.focus();
        }
    }

    function backToList() {
        const back = iconButton('sbctm-back', 'fa-chevron-left', 'All snapshots', showList);
        return back;
    }

    function detailHead(title, subtitle, kind) {
        const head = el('div', 'sbctm-detail-head');
        const art = el('span', 'sbctm-detail-art');
        art.append(icon(KIND_ICONS[kind] ?? 'fa-clock-rotate-left'));
        const text = el('div', 'sbctm-detail-text');
        text.append(el('h4', 'sbctm-heading', title));
        if (subtitle) {
            text.append(el('p', 'sbctm-sub', subtitle));
        }
        head.append(art, text);
        return head;
    }

    function renderTimeline() {
        detail.replaceChildren();
        if (!state.selected) {
            setView('list');
            const empty = el('div', 'sbctm-empty', 'Pick something on the left to see its history.');
            detail.append(empty);
            return;
        }
        setView('detail');

        const { kind, target } = state.selected;
        const rows = sortSnapshots(listSnapshots().filter(r => r.kind === kind && r.target === target));
        detail.append(backToList(), detailHead(rows[0]?.label ?? target, `${versionCount(rows.length)} saved`, kind));

        const list = el('ol', 'sbctm-timeline');
        rows.forEach((row, index) => {
            const entry = el('li', 'sbctm-version');
            entry.append(el('span', 'sbctm-version-dot'));
            const text = el('div', 'sbctm-version-text');
            const whenLine = el('span', 'sbctm-version-line');
            const when = el('span', 'sbctm-version-when', formatWhen(row.ts));
            when.title = new Date(row.ts).toLocaleString();
            whenLine.append(when);
            if (index === 0) {
                whenLine.append(el('span', 'sbctm-badge sbctm-badge-latest', 'Latest'));
            }
            text.append(whenLine, el('span', 'sbctm-version-meta', `${new Date(row.ts).toLocaleString()} · ${formatBytes(row.size)}`));
            entry.append(text);

            const controls = el('div', 'sbctm-version-actions');
            controls.append(button('menu_button sbctm-small', 'Compare', () => {
                if (!state.restoring) {
                    void showComparison(row);
                }
            }));
            const deleteVersion = iconButton('menu_button sbctm-small sbctm-delete', 'fa-trash-can', 'Delete', async () => {
                if (state.restoring) {
                    return;
                }
                const ok = await confirmAction(
                    'Delete this snapshot?',
                    `${row.label}, saved ${new Date(row.ts).toLocaleString()}. This version will be permanently deleted.`,
                );
                if (!ok) {
                    return;
                }
                deleteVersion.disabled = true;
                try {
                    await trackWork(remove(row));
                    state.comparison++;
                    if (!listSnapshots().some(r => r.kind === kind && r.target === target)) {
                        state.selected = null;
                    }
                    renderTimeline();
                    renderTargets();
                    focusDetailHeading();
                } catch (error) {
                    console.error('[Time Machine] snapshot deletion failed', error);
                    status.textContent = 'That snapshot could not be deleted.';
                    globalThis.toastr?.error('That snapshot could not be deleted.');
                    deleteVersion.disabled = false;
                }
            });
            controls.append(deleteVersion);
            entry.append(controls);
            list.append(entry);
        });
        detail.append(list);
    }

    async function currentStateOf(kind, target) {
        if (kind === 'character') {
            await ctx().getCharacters();
            return liveCharacterState(target);
        }
        if (kind === 'lorebook') {
            const data = await liveLorebook(target);
            return data === null ? null : { data };
        }
        const [apiId, ...rest] = target.split('/');
        const name = rest.join('/');
        const found = (await readAllPresets()).find(p => p.apiId === apiId && p.name === name);
        return found ? { data: found.preset } : null;
    }

    async function showComparison(row) {
        if (state.restoring) {
            return;
        }
        const token = ++state.comparison;
        detail.replaceChildren(el('div', 'sbctm-empty', 'Reading that version...'));
        let payload;
        let live;
        try {
            [payload, live] = await Promise.all([
                load(row),
                currentStateOf(row.kind, row.target),
            ]);
        } catch (error) {
            if (!comparisonIsCurrent(token, row)) {
                return;
            }
            console.error('[Time Machine] could not compare', error);
            detail.replaceChildren(el('div', 'sbctm-empty', 'That version could not be read.'));
            return;
        }
        if (!comparisonIsCurrent(token, row)) {
            return;
        }

        detail.replaceChildren(backToList());
        const head = detailHead(row.label, `${formatWhen(row.ts)} · ${formatBytes(row.size)}`, row.kind);
        head.querySelector('.sbctm-sub').title = new Date(row.ts).toLocaleString();
        detail.append(head);

        if (live === null) {
            const warn = el('div', 'sbctm-warn');
            warn.append(icon('fa-triangle-exclamation'), el('span', '',
                row.kind === 'character'
                    ? 'This character is not in your collection any more. Restoring needs the card file itself, which this extension does not store; it stores only the fields.'
                    : 'This no longer exists. Restoring will create it again.'));
            detail.append(warn);
        }

        const diffNode = row.kind === 'character'
            ? characterDiff(live, payload)
            : row.kind === 'lorebook'
                ? lorebookDiff(live?.data, payload.data)
                : fieldDiff(live?.data, payload.data);
        if (live === null && diffNode.classList.contains('sbctm-empty')) {
            diffNode.textContent = 'This snapshot is empty.';
        }
        detail.append(diffNode);

        const bar = el('div', 'sbctm-bar');
        const restore = iconButton('menu_button menu_button_primary', 'fa-clock-rotate-left', 'Restore this version', () => trackWork(confirmRestore(row, payload, restore)));
        if (row.kind === 'character' && live === null) {
            restore.disabled = true;
        }
        // The diff renderers return the empty-state div exactly when nothing differs.
        if (live !== null && diffNode.classList.contains('sbctm-empty')) {
            restore.disabled = true;
            restore.title = 'This version is identical to the current one';
        }
        bar.append(restore, button('menu_button', 'Back', () => {
            if (state.restoring) {
                return;
            }
            state.comparison++;
            renderTimeline();
            focusDetailHeading();
        }));
        detail.append(bar);
        focusDetailHeading();
    }

    function comparisonIsCurrent(token, row) {
        return token === state.comparison
            && state.selected?.kind === row.kind
            && state.selected?.target === row.target;
    }

    function fieldDiff(live, snapshot) {
        // "Now" first, then the snapshot: the question is "what would restoring
        // change", so the current state is the starting point.
        return renderFieldDiff(diffFields(live ?? {}, snapshot ?? {}), key => key);
    }

    function characterDiff(live, snapshot) {
        const rows = diffFields(live?.data ?? {}, snapshot?.data ?? {});
        // The V2 card repeats most fields inside `data`. Show its fields one by
        // one, and only those the top-level rows have not already covered.
        const nestedIndex = rows.findIndex(change => change.key === 'data');
        if (nestedIndex !== -1) {
            const [nested] = rows.splice(nestedIndex, 1);
            const covered = new Set(rows.map(change => change.key));
            const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
            const inner = diffFields(asObject(nested.from), asObject(nested.to));
            if (inner.length === 0 && canonicalJson(nested.from) !== canonicalJson(nested.to)) {
                rows.push(nested);
            }
            rows.push(...inner.filter(change => !covered.has(change.key)));
        }
        if (snapshot?.tags !== undefined) {
            rows.push(...diffFields(
                { tags: live?.tags ?? [] },
                { tags: snapshot.tags },
            ).map(change => ({ ...change, key: 'Tags' })));
        }
        return renderFieldDiff(rows, characterFieldLabel);
    }

    function renderFieldDiff(rows, labelFor) {
        if (rows.length === 0) {
            return el('div', 'sbctm-empty', 'Identical to what is there now.');
        }
        const wrapper = el('div', 'sbctm-diff-wrap');
        wrapper.append(el('p', 'sbctm-diff-legend',
            `Restoring this version changes ${rows.length} field${rows.length === 1 ? '' : 's'}.`));
        for (const change of rows) {
            const card = el('div', `sbctm-change sbctm-${change.kind}`);
            const head = el('div', 'sbctm-change-head');
            head.append(
                el('span', 'sbctm-change-key', labelFor(change.key)),
                el('span', `sbctm-badge sbctm-badge-${change.kind}`, CHANGE_LABELS[change.kind] ?? CHANGE_LABELS.changed),
            );
            const sides = el('div', 'sbctm-change-sides');
            sides.append(diffSide('sbctm-diff-from', 'Now', change.from), diffSide('sbctm-diff-to', 'This version', change.to));
            card.append(head, sides);
            wrapper.append(card);
        }
        return wrapper;
    }

    function diffSide(className, label, value) {
        const side = el('div', `sbctm-side ${className}`);
        const text = el('div', 'sbctm-side-text', preview(value));
        if (value === undefined || value === '') {
            text.classList.add('sbctm-side-unset');
        }
        side.append(el('span', 'sbctm-side-label', label), text);
        return side;
    }

    function lorebookDiff(live, snapshot) {
        const { added, removed, changed, metadata } = diffLorebook(live ?? {}, snapshot ?? {});
        if (added.length + removed.length + changed.length + metadata.length === 0) {
            return el('div', 'sbctm-empty', 'Identical to what is there now.');
        }
        const wrapper = el('div', 'sbctm-diff-wrap');
        wrapper.append(el('p', 'sbctm-diff-legend',
            `Restoring would bring back ${added.length}, remove ${removed.length}, change ${changed.length} entries, and change ${metadata.length} book settings.`));
        const list = el('ul', 'sbctm-entries');
        const line = (kind, badge, title, extra = '') => {
            const item = el('li', `sbctm-entry sbctm-${kind}`);
            const text = el('span', 'sbctm-entry-text');
            text.append(el('span', 'sbctm-entry-title', title));
            if (extra) {
                text.append(el('span', 'sbctm-entry-detail', extra));
            }
            item.append(el('span', `sbctm-badge sbctm-badge-${kind}`, badge), text);
            list.append(item);
        };
        for (const entry of added) {
            line('added', 'Comes back', entry.title);
        }
        for (const entry of removed) {
            line('removed', 'Goes away', entry.title);
        }
        for (const entry of changed) {
            line('changed', 'Changes', entry.title, entry.fields.map(field => field.key).join(', '));
        }
        for (const field of metadata) {
            line(field.kind, 'Book setting', field.key, `${shortPreview(field.from)} → ${shortPreview(field.to)}`);
        }
        wrapper.append(list);
        return wrapper;
    }

    function shortPreview(value) {
        const text = value === undefined ? '(not set)' : typeof value === 'string' ? value : JSON.stringify(value);
        return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }

    async function confirmRestore(row, payload, control) {
        if (state.restoring) {
            return;
        }
        state.restoring = true;
        // Inert the panes, not the whole root: an inert subtree is removed from
        // the accessibility tree, and the status live region has to keep
        // announcing progress during the one operation that matters most.
        body.inert = true;
        hostSection.inert = true;
        control.disabled = true;
        let rollback = null;
        let restored = false;
        const pinned = [];
        try {
            const ok = await confirmAction(
                'Restore this version?',
                `${row.label}, saved ${new Date(row.ts).toLocaleString()}. The current item will be snapshotted first when it exists. Recreating a deleted item cannot be undone automatically.`,
            );
            if (!ok) {
                return;
            }

            pinned.push(row.id);
            pinSnapshots(pinned);
            status.textContent = 'Reading the current version...';
            const live = await currentStateOf(row.kind, row.target);
            if (row.kind === 'character' && live === null) {
                throw new Error('The character no longer exists, so its image cannot be restored');
            }
            rollback = await snapshotBeforeRestore(row, live);
            if (rollback && !pinned.includes(rollback.id)) {
                pinned.push(rollback.id);
                pinSnapshots([rollback.id]);
            }
            status.textContent = 'Checking for newer changes...';
            const current = await currentStateOf(row.kind, row.target);
            if (canonicalJson(current) !== canonicalJson(live)) {
                const error = new Error('The item changed while its rollback snapshot was being saved');
                error.code = 'RESTORE_CHANGED';
                throw error;
            }
            status.textContent = 'Restoring...';

            if (row.kind === 'character') {
                await restoreCharacter(row.target, payload.data, current.data, payload.tags);
            } else if (row.kind === 'lorebook') {
                await restoreLorebook(row.target, payload.data, current?.data ?? null);
            } else {
                const [apiId, ...rest] = row.target.split('/');
                await restorePreset(apiId, rest.join('/'), payload.data, current?.data ?? null);
            }

            let cleanupFailed = false;
            try {
                await prune({ protectedIds: rollback ? [rollback.id] : [] });
            } catch (error) {
                cleanupFailed = true;
                console.error('[Time Machine] restore succeeded, but retention failed', error);
            }
            status.textContent = cleanupFailed
                ? `${row.label} restored; old snapshot cleanup needs attention.`
                : `${row.label} restored.`;
            globalThis.toastr?.success('Version restored.');
            unpinSnapshots(pinned);
            state.comparison++;
            renderTargets();
            renderTimeline();
            restored = true;
        } catch (error) {
            console.error('[Time Machine] restore failed', error);
            if (error.partial) {
                status.textContent = rollback
                    ? 'The item may have changed, but its before snapshot was kept.'
                    : 'The item may have changed. See the console before trying again.';
                globalThis.toastr?.warning('The restore may have partially completed.');
            } else if (error.code === 'RESTORE_CHANGED' || error.status === 409) {
                status.textContent = 'The item changed again, so the restore was stopped. Compare the versions and try again.';
                globalThis.toastr?.warning('Restore stopped because a newer change was detected.');
                unpinSnapshots(pinned);
            } else {
                status.textContent = 'The restore stopped before the item was changed.';
                globalThis.toastr?.error('The restore was stopped safely.');
                unpinSnapshots(pinned);
            }
        } finally {
            state.restoring = false;
            body.inert = false;
            hostSection.inert = false;
            control.disabled = false;
            if (restored) {
                // Only after un-inerting: an inert pane refuses focus. The
                // button the user pressed no longer exists on this path.
                focusDetailHeading();
            }
        }
    }

    async function snapshotBeforeRestore(row, live) {
        if (live === null) {
            return null;
        }
        const rollback = await save({
            kind: row.kind,
            target: row.target,
            label: row.label,
            data: live.data,
            extra: row.kind === 'character' ? { tags: live.tags } : {},
        }, { skipPrune: true, protectedIds: [row.id] });
        return rollback ?? sortSnapshots(listSnapshots().filter(item =>
            item.kind === row.kind && item.target === row.target))[0] ?? null;
    }

    // ---- the host's own settings backups ----
    const hostSection = hostBackupsSection();
    root.append(hostSection);

    renderTargets();
    renderTimeline();

    let popup;
    popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        onClose: () => {
            if (openPopup === popup) {
                openPopup = null;
            }
            invalidateUi(generation);
        },
    });
    openPopup = popup;
    popup.dlg?.setAttribute('aria-labelledby', heading.id);
    await popup.show();
    if (openPopup === popup) {
        openPopup = null;
    }
    invalidateUi(generation);
}

/**
 * Presets are ours to restore, while extension settings live in settings.json,
 * which the server already backs up. This lifts one safe block out of a past
 * copy rather than duplicating the capture.
 */
function hostBackupsSection() {
    const section = el('details', 'sbctm-host');
    const summary = el('summary');
    const chevron = icon('fa-chevron-down');
    chevron.classList.add('sbctm-host-chevron');
    summary.append(icon('fa-box-archive'), el('span', '', 'Restore an extension\'s settings from Neconyan\'s own backups'), chevron);
    section.append(summary);
    const inner = el('div', 'sbctm-host-body');
    section.append(inner);
    inner.append(el('div', 'sbctm-hint',
        'Neconyan keeps rotating copies of settings.json. Only the extension block you choose is written back; tags, agents, host bookkeeping, and the rest of your settings are left alone.'));

    const picker = el('div', 'sbctm-host-picker');
    inner.append(picker);

    let loaded = false;
    let request = 0;
    section.addEventListener('toggle', async () => {
        if (!section.open || loaded) {
            return;
        }
        loaded = true;
        picker.replaceChildren();
        try {
            const backups = await listHostSnapshots();
            if (backups.length === 0) {
                picker.append(el('div', 'sbctm-empty', 'Neconyan has not written a settings backup yet.'));
                return;
            }
            const select = el('select', 'text_pole');
            for (const backup of backups) {
                const option = el('option', '', `${new Date(backup.date).toLocaleString()} · ${formatBytes(backup.size)}`);
                option.value = backup.name;
                select.append(option);
            }
            const parts = el('div', 'sbctm-host-parts');
            const selectLabel = el('label', 'sbctm-host-select');
            selectLabel.append(el('span', '', 'Settings backup'), select);
            select.addEventListener('change', () => {
                request++;
                parts.replaceChildren();
            });
            const open = button('menu_button', 'Open this backup', async () => {
                const token = ++request;
                const selectedName = select.value;
                const backup = backups.find(item => item.name === selectedName);
                parts.replaceChildren(el('div', 'sbctm-empty', 'Reading...'));
                try {
                    const settings = await loadHostSnapshot(selectedName);
                    if (token !== request || select.value !== selectedName) {
                        return;
                    }
                    renderParts(parts, settings, backup);
                } catch (error) {
                    if (token !== request) {
                        return;
                    }
                    console.error('[Time Machine] could not read the backup', error);
                    parts.replaceChildren(el('div', 'sbctm-empty', 'That backup could not be read.'));
                }
            });
            const row = el('div', 'sbctm-host-row');
            row.append(selectLabel, open);
            picker.append(row, parts);
        } catch (error) {
            console.error('[Time Machine] could not list backups', error);
            // Not loaded after all: reopening the section retries the fetch.
            loaded = false;
            picker.replaceChildren(el('div', 'sbctm-empty', 'The backup list could not be read. Close and reopen this section to retry.'));
        }
    });

    return section;
}

function renderParts(host, settings, backup) {
    host.replaceChildren();
    const backupWhen = backup ? new Date(backup.date).toLocaleString() : 'the selected backup';
    if (backup) {
        host.append(el('div', 'sbctm-host-loaded', `Backup from ${backupWhen}`));
    }
    const parts = hostSnapshotParts(settings);
    if (parts.length === 0) {
        host.append(el('div', 'sbctm-empty', 'That backup has no extension settings in it.'));
        return;
    }
    for (const part of parts) {
        const stored = settings.extension_settings[part.key];
        const rows = diffFields(ctx().extensionSettings[part.key] ?? {}, stored ?? {});
        const line = el('div', 'sbctm-host-part');
        const text = el('span', 'sbctm-target-text');
        const meta = el('span', 'sbctm-target-meta',
            rows.length === 0 ? 'Same as now' : `${rows.length} setting${rows.length === 1 ? '' : 's'} differ`);
        text.append(el('span', 'sbctm-target-name', part.label), meta);
        line.append(text);
        if (rows.length > 0) {
            const restore = button('menu_button sbctm-small', 'Restore this block', async () => {
                const ok = await confirmAction(
                    'Restore this extension settings block?',
                    `${part.label}, from ${backupWhen}. The block will be replaced with this backup's version. Reload Neconyan afterwards for it to take effect.`,
                );
                if (!ok) {
                    return;
                }
                restore.disabled = true;
                try {
                    await trackWork(restoreExtensionBlock(part.key, stored));
                    meta.textContent = 'Restored; reload required';
                    globalThis.toastr?.success('Extension settings restored. Reload the page for them to take effect.');
                } catch (error) {
                    console.error('[Time Machine] extension settings restore failed', error);
                    globalThis.toastr?.error('Extension settings could not be restored.');
                    restore.disabled = false;
                }
            });
            line.append(restore);
        }
        host.append(line);
    }
}

export async function closeTimeMachine() {
    uiGeneration++;
    const popups = [...activeConfirmations];
    if (openPopup) {
        popups.push(openPopup);
        openPopup = null;
    }
    await Promise.allSettled(popups.map(popup => Promise.resolve().then(() => popup.completeCancelled?.())));
    await Promise.allSettled([...pendingWork]);
}

/** Retention settings, shown in the extensions drawer rather than the popup. */
export function renderDrawer(hostElement) {
    const settings = getSettings();
    hostElement.replaceChildren();

    for (const [key, label] of [
        ['captureCharacters', 'Snapshot characters when they are edited'],
        ['captureLorebooks', 'Snapshot lorebooks when they are saved'],
        ['capturePresets', 'Snapshot presets at startup and when you switch preset'],
    ]) {
        const wrapper = el('label', 'checkbox_label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!settings[key];
        box.addEventListener('change', async () => {
            const settings = getSettings();
            const previous = settings[key];
            settings[key] = box.checked;
            box.disabled = true;
            try {
                await commitSettings();
            } catch (error) {
                settings[key] = previous;
                box.checked = previous;
                console.error('[Time Machine] could not save capture settings', error);
                globalThis.toastr?.error(settingsSaveError(error));
            } finally {
                box.disabled = false;
            }
        });
        wrapper.append(box, el('span', '', label));
        hostElement.append(wrapper);
    }

    hostElement.append(
        numberField(hostElement, 'Versions kept per item', settings.keepPerTarget, (value) => {
            const settings = getSettings();
            const previous = settings.keepPerTarget;
            settings.keepPerTarget = value;
            return () => { settings.keepPerTarget = previous; };
        }),
        numberField(hostElement, 'Total size budget (MB)', Math.round(settings.maxTotalBytes / (1024 * 1024)), (value) => {
            const settings = getSettings();
            const previous = settings.maxTotalBytes;
            settings.maxTotalBytes = value * 1024 * 1024;
            return () => { settings.maxTotalBytes = previous; };
        }),
    );

    const used = listSnapshots().reduce((sum, row) => sum + (row.size ?? 0), 0);
    hostElement.append(el('div', 'sbctm-hint',
        `${listSnapshots().length} snapshots, ${formatBytes(used)} used. `
        + 'Snapshots are files on the server, so they are included in whatever backs up your Neconyan data directory.'));
}

function settingsSaveError(error) {
    return error?.code === 'STALE_INDEX'
        ? 'Time Machine changed in another tab. Reload Neconyan before changing its settings.'
        : 'The setting could not be saved. The change was undone.';
}

/** A labelled integer setting; `apply` writes it and returns how to undo that. */
function numberField(hostElement, label, current, apply) {
    const field = el('label', 'sbctm-field');
    field.append(el('span', '', label));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'text_pole';
    input.min = '1';
    input.step = '1';
    input.required = true;
    input.value = String(current);
    input.addEventListener('change', async () => {
        const value = input.valueAsNumber;
        if (!Number.isInteger(value) || value < 1) {
            input.reportValidity();
            input.value = String(current);
            return;
        }
        const revert = apply(value);
        input.disabled = true;
        try {
            await commitSettings();
        } catch (error) {
            revert();
            input.value = String(current);
            console.error('[Time Machine] could not save the setting', error);
            globalThis.toastr?.error(settingsSaveError(error));
            input.disabled = false;
            return;
        }
        try {
            await prune();
        } catch (error) {
            console.error('[Time Machine] retention cleanup failed', error);
            globalThis.toastr?.warning('The setting was saved, but some old snapshots could not be removed.');
        }
        renderDrawer(hostElement);
    });
    field.append(input);
    return field;
}
