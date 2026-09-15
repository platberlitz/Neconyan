/**
 * The Reference tab: everything this extension provides, searchable, without
 * leaving Neconyan.
 *
 * Content comes from src/catalog.js (captured at registration, so it is exactly
 * what is live right now, including the user's own macros and any collision
 * rename) and src/help/topics.js (the written guides). Nothing here is a second
 * copy of the documentation.
 */

import { button, copyToClipboard, el, flashButtonText } from '../dom.js';
import { getCommandDocs, getMacroCatalog, macroSignature } from '../catalog.js';
import { TOPICS } from './topics.js';

const GUIDES_KEY = 'guides';
const COMMANDS_KEY = 'commands';

/** Category label -> what to show on the filter chip. */
function chipLabel(key) {
    if (key === GUIDES_KEY) {
        return 'Guides';
    }
    if (key === COMMANDS_KEY) {
        return 'Commands';
    }
    return key.replace(/^enhanced-/, '');
}

/** The first sentence of a description, for the collapsed one-liner. */
function firstSentence(text) {
    const match = /^(.*?[.!?])(\s|$)/.exec(String(text ?? '').trim());
    return match ? match[1] : String(text ?? '').trim();
}

/**
 * Renders a helpString into real nodes. The host's help strings embed <code>
 * tags; this keeps them readable without handing a string to innerHTML.
 */
function helpStringNodes(target, help) {
    const parts = String(help ?? '').split(/<code>|<\/code>/);
    parts.forEach((part, index) => {
        if (!part) {
            return;
        }
        // Odd indices sat between the tags.
        if (index % 2 === 1) {
            target.appendChild(el('code', 'me-ref-code', part));
        } else {
            target.appendChild(document.createTextNode(part.replace(/<[^>]+>/g, '')));
        }
    });
}

/**
 * Mounts the reference into a container.
 *
 * @param {HTMLElement} container
 * @param {object} deps
 * @param {(text: string) => void} deps.onInsert - Send an example to the Playground.
 * @returns {{focusTopic: (id: string) => void, focusMacro: (name: string) => void}}
 */
