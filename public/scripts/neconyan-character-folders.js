import { characters, entitiesFilter, generateRaw, getGeneratingModel, online_status, saveSettingsDebounced } from '../script.js';
import { eventSource, event_types } from './events.js';
import { FILTER_TYPES } from './filters.js';
import { groups } from './group-chats.js';
import { t, translate } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user } from './power-user.js';
import {
    addTagsToEntity,
    chooseBogusFolder,
    createNewTag,
    printTagFilters,
    sortTags,
    tag_filter_type,
    tag_map,
    tags,
} from './tags.js';
import {
    AI_SORT_BATCH_MAX,
    AI_SORT_BATCH_MIN,
    AI_SORT_MAX_CUSTOM_PROMPTS,
    AI_SORT_MAX_PROMPT_LENGTH,
    AI_SORT_PRESETS,
    CHARACTER_FOLDER_SETTINGS_KEY,
    IMPORT_SOURCES,
    buildAiSortPrompt,
    buildFolderTabs,
    chunkForAiSort,
    classifyAiSortError,
    createCustomPrompt,
    describeAiSortPlan,
    detectImportSource,
    isFolderTag,
    mergeNewFolderSpellings,
    normalizeCharacterFolderSettings,
    normalizeFolderName,
    parseAiSortResponse,
    planImportFolder,
    resolveAiSortPrompt,
    summarizeCharacterForSort,
} from './neconyan-character-folders-policy.js';

const ROOT_ID = 'neconyan-folder-tabs';
const RAIL_ID = 'neconyan-folder-tabs-rail';
const ALL_TAB_ID = '';

let initialized = false;
let root = null;
let rail = null;
let toggleButton = null;
let currentLabel = null;
let renderQueued = false;
let revealedTabId = null;
let observedFilterList = null;
let settingsSource = null;
let settingsCache = null;

const filterObserver = new MutationObserver(() => scheduleRender());
const blockObserver = new MutationObserver(() => scheduleRender());

/** @returns {import('./neconyan-character-folders-policy.js').CharacterFolderSettings} */
function getSettings() {
    const raw = power_user[CHARACTER_FOLDER_SETTINGS_KEY];
    if (!settingsCache || raw !== settingsSource) {
        settingsCache = normalizeCharacterFolderSettings(raw);
        power_user[CHARACTER_FOLDER_SETTINGS_KEY] = settingsCache;
        settingsSource = settingsCache;
    }
    return settingsCache;
}

function saveSettings() {
    power_user[CHARACTER_FOLDER_SETTINGS_KEY] = getSettings();
    saveSettingsDebounced();
}

function getSelectedTagIds() {
    const selected = entitiesFilter?.getFilterData?.(FILTER_TYPES.TAG)?.selected;
    return Array.isArray(selected) ? selected.map(String) : [];
}

function getEntityKeys() {
    return [
        ...characters.map(character => character?.avatar).filter(Boolean),
        ...groups.map(group => group?.id).filter(Boolean),
    ];
}

function getFolderTags() {
    return sortTags(tags.filter(isFolderTag));
}

function findTagByName(name) {
    const key = normalizeFolderName(name);
    return tags.find(tag => normalizeFolderName(tag?.name) === key) ?? null;
}

/**
 * Returns a folder tag with this name, turning a plain tag of the same name into
 * a folder or creating a new one.
 * @param {string} name
 * @param {'OPEN'|'CLOSED'} folderType Type for a folder made here
 */
