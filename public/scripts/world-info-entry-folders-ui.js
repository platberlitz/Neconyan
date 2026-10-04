import { t } from './i18n.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';
import { ENTRY_FOLDER_KEY, addEntryFolder, findEntryFolderHeadingAt, getEntryFolder, getEntryFolders, groupEntriesByFolder, normalizeEntryFolder, renameEntryFolder, resolveEntryFolderDrop, setEntryFolder } from './world-info-entry-folders.js';

const views = new Map();

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, icon, action, iconOnly = false) {
    const node = element('button', 'menu_button menu_button_icon');
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    const glyph = element('i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph);
    if (!iconOnly) node.append(element('span', '', label));
    node.addEventListener('click', event => {
        event.stopPropagation();
        Promise.resolve(action()).catch(error => {
            console.error('Entry folder action failed', error);
            toastr.error('The folder change could not be saved.');
        });
    });
    return node;
}

/** One controller per render; only navigation and collapsed state survive between renders. */
export function createEntryFolderUI({ name, data, save, refresh, syncOriginal, requestedUid }) {
    const host = document.getElementById('world_info_entry_folders');
    if (!host) return null;
    host.replaceChildren();
    host.hidden = !data?.entries;
    if (!data?.entries) return null;
    const storageKey = `neconyan-entry-folders-closed:${name}`;
    if (!views.has(name)) {
        let closed = [];
        try { closed = JSON.parse(accountStorage.getItem(storageKey) || '[]'); } catch { /* Use open folders. */ }
        views.set(name, { filter: null, closed: new Set(Array.isArray(closed) ? closed : []) });
    }
    const view = views.get(name);
    const folders = getEntryFolders(data);
    if (view.filter && !folders.includes(view.filter)) view.filter = null;
    if (requestedUid !== null && data.entries[requestedUid]) {
        const folder = getEntryFolder(data.entries[requestedUid]);
        view.closed.delete(folder);
        if (view.filter !== null && view.filter !== folder) view.filter = null;
    }

    async function commit(changed = [], navigation = undefined) {
        changed.forEach(entry => syncOriginal(entry.uid, `extensions.${ENTRY_FOLDER_KEY}`, getEntryFolder(entry)));
        await save();
        await refresh(navigation);
    }

    let dropHeading = null;
    function setDropHeading(heading) {
        if (dropHeading === heading) return;
        dropHeading?.classList.remove('neco-entry-folder-drop-target');
        dropHeading = heading;
        dropHeading?.classList.add('neco-entry-folder-drop-target');
    }
    function precedingHeading(node) {
        for (let sibling = node?.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            if (sibling.classList.contains('neco-entry-folder-heading')) return sibling;
        }
        return null;
    }

    async function moveEntries(initialEntries = null) {
        const body = element('div', 'neco-entry-folder-picker');
        const label = element('label', '', 'Destination folder');
        const input = element('input', 'text_pole');
        input.type = 'text';
        input.maxLength = 120;
        input.placeholder = 'Choose or type a folder; leave blank to unfile';
        input.setAttribute('list', 'neco-entry-folder-options');
        input.value = initialEntries?.length === 1 ? getEntryFolder(initialEntries[0]) : view.filter ?? '';
        const suggestions = element('datalist', '');
        suggestions.id = 'neco-entry-folder-options';
        folders.forEach(folder => suggestions.append(new Option(folder, folder)));
        label.append(input);
        body.append(label, suggestions);
        const selected = new Set(initialEntries?.map(entry => entry.uid) ?? []);
        if (!initialEntries) {
            const search = element('input', 'text_pole');
            search.type = 'search';
            search.placeholder = 'Find entries to move';
            search.setAttribute('aria-label', 'Find entries to move');
            const list = element('div', 'neco-entry-folder-picks');
            const rows = Object.values(data.entries).map(entry => {
                const row = element('label', 'checkbox_label');
                const check = element('input', '');
                check.type = 'checkbox';
                check.addEventListener('change', () => check.checked ? selected.add(entry.uid) : selected.delete(entry.uid));
                row.append(check, element('span', '', entry.comment || entry.key?.join(', ') || `Entry ${entry.uid}`));
                row.dataset.search = `${entry.comment ?? ''} ${(entry.key ?? []).join(' ')} ${getEntryFolder(entry)}`.toLocaleLowerCase();
                list.append(row);
                return { row, check, uid: entry.uid };
            });
            search.addEventListener('input', () => rows.forEach(({ row }) => {
                row.hidden = !row.dataset.search.includes(search.value.trim().toLocaleLowerCase());
            }));
            const actions = element('div', 'flex-container');
            actions.append(button('Select shown', 'fa-check-double', () => rows.forEach(({ row, check, uid }) => {
                if (!row.hidden) { check.checked = true; selected.add(uid); }
            })), button('Clear selection', 'fa-xmark', () => {
                selected.clear();
                rows.forEach(({ check }) => { check.checked = false; });
            }));
            body.append(search, actions, list);
        }
        body.prepend(element('h3', '', 'Move entries to a folder'));
        if (!await new Popup(body, POPUP_TYPE.CONFIRM, null, { okButton: 'Move entries' }).show()) return;
        if (!selected.size) return;
        const folder = addEntryFolder(data, input.value);
        const entries = [...selected].map(uid => data.entries[uid]).filter(Boolean);
        entries.forEach(entry => setEntryFolder(entry, folder));
        view.closed.delete(folder);
        await commit(entries);
    }

    const filter = element('select', 'text_pole');
    filter.setAttribute('aria-label', 'Entry folder');
    filter.append(new Option('All folders', '*'), new Option('Unfiled', ''));
    folders.forEach(folder => filter.append(new Option(folder, `folder:${folder}`)));
    filter.value = view.filter === null ? '*' : view.filter ? `folder:${view.filter}` : '';
    filter.addEventListener('change', () => {
        view.filter = filter.value === '*' ? null : filter.value.replace(/^folder:/, '');
        refresh();
    });
    host.append(filter, button('New folder', 'fa-folder-plus', async () => {
        const value = await Popup.show.input('New entry folder', 'Folder name');
        if (!normalizeEntryFolder(value)) return;
        addEntryFolder(data, value);
        await commit();
    }), button('Move entries', 'fa-folder-open', () => moveEntries()));

    return {
        hasFolders: folders.length > 0,
        filter: entries => groupEntriesByFolder(entries, data, view.filter),
        dragStart(list) {
            if (!folders.length) return;
            setDropHeading(null);
            list.classList.add('neco-entry-folder-dragging');
        },
        dragOver(list, event) {
            if (!folders.length) return;
            // Highlight where the entry will land: the heading under the pointer, else the folder holding the gap.
            const hovered = findEntryFolderHeadingAt(list.querySelectorAll(':scope > .neco-entry-folder-heading'), event?.clientX, event?.clientY);
            setDropHeading(hovered ?? precedingHeading(list.querySelector(':scope > .ui-sortable-placeholder')));
        },
        /** Returns the entry and its new folder, or null when the drop leaves the folder unchanged. */
        dragEnd(list, item) {
            const heading = dropHeading?.isConnected ? dropHeading : null;
            setDropHeading(null);
            list.classList.remove('neco-entry-folder-dragging');
            if (!folders.length) return null;
            const entry = data.entries[item?.getAttribute('uid')];
            if (!entry) return null;
            const preceding = precedingHeading(item);
            const folder = resolveEntryFolderDrop({
                hovered: heading ? heading.dataset.folder ?? '' : null,
                preceding: preceding ? preceding.dataset.folder ?? '' : null,
            });
            return folder === getEntryFolder(entry) ? null : { entry, folder };
        },
        async moveEntry(entry, folder) {
            setEntryFolder(entry, folder);
            view.closed.delete(folder);
            await commit([entry], entry.uid);
        },
        fileNewEntry(entry) {
            if (view.filter) {
                setEntryFolder(entry, view.filter);
                syncOriginal(entry.uid, `extensions.${ENTRY_FOLDER_KEY}`, view.filter);
            }
        },
        render(list, blocks, searching = false) {
            if (!folders.length) { list.append(...blocks.map(block => block[0] ?? block)); return; }
            const groups = new Map(['', ...folders].map(folder => [folder, []]));
            blocks.forEach(block => {
                const uid = block.dataset ? block.getAttribute('uid') : block.attr('uid');
                const folder = getEntryFolder(data.entries[uid]);
                groups.get(folder)?.push(block[0] ?? block);
            });
            for (const [folder, children] of groups) {
                const total = Object.values(data.entries).filter(entry => getEntryFolder(entry) === folder).length;
                if (!children.length && (total || !folder || (view.filter !== null && view.filter !== folder) || searching)) continue;
                const row = element('div', 'neco-entry-folder-heading');
                row.dataset.folder = folder;
                const collapsed = view.closed.has(folder) && !searching;
                children.forEach(node => node.classList.toggle('neco-entry-folder-hidden', collapsed));
                const toggle = button(`${folder || t`Unfiled`} (${total})`, collapsed ? 'fa-folder' : 'fa-folder-open', () => {
                    const closed = toggle.getAttribute('aria-expanded') === 'true';
                    if (closed) view.closed.add(folder); else view.closed.delete(folder);
                    accountStorage.setItem(storageKey, JSON.stringify([...view.closed]));
                    toggle.setAttribute('aria-expanded', String(!closed));
                    toggle.querySelector('i').className = `fa-solid ${closed ? 'fa-folder' : 'fa-folder-open'}`;
                    children.forEach(node => node.classList.toggle('neco-entry-folder-hidden', closed));
                });
                toggle.setAttribute('aria-expanded', String(!collapsed));
                row.append(toggle);
                if (folder) {
                    row.append(button('Rename folder', 'fa-pen', async () => {
                        const next = await Popup.show.input('Rename entry folder', 'Folder name', folder);
                        if (!normalizeEntryFolder(next)) return;
                        const changed = renameEntryFolder(data, folder, next);
                        if (view.filter === folder) view.filter = normalizeEntryFolder(next);
                        view.closed.delete(folder);
                        await commit(changed);
                    }, true), button('Remove folder', 'fa-folder-minus', async () => {
                        if (!await Popup.show.confirm('Remove folder?', 'Its entries will move to Unfiled. Their contents and activation settings stay as they are.')) return;
                        const changed = renameEntryFolder(data, folder, '');
                        if (view.filter === folder) view.filter = null;
                        view.closed.delete(folder);
                        await commit(changed);
                    }, true));
                }
                list.append(row, ...children);
            }
        },
        entryButton(entry) {
            return button('Folder', 'fa-folder-open', () => moveEntries([entry]));
        },
    };
}
