import { escapeRegex } from '../utils.js';
import { SlashCommandParser } from './SlashCommandParser.js';
import { t } from '../i18n.js';

export class SlashCommandBrowser {
    /**@type {SlashCommand[]}*/ cmdList;
    /**@type {HTMLElement}*/ dom;
    /**@type {HTMLElement}*/ search;
    /**@type {HTMLElement}*/ details;
    /**@type {Object.<string,HTMLElement>}*/ itemMap = {};
    /**@type {MutationObserver}*/ mo;

    renderInto(parent) {
        if (!this.dom) {
            const queryRegex = /(?:(?:^|\s+)([^\s"][^\s]*?)(?:\s+|$))|(?:(?:^|\s+)"(.*?)(?:"|$)(?:\s+|$))/;
            const root = document.createElement('div'); {
                this.dom = root;
                let activeFilter = 'all';
                let container;
                let list;
                let countBadge;
                let emptyListEl;

                const clearSelection = () => {
                    list?.querySelectorAll('.selected').forEach(it => it.classList.remove('selected'));
                    this.details?.remove();
                    this.details = null;
                    container?.classList.remove('has-selection');
                };

                const updateCount = (visibleCount, totalCount) => {
                    if (!countBadge) return;
                    const isFiltered = activeFilter !== 'all' || Boolean(this.search?.value.trim());
                    if (visibleCount === 0) {
                        countBadge.textContent = t`No matches`;
                    } else if (isFiltered) {
                        countBadge.textContent = t`${visibleCount} of ${totalCount}`;
                    } else {
                        countBadge.textContent = totalCount === 1 ? t`1 command` : t`${totalCount} commands`;
                    }
                    if (emptyListEl) {
                        emptyListEl.hidden = visibleCount > 0;
                    }
                };

                let filterCommands = () => {};

                const header = document.createElement('div'); {
                    header.classList.add('nn-scb-header');
                    const headingGroup = document.createElement('div');
                    headingGroup.classList.add('nn-scb-title-group');

                    const iconWrap = document.createElement('span');
                    iconWrap.classList.add('nn-scb-badge-icon');
                    iconWrap.setAttribute('aria-hidden', 'true');
                    const icon = document.createElement('i');
                    icon.classList.add('fa-solid', 'fa-terminal');
                    iconWrap.append(icon);

                    const title = document.createElement('div');
                    title.classList.add('nn-scb-title');
                    title.setAttribute('role', 'heading');
                    title.setAttribute('aria-level', '3');
                    title.textContent = t`Slash Commands`;

                    countBadge = document.createElement('span');
                    countBadge.classList.add('nn-scb-count');
                    countBadge.setAttribute('aria-live', 'polite');

                    headingGroup.append(iconWrap, title, countBadge);

                    const filters = document.createElement('div');
                    filters.classList.add('nn-scb-filters');
                    filters.setAttribute('role', 'group');
                    filters.setAttribute('aria-label', t`Filter commands by source`);
                    const filterDefs = [
                        { id: 'all', label: t`All` },
                        { id: 'core', label: t`Core` },
                        { id: 'extensions', label: t`Extensions` },
                    ];
                    const filterButtons = [];
                    for (const def of filterDefs) {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.classList.add('nn-scb-filter-btn');
                        btn.dataset.filter = def.id;
                        btn.textContent = def.label;
                        btn.setAttribute('aria-pressed', def.id === activeFilter ? 'true' : 'false');
                        btn.addEventListener('click', () => {
                            if (activeFilter === def.id) return;
                            activeFilter = def.id;
                            for (const other of filterButtons) {
                                other.setAttribute('aria-pressed', other.dataset.filter === activeFilter ? 'true' : 'false');
                            }
                            filterCommands();
                        });
                        filterButtons.push(btn);
                        filters.append(btn);
                    }

                    header.append(headingGroup, filters);
                    root.append(header);
                }

                const search = document.createElement('div'); {
                    search.classList.add('search');
                    const lbl = document.createElement('label'); {
                        lbl.classList.add('searchLabel');
                        const searchIcon = document.createElement('i');
                        searchIcon.classList.add('fa-solid', 'fa-magnifying-glass', 'nn-scb-search-icon');
                        searchIcon.setAttribute('aria-hidden', 'true');
                        const searchText = document.createElement('span');
                        searchText.classList.add('nn-scb-search-text');
                        searchText.textContent = `${t`Search:`} `;
                        lbl.append(searchIcon, searchText);
                        const inp = document.createElement('input'); {
                            this.search = inp;
                            inp.classList.add('searchInput');
                            inp.classList.add('text_pole');
                            inp.type = 'search';
                            inp.setAttribute('aria-label', t`Search slash commands`);
                            inp.placeholder = t`Search slash commands`;
                            inp.title = t`Search slash commands - use quotes to search "literal" instead of fuzzy`;
                            // Neconyan: the filter tests every command's help text, so it runs once typing
                            // pauses, and only rows whose state changes are touched.
                            let filterTimer = 0;
                            const targetCache = new Map();
                            filterCommands = () => {
                                clearSelection();
                                let query = inp.value.trim();
                                if (query.slice(-1) === '"' && !/(?:^|\s+)"/.test(query)) {
                                    query = `"${query}`;
                                }
                                let fuzzyList = [];
                                let quotedList = [];
                                while (query.length > 0) {
                                    const match = queryRegex.exec(query);
                                    if (!match) break;
                                    if (match[1] !== undefined) {
                                        fuzzyList.push(new RegExp(`^(.*?)${match[1].split('').map(char => `(${escapeRegex(char)})`).join('(.*?)')}(.*?)$`, 'i'));
                                    } else if (match[2] !== undefined) {
                                        quotedList.push(match[2]);
                                    }
                                    query = query.slice(match.index + match[0].length);
                                }
                                let visibleCount = 0;
                                for (const cmd of this.cmdList) {
                                    const matchesCategory = activeFilter === 'all'
                                        || (activeFilter === 'core' && !cmd.isExtension)
                                        || (activeFilter === 'extensions' && Boolean(cmd.isExtension));
                                    let filtered = !matchesCategory;
                                    if (!filtered && (fuzzyList.length + quotedList.length > 0)) {
                                        const targets = targetCache.get(cmd) ?? [
                                            cmd.name,
                                            ...cmd.namedArgumentList.map(it => it.name),
                                            ...cmd.namedArgumentList.map(it => it.description),
                                            ...cmd.namedArgumentList.map(it => it.enumList.map(e => e.value)).flat(),
                                            ...cmd.namedArgumentList.map(it => it.typeList).flat(),
                                            ...cmd.unnamedArgumentList.map(it => it.description),
                                            ...cmd.unnamedArgumentList.map(it => it.enumList.map(e => e.value)).flat(),
                                            ...cmd.unnamedArgumentList.map(it => it.typeList).flat(),
                                            ...cmd.aliases,
                                            cmd.helpString,
                                        ];
                                        targetCache.set(cmd, targets);
                                        filtered = !targets.some(target => typeof target === 'string'
                                            && (fuzzyList.some(pattern => pattern.test(target)) || quotedList.some(literal => target.includes(literal))));
                                    }
                                    if (!filtered) visibleCount++;
                                    const item = this.itemMap[cmd.name];
                                    if (item.classList.contains('isFiltered') !== filtered) {
                                        item.classList.toggle('isFiltered', filtered);
                                    }
                                }
                                updateCount(visibleCount, this.cmdList.length);
                            };
                            inp.addEventListener('input', () => {
                                clearTimeout(filterTimer);
                                filterTimer = setTimeout(filterCommands, 120);
                            });
                            lbl.append(inp);
                        }
                        search.append(lbl);
                    }
                    root.append(search);
                }
                container = document.createElement('div'); {
                    container.classList.add('commandContainer');
                    list = document.createElement('div'); {
                        list.classList.add('autoComplete');
                        this.cmdList = Object
                            .keys(SlashCommandParser.commands)
                            .filter(key => SlashCommandParser.commands[key].name === key) // exclude aliases
                            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                            .map(key => SlashCommandParser.commands[key])
                        ;
                        for (const cmd of this.cmdList) {
                            const item = cmd.renderHelpItem();
                            item.dataset.name = cmd.name;
                            this.itemMap[cmd.name] = item;
                            let details;
                            item.addEventListener('click', () => {
                                if (!details) {
                                    details = document.createElement('div'); {
                                        details.classList.add('autoComplete-detailsWrap');
                                        const bar = document.createElement('div');
                                        bar.classList.add('nn-scb-details-bar');
                                        const backBtn = document.createElement('button');
                                        backBtn.type = 'button';
                                        backBtn.classList.add('nn-scb-details-back');
                                        backBtn.setAttribute('aria-label', t`Back to commands`);
                                        const backIcon = document.createElement('i');
                                        backIcon.classList.add('fa-solid', 'fa-arrow-left');
                                        backIcon.setAttribute('aria-hidden', 'true');
                                        const backLabel = document.createElement('span');
                                        backLabel.textContent = t`Back to commands`;
                                        backBtn.append(backIcon, backLabel);
                                        backBtn.addEventListener('click', () => clearSelection());

                                        const closeBtn = document.createElement('button');
                                        closeBtn.type = 'button';
                                        closeBtn.classList.add('nn-scb-details-close');
                                        closeBtn.setAttribute('aria-label', t`Close details`);
                                        closeBtn.title = t`Close details`;
                                        const closeIcon = document.createElement('i');
                                        closeIcon.classList.add('fa-solid', 'fa-xmark');
                                        closeIcon.setAttribute('aria-hidden', 'true');
                                        closeBtn.append(closeIcon);
                                        closeBtn.addEventListener('click', () => clearSelection());

                                        bar.append(backBtn, closeBtn);
                                        details.append(bar);

                                        const inner = document.createElement('div'); {
                                            inner.classList.add('autoComplete-details');
                                            inner.append(cmd.renderHelpDetails());
                                            details.append(inner);
                                        }
                                    }
                                }
                                if (this.details !== details) {
                                    Array.from(list.querySelectorAll('.selected')).forEach(it => it.classList.remove('selected'));
                                    item.classList.add('selected');
                                    this.details?.remove();
                                    container.append(details);
                                    container.classList.add('has-selection');
                                    this.details = details;
                                    const pRect = list.getBoundingClientRect();
                                    const rawRect = item.getBoundingClientRect();
                                    const rect = (rawRect.width > 0 || rawRect.height > 0)
                                        ? rawRect
                                        : (item.children[0]?.getBoundingClientRect() ?? rawRect);
                                    details.style.setProperty('--targetOffset', String(rect.top - pRect.top));
                                } else {
                                    clearSelection();
                                }
                            });
                            list.append(item);
                        }
                        emptyListEl = document.createElement('div');
                        emptyListEl.classList.add('nn-scb-empty-list');
                        emptyListEl.hidden = true;
                        const emptyIcon = document.createElement('i');
                        emptyIcon.classList.add('fa-solid', 'fa-magnifying-glass');
                        emptyIcon.setAttribute('aria-hidden', 'true');
                        const emptyText = document.createElement('span');
                        emptyText.textContent = t`No commands match this filter.`;
                        emptyListEl.append(emptyIcon, emptyText);
                        list.append(emptyListEl);
                        container.append(list);
                    }
                    const emptyDetails = document.createElement('div'); {
                        emptyDetails.classList.add('nn-scb-empty-details');
                        const hintIcon = document.createElement('i');
                        hintIcon.classList.add('fa-solid', 'fa-terminal');
                        hintIcon.setAttribute('aria-hidden', 'true');
                        const hintTitle = document.createElement('span');
                        hintTitle.classList.add('nn-scb-empty-details-title');
                        hintTitle.textContent = t`Select a command`;
                        const hintSub = document.createElement('span');
                        hintSub.classList.add('nn-scb-empty-details-sub');
                        hintSub.textContent = t`Pick any slash command on the left to inspect its arguments, return value, aliases, and examples.`;
                        emptyDetails.append(hintIcon, hintTitle, hintSub);
                        container.append(emptyDetails);
                    }
                    root.append(container);
                }
                updateCount(this.cmdList.length, this.cmdList.length);
                root.classList.add('slashCommandBrowser');
            }
        }
        parent.append(this.dom);

        const chatRoot = this.dom.closest('#chat');
        const message = this.dom.closest('.mes');
        // The reading column is padded, so a percentage on the message alone
        // can't use the full chat width. Measure the chat, not the viewport.
        const updateWidth = () => {
            message.style.setProperty('--nn-scb-chat-width', `${Math.max(0, chatRoot.clientWidth - 32)}px`);
        };
        const chatResize = chatRoot && message ? new ResizeObserver(updateWidth) : null;
        if (chatResize) {
            updateWidth();
            chatResize.observe(chatRoot, { box: 'border-box' });
        }
        const boundHandler = this.handleKeyDown.bind(this);
        this.mo = new MutationObserver(muts => {
            if (muts.find(mut => Array.from(mut.removedNodes).find(it => it === this.dom || it.contains(this.dom)))) {
                this.mo.disconnect();
                chatResize?.disconnect();
                message?.style.removeProperty('--nn-scb-chat-width');
                window.removeEventListener('keydown', boundHandler);
            }
        });
        if (chatRoot) {
            this.mo.observe(chatRoot, { childList: true, subtree: true });
        }
        window.addEventListener('keydown', boundHandler);
        return this.dom;
    }

    handleKeyDown(evt) {
        if (!evt.shiftKey && !evt.altKey && evt.ctrlKey && evt.key.toLowerCase() === 'f') {
            if (!this.dom.closest('body')) return;
            if (this.dom.closest('.mes') && !this.dom.closest('.last_mes')) return;
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
            this.search.focus({ preventScroll: true });
        }
    }
}