function ensureFolderTag(name, folderType = 'OPEN') {
    const existing = findTagByName(name);
    if (existing) {
        if (!isFolderTag(existing)) existing.folder_type = folderType;
        return existing;
    }
    const created = createNewTag(name);
    if (created) created.folder_type = folderType;
    return created ?? null;
}

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function icon(name) {
    const node = el('i', `fa-solid ${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function buildRoot() {
    const container = el('div', 'neconyan-folder-tabs');
    container.id = ROOT_ID;

    const head = el('div', 'neconyan-folder-tabs-head');
    toggleButton = el('button', 'neconyan-folder-tabs-toggle');
    toggleButton.type = 'button';
    toggleButton.setAttribute('aria-controls', RAIL_ID);
    toggleButton.append(icon('fa-chevron-down'), el('span', 'neconyan-folder-tabs-title', t`Folders`));
    currentLabel = el('span', 'neconyan-folder-tabs-current');
    toggleButton.append(currentLabel);
    toggleButton.addEventListener('click', () => {
        const settings = getSettings();
        settings.tabs.collapsed = !settings.tabs.collapsed;
        saveSettings();
        renderTabs();
    });

    const organise = el('button', 'neconyan-folder-tabs-organise');
    organise.type = 'button';
    organise.title = t`Folder tabs, sorting imports by site and sorting with AI`;
    organise.append(icon('fa-wand-magic-sparkles'), el('span', '', t`Organise`));
    organise.addEventListener('click', () => openOrganiser());

    head.append(toggleButton, organise);

    rail = el('div', 'neconyan-folder-tabs-rail');
    rail.id = RAIL_ID;
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', t`Character folders`);
    rail.addEventListener('click', onRailClick);

    container.append(head, rail);
    return container;
}

function ensureMounted() {
    const block = document.getElementById('rm_characters_block');
    if (!block) return false;
    if (!root) root = buildRoot();

    const library = document.getElementById('neconyan-character-library');
    if (library && block.contains(library)) {
        if (root.parentElement !== library) library.append(root);
    } else if (!block.contains(root)) {
        const list = document.getElementById('rm_print_characters_block');
        block.insertBefore(root, list?.parentElement === block ? list : null);
    }

    const filterList = block.querySelector('.rm_tag_filter');
    if (filterList && filterList !== observedFilterList) {
        filterObserver.disconnect();
        filterObserver.observe(filterList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        observedFilterList = filterList;
    }
    return true;
}

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderTabs();
    });
}

function tabLabel(name, count) {
    return [name, count === 1 ? t`1 character` : t`${count} characters`].join(', ');
}

/**
 * Updates one tab button in place so the rail and its scroll chrome stay put.
 */
function updateTab(button, { id, name, count, selected, closed, empty }) {
    button.dataset.folderId = id;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-disabled', String(empty && !selected));
    button.title = empty ? t`${name} is empty` : tabLabel(name, count);
    button.classList.toggle('is-closed', closed);

    const iconName = id === ALL_TAB_ID ? 'fa-users' : closed ? 'fa-folder' : 'fa-folder-open';
    let iconNode = button.querySelector('i');
    if (!iconNode) {
        iconNode = icon(iconName);
        button.append(iconNode);
    }
    iconNode.className = `fa-solid ${iconName}`;

    let nameNode = button.querySelector('.neconyan-folder-tab-name');
    if (!nameNode) {
        nameNode = el('span', 'neconyan-folder-tab-name');
        button.append(nameNode);
    }
    if (nameNode.textContent !== name) nameNode.textContent = name;

    let countNode = button.querySelector('.neconyan-folder-tab-count');
    if (!countNode) {
        countNode = el('span', 'neconyan-folder-tab-count');
        countNode.setAttribute('aria-hidden', 'true');
        button.append(countNode);
    }
    const countText = String(count);
    if (countNode.textContent !== countText) countNode.textContent = countText;
}

function renderTabs() {
    if (!ensureMounted()) return;
    const settings = getSettings();
    const selectedIds = getSelectedTagIds();
    const folders = buildFolderTabs({
        tags: getFolderTags(),
        tagMap: tag_map,
        entityKeys: getEntityKeys(),
        hidden: settings.tabs.hidden,
        selected: selectedIds,
    });
    const visible = folders.filter(folder => !folder.hidden || folder.selected);
    const active = folders.find(folder => folder.selected) ?? null;

    const collapsed = settings.tabs.collapsed;
    root.dataset.collapsed = String(collapsed);
    toggleButton.setAttribute('aria-expanded', String(!collapsed));
    toggleButton.title = collapsed ? t`Show folder tabs` : t`Hide folder tabs`;
    const currentText = active ? active.name : t`All characters`;
    if (currentLabel.textContent !== currentText) currentLabel.textContent = currentText;
    rail.hidden = collapsed;

    const wanted = [
        { id: ALL_TAB_ID, name: t`All`, count: characters.length, selected: !active, closed: false, empty: false },
        ...visible.map(folder => ({ ...folder, empty: folder.count === 0 })),
    ];

    const existing = new Map();
    for (const button of rail.querySelectorAll('.neconyan-folder-tab')) {
        existing.set(button.dataset.folderId ?? '', button);
    }

    let previous = null;
    for (const tab of wanted) {
        let button = existing.get(tab.id);
        existing.delete(tab.id);
        if (!button) {
            button = el('button', 'neconyan-folder-tab');
            button.type = 'button';
        }
        updateTab(button, tab);
        const expectedPosition = previous ? previous.nextElementSibling : rail.firstElementChild;
        if (expectedPosition !== button) {
            rail.insertBefore(button, expectedPosition);
        }
        previous = button;
    }
    for (const stale of existing.values()) stale.remove();

    let addButton = rail.querySelector('.neconyan-folder-tab-add');
    if (!addButton) {
        addButton = el('button', 'neconyan-folder-tab-add');
        addButton.type = 'button';
        addButton.append(icon('fa-plus'), el('span', '', t`New folder`));
    }
    if (rail.lastElementChild !== addButton) rail.append(addButton);

    const selectedTabId = active ? active.id : ALL_TAB_ID;
    if (!collapsed && selectedTabId !== revealedTabId) {
        revealedTabId = selectedTabId;
        revealTab(rail.querySelector('.neconyan-folder-tab[aria-pressed="true"]'));
    }
}

/**
 * Scrolls the rail sideways, never the page, so the selected tab sits clear of the swipe arrows.
 * @param {Element|null} button
 */
function revealTab(button) {
    if (!(button instanceof HTMLElement) || rail.scrollWidth <= rail.clientWidth) return;
    const margin = 48;
    const railBox = rail.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const left = box.left - railBox.left + rail.scrollLeft;
    const right = left + box.width;
    let next = rail.scrollLeft;
    if (left - margin < rail.scrollLeft) next = left - margin;
    else if (right + margin > rail.scrollLeft + rail.clientWidth) next = right + margin - rail.clientWidth;
    next = Math.max(0, Math.min(next, rail.scrollWidth - rail.clientWidth));
    if (Math.abs(next - rail.scrollLeft) < 1) return;
    const reduced = document.body.classList.contains('reduced-motion')
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: next, behavior: reduced ? 'auto' : 'smooth' });
}

async function onRailClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.neconyan-folder-tab-add')) {
        await promptNewFolder();
        return;
    }
    const button = target.closest('.neconyan-folder-tab');
    if (!button) return;
    if (button.getAttribute('aria-disabled') === 'true') {
        toastr.info(t`Add characters to this folder from their tags, or with Organise.`, t`This folder is empty`);
        return;
    }
    selectFolder(button, button.dataset.folderId ?? ALL_TAB_ID);
}

/**
 * Shows one folder, or every character for the All tab.
 * @param {HTMLElement} source Element inside the character list
 * @param {string} tagId
 */
export function selectFolder(source, tagId) {
    const folderIds = new Set(tags.filter(isFolderTag).map(tag => tag.id));
    const selectedFolders = getSelectedTagIds().filter(id => folderIds.has(id));
    if (tagId && selectedFolders.length === 1 && selectedFolders[0] === tagId) return;

    for (const id of selectedFolders) {
        if (id !== tagId) chooseBogusFolder(source, id, true);
    }
    if (tagId && !selectedFolders.includes(tagId)) chooseBogusFolder(source, tagId);
    scheduleRender();
}

async function promptNewFolder() {
    const name = await Popup.show.input(t`New folder`, t`Name the folder. You can then add characters to it from their tags or with Organise.`, '');
    const cleaned = typeof name === 'string' ? name.trim() : '';
    if (!cleaned) return null;
    const tag = ensureFolderTag(cleaned, 'OPEN');
    if (!tag) return null;
    printTagFilters(tag_filter_type.character);
    saveSettingsDebounced();
    scheduleRender();
    return tag;
}

/**
 * Puts freshly imported characters into the folder for the site they came from.
 * @param {{ entries?: { avatar: string, fileName?: string, sourceUrl?: string, sourceId?: string, replaced?: boolean }[] }} payload
 */
export async function sortImportedCharacters(payload) {
    const settings = getSettings();
    if (!settings.autoSort.enabled) return [];
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const placed = [];

    for (const entry of entries) {
        if (!entry?.avatar || entry.replaced) continue;
        const character = characters.find(item => item?.avatar === entry.avatar) ?? null;
        const sourceId = detectImportSource({
            sourceUrl: entry.sourceUrl,
            sourceId: entry.sourceId,
            fileName: entry.fileName,
            card: character,
        });
        if (!sourceId) continue;

        const plan = planImportFolder({ sourceId, settings, tags });
        let tag = null;
        if (plan.action === 'existing') {
            tag = tags.find(item => item.id === plan.tagId) ?? null;
            if (tag && plan.makeFolder) tag.folder_type = settings.autoSort.folderType;
        } else if (plan.action === 'create') {
            tag = ensureFolderTag(plan.name, settings.autoSort.folderType);
        }
        if (!tag) continue;

        addTagsToEntity(tag, entry.avatar);
        placed.push({ avatar: entry.avatar, folder: tag.name });
    }

    if (placed.length) {
        printTagFilters(tag_filter_type.character);
        saveSettingsDebounced();
        scheduleRender();
        const folders = [...new Set(placed.map(item => item.folder))];
        toastr.info(
            placed.length === 1
                ? t`Put 1 imported character into ${folders.join(', ')}.`
                : t`Put ${placed.length} imported characters into ${folders.join(', ')}.`,
            t`Sorted by site`,
        );
    }
    return placed;
}

function labelled(text, control, hint = '') {
    const label = el('label', 'neconyan-folder-organiser-field');
    const caption = el('span', 'neconyan-folder-organiser-label', text);
    label.append(caption, control);
    if (hint) label.append(el('small', 'neconyan-folder-organiser-hint', hint));
    return label;
}

function checkbox(text, checked, onChange) {
    const label = el('label', 'neconyan-folder-organiser-check checkbox_label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked, input));
    label.append(input, el('span', '', text));
    return { label, input };
}

function select(options, value, onChange) {
    const node = el('select', 'text_pole');
    for (const option of options) {
        if (option.group) {
            const group = el('optgroup');
            group.label = option.group;
            for (const child of option.options) group.append(new Option(child.label, child.value));
            node.append(group);
        } else {
            node.append(new Option(option.label, option.value));
        }
    }
    node.value = value;
    node.addEventListener('change', () => onChange(node.value, node));
    return node;
}

function button(text, iconName, onClick, primary = false) {
    const node = el('button', primary ? 'menu_button menu_button_primary' : 'menu_button');
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    node.append(el('span', '', text));
    node.addEventListener('click', onClick);
    return node;
}

function renderTabsSection(container) {
    const settings = getSettings();
    container.replaceChildren();
    container.append(el('h4', '', t`Tabs`));
    container.append(el('p', 'neconyan-folder-organiser-intro', t`Choose which folders show as tabs above your character list.`));

    const folders = buildFolderTabs({ tags: getFolderTags(), tagMap: tag_map, entityKeys: getEntityKeys(), hidden: settings.tabs.hidden });
    const list = el('div', 'neconyan-folder-organiser-list');
    if (!folders.length) {
        list.append(el('p', 'neconyan-folder-organiser-empty', t`No folders yet. Make one here, turn on sorting by site, or let the AI suggest some.`));
    }
    for (const folder of folders) {
        const row = checkbox(tabLabel(folder.name, folder.count), !folder.hidden, (checked) => {
            const hidden = new Set(getSettings().tabs.hidden);
            if (checked) hidden.delete(folder.id); else hidden.add(folder.id);
            getSettings().tabs.hidden = [...hidden];
            saveSettings();
            scheduleRender();
        });
        list.append(row.label);
    }
    container.append(list);
    const actions = el('div', 'neconyan-folder-organiser-actions');
    actions.append(button(t`New folder`, 'fa-plus', async () => {
        if (await promptNewFolder()) renderTabsSection(container);
    }));
    container.append(actions);
}

function renderAutoSortSection(container) {
    const settings = getSettings();
    container.replaceChildren();
    container.append(el('h4', '', t`Sort imports by site`));
    container.append(el('p', 'neconyan-folder-organiser-intro', t`Put each character you import into a folder for the site it came from, such as JanitorAI or Chub. This works for links, Bot Browser imports and Chub, RisuRealm, Perchance and Backyard files.`));

    const enabled = checkbox(t`Sort imported characters by site`, settings.autoSort.enabled, (checked) => {
        getSettings().autoSort.enabled = checked;
        saveSettings();
        renderAutoSortSection(container);
    });
    container.append(enabled.label);

    const details = el('div', 'neconyan-folder-organiser-group');
    details.hidden = !settings.autoSort.enabled;

    const create = checkbox(t`Make a folder for a site the first time`, settings.autoSort.createFolders, (checked) => {
        getSettings().autoSort.createFolders = checked;
        saveSettings();
    });
    details.append(create.label);

    details.append(labelled(t`New site folders`, select([
        { value: 'OPEN', label: t`Open: also in the main list` },
        { value: 'CLOSED', label: t`Closed: only inside the folder` },
    ], settings.autoSort.folderType, (value) => {
        getSettings().autoSort.folderType = value === 'CLOSED' ? 'CLOSED' : 'OPEN';
        saveSettings();
    })));

    const folderOptions = getFolderTags().map(tag => ({ value: tag.id, label: tag.name }));
    const sites = el('div', 'neconyan-folder-organiser-sites');
    for (const source of IMPORT_SOURCES) {
        const options = [{ value: '', label: t`Folder named ${source.label}` }, ...folderOptions];
        const mapped = settings.autoSort.sources[source.id] ?? '';
        const value = options.some(option => option.value === mapped) ? mapped : '';
        sites.append(labelled(source.label, select(options, value, (next) => {
            const current = getSettings();
            if (next) current.autoSort.sources[source.id] = next; else delete current.autoSort.sources[source.id];
            saveSettings();
        })));
    }
    const sitesDetails = el('details', 'neconyan-folder-organiser-details');
    sitesDetails.append(el('summary', '', t`Choose a folder for each site`), sites);
    details.append(sitesDetails);
    container.append(details);
}

/**
 * @param {HTMLElement} container
 * @param {{ controller: AbortController|null, refreshPlan?: () => void, closed?: boolean }} run
 */
function renderAiSection(container, run) {
    const settings = getSettings();
    container.replaceChildren();
    container.append(el('h4', '', t`Sort with AI`));
    container.append(el('p', 'neconyan-folder-organiser-intro', t`Your connected model reads character names, tags and short excerpts from their cards in batches, then suggests folders for you to review. Nothing moves until you press Apply.`));

    const chosen = resolveAiSortPrompt(settings.ai.promptId, settings) ?? resolveAiSortPrompt(AI_SORT_PRESETS[0].id, settings);
    const promptOptions = [
        { group: t`Ready-made`, options: AI_SORT_PRESETS.map(preset => ({ value: preset.id, label: preset.label })) },
    ];
    if (settings.ai.customPrompts.length) {
        promptOptions.push({ group: t`My prompts`, options: settings.ai.customPrompts.map(item => ({ value: item.id, label: item.name })) });
    }
    const promptSelect = select(promptOptions, chosen.id, (value) => {
        getSettings().ai.promptId = value;
        saveSettings();
        renderAiSection(container, run);
    });
    container.append(labelled(t`How to sort`, promptSelect));
    container.append(el('p', 'neconyan-folder-organiser-prompt', chosen.prompt));

    const editor = el('div', 'neconyan-folder-organiser-editor');
    editor.hidden = true;
    const nameInput = el('input', 'text_pole');
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.placeholder = t`For example: By mood`;
    const bodyInput = el('textarea', 'text_pole');
    bodyInput.rows = 4;
    bodyInput.maxLength = AI_SORT_MAX_PROMPT_LENGTH;
    bodyInput.placeholder = t`Describe how to sort, for example: Sort each character by the mood of their story: Cosy, Dark, Silly or Dramatic.`;
    let editingId = null;
    const saveEdit = button(t`Save prompt`, 'fa-check', () => {
        const name = nameInput.value.trim();
        const prompt = bodyInput.value.trim();
        if (!name || !prompt) {
            toastr.warning(t`Give the prompt a name and say how to sort.`);
            return;
        }
        const current = getSettings();
        if (editingId) {
            const item = current.ai.customPrompts.find(entry => entry.id === editingId);
            if (item) Object.assign(item, { name: name.slice(0, 80), prompt: prompt.slice(0, AI_SORT_MAX_PROMPT_LENGTH) });
        } else {
            if (current.ai.customPrompts.length >= AI_SORT_MAX_CUSTOM_PROMPTS) {
                toastr.warning(t`You have the most custom prompts allowed. Delete one first.`);
                return;
            }
            const item = createCustomPrompt(name, prompt, current.ai.customPrompts.map(entry => entry.id));
            current.ai.customPrompts.push(item);
            current.ai.promptId = item.id;
        }
        saveSettings();
        renderAiSection(container, run);
    }, true);
    const cancelEdit = button(t`Cancel`, '', () => {
        editor.hidden = true;
    });
    const editorButtons = el('div', 'neconyan-folder-organiser-actions');
    editorButtons.append(saveEdit, cancelEdit);
    editor.append(labelled(t`Prompt name`, nameInput), labelled(t`Instructions`, bodyInput), editorButtons);

    const promptActions = el('div', 'neconyan-folder-organiser-actions');
    promptActions.append(button(t`New prompt`, 'fa-plus', () => {
        editingId = null;
        nameInput.value = '';
        bodyInput.value = chosen.custom ? '' : chosen.prompt;
        editor.hidden = false;
        nameInput.focus();
    }));
    if (chosen.custom) {
        promptActions.append(button(t`Edit`, 'fa-pen', () => {
            editingId = chosen.id;
            nameInput.value = chosen.name;
            bodyInput.value = chosen.prompt;
            editor.hidden = false;
            nameInput.focus();
        }));
        promptActions.append(button(t`Delete`, 'fa-trash-can', async () => {
            const confirmed = await Popup.show.confirm(t`Delete this prompt?`, chosen.name);
            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
            const current = getSettings();
            current.ai.customPrompts = current.ai.customPrompts.filter(entry => entry.id !== chosen.id);
            current.ai.promptId = AI_SORT_PRESETS[0].id;
            saveSettings();
            renderAiSection(container, run);
        }));
    }
    container.append(promptActions, editor);

    const options = el('div', 'neconyan-folder-organiser-group');
    options.append(labelled(t`Characters to sort`, select([
        { value: 'unsorted', label: t`Only characters not in a folder yet` },
        { value: 'all', label: t`Every character` },
    ], settings.ai.scope, (value) => {
        getSettings().ai.scope = value === 'all' ? 'all' : 'unsorted';
        saveSettings();
        refreshPlan();
    })));

    const allowNew = checkbox(t`Let the AI make new folders`, chosen.existingOnly ? false : settings.ai.allowNewFolders, (checked) => {
        getSettings().ai.allowNewFolders = checked;
        saveSettings();
        refreshPlan();
    });
    allowNew.input.disabled = chosen.existingOnly;
    options.append(allowNew.label);

    const batch = el('input', 'text_pole');
    batch.type = 'number';
    batch.min = String(AI_SORT_BATCH_MIN);
    batch.max = String(AI_SORT_BATCH_MAX);
    batch.value = String(settings.ai.batchSize);
    batch.addEventListener('change', () => {
        const current = getSettings();
        current.ai.batchSize = normalizeCharacterFolderSettings({ ai: { batchSize: batch.value } }).ai.batchSize;
        batch.value = String(current.ai.batchSize);
        saveSettings();
        refreshPlan();
    });
    batch.addEventListener('input', refreshPlan);
    options.append(labelled(t`Characters per request`, batch, t`Smaller batches suit models with short context.`));
    container.append(options);

    const status = el('p', 'neconyan-folder-organiser-status');
    status.setAttribute('role', 'status');
    const results = el('div', 'neconyan-folder-organiser-results');
    const plan = el('div', 'neconyan-folder-ai-plan');
    const modelLine = el('strong');
    const planLine = el('span');
    plan.setAttribute('role', 'status');
    plan.append(modelLine, planLine);
    const runButton = button(t`Suggest folders`, 'fa-wand-magic-sparkles', () => {
        if (run.controller) {
            run.controller.abort();
            return;
        }
        const job = getJob();
        if (job.plan.blockedReason || online_status === 'no_connection') return;
        void runAiSort({ prompt: chosen, job, status, results, runButton, run, setControlsLocked, refreshPlan });
    }, true);
    const runActions = el('div', 'neconyan-folder-organiser-actions');
    runActions.append(runButton);
    const controls = [...container.querySelectorAll('input, select, textarea, button')];
    function setControlsLocked(locked) {
        for (const control of controls) control.disabled = locked || (control === allowNew.input && chosen.existingOnly);
    }
    function getJob() {
        const { ai } = getSettings();
        const folders = getFolderTags();
        const items = pickCharactersForAiSort(ai.scope, folders);
        const allowNewFolders = !chosen.existingOnly && ai.allowNewFolders;
        const plan = describeAiSortPlan({ characterCount: items.length, batchSize: batch.valueAsNumber, allowNewFolders, existingFolderCount: folders.length });
        return { items, folders, allowNewFolders, plan };
    }
    function refreshPlan() {
        const disconnected = online_status === 'no_connection';
        const model = disconnected ? '' : getGeneratingModel();
        if (model) modelLine.textContent = t`Model: ${model}`;
        else modelLine.textContent = disconnected ? t`No model connected` : t`Active model`;
        const { plan: { characterCount, batchCount, blockedReason } } = getJob();
        if (disconnected) planLine.textContent = t`Connect to a model in Connections, then try again.`;
        else if (blockedReason === 'empty_scope') {
            planLine.textContent = characters.some(character => character?.avatar) && getSettings().ai.scope === 'unsorted'
                ? t`Every character is already in a folder. Choose Every character to sort them again.`
                : t`There are no characters to sort yet.`;
        } else if (blockedReason === 'no_folders_allowed') {
            planLine.textContent = chosen.existingOnly
                ? t`Make a folder first, or choose a different way to sort.`
                : t`Make a folder first, or let the AI make new folders.`;
        } else {
            planLine.textContent = characterCount === 1 ? t`1 character in 1 batch`
                : batchCount === 1 ? t`${characterCount} characters in 1 batch` : t`${characterCount} characters in ${batchCount} batches`;
        }
        runButton.disabled = !run.controller && (disconnected || Boolean(blockedReason));
    }
    run.refreshPlan = refreshPlan;
    container.append(plan, runActions, status, results);
    refreshPlan();
}

function setRunButton(node, running) {
    const label = node.querySelector('span');
    const iconNode = node.querySelector('i');
    if (label) label.textContent = running ? t`Stop` : t`Suggest folders`;
    if (iconNode) iconNode.className = `fa-solid ${running ? 'fa-stop' : 'fa-wand-magic-sparkles'}`;
}

function pickCharactersForAiSort(scope, folderTags) {
    const folderIds = new Set(folderTags.map(tag => tag.id));
    return characters.filter(character => character?.avatar && (scope === 'all' || !(tag_map[character.avatar] ?? []).some(id => folderIds.has(id))));
}

/**
 * @param {object} input
 * @param {NonNullable<ReturnType<typeof resolveAiSortPrompt>>} input.prompt
 * @param {HTMLElement} input.status
 * @param {HTMLElement} input.results
 * @param {HTMLElement} input.runButton
 * @param {{ items: any[], folders: any[], allowNewFolders: boolean, plan: ReturnType<typeof describeAiSortPlan> }} input.job
 * @param {{ controller: AbortController|null, closed?: boolean }} input.run
 * @param {(locked: boolean) => void} input.setControlsLocked
 * @param {() => void} input.refreshPlan
 */
async function runAiSort({ prompt, job, status, results, runButton, run, setControlsLocked, refreshPlan }) {
    results.replaceChildren();
    delete status.dataset.tone;
    const { items, allowNewFolders } = job;
    const folders = job.folders.map(tag => tag.name);
    const folderIds = new Set(job.folders.map(tag => tag.id));
    const tagNames = new Map(tags.map(tag => [tag.id, tag.name]));
    const controller = new AbortController();
    run.controller = controller;
    setRunButton(runButton, true);
    setControlsLocked(true);
    const batches = chunkForAiSort(items, job.plan.batchSize);
    const suggestions = [];
    let batchError = '';
    let stopReason = '';
    let consecutiveUnreadable = 0;
    let consecutiveEmpty = 0;

    try {
        for (let index = 0; index < batches.length; index++) {
            if (controller.signal.aborted) break;
            const batchItems = batches[index];
            status.textContent = t`Checking batch ${index + 1} of ${batches.length} · ${suggestions.length} suggestions so far...`;
            const knownFolders = [...new Set([...folders, ...suggestions.filter(item => item.isNew).map(item => item.folder)])];
            const request = buildAiSortPrompt({
                instructions: prompt.prompt,
                folders: knownFolders,
                characters: batchItems.map(character => summarizeCharacterForSort(character,
                    (tag_map[character.avatar] ?? []).filter(id => !folderIds.has(id)).map(id => tagNames.get(id)).filter(Boolean))),
                allowNewFolders,
            });
            try {
                const reply = await generateRaw({
                    prompt: request.prompt,
                    systemPrompt: request.systemPrompt,
                    responseLength: Math.min(8192, 1024 + batchItems.length * 60),
                    // Thinking models can spend the whole reply reasoning about long character cards and
                    // return nothing, and some reject the saved effort outright; folder labels need none.
                    reasoningEffort: 'none',
                    signal: controller.signal,
                });
                if (controller.signal.aborted) break;
                const parsed = parseAiSortResponse(reply, { count: batchItems.length, folders: knownFolders, allowNewFolders, strict: true });
                consecutiveUnreadable = 0;
                consecutiveEmpty = 0;
                for (const item of parsed) {
                    const character = batchItems[item.index];
                    suggestions.push({ avatar: character.avatar, name: character.name, folder: item.folder, isNew: !folders.includes(item.folder) });
                }
            } catch (error) {
                if (controller.signal.aborted) break;
                console.warn('[Character folders] AI sort batch failed', error);
                const classification = classifyAiSortError(error);
                if (classification.fatal) {
                    stopReason = translate(classification.message);
                    break;
                }
                batchError = translate(classification.message);
                consecutiveEmpty = classification.empty ? consecutiveEmpty + 1 : 0;
                if (++consecutiveUnreadable === 2) {
                    stopReason = consecutiveEmpty === 2
                        ? t`Stopped after 2 empty replies in a row. Choose another model in Connections, then try again.`
                        : t`Stopped after 2 unreadable replies in a row. Try another prompt, another model or fewer characters per request.`;
                    break;
                }
            }
        }
    } finally {
        run.controller = null;
        setRunButton(runButton, false);
        setControlsLocked(false);
        refreshPlan();
    }

    if (run.closed) return;
    const merged = mergeNewFolderSpellings(suggestions);
    const stopped = controller.signal.aborted;
    if (stopReason || stopped || batchError) {
        const reason = stopReason || (stopped ? t`Sorting stopped.` : batchError);
        const next = merged.length ? t`Review and apply these suggestions, then run again with 'Only characters not in a folder yet'.` : '';
        status.dataset.tone = stopped ? 'info' : 'error';
        status.textContent = [reason, next].filter(Boolean).join(' ');
        if (!stopped) toastr.error(status.textContent, t`Sort with AI`);
        else if (merged.length) toastr.info(status.textContent, t`Sort with AI`);
    } else {
        status.textContent = merged.length ? t`Untick anything you disagree with, then press Apply.`
            : t`The model did not suggest any folders. Try another prompt or a smaller batch.`;
    }
    if (merged.length) renderSuggestions(results, merged, status, refreshPlan);
}

function renderSuggestions(container, suggestions, status, refreshPlan) {
    container.replaceChildren();
    const byFolder = new Map();
    for (const item of suggestions) {
        if (!byFolder.has(item.folder)) byFolder.set(item.folder, []);
        byFolder.get(item.folder).push(item);
    }

    const folderCount = byFolder.size;
    const total = suggestions.length;
    const summary = total === 1 ? t`1 suggestion for 1 folder`
        : folderCount === 1 ? t`${total} suggestions for 1 folder` : t`${total} suggestions across ${folderCount} folders`;
    const selection = el('span', 'neconyan-folder-selection');
    selection.setAttribute('role', 'status');
    const checks = [];
    const groups = [];
    const actions = el('div', 'neconyan-folder-organiser-actions');
    const apply = button(t`Apply`, 'fa-check', () => {
        const chosen = checks.filter(entry => entry.input.checked).map(entry => entry.item);
        const count = applySuggestions(chosen);
        container.replaceChildren();
        delete status.dataset.tone;
        status.textContent = count === 1 ? t`Moved 1 character into a folder.` : t`Moved ${count} characters into folders.`;
        refreshPlan();
    }, true);
    const discard = button(t`Discard`, 'fa-xmark', () => {
        container.replaceChildren();
        status.textContent = '';
        delete status.dataset.tone;
    });
    const selectAll = button(t`Select all`, '', () => setChecked(checks, true));
    const selectNone = button(t`Select none`, '', () => setChecked(checks, false));
    const caption = el('div', 'neconyan-folder-results-summary');
    caption.append(el('strong', '', summary), selection);
    actions.append(apply, selectAll, selectNone, discard);
    container.append(caption, actions);

    function setChecked(entries, checked) {
        for (const entry of entries) entry.input.checked = checked;
        updateSelection();
    }
    function updateSelection() {
        let selected = 0;
        for (const { input, rows } of groups) {
            const count = rows.filter(row => row.input.checked).length;
            input.checked = count === rows.length;
            input.indeterminate = count > 0 && count < rows.length;
            selected += count;
        }
        selection.textContent = t`${selected} of ${total} selected`;
        apply.disabled = selected === 0;
        selectAll.disabled = selected === total;
        selectNone.disabled = selected === 0;
    }

    for (const [folder, items] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const group = el('div', 'neconyan-folder-suggestion');
        const header = el('div', 'neconyan-folder-suggestion-heading');
        const list = el('div', 'neconyan-folder-suggestion-list');
        list.id = `neconyan-folder-suggestion-${groups.length}`;
        list.hidden = total > 25;
        const rows = [];
        const check = checkbox('', true, checked => setChecked(rows, checked));
        check.input.setAttribute('aria-label', t`Select suggestions for ${folder}`);
        const toggle = button(folder, items.some(item => item.isNew) ? 'fa-folder-plus' : 'fa-folder', () => {
            list.hidden = !list.hidden;
            toggle.setAttribute('aria-expanded', String(!list.hidden));
        });
        toggle.setAttribute('aria-expanded', String(!list.hidden));
        toggle.setAttribute('aria-controls', list.id);
        const caption = el('span', 'neconyan-folder-suggestion-caption');
        caption.append(...toggle.childNodes, el('span', 'neconyan-folder-suggestion-count', String(items.length)));
        if (items.some(item => item.isNew)) caption.append(el('span', 'neconyan-folder-suggestion-new', t`new folder`));
        toggle.append(caption, icon('fa-chevron-down'));
        header.append(check.label, toggle);
        for (const item of items) {
            const row = checkbox(item.name, true, updateSelection);
            const entry = { input: row.input, item };
            checks.push(entry);
            rows.push(entry);
            list.append(row.label);
        }
        groups.push({ input: check.input, rows });
        group.append(header, list);
        container.append(group);
    }
    updateSelection();
}

/**
 * @param {{ avatar: string, folder: string }[]} suggestions
 * @returns {number} how many characters were placed
 */
export function applySuggestions(suggestions) {
    const byFolder = new Map();
    for (const item of suggestions) {
        if (!item?.avatar || !item.folder) continue;
        if (!characters.some(character => character?.avatar === item.avatar)) continue;
        const key = normalizeFolderName(item.folder);
        if (!byFolder.has(key)) byFolder.set(key, { name: item.folder, avatars: [] });
        byFolder.get(key).avatars.push(item.avatar);
    }
    let count = 0;
    for (const { name, avatars } of byFolder.values()) {
        const tag = ensureFolderTag(name, 'OPEN');
        if (!tag) continue;
        addTagsToEntity(tag, avatars);
        count += avatars.length;
    }
    if (count) {
        printTagFilters(tag_filter_type.character);
        saveSettingsDebounced();
        scheduleRender();
    }
    return count;
}

export async function openOrganiser() {
    const content = el('div', 'neconyan-folder-organiser');
    content.append(el('h3', '', t`Organise folders`));
    const tabsSection = el('section', 'neconyan-folder-organiser-section');
    const autoSection = el('section', 'neconyan-folder-organiser-section');
    const aiSection = el('section', 'neconyan-folder-organiser-section');
    aiSection.classList.add('neconyan-folder-ai');
    const run = { controller: null, refreshPlan: null, closed: false };
    renderTabsSection(tabsSection);
    renderAutoSortSection(autoSection);
    renderAiSection(aiSection, run);
    content.append(tabsSection, autoSection, aiSection);

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: t`Done`,
        cancelButton: false,
        wide: true,
        allowVerticalScrolling: true,
        onClose: () => {
            run.closed = true;
            run.controller?.abort();
        },
    });
    const planEvents = [event_types.ONLINE_STATUS_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.CONNECTION_PROFILE_LOADED];
    const refreshPlan = () => run.refreshPlan?.();
    for (const eventType of planEvents) eventSource.on(eventType, refreshPlan);
    try {
        await popup.show();
    } finally {
        for (const eventType of planEvents) eventSource.removeListener(eventType, refreshPlan);
    }
    scheduleRender();
}

export function initCharacterFolders() {
    if (initialized) return;
    initialized = true;

    eventSource.on(event_types.CHARACTER_IMPORTED, sortImportedCharacters);
    for (const type of [event_types.CHARACTER_PAGE_LOADED, event_types.CHARACTER_DELETED, event_types.SETTINGS_LOADED]) {
        if (type) eventSource.on(type, scheduleRender);
    }

    const block = document.getElementById('rm_characters_block');
    if (block) blockObserver.observe(block, { childList: true });
    renderTabs();
}
