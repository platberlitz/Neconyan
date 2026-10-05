import { button, clear, field, h, setButtonPressed } from './dom.js';
import { parsePropertyValue } from './property-values.js';

export function propertyTableScopeCurrent(app, snapshot) {
    const { state } = app;
    return state.workspaceView === 'table' && state.account === snapshot.account && state.notebookId === snapshot.notebookId
        && state.workspaceVersion === snapshot.workspaceVersion && state.notebookSelectionVersion === snapshot.notebookSelectionVersion
        && state.noteRequestVersion === snapshot.noteRequestVersion;
}

/** Sideways gestures stay native; vertical gestures scroll only this table's pane. */
export function bindPropertyTableTouchScroll(rail) {
    if (typeof rail.addEventListener !== 'function') return;
    let gesture = null;
    rail.addEventListener('touchstart', event => {
        gesture = null;
        if (event.touches.length !== 1 || !rail.isConnected) return;
        const pane = rail.closest('.notes-table-pane');
        if (!pane) return;
        const touch = event.touches[0];
        gesture = { pane, id: touch.identifier, x: touch.clientX, y: touch.clientY, top: pane.scrollTop, direction: null };
    }, { passive: true });
    rail.addEventListener('touchmove', event => {
        if (!gesture) return;
        if (event.touches.length !== 1 || !rail.isConnected || !gesture.pane.classList.contains('notes-table-pane')) { gesture = null; return; }
        const touch = event.touches[0];
        if (touch.identifier !== gesture.id) { gesture = null; return; }
        const x = touch.clientX - gesture.x;
        const y = touch.clientY - gesture.y;
        if (!gesture.direction && Math.max(Math.abs(x), Math.abs(y)) >= 8) gesture.direction = Math.abs(y) > Math.abs(x) ? 'vertical' : 'horizontal';
        if (gesture.direction !== 'vertical') return;
        if (event.cancelable) event.preventDefault();
        gesture.pane.scrollTop = Math.max(0, Math.min(gesture.pane.scrollHeight - gesture.pane.clientHeight, gesture.top - y));
    }, { passive: false });
    const end = () => { gesture = null; };
    rail.addEventListener('touchend', end, { passive: true });
    rail.addEventListener('touchcancel', end, { passive: true });
}