export function renderReferenceTab(container, { onInsert } = {}) {
    container.innerHTML = '';

    container.appendChild(el('div', 'me-audit-intro',
        'Everything Macro Enhanced adds, with its arguments and examples. Search matches names, descriptions and guide text.'));

    const controls = el('div', 'me-ref-controls');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole me-ref-search';
    search.placeholder = 'Search macros, commands and guides…';
    search.setAttribute('aria-label', 'Search the macro reference');
    controls.appendChild(search);
    container.appendChild(controls);

    const chips = el('div', 'me-ref-chips');
    container.appendChild(chips);

    const results = el('div', 'me-ref-results');
    container.appendChild(results);

    /** Rebuilt on every render so newly added custom macros show up. */
    let groups = [];
    let activeFilter = 'all';
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
                    // A guide title is prose, not something you type.
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
            seeRow.appendChild(el('span', 'me-custom-label', 'See: '));
            for (const name of topic.see) {
                seeRow.appendChild(button('me-ref-link', `{{${name}}}`, () => focusMacro(name)));
            }
            body.appendChild(seeRow);
        }
    }

    function renderMacro(body, entry) {
        body.appendChild(el('div', 'me-ref-description', entry.description));

        if (entry.unnamedArgs?.length) {
            const table = el('table', 'me-ref-args');
            for (const arg of entry.unnamedArgs) {
                const row = el('tr');
                row.appendChild(el('td', 'me-ref-arg-name', arg.name));
                const notes = [];
                if (arg.optional) {
                    notes.push(arg.defaultValue !== undefined && arg.defaultValue !== ''
                        ? `optional, defaults to ${arg.defaultValue}`
                        : 'optional');
                }
                if (arg.type) {
                    notes.push(String(arg.type));
                }
                row.appendChild(el('td', 'me-ref-arg-note', notes.join(' · ')));
                row.appendChild(el('td', 'me-ref-arg-desc', arg.description ?? ''));
                table.appendChild(row);
            }
            body.appendChild(table);
        }

        const badges = el('div', 'me-ref-badges');
        if (entry.returns) {
            badges.appendChild(el('span', 'me-ref-returns', `Returns ${entry.returns}`));
        }
        if (entry.list) {
            badges.appendChild(el('span', 'me-ref-badge', 'takes any number of values'));
        }
        if (entry.delayArgResolution) {
            badges.appendChild(el('span', 'me-ref-badge', 'only the used branch is evaluated'));
        }
        if (entry.aliases?.length) {
            badges.appendChild(el('span', 'me-ref-badge', `also {{${entry.aliases.join('}}, {{')}}}`));
        }
        if (badges.childElementCount) {
            body.appendChild(badges);
        }

        for (const example of entry.exampleUsage ?? []) {
            body.appendChild(exampleRow(example));
        }

        if (entry.renamed) {
            body.appendChild(el('div', 'me-inspector-warning',
                `{{${entry.requested}}} was already taken, so this macro is registered as {{${entry.name}}}.`));
        }
    }

    function renderCommand(body, command) {
        const help = el('div', 'me-ref-description');
        helpStringNodes(help, command.helpString);
        body.appendChild(help);

        if (command.args.length) {
            const table = el('table', 'me-ref-args');
            for (const arg of command.args) {
                const row = el('tr');
                row.appendChild(el('td', 'me-ref-arg-name', arg.named ? `${arg.name}=` : (arg.name || 'text')));
                const notes = [arg.required ? 'required' : 'optional'];
                if (arg.defaultValue !== undefined && arg.defaultValue !== '') {
                    notes.push(`defaults to ${arg.defaultValue}`);
                }
                if (arg.enums.length) {
                    notes.push(arg.enums.join(' | '));
                }
                row.appendChild(el('td', 'me-ref-arg-note', notes.join(' · ')));
                row.appendChild(el('td', 'me-ref-arg-desc', arg.description ?? ''));
                table.appendChild(row);
            }
            body.appendChild(table);
        }

        if (command.returns) {
            const badges = el('div', 'me-ref-badges');
            badges.appendChild(el('span', 'me-ref-returns', `Returns ${command.returns}`));
            body.appendChild(badges);
        }
    }

    /** An example with the two things you actually want to do with one. */
    function exampleRow(example) {
        const row = el('div', 'me-ref-example');
        row.appendChild(el('code', 'me-ref-example-text', example));
        const actions = el('div', 'me-ref-example-actions');
        if (onInsert) {
            actions.appendChild(button('menu_button me-custom-button', 'Insert', () => onInsert(example)));
        }
        const copy = button('menu_button me-custom-button', 'Copy', async () => {
            const ok = await copyToClipboard(example);
            flashButtonText(copy, ok ? 'Copied ✓' : 'Copy failed');
        });
        actions.appendChild(copy);
        row.appendChild(actions);
        return row;
    }

    /** One collapsible entry. Collapsed shows a signature and a one-liner. */
    function renderItem(item, { startExpanded }) {
        const wrapper = el('div', 'me-ref-item');
        const body = el('div', 'me-ref-item-body');
        let built = false;
        let expanded = false;

        const head = button('me-ref-item-head', '', () => setExpanded(!expanded));
        const marker = el('span', 'me-ref-marker', '▸');
        head.appendChild(marker);
        head.appendChild(el('span', item.prose ? 'me-ref-item-title' : 'me-ref-item-label', item.label));
        const summary = item.summary ? el('span', 'me-ref-item-summary', item.summary) : null;
        if (summary) {
            head.appendChild(summary);
        }
        head.setAttribute('aria-expanded', 'false');
        wrapper.appendChild(head);

        function setExpanded(next) {
            expanded = next;
            if (next && !built) {
                item.render(body, item);
                built = true;
            }
            marker.textContent = next ? '▾' : '▸';
            head.setAttribute('aria-expanded', String(next));
            body.style.display = next ? '' : 'none';
            // The summary is the opening of the full text below it; showing both
            // just reads as a stutter.
            if (summary) {
                summary.style.display = next ? 'none' : '';
            }
        }

        body.style.display = 'none';
        wrapper.appendChild(body);
        if (startExpanded) {
            setExpanded(true);
        }

        anchors.set(item.id, { row: wrapper, expand: () => setExpanded(true) });
        return wrapper;
    }

    function renderChips() {
        chips.innerHTML = '';
        const keys = ['all', ...groups.map(group => group.key)];
        for (const key of keys) {
            const chip = button('me-ref-chip', key === 'all' ? 'All' : chipLabel(key), () => {
                activeFilter = key;
                draw();
            });
            if (key === activeFilter) {
                chip.classList.add('me-ref-chip-active');
            }
            chip.setAttribute('aria-pressed', String(key === activeFilter));
            chips.appendChild(chip);
        }
    }

    function draw() {
        results.innerHTML = '';
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

            const section = el('div', 'me-ref-group');
            const body = el('div', 'me-ref-group-body');
            // Searching, or filtering down to one group, means you already said
            // what you want. open it rather than making you click again.
            let open = searching || activeFilter !== 'all';

            const marker = el('span', 'me-ref-marker', open ? '▾' : '▸');
            const head = button('me-ref-group-head', '', () => {
                open = !open;
                marker.textContent = open ? '▾' : '▸';
                head.setAttribute('aria-expanded', String(open));
                body.style.display = open ? '' : 'none';
            });
            head.appendChild(marker);
            head.appendChild(el('span', 'me-ref-group-title', group.title));
            head.appendChild(el('span', 'me-ref-group-count', String(items.length)));
            head.setAttribute('aria-expanded', String(open));
            section.appendChild(head);

            body.style.display = open ? '' : 'none';
            for (const item of items) {
                // A single hit is almost certainly the one you meant.
                body.appendChild(renderItem(item, { startExpanded: searching && items.length === 1 }));
            }
            section.appendChild(body);
            results.appendChild(section);
        }

        if (!shown) {
            results.appendChild(el('div', 'me-inspector-empty',
                searching ? `Nothing matches "${search.value.trim()}".` : 'Nothing to show yet.'));
        }
    }

    function refresh() {
        groups = buildGroups();
        renderChips();
        draw();
    }

    /** Opens an entry and scrolls to it, clearing whatever hid it. */
    function reveal(id) {
        if (!anchors.has(id)) {
            search.value = '';
            activeFilter = 'all';
            refresh();
        }
        const anchor = anchors.get(id);
        if (!anchor) {
            return;
        }
        anchor.expand();
        anchor.row.scrollIntoView({ block: 'nearest' });
        anchor.row.classList.add('me-ref-flash');
        setTimeout(() => anchor.row.classList.remove('me-ref-flash'), 1200);
    }

    function focusMacro(name) {
        const key = String(name).toLowerCase();
        // A guide links to {{lore}}; if upstream claimed that name the macro
        // now answers to {{me-lore}}, and the link should still land.
        const id = anchors.has(`macro:${key}`) || !anchors.has(`macro:me-${key}`)
            ? `macro:${key}`
            : `macro:me-${key}`;
        reveal(id);
    }

    function focusTopic(id) {
        reveal(`topic:${id}`);
    }

    search.addEventListener('input', draw);
    search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && search.value) {
            event.stopPropagation();
            search.value = '';
            draw();
        }
    });

    refresh();
    return { focusTopic, focusMacro, refresh };
}
