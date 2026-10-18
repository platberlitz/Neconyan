/**
 * The Reference: everything this extension provides, searchable, without
 * leaving Neconyan. Content comes from src/catalog.js (captured at registration,
 * including the user's own macros and any collision rename) and the written
 * guides in src/help/topics.js.
 */
import { button, copyToClipboard, el, flashButtonText } from '../dom.js';
import { getCommandDocs, getMacroCatalog, macroSignature } from '../catalog.js';
import { renderMacroText } from '../ui/macro-text.js';
import { uiState } from '../ui/ui-state.js';
import { TOPICS } from './topics.js';

const GUIDES_KEY = 'guides';
const COMMANDS_KEY = 'commands';

function chipLabel(key) {
    if (key === GUIDES_KEY) {
        return 'Guides';
    }
    if (key === COMMANDS_KEY) {
        return 'Commands';
    }
    return key.replace(/^enhanced-/, '');
}

function firstSentence(text) {
    const value = String(text ?? '').trim();
    for (const match of value.matchAll(/[.!?](?=\s|$)/g)) {
        const sentence = value.slice(0, match.index + 1);
        if (/\b(?:e\.g|i\.e|etc|vs)\.$/i.test(sentence)) {
            continue;
        }
        return sentence;
    }
    return value;
}

/** Renders a host help string while keeping its `<code>` runs readable. */
function helpStringNodes(target, help) {
    const parts = String(help ?? '').split(/<code>|<\/code>/);
    parts.forEach((part, index) => {
        if (!part) {
            return;
        }
        if (index % 2 === 1) {
            target.appendChild(el('code', 'me-ref-code', part));
        } else {
            target.appendChild(document.createTextNode(part.replace(/<[^>]+>/g, '')));
        }
    });
}

function argNotes(arg) {
    const notes = [];
    if (arg.optional) {
        notes.push(arg.defaultValue !== undefined && arg.defaultValue !== ''
            ? `optional, defaults to ${arg.defaultValue}`
            : 'optional');
    }
    if (arg.type) {
        notes.push(String(arg.type));
    }
    return notes.join(' · ');
}

/**
 * @param {HTMLElement} container
 * @param {object} [deps]
 * @param {(text: string) => void} [deps.onInsert]
 */