/** A separately loaded metadata view. Writes stay in the ordinary properties operation. */
export function createPropertyTableView(app, container) {
    let scope = null;
    let controlsScope = null;
    let requestVersion = 0;
    let result = null;
    let output = null;
    let columnsHost = null;
    let columnCatalog = null;
    let shownColumns = [];
    let offset = 0;
    let previousOffsets = [];
    let columns;
    let filters = { folder: '', tag: '', query: '', key: '', op: 'contains', value: '', kind: 'text' };
    let sort = { by: 'title', direction: 'asc', key: '' };
    let limit = 50;
    const fields = {};
    const sortButtons = new Map();
    const directionButtons = new Map();
    const sizeButtons = new Map();
    const columnButtons = new Map();
    const current = captured => scope === captured && propertyTableScopeCurrent(app, captured);

    function buildControls() {
        if (controlsScope === scope) return;
        controlsScope = scope;
        const controlScope = scope;
        const usable = () => current(controlScope);
        clear(container);
        const header = h('div', { class: 'notes-table-head' }, h('h3', { class: 'notes-heading', text: 'Property table' }),
            button('Back to note', () => { if (usable()) app.closeNotebookView(); }),
            button('Refresh table', () => { if (usable()) void refresh(); }));
        const form = h('form', { class: 'notes-table-filters', onsubmit: event => {
            event.preventDefault();
            if (!usable()) return;
            for (const key of ['folder', 'tag', 'query', 'key', 'value']) filters[key] = fields[key].value;
            filters.op = fields.op.value;
            filters.kind = fields.kind.value;
            sort.key = fields.sortKey.value;
            offset = 0;
            previousOffsets = [];
            void refresh();
        } });
        for (const [key, label] of [['folder', 'Folder'], ['tag', 'Tag'], ['query', 'Find notes'], ['key', 'Filter property'], ['value', 'Filter value'], ['sortKey', 'Sort property']]) {
            fields[key] = h('input', { class: 'text_pole', type: 'text', value: key === 'sortKey' ? sort.key : filters[key], placeholder: key === 'folder' || key === 'tag' ? 'All' : '' });
            form.append(field(label, fields[key]));
        }
        fields.op = h('select', { class: 'text_pole' }, ...[['contains', 'Contains'], ['equals', 'Equals'], ['exists', 'Is set'], ['missing', 'Is not set'], ['greater', 'Greater than'], ['less', 'Less than']]
            .map(([value, text]) => h('option', { value, text, selected: value === filters.op })));
        fields.kind = h('select', { class: 'text_pole' }, ...[['text', 'Text'], ['number', 'Number'], ['boolean', 'True / false'], ['list', 'List'], ['null', 'Null']]
            .map(([value, text]) => h('option', { value, text, selected: value === filters.kind })));
        form.append(field('Comparison', fields.op), field('Filter value type', fields.kind),
            h('button', { class: 'menu_button notes-button', type: 'submit', text: 'Apply filters' }),
            button('Clear filters', () => {
                if (!usable()) return;
                filters = { folder: '', tag: '', query: '', key: '', op: 'contains', value: '', kind: 'text' };
                for (const key of ['folder', 'tag', 'query', 'key', 'value']) fields[key].value = '';
                fields.op.value = 'contains';
                fields.kind.value = 'text';
                offset = 0;
                previousOffsets = [];
                void refresh();
            }));
        const sorting = h('div', { class: 'notes-wrap', 'aria-label': 'Sort notes' });
        sortButtons.clear();
        for (const [by, label] of [['title', 'Title'], ['path', 'Path'], ['createdAt', 'Created'], ['updatedAt', 'Updated'], ['property', 'Property']]) {
            const control = button(`Sort by ${label.toLowerCase()}`, () => {
                if (!usable()) return;
                sort.by = by;
                sort.key = fields.sortKey.value;
                offset = 0;
                previousOffsets = [];
                void refresh();
            });
            sortButtons.set(by, control);
            sorting.append(control);
        }
        directionButtons.clear();
        for (const [direction, label] of [['asc', 'Ascending'], ['desc', 'Descending']]) {
            const control = button(label, () => {
                if (!usable()) return;
                sort.direction = direction;
                offset = 0;
                previousOffsets = [];
                void refresh();
            });
            directionButtons.set(direction, control);
            sorting.append(control);
        }
        const sizes = h('div', { class: 'notes-wrap', 'aria-label': 'Rows per page' });
        sizeButtons.clear();
        for (const size of [25, 50, 100]) {
            const control = button(`${size} rows per page`, () => {
                if (!usable()) return;
                limit = size;
                offset = 0;
                previousOffsets = [];
                void refresh();
            });
            sizeButtons.set(size, control);
            sizes.append(control);
        }
        columnsHost = h('div', { class: 'notes-table-columns' });
        columnCatalog = null;
        shownColumns = [];
        columnButtons.clear();
        output = h('div', { class: 'notes-table-results' });
        container.append(header, h('p', { class: 'notes-hint', text: 'Saved properties only. Folder and tag filters include their children. Nested, null and identity values stay source-only.' }),
            form, sorting, sizes, columnsHost, output);
    }

    function renderColumns() {
        const selected = columns ?? result?.columns ?? shownColumns;
        for (const [key, control] of columnButtons) setButtonPressed(control, selected.includes(key));
        if (!result || result.status !== 'success') return;
        const controlScope = scope;
        const available = (result.availableColumns ?? []).slice(0, 128);
        shownColumns = result.columns ?? [];
        const catalog = JSON.stringify(available);
        if (catalog === columnCatalog) return;
        const expanded = columnsHost.querySelector?.('details')?.open ?? false;
        clear(columnsHost);
        columnButtons.clear();
        columnCatalog = catalog;
        const choices = h('details', { class: 'notes-table-column-picker', open: expanded }, h('summary', { text: 'Choose columns' }));
        const list = h('div', { class: 'notes-wrap' });
        for (const key of available) {
            const control = button(key, () => {
                if (!current(controlScope)) return;
                const next = new Set(columns ?? shownColumns);
                if (next.has(key)) next.delete(key);
                else if (next.size < 12) next.add(key);
                else { app.toast('info', 'Choose up to 12 property columns.'); return; }
                columns = [...next];
                void refresh();
            }, { pressed: selected.includes(key) });
            columnButtons.set(key, control);
            list.append(control);
        }
        choices.append(h('p', { class: 'notes-hint', text: 'Choose up to 12 properties. Swipe the table sideways on a phone to reach other columns.' }), list);
        columnsHost.append(choices);
    }

    function render() {
        if (!scope || !current(scope)) return;
        buildControls();
        for (const [value, control] of sortButtons) setButtonPressed(control, sort.by === value);
        for (const [value, control] of directionButtons) setButtonPressed(control, sort.direction === value);
        for (const [value, control] of sizeButtons) setButtonPressed(control, limit === value);
        clear(output);
        renderColumns();
        if (!result) { output.append(h('p', { class: 'notes-hint', role: 'status', text: 'Loading saved properties…' })); return; }
        if (result.status !== 'success') { output.append(h('p', { class: 'notes-notice', text: result.message || 'The table could not be loaded. Try refreshing it.' })); return; }
        const rows = (result.rows ?? []).filter(row => /^n_[a-f\d]{16}$/.test(row.id) && typeof row.revision === 'string').slice(0, 100);
        const shown = (result.columns ?? []).slice(0, 12);
        output.append(h('p', { class: 'notes-hint', text: rows.length ? `Showing notes ${result.offset + 1}-${result.offset + rows.length} of ${result.total}.`
            : 'No notes match these filters. Clear them or choose another property.' }));
        if (result.limited?.bytes || result.limited?.columns) output.append(h('p', { class: 'notes-hint', text: 'This view is limited in size. Use the next page or choose fewer columns.' }));
        const rowScope = scope;
        const rowVersion = requestVersion;
        const usable = () => current(rowScope) && rowVersion === requestVersion;
        const table = h('table', { class: 'notes-property-table' }, h('caption', { class: 'notes-hint', text: 'Saved note properties' }),
            h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Note' }), ...shown.map(key => h('th', { scope: 'col', text: key })))));
        const body = h('tbody');
        for (const row of rows) {
            const link = button(row.title, () => { if (usable()) void app.openNote(rowScope.notebookId, row.id, { pushBack: true }); }, { className: 'notes-table-note', userText: true });
            const line = h('tr', { 'data-table-note': row.id }, h('th', { scope: 'row' }, link, h('p', { class: 'notes-muted', text: row.path })));
            for (const key of shown) {
                const cell = Object.hasOwn(row.cells ?? {}, key) ? row.cells[key] : { display: 'Not set', editable: false };
                const content = cell?.editable === true ? button(String(cell.display ?? 'Not set'), async () => {
                    if (!usable()) return;
                    const saved = await app.dialogs.editPropertyCell(app, { ...row, notebookId: rowScope.notebookId }, key, cell, { isCurrent: usable });
                    if (saved && usable()) { await app.refreshTree(); if (usable()) await refresh(); }
                }, { className: 'notes-property-cell' })
                    : h('span', { class: 'notes-muted', text: String(cell?.display ?? 'Edit in source.') });
                if (cell?.editable === true) content.setAttribute('aria-label', `Edit ${key} for ${row.title}`);
                line.append(h('td', { 'data-property-key': key }, content));
            }
            body.append(line);
        }
        table.append(body);
        const rail = h('div', { class: 'notes-property-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Note properties; scroll sideways for more columns' }, table);
        bindPropertyTableTouchScroll(rail);
        output.append(rail);
        const pages = h('div', { class: 'notes-wrap' });
        pages.append(button('Previous page', () => { if (usable() && previousOffsets.length) { offset = previousOffsets.pop(); void refresh(); } }, { disabled: !previousOffsets.length }),
            button('Next page', () => { if (usable() && result.nextOffset !== null) { previousOffsets.push(offset); offset = result.nextOffset; void refresh(); } }, { disabled: result.nextOffset === null }));
        output.append(pages);
    }

    async function refresh() {
        const captured = scope;
        if (!captured || !current(captured)) return;
        const version = ++requestVersion;
        let filter = null;
        try {
            if (filters.key.trim()) filter = { key: filters.key.trim(), op: filters.op, value: ['exists', 'missing'].includes(filters.op) ? null : parsePropertyValue(filters.kind, filters.value) };
        } catch (error) { result = { status: 'failure', message: error.message }; render(); return; }
        result = null;
        render();
        let response;
        try {
            response = await app.request('/properties/table', { notebookId: captured.notebookId, folder: filters.folder.trim() || null, tag: filters.tag.trim() || null,
                query: filters.query, filter, sort: { ...sort }, columns, offset, limit });
        } catch { response = { status: 'failure', message: 'The table could not be loaded. Try refreshing it.' }; }
        if (!current(captured) || version !== requestVersion) return;
        result = response && typeof response.status === 'string' ? response : { status: 'failure', message: 'The table could not be loaded. Try refreshing it.' };
        render();
    }

    return {
        async open() {
            const { state } = app;
            if (!scope || scope.account !== state.account || scope.notebookId !== state.notebookId) {
                columns = undefined;
                filters = { folder: '', tag: '', query: '', key: '', op: 'contains', value: '', kind: 'text' };
                sort = { by: 'title', direction: 'asc', key: '' };
                offset = 0;
                previousOffsets = [];
            }
            scope = { account: state.account, notebookId: state.notebookId, workspaceVersion: state.workspaceVersion,
                notebookSelectionVersion: state.notebookSelectionVersion, noteRequestVersion: state.noteRequestVersion };
            await refresh();
        },
        refresh,
        clear() { requestVersion++; scope = null; controlsScope = null; result = null; clear(container); },
    };
}
