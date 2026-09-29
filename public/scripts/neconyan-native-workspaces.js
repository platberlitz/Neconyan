import {
    getNeconyanLorebookFolders,
    getWorldInfoEditorBookName,
    updateNeconyanLorebookFolders,
    world_names,
} from './world-info.js';
import { createNeconyanFolder, moveNeconyanLorebook } from './neconyan-lorebook-folders.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { initModelRotation, mountModelRotationPanel } from './neconyan-model-rotation.js';

const nativeState = {
    characterRoot: null,
    lorebookRoot: null,
    modelRoot: null,
    lorebookFolder: 'all',
    lorebookQuery: '',
    lorebookSelected: '',
    lorebookBrowsing: false,
};

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function button(label, className = '') {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
}

function getLorebookNames() {
    const names = world_names;
    return Array.isArray(names) ? names.map(name => String(name ?? '')).filter(Boolean) : [];
}

function selectLorebook(name) {
    const select = document.getElementById('world_editor_select');
    const index = getLorebookNames().indexOf(name);
    if (!(select instanceof HTMLSelectElement) || index < 0) return;
    nativeState.lorebookSelected = name;
    nativeState.lorebookBrowsing = false;
    if (select.value === String(index) && getWorldInfoEditorBookName() === name) {
        renderLorebookLibrary(document.getElementById('neconyan-lorebook-library'));
        return;
    }
    select.value = String(index);
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function createCharacterLibraryHeader(listRoot, root) {
    let header = listRoot.querySelector(':scope > #neconyan-character-library');
    if (!(header instanceof HTMLElement)) {
        header = element('section', 'neconyan-native-library neconyan-character-library');
        header.id = 'neconyan-character-library';
        header.setAttribute('aria-label', 'Character library controls');
        listRoot.prepend(header);
    }

    const panel = root?.closest?.('#right-nav-panel') ?? document.getElementById('right-nav-panel');
    panel?.classList.add('neconyan-character-workspace');
    const legacyNavWrapper = panel?.querySelector('.sb-character-shell-nav-wrapper');
    const nav = header.querySelector(':scope .sb-character-native-nav')
        ?? legacyNavWrapper?.querySelector('.sb-character-shell-nav');
    if (nav instanceof HTMLElement) {
        nav.classList.add('sb-character-native-nav');
        nav.classList.add('neconyan-character-native-nav');
        const navWrapper = legacyNavWrapper ?? nav.closest('.sb-character-shell-nav-wrapper');
        if (navWrapper instanceof HTMLElement) {
            navWrapper.classList.add('neconyan-character-native-nav-wrapper');
            if (navWrapper.parentElement !== panel) panel?.prepend(navWrapper);
        } else if (nav.parentElement !== panel) {
            panel?.prepend(nav);
        }
        const editorTab = nav.querySelector('[data-sb-character-tab="editor"]');
        if (editorTab instanceof HTMLElement) editorTab.hidden = true;
        nav.querySelector('[data-sb-character-tab="world-info"]')?.setAttribute('hidden', '');
    }

    const fixedTop = listRoot.querySelector(':scope > #charListFixedTop');
    if (fixedTop instanceof HTMLElement && fixedTop.parentElement !== header) {
        header.append(fixedTop);
    }
    let filters = header.querySelector('.neconyan-character-filters');
    if (!filters) {
        filters = element('details', 'neconyan-character-filters');
        const summary = element('summary', 'neconyan-character-filters-summary');
        summary.append(element('i', 'fa-solid fa-sliders', ''), element('span', '', 'Filter and organise'));
        filters.append(summary);
        header.append(filters);
    }
    for (const control of [listRoot.querySelector('.rm_tag_controls'), listRoot.querySelector('#character_sort_order')]) {
        if (control && control.parentElement !== filters) filters.append(control);
    }
    if (!(header.querySelector(':scope > .neconyan-native-library-hint') instanceof HTMLElement)) {
        header.appendChild(element('span', 'neconyan-native-library-hint', 'Your character library'));
    }
    let footer = header.querySelector('.neconyan-character-library-footer');
    if (!footer) {
        footer = element('div', 'neconyan-character-library-footer');
        header.append(footer);
    }
    if (filters.parentElement !== footer) footer.prepend(filters);
    const secondary = header.querySelector('.sb-character-library-secondary-actions');
    if (secondary && secondary.parentElement !== filters) filters.append(secondary);
    const pagination = listRoot.querySelector('#rm_print_characters_pagination');
    if (pagination && pagination.parentElement !== footer) footer.append(pagination);
    return header;
}

function syncCharacterLibraryHeader() {
    const listRoot = document.getElementById('rm_characters_block');
    const header = listRoot?.querySelector(':scope > #neconyan-character-library');
    if (!(header instanceof HTMLElement)) return;
    const panel = document.getElementById('right-nav-panel');
    const menuType = panel?.dataset.menuType || 'characters';
    header.hidden = !['characters', 'groups'].includes(menuType);
    const total = document.getElementById('rm_print_characters_block')?.querySelectorAll('.character_select, .group_select').length;
    const hint = header.querySelector('.neconyan-native-library-hint');
    const nextText = `${total || 0} ${menuType === 'groups' ? 'groups' : 'characters'} shown`;
    if (hint instanceof HTMLElement && hint.textContent !== nextText) hint.textContent = nextText;
}

export function mountNeconyanCharacterWorkspace(root = document) {
    const listRoot = root.querySelector?.('#rm_characters_block') ?? document.getElementById('rm_characters_block');
    if (!(listRoot instanceof HTMLElement)) return;
    nativeState.characterRoot = listRoot;
    createCharacterLibraryHeader(listRoot, root);
    syncCharacterLibraryHeader();
    if (listRoot.dataset.neconyanNativeObserver !== 'true' && typeof MutationObserver !== 'undefined') {
        listRoot.dataset.neconyanNativeObserver = 'true';
        new MutationObserver(syncCharacterLibraryHeader).observe(listRoot, { childList: true, subtree: true });
    }
    const panel = root?.closest?.('#right-nav-panel') ?? document.getElementById('right-nav-panel');
    if (panel instanceof HTMLElement && panel.dataset.neconyanNativeViewObserver !== 'true' && typeof MutationObserver !== 'undefined') {
        panel.dataset.neconyanNativeViewObserver = 'true';
        new MutationObserver(syncCharacterLibraryHeader).observe(panel, { attributes: true, attributeFilter: ['data-menu-type'] });
    }
}

function ensureModelPresetWorkspace(config) {
    const presets = config.querySelector('#respective-presets-block');
    if (!(presets instanceof HTMLElement)) return;
    let workspace = config.querySelector(':scope > #neconyan-model-presets-workspace');
    if (!(workspace instanceof HTMLElement)) {
        workspace = element('section', 'neconyan-model-native-page');
        workspace.id = 'neconyan-model-presets-workspace';
        workspace.setAttribute('aria-label', 'Saved model presets');
        const heading = element('div', 'neconyan-model-native-heading');
        heading.append(element('span', 'neconyan-native-kicker', 'Presets'), element('h3', '', 'Saved writing setup'));
        workspace.appendChild(heading);
        config.prepend(workspace);
    }
    if (presets.parentElement !== workspace) workspace.appendChild(presets);
}

async function clearCustomConnectionFields() {
    // Neconyan: 'New endpoint' wipes the URL and model; ask first when there is something to lose.
    const url = document.getElementById('custom_api_url_text');
    const model = document.getElementById('custom_model_id');
    const hasContent = (url instanceof HTMLInputElement && url.value.trim()) || (model instanceof HTMLInputElement && model.value.trim());
    if (hasContent) {
        const confirmed = await callGenericPopup(t`Clear the current endpoint URL, model and key to start a new endpoint? Saved profiles are not affected.`, POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    for (const id of ['custom_endpoint_preset_name', 'custom_api_url_text', 'api_key_custom', 'custom_model_id']) {
        const input = document.getElementById(id);
        if (input instanceof HTMLInputElement) {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    const select = document.getElementById('custom_endpoint_preset');
    if (select instanceof HTMLSelectElement) {
        select.value = 'None';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function ensureCustomConnectionWorkflow(customForm) {
    const drawerContent = customForm.querySelector('.inline-drawer-content');
    const row = customForm.querySelector('#custom_endpoint_preset')?.closest('.openai_logit_bias_preset_form');
    const nameInput = customForm.querySelector('#custom_endpoint_preset_name');
    if (!(drawerContent instanceof HTMLElement) || !(row instanceof HTMLElement) || !(nameInput instanceof HTMLElement)) return;
    let section = drawerContent.querySelector(':scope > .neconyan-saved-connections');
    if (!(section instanceof HTMLElement)) {
        section = element('section', 'neconyan-saved-connections');
        section.setAttribute('aria-label', t`Custom endpoint profiles`);
        const heading = element('div', 'neconyan-model-native-heading');
        heading.append(element('span', 'neconyan-native-kicker', t`Connections`), element('h4', '', t`Custom endpoints`));
        const actions = element('div', 'neconyan-saved-connection-actions');
        const fresh = button(t`New endpoint`, 'menu_button menu_button_icon');
        fresh.innerHTML = '<i class="fa-solid fa-file-circle-plus" aria-hidden="true"></i>';
        fresh.append(element('span', '', t`New endpoint`));
        fresh.addEventListener('click', clearCustomConnectionFields);
        actions.appendChild(fresh);
        section.append(heading, actions);
        drawerContent.prepend(section);
    }
    if (row.parentElement !== section) section.appendChild(row);
    let nameLabel = section.querySelector('label[for="custom_endpoint_preset_name"]');
    if (!nameLabel) {
        nameLabel = element('label', '', t`Endpoint name`);
        nameLabel.htmlFor = nameInput.id;
        section.append(nameLabel);
        customForm.querySelector('[data-i18n="Profile Name"]')?.classList.add('neconyan-relocated-label');
    }
    const nameHost = nameInput.closest('.wide100p');
    if (nameHost instanceof HTMLElement && nameHost.parentElement !== section) section.append(nameHost);
}

function organizeSavedConnections(api, page) {
    const select = api.querySelector('#connection_profiles');
    let library = page.querySelector(':scope > .neconyan-model-saved');
    if (!library) {
        library = element('aside', 'neconyan-model-saved');
        library.setAttribute('aria-label', 'Saved connections');
        page.prepend(library);
    }
    library.hidden = !select;
    page.classList.toggle('has-saved-connections', Boolean(select));
    if (!select) return;
    const owner = select.closest('.connection-profile-picker')?.parentElement;
    if (!owner) return;
    if (owner.parentElement !== library) library.append(owner);
    const title = owner.querySelector('h3 [data-i18n="Connection Profile"]');
    if (title) { title.textContent = 'Saved connections'; title.removeAttribute('data-i18n'); }
    select.setAttribute('aria-label', 'Saved connection');
    mountModelRotationPanel(library);
    const actions = owner.querySelector('.connection-profile-actions');
    if (!actions || owner.querySelector('.neconyan-connection-management')) return;
    const management = element('details', 'neconyan-connection-management');
    management.append(element('summary', '', 'Manage connections'));
    const secondary = element('div', 'neconyan-connection-secondary');
    for (const action of [...actions.children]) {
        if (!['create_connection_profile', 'update_connection_profile'].includes(action.id)) secondary.append(action);
    }
    management.append(secondary);
    owner.append(management);
}

function organizeProviderFields(form) {
    if (form.dataset.neconyanFields === 'true') return;
    form.dataset.neconyanFields = 'true';
    for (const input of form.querySelectorAll('input[id^="api_key"], select[id*="model"], input[id*="model"]')) {
        if (!input.labels?.length && !input.hasAttribute('aria-label')) {
            input.setAttribute('aria-label', input.id.startsWith('api_key') ? 'API key' : input.tagName === 'SELECT' ? 'Available models' : 'Model ID');
        }
    }
    const children = [...form.children];
    const modelField = 'select[id*="model"], input[id*="model"]';
    let split = children.findIndex(node => node.matches(modelField) || node.querySelector(modelField));
    if (split <= 0) return;
    while (split > 0 && children[split - 1].matches('h3, h4, .range-block-title')) split--;
    if (!split) return;
    const fields = element('div', 'neconyan-provider-fields');
    const connection = element('section', 'neconyan-provider-connection');
    connection.setAttribute('aria-label', 'Connection details');
    const model = element('section', 'neconyan-provider-model');
    model.setAttribute('aria-label', 'Model selection');
    connection.append(...children.slice(0, split));
    model.append(...children.slice(split));
    const helpNodes = [...connection.children].filter(node => node.querySelector('ol, #openai_api_usage'));
    if (helpNodes.length) {
        const help = element('details', 'neconyan-provider-help');
        help.append(element('summary', '', 'Provider help'), ...helpNodes);
        connection.append(help);
    }
    fields.append(connection, model);
    form.append(fields);
}

function organizeConnectionActions(api) {
    for (const connect of api.querySelectorAll('.api_button')) {
        const row = connect.parentElement;
        if (!row || row.classList.contains('neconyan-connect-actions') || row.tagName === 'FORM') continue;
        row.classList.add('neconyan-connect-actions');
        const parent = row.parentElement;
        if (!parent) continue;
        const status = parent.querySelector(':scope > .online_status') ?? parent.parentElement?.querySelector(':scope > .online_status');
        if (status) row.append(status);
        if (connect.id === 'api_button_openai') {
            const source = parent.querySelector('#chat_completion_source');
            source?.after(row);
            const extras = [...row.children].filter(node => !node.matches('.api_button, .api_loading, .online_status'));
            if (extras.length) {
                const more = element('details', 'neconyan-connection-tools');
                more.append(element('summary', '', 'Connection tools'), ...extras);
                row.append(more);
            }
        } else {
            parent.prepend(row);
        }
    }
}

function ensureModelConnectionWorkspace(apiRoot) {
    const api = apiRoot.querySelector('#rm_api_block') ?? apiRoot;
    if (!(api instanceof HTMLElement)) return;
    api.classList.add('neconyan-model-connections-page');
    let page = api.querySelector(':scope > #neconyan-model-connections-native');
    if (!page) {
        page = element('section', 'neconyan-model-connections-native');
        page.id = 'neconyan-model-connections-native';
        page.setAttribute('aria-label', 'Model connections');
        const stack = api.querySelector(':scope > .flex-container');
        const title = api.querySelector(':scope > #title_api');
        api.prepend(page);
        if (title) title.hidden = true;
        if (stack) { stack.classList.add('neconyan-model-provider-stack'); page.append(stack); }
    }
    organizeSavedConnections(api, page);
    const selector = page.querySelector('#main-API-selector-block');
    if (selector) {
        selector.classList.add('neconyan-model-service-selector');
        if (!selector.querySelector('label[for="main_api"]')) {
            const label = element('label', '', 'Reply format');
            label.htmlFor = 'main_api';
            selector.prepend(label);
            selector.querySelector('#main_api')?.setAttribute('aria-label', 'Reply format');
        }
    }
    const provider = page.querySelector('#chat_completion_source');
    const providerLabel = provider?.previousElementSibling;
    if (providerLabel?.tagName === 'H4' && providerLabel.textContent.trim() !== 'Provider') {
        providerLabel.textContent = 'Provider';
        providerLabel.removeAttribute('data-i18n');
        provider.setAttribute('aria-label', 'Provider');
    }
    const customForm = page.querySelector('#custom_form');
    if (customForm) ensureCustomConnectionWorkflow(customForm);
    for (const form of page.querySelectorAll('form')) organizeProviderFields(form);
    organizeConnectionActions(api);
    const nav = document.querySelector('#left-nav-panel .sb-model-native-nav-wrapper .sb-shell-nav');
    const connectionTab = nav?.querySelector('[data-sb-tab="api"]');
    if (connectionTab && nav.firstElementChild !== connectionTab) nav.prepend(connectionTab);
    if (api.dataset.neconyanConnectionObserver !== 'true') {
        api.dataset.neconyanConnectionObserver = 'true';
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; ensureModelConnectionWorkspace(api); });
        }).observe(api, { childList: true, subtree: true });
    }
}

export function mountNeconyanModelWorkspace(root = document) {
    initModelRotation();
    const config = root.querySelector?.('#ai_response_configuration') ?? document.getElementById('ai_response_configuration');
    if (!(config instanceof HTMLElement)) return;
    nativeState.modelRoot = config;
    ensureModelPresetWorkspace(config);
    const apiRoot = root.querySelector?.('#sys-settings-button > .sb-shell-embedded-content')
        ?? root.querySelector?.('#rm_api_block')
        ?? document.getElementById('rm_api_block');
    if (apiRoot instanceof HTMLElement) ensureModelConnectionWorkspace(apiRoot);
}

function getLorebookFolderName(metadata, folderId) {
    return metadata.folders.find(folder => folder.id === folderId)?.name || 'Unfiled';
}

async function mutateLorebookFolders(mutator, render) {
    try {
        await updateNeconyanLorebookFolders(mutator);
        render();
        return true;
    } catch (error) {
        globalThis.toastr?.error?.(error?.message || 'Lorebook folders could not be saved.', 'Lorebooks');
        render();
        return false;
    }
}

function createLorebookLibrary(worldInfo) {
    let library = worldInfo.querySelector('#neconyan-lorebook-library');
    if (library instanceof HTMLElement) {
        const toolbar = library.querySelector('.neconyan-lorebook-toolbar');
        const primaryActions = worldInfo.querySelector('#world_popup_primary_actions');
        if (toolbar instanceof HTMLElement && primaryActions instanceof HTMLElement && primaryActions.parentElement !== toolbar) {
            primaryActions.classList.add('neconyan-lorebook-primary-actions');
            toolbar.appendChild(primaryActions);
        }
        return library;
    }

    library = element('section', 'neconyan-native-workspace neconyan-lorebook-library');
    library.id = 'neconyan-lorebook-library';
    library.setAttribute('aria-labelledby', 'neconyan-lorebook-library-title');
    const heading = element('div', 'neconyan-native-workspace-heading');
    const libraryLabel = element('span', 'neconyan-native-kicker', 'Library');
    libraryLabel.id = 'neconyan-lorebook-library-title';
    heading.append(libraryLabel);
    heading.appendChild(element('span', 'neconyan-lorebook-selected', 'Choose a book to edit its entries.'));
    const toolbar = element('div', 'neconyan-lorebook-toolbar');
    const back = button('Back to library', 'menu_button menu_button_icon neconyan-lorebook-back');
    back.innerHTML = '<i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>Back to library</span>';
    back.addEventListener('click', () => {
        nativeState.lorebookBrowsing = true;
        renderLorebookLibrary(library);
    });
    const newFolder = button('New folder', 'menu_button menu_button_icon neconyan-lorebook-new-folder');
    newFolder.innerHTML = '<i class="fa-solid fa-folder-plus" aria-hidden="true"></i><span>New folder</span>';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole';
    search.placeholder = 'Search lorebooks';
    search.setAttribute('aria-label', 'Search lorebooks');
    search.addEventListener('input', () => {
        nativeState.lorebookQuery = search.value.trim().toLowerCase();
        renderLorebookLibrary(library);
    });
    newFolder.addEventListener('click', async () => {
        const name = window.prompt('Name this lorebook folder:')?.trim();
        if (!name) return;
        const metadata = getNeconyanLorebookFolders();
        if (metadata.folders.some(folder => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            globalThis.toastr?.warning?.('A folder with that name already exists.', 'Lorebooks');
            return;
        }
        await mutateLorebookFolders(current => ({
            ...current,
            folders: [...current.folders, createNeconyanFolder(name)],
        }), () => renderLorebookLibrary(library));
    });
    toolbar.append(back, newFolder, search);
    const primaryActions = worldInfo.querySelector('#world_popup_primary_actions');
    if (primaryActions instanceof HTMLElement && primaryActions.parentElement !== toolbar) {
        primaryActions.classList.add('neconyan-lorebook-primary-actions');
        toolbar.appendChild(primaryActions);
    }
    const folderNav = element('nav', 'neconyan-lorebook-folders');
    folderNav.setAttribute('aria-label', 'Lorebook folders');
    const books = element('div', 'neconyan-lorebook-books');
    library.append(heading, toolbar, folderNav, books);
    const holder = worldInfo.querySelector('#wi-holder');
    if (holder instanceof HTMLElement) holder.prepend(library);
    else worldInfo.prepend(library);
    return library;
}

function renderLorebookLibrary(library) {
    if (!(library instanceof HTMLElement)) return;
    const metadata = getNeconyanLorebookFolders();
    const names = getLorebookNames();
    const editorSelect = document.getElementById('world_editor_select');
    const selectedValue = editorSelect instanceof HTMLSelectElement ? editorSelect.value.trim() : '';
    const selectedIndex = selectedValue === '' ? -1 : Number(selectedValue);
    nativeState.lorebookSelected = Number.isInteger(selectedIndex) && selectedIndex >= 0 ? names[selectedIndex] || '' : '';
    const view = nativeState.lorebookSelected && !nativeState.lorebookBrowsing ? 'book' : 'library';
    library.dataset.view = view;
    const worldInfo = library.closest('#WorldInfo');
    if (worldInfo) worldInfo.dataset.neconyanLorebookView = view;
    const selectedCopy = library.querySelector('.neconyan-lorebook-selected');
    if (selectedCopy instanceof HTMLElement) selectedCopy.textContent = view === 'book'
        ? `${nativeState.lorebookSelected} · ${getLorebookFolderName(metadata, metadata.assignments[nativeState.lorebookSelected])}`
        : 'Choose a book to edit its entries.';
    const primaryActions = library.querySelector('#world_popup_primary_actions');
    const primaryGroup = primaryActions?.querySelector('.world_popup_action_group--select');
    if (primaryGroup) {
        let legacyPicker = primaryGroup.querySelector('.neconyan-legacy-book-picker');
        if (!legacyPicker) {
            legacyPicker = element('div', 'neconyan-legacy-book-picker');
            legacyPicker.hidden = true;
            primaryGroup.append(legacyPicker);
        }
        for (const child of [...primaryGroup.children]) {
            if (child !== legacyPicker && !child.matches('button, input[type="file"], .menu_button, [data-extension-name]')) legacyPicker.append(child);
        }
        for (const id of ['world_import_button', 'world_batch_import_embedded']) {
            const action = document.getElementById(id);
            if (action && action.parentElement !== primaryGroup) primaryGroup.append(action);
        }
    }
    const folderNav = library.querySelector('.neconyan-lorebook-folders');
    const books = library.querySelector('.neconyan-lorebook-books');
    if (!(folderNav instanceof HTMLElement) || !(books instanceof HTMLElement)) return;
    folderNav.replaceChildren();

    const counts = new Map(metadata.folders.map(folder => [folder.id, 0]));
    for (const name of names) {
        const folderId = metadata.assignments[name];
        if (folderId && counts.has(folderId)) counts.set(folderId, counts.get(folderId) + 1);
    }
    const folderButtons = [
        ['all', 'All books', names.length],
        ['unfiled', 'Unfiled', names.filter(name => !metadata.assignments[name]).length],
        ...metadata.folders.map(folder => [folder.id, folder.name, counts.get(folder.id) || 0]),
    ];
    for (const [id, label, count] of folderButtons) {
        const item = element('div', 'neconyan-lorebook-folder-item');
        const select = button(`${label} ${count}`, `neconyan-lorebook-folder${nativeState.lorebookFolder === id ? ' is-active' : ''}`);
        select.setAttribute('aria-pressed', String(nativeState.lorebookFolder === id));
        select.addEventListener('click', () => {
            nativeState.lorebookFolder = id;
            renderLorebookLibrary(library);
        });
        item.appendChild(select);
        if (id !== 'all' && id !== 'unfiled') {
            const rename = button('Rename', 'neconyan-lorebook-folder-action');
            rename.addEventListener('click', async event => {
                event.stopPropagation();
                const nextName = window.prompt('Rename this folder:', label)?.trim();
                if (!nextName || nextName === label) return;
                const currentMetadata = getNeconyanLorebookFolders();
                if (currentMetadata.folders.some(folder => folder.id !== id && folder.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
                    globalThis.toastr?.warning?.('A folder with that name already exists.', 'Lorebooks');
                    return;
                }
                await mutateLorebookFolders(current => ({
                    ...current,
                    folders: current.folders.map(folder => folder.id === id ? { ...folder, name: nextName.slice(0, 120) } : folder),
                }), () => renderLorebookLibrary(library));
            });
            const remove = button('Delete', 'neconyan-lorebook-folder-action caution');
            remove.addEventListener('click', async event => {
                event.stopPropagation();
                if (!window.confirm(`Delete the folder “${label}”? Its books will become Unfiled.`)) return;
                if (nativeState.lorebookFolder === id) nativeState.lorebookFolder = 'all';
                await mutateLorebookFolders(current => ({
                    ...current,
                    folders: current.folders.filter(folder => folder.id !== id),
                    assignments: Object.fromEntries(Object.entries(current.assignments).filter(([, folderId]) => folderId !== id)),
                }), () => renderLorebookLibrary(library));
            });
            item.append(rename, remove);
        }
        folderNav.appendChild(item);
    }

    const query = nativeState.lorebookQuery;
    const selectedFolder = nativeState.lorebookFolder;
    const visibleNames = names.filter(name => {
        if (query && !name.toLocaleLowerCase().includes(query)) return false;
        const folderId = metadata.assignments[name];
        if (selectedFolder === 'unfiled') return !folderId;
        return selectedFolder === 'all' || folderId === selectedFolder;
    });
    books.replaceChildren();
    if (!visibleNames.length) {
        books.appendChild(element('p', 'neconyan-lorebook-empty', names.length ? 'No lorebooks match this view.' : 'No lorebooks yet. Create or import one to get started.'));
        return;
    }
    for (const name of visibleNames) {
        const row = element('article', 'neconyan-lorebook-book');
        const open = button('', 'neconyan-lorebook-book-open');
        open.setAttribute('aria-label', t`Open ${name}`);
        open.append(element('i', 'fa-solid fa-book-open', ''), element('span', '', name));
        open.addEventListener('click', () => selectLorebook(name));
        const location = element('span', 'neconyan-lorebook-book-location', getLorebookFolderName(metadata, metadata.assignments[name]));
        const move = document.createElement('select');
        move.className = 'text_pole neconyan-lorebook-book-move';
        move.setAttribute('aria-label', `Folder for ${name}`);
        move.appendChild(new Option('Unfiled', ''));
        for (const folder of metadata.folders) move.appendChild(new Option(folder.name, folder.id));
        move.value = metadata.assignments[name] || '';
        move.addEventListener('change', async () => {
            move.disabled = true;
            await mutateLorebookFolders(current => moveNeconyanLorebook(current, name, move.value), () => renderLorebookLibrary(library));
            move.disabled = false;
        });
        row.append(open, location, move);
        books.appendChild(row);
    }
}

function ensureLorebookSecondarySettings(worldInfo) {
    const topBlock = worldInfo.querySelector('#wiTopBlock');
    if (!(topBlock instanceof HTMLElement) || topBlock.dataset.neconyanNativeDisclosure === 'true') return;
    topBlock.dataset.neconyanNativeDisclosure = 'true';
    const details = document.createElement('details');
    details.className = 'neconyan-lorebook-secondary-settings';
    const summary = document.createElement('summary');
    summary.textContent = 'Lorebook settings';
    const parent = topBlock.parentElement;
    parent?.insertBefore(details, topBlock);
    details.append(summary);
    const originalHeading = worldInfo.querySelector(':scope > .flex-container:has(#WI_panel_pin)');
    if (originalHeading) details.append(originalHeading);
    details.append(topBlock);
}

function syncLorebookSelectedWorkspace(worldInfo) {
    const popup = worldInfo.querySelector('#world_popup');
    const select = document.getElementById('world_editor_select');
    if (!(popup instanceof HTMLElement)) return;
    const hasSelection = select instanceof HTMLSelectElement && select.value.trim() !== '';
    popup.classList.toggle('neconyan-lorebook-no-selection', !hasSelection);
}

export function mountNeconyanLorebookWorkspace(root = document) {
    const worldInfo = root.querySelector?.('#WorldInfo') ?? document.getElementById('WorldInfo');
    if (!(worldInfo instanceof HTMLElement)) return;
    nativeState.lorebookRoot = worldInfo;
    const library = createLorebookLibrary(worldInfo);
    ensureLorebookSecondarySettings(worldInfo);
    renderLorebookLibrary(library);
    syncLorebookSelectedWorkspace(worldInfo);
    void import('./neconyan-lorebook-tools.js').then(({ mountLorebookTools }) => mountLorebookTools(worldInfo))
        .catch(error => console.error('Lorebook tools failed to load:', error));
    void import('./neconyan-lorebook-tour.js').then(({ mountLorebookTour }) => mountLorebookTour(worldInfo))
        .catch(error => console.error('Lorebook tour failed to load:', error));
    if (worldInfo.dataset.neconyanNativeObserver !== 'true') {
        worldInfo.dataset.neconyanNativeObserver = 'true';
        window.addEventListener('neconyan:lorebooks-updated', () => renderLorebookLibrary(library));
        const namesObserver = new MutationObserver(() => renderLorebookLibrary(library));
        const editorSelect = document.getElementById('world_editor_select');
        if (editorSelect instanceof HTMLElement) {
            namesObserver.observe(editorSelect, { childList: true });
            // Native imports and renames dispatch jQuery change events.
            $(editorSelect).on('change.neconyanNativeWorkspace', () => {
                const name = getLorebookNames()[Number(editorSelect.value)];
                if (name !== nativeState.lorebookSelected) nativeState.lorebookBrowsing = false;
                renderLorebookLibrary(library);
                syncLorebookSelectedWorkspace(worldInfo);
            });
        }
    }
}