export function renderReferenceTab(container, { onInsert } = {}) {
    container.innerHTML = '';

    const controls = el('div', 'me-ref-controls');
    const searchLabel = el('label', 'me-field me-ref-search-field');
    searchLabel.appendChild(el('span', 'me-field-label', 'Search'));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole me-ref-search';
    search.placeholder = 'Search macros, commands and guides';
    search.setAttribute('aria-label', 'Search the macro reference');
    search.value = uiState.referenceQuery;
    searchLabel.appendChild(search);
    controls.appendChild(searchLabel);
    container.appendChild(controls);

    const chips = el('div', 'me-ref-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Filter the macro reference');
    container.appendChild(chips);

    const results = el('div', 'me-ref-results');
    container.appendChild(results);

    let groups = [];
    let activeFilter = uiState.referenceFilter || 'all';
    let itemCounter = 0;
    let flashTimer = null;
    /** @type {Map<string, {row: HTMLElement, expand: () => void}>} */
    const anchors = new Map();

    function buildGroups() {
        const built = [];
        if (TOPICS.length) {
            built.push({
                key: GUIDES_KEY,
                title: 'Guides',
                items: TOPICS.map(topic => ({
                    id: `topic:${topic.id}`,
                    label: topic.title,
                    prose: true,
                    summary: firstSentence(topic.body[0]),
                    haystack: `${topic.title} ${topic.body.join(' ')}`.toLowerCase(),
                    render: body => renderTopic(body, topic),
                })),
            });
        }

        const byCategory = new Map();
        for (const entry of getMacroCatalog()) {
            if (!byCategory.has(entry.category)) {
                byCategory.set(entry.category, []);
            }
            byCategory.get(entry.category).push(entry);
        }
        for (const [category, macros] of byCategory) {
            built.push({
                key: category,
                title: chipLabel(category),
                items: macros.map(entry => ({
                    id: `macro:${entry.name.toLowerCase()}`,
                    label: macroSignature(entry),
                    prose: false,
                    summary: firstSentence(entry.description),
                    haystack: [
                        entry.name,
                        entry.requested,
                        entry.description,
                        entry.returns,
                        ...(entry.aliases ?? []),
                        ...(entry.unnamedArgs ?? []).map(arg => `${arg.name} ${arg.description ?? ''}`),
                        ...(entry.exampleUsage ?? []),
                    ].join(' ').toLowerCase(),
                    render: body => renderMacro(body, entry),
                })),
            });
        }

        const commands = getCommandDocs();
        if (commands.length) {
            built.push({
                key: COMMANDS_KEY,
                title: 'Slash commands',
                items: commands.map(command => ({
                    id: `command:${command.name.toLowerCase()}`,
                    label: `/${command.name}`,
                    prose: true,
                    summary: firstSentence(command.helpString.replace(/<[^>]+>/g, '')),
                    haystack: `${command.name} ${command.helpString} ${command.returns}`.toLowerCase(),
                    render: body => renderCommand(body, command),
                })),
            });
        }
        return built;
    }

    function renderTopic(body, topic) {
        for (const paragraph of topic.body) {
            body.appendChild(el('p', 'me-ref-paragraph', paragraph));
        }
        if (topic.see?.length) {
            const seeRow = el('div', 'me-ref-see');
            seeRow.appendChild(el('span', 'me-ref-see-label', 'See:'));
            for (const name of topic.see) {
                seeRow.appendChild(button('me-ref-link', `{{${name}}}`, () => focusMacro(name)));
            }
            body.appendChild(seeRow);
        }
    }

    function renderArgs(body, args, named) {
        if (!args?.length) {
            return;
        }
        const list = el('dl', 'me-ref-args');
        for (const arg of args) {
            const row = el('div', 'me-ref-arg-row');
            const name = el('dt', 'me-ref-arg-name');
            name.appendChild(renderMacroText(named ? `${arg.name}=` : (arg.name || 'text'), { tag: 'span', className: 'me-mt me-mt-plain' }));
            row.appendChild(name);
            const notes = named
                ? [arg.required ? 'required' : 'optional',
                    ...(arg.defaultValue !== undefined && arg.defaultValue !== '' ? [`defaults to ${arg.defaultValue}`] : []),
                    ...(arg.enums.length ? [arg.enums.join(' | ')] : [])].join(' · ')
                : argNotes(arg);
            row.appendChild(el('dd', 'me-ref-arg-desc', `${notes ? `${notes}. ` : ''}${arg.description ?? ''}`.trim()));
            list.appendChild(row);
        }
        body.appendChild(list);
    }

    function renderBadges(body, entries) {
        const badges = el('div', 'me-ref-badges');
        for (const [className, text] of entries) {
            if (text) {
                badges.appendChild(el('span', className, text));
            }
        }
        if (badges.childElementCount) {
            body.appendChild(badges);
        }
    }

    function exampleRow(example) {
        const row = el('div', 'me-ref-example');
        row.appendChild(renderMacroText(example, { tag: 'code', className: 'me-mt me-ref-example-text' }));
        const actions = el('div', 'me-ref-example-actions');
        if (onInsert) {
            actions.appendChild(button('menu_button', 'Try it', () => onInsert(example)));
        }
        const copy = button('menu_button', 'Copy', async () => {
            const ok = await copyToClipboard(example);
            flashButtonText(copy, ok ? 'Copied' : 'Copy failed');
        });
        actions.appendChild(copy);
        row.appendChild(actions);
        return row;
    }

    function renderMacro(body, entry) {
        body.appendChild(el('p', 'me-ref-description', entry.description));
        renderArgs(body, entry.unnamedArgs, false);
        renderBadges(body, [
            ['me-ref-returns', entry.returns ? `Returns ${entry.returns}` : ''],
            ['me-ref-badge', entry.list ? 'takes any number of values' : ''],
            ['me-ref-badge', entry.delayArgResolution ? 'only the used branch is evaluated' : ''],
            ['me-ref-badge', entry.aliases?.length ? `also {{${entry.aliases.join('}}, {{')}}}` : ''],
        ]);
        for (const example of entry.exampleUsage ?? []) {
            body.appendChild(exampleRow(example));
        }
        if (entry.renamed) {
            body.appendChild(el('div', 'me-warning',
                `{{${entry.requested}}} was already taken, so this macro is registered as {{${entry.name}}}.`));
        }
    }

    function renderCommand(body, command) {
        const help = el('div', 'me-ref-description');
        helpStringNodes(help, command.helpString);
        body.appendChild(help);
        renderArgs(body, command.args, true);
        renderBadges(body, [['me-ref-returns', command.returns ? `Returns ${command.returns}` : '']]);
    }

    function renderItem(item, openGroup, startExpanded) {
        const wrapper = el('section', 'me-ref-item');
        const body = el('div', 'me-ref-item-body');
        const bodyId = `me-ref-item-${++itemCounter}`;
        body.id = bodyId;
        let built = false;
        let expanded = false;

        const head = button('me-ref-item-head', '', () => setExpanded(!expanded));
        head.setAttribute('aria-controls', bodyId);
        const marker = el('span', 'me-ref-marker', '▸');
        marker.setAttribute('aria-hidden', 'true');
        head.appendChild(marker);
        if (item.prose) {
            head.appendChild(el('span', 'me-ref-item-title', item.label));
        } else {
            head.appendChild(renderMacroText(item.label, { tag: 'span', className: 'me-mt me-ref-item-label' }));
        }
        const summary = item.summary ? el('span', 'me-ref-item-summary', item.summary) : null;
        if (summary) {
            head.appendChild(summary);
        }
        head.setAttribute('aria-expanded', 'false');
        wrapper.appendChild(head);

        function setExpanded(next) {
            expanded = next;
            if (next) {
                openGroup();
                if (!built) {
                    item.render(body, item);
                    built = true;
                }
            }
            marker.textContent = next ? '▾' : '▸';
            head.setAttribute('aria-expanded', String(next));
            body.hidden = !next;
            if (summary) {
                summary.hidden = next;
            }
        }

        body.hidden = true;
        wrapper.appendChild(body);
        if (startExpanded) {
            setExpanded(true);
        }

        anchors.set(item.id, { row: wrapper, expand: () => setExpanded(true) });
        return wrapper;
    }

    function renderGroup(group, items, { startOpen }) {
        const section = el('section', 'me-ref-group');
        const bodyId = `me-ref-group-body-${++itemCounter}`;
        const head = button('me-ref-group-head', '', () => toggle());
        head.setAttribute('aria-controls', bodyId);
        const marker = el('span', 'me-ref-marker', startOpen ? '▾' : '▸');
        marker.setAttribute('aria-hidden', 'true');
        head.appendChild(marker);
        head.appendChild(el('span', 'me-ref-group-title', group.title));
        head.appendChild(el('span', 'me-ref-group-count', String(items.length)));
        head.setAttribute('aria-expanded', String(startOpen));
        const body = el('div', 'me-ref-group-body');
        body.id = bodyId;
        body.hidden = !startOpen;
        let open = startOpen;
        function setOpen(next) {
            open = next;
            marker.textContent = open ? '▾' : '▸';
            head.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
        }
        function toggle() {
            setOpen(!open);
        }
        section.append(head, body);
        for (const item of items) {
            body.appendChild(renderItem(item, () => setOpen(true), false));
        }
        return { section, open: () => setOpen(true) };
    }

    function renderChips() {
        chips.replaceChildren();
        const keys = ['all', ...groups.map(group => group.key)];
        if (activeFilter !== 'all' && !keys.includes(activeFilter)) {
            activeFilter = 'all';
        }
        uiState.referenceFilter = activeFilter;
        for (const key of keys) {
            const chip = button('me-chip', key === 'all' ? 'All' : chipLabel(key), () => {
                activeFilter = key;
                uiState.referenceFilter = key;
                draw();
            });
            chip.setAttribute('aria-pressed', String(key === activeFilter));
            chips.appendChild(chip);
        }
    }

    function draw() {
        results.replaceChildren();
        anchors.clear();
        const query = search.value.trim().toLowerCase();
        const searching = query.length > 0;
        let shown = 0;

        for (const group of groups) {
            if (activeFilter !== 'all' && activeFilter !== group.key) {
                continue;
            }
            const items = searching ? group.items.filter(item => item.haystack.includes(query)) : group.items;
            if (!items.length) {
                continue;
            }
            shown += items.length;
            const open = searching || activeFilter !== 'all';
            const rendered = renderGroup(group, items, { startOpen: open });
            // A single search hit is almost certainly the one you meant.
            if (searching && items.length === 1) {
                anchors.get(items[0].id)?.expand();
            }
            results.appendChild(rendered.section);
        }

        if (!shown) {
            results.appendChild(el('div', 'me-empty-state',
                searching ? `Nothing matches "${search.value.trim()}".` : 'Nothing to show yet.'));
        }
    }

    function refresh() {
        groups = buildGroups();
        renderChips();
        draw();
    }

    function reveal(id) {
        if (!anchors.has(id)) {
            search.value = '';
            uiState.referenceQuery = '';
            activeFilter = 'all';
            uiState.referenceFilter = 'all';
            refresh();
        }
        const anchor = anchors.get(id);
        if (!anchor) {
            return;
        }
        anchor.expand();
        anchor.row.scrollIntoView({ block: 'nearest' });
        anchor.row.classList.add('me-ref-flash');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => anchor.row.classList.remove('me-ref-flash'), 1200);
    }

    function focusMacro(name) {
        const key = String(name).toLowerCase();
        const id = anchors.has(`macro:${key}`) || !anchors.has(`macro:me-${key}`)
            ? `macro:${key}`
            : `macro:me-${key}`;
        reveal(id);
    }

    function focusTopic(id) {
        reveal(`topic:${id}`);
    }

    search.addEventListener('input', () => {
        uiState.referenceQuery = search.value;
        draw();
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape' && search.value) {
            event.stopPropagation();
            search.value = '';
            uiState.referenceQuery = '';
            draw();
        }
    });

    refresh();
    return {
        focusTopic,
        focusMacro,
        refresh,
        destroy() {
            clearTimeout(flashTimer);
        },
    };
}
