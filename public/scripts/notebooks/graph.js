import { button, clear, field, h, setButtonPressed } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_ID = /^n_[a-f\d]{16}$/;

/** A deterministic layout keeps the diagram light; the note list is always available. */
export function graphCoordinates(nodes) {
    const positions = new Map();
    let rings = 0;
    for (let remaining = nodes.length; remaining > 0; rings++) remaining -= 16 + rings * 16;
    const spacing = rings > 1 ? 230 / (rings - 1) : 0;
    let start = 0;
    let ring = 0;
    while (start < nodes.length) {
        const count = Math.min(16 + ring * 16, nodes.length - start);
        const radius = 70 + ring * spacing;
        for (let index = 0; index < count; index++) {
            const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
            positions.set(nodes[start + index].id, { x: 450 + Math.cos(angle) * radius, y: 350 + Math.sin(angle) * radius });
        }
        start += count;
        ring++;
    }
    return positions;
}

function svgElement(name, attributes = {}, text = '') {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
}

function graphDiagram(nodes, edges) {
    const positions = graphCoordinates(nodes);
    const points = [...positions.values()];
    const minX = points.length ? Math.min(...points.map(point => point.x)) : 450;
    const maxX = points.length ? Math.max(...points.map(point => point.x)) : 450;
    const minY = points.length ? Math.min(...points.map(point => point.y)) : 350;
    const maxY = points.length ? Math.max(...points.map(point => point.y)) : 350;
    const width = Math.max(360, maxX - minX + 160);
    const height = Math.max(280, maxY - minY + 160);
    const viewBox = `${(minX + maxX - width) / 2} ${(minY + maxY - height) / 2} ${width} ${height}`;
    const svg = svgElement('svg', { viewBox, role: 'img', 'aria-label': 'Notebook links. Open a note using the list below.' });
    const lines = svgElement('g', { class: 'notes-graph-lines' });
    for (const edge of edges) {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) continue;
        lines.append(svgElement('line', { x1: source.x, y1: source.y, x2: target.x, y2: target.y,
            class: edge.embedded ? 'notes-graph-embed-edge' : 'notes-graph-edge' }));
    }
    svg.append(lines);
    for (const node of nodes) {
        const point = positions.get(node.id);
        const group = svgElement('g', { 'data-graph-node': node.id, class: 'notes-graph-node' });
        group.append(svgElement('circle', { cx: point.x, cy: point.y, r: nodes.length > 100 ? 8 : 12 }), svgElement('title', { 'data-i18n-ignore': '' }, `${node.title}\n${node.path}`));
        if (nodes.length <= 50) group.append(svgElement('text', { x: point.x, y: point.y + 27, 'text-anchor': 'middle', 'data-i18n-ignore': '' }, node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title));
        svg.append(group);
    }
    return svg;
}

export function graphScopeCurrent(app, scope) {
    const { state } = app;
    return Boolean(scope) && state.workspaceView === 'graph' && state.account === scope.account && state.notebookId === scope.notebookId
        && state.workspaceVersion === scope.workspaceVersion && state.notebookSelectionVersion === scope.notebookSelectionVersion
        && state.noteRequestVersion === scope.noteRequestVersion;
}

export function createGraphView(app, container) {
    let scope = null;
    let requestVersion = 0;
    let result = null;
    let folder = '';
    let tag = '';
    let limit = 100;
    let mode = globalThis.matchMedia?.('(max-width: 768px)').matches || app.state.layout === 'beside' ? 'list' : 'diagram';
    let controlsScope = null;
    let output = null;
    const limitButtons = new Map();
    const modeButtons = new Map();

    function buildControls() {
        controlsScope = scope;
        const current = controlsScope;
        const usable = () => scope === current && graphScopeCurrent(app, current);
        clear(container);
        limitButtons.clear();
        modeButtons.clear();
        const folderInput = h('input', { class: 'text_pole', type: 'text', value: folder, placeholder: 'All folders', 'aria-label': 'Graph folder', maxlength: '500' });
        const tagInput = h('input', { class: 'text_pole', type: 'text', value: tag, placeholder: 'All tags', 'aria-label': 'Graph tag', maxlength: '100' });
        const apply = event => {
            event.preventDefault();
            if (!usable()) return;
            folder = folderInput.value.trim();
            tag = tagInput.value.trim();
            void refresh();
        };
        const filters = h('form', { class: 'notes-graph-filters', onsubmit: apply }, field('Folder', folderInput, 'Includes notes in subfolders.'),
            field('Tag', tagInput, 'Includes child tags, such as world/city.'),
            h('div', { class: 'notes-nav-actions' }, h('button', { type: 'submit', class: 'menu_button notes-button', text: 'Apply filters' }),
                button('Clear filters', () => {
                    if (!usable()) return;
                    folder = ''; tag = ''; folderInput.value = ''; tagInput.value = '';
                    void refresh();
                })));
        const caps = h('div', { class: 'notes-choice-row', role: 'group', 'aria-label': 'Graph note limit' });
        for (const value of [50, 100, 300]) {
            const control = button(`Up to ${value}`, () => { if (usable()) { limit = value; void refresh(); } }, { pressed: limit === value, className: 'notes-choice' });
            limitButtons.set(value, control);
            caps.append(control);
        }
        const views = h('div', { class: 'notes-choice-row', role: 'group', 'aria-label': 'Graph display' });
        for (const [value, label] of [['diagram', 'Diagram'], ['list', 'List']]) {
            const control = button(label, () => { if (usable()) { mode = value; render(); } }, { pressed: mode === value, className: 'notes-choice' });
            modeButtons.set(value, control);
            views.append(control);
        }
        output = h('div', { class: 'notes-graph-results' });
        container.append(h('div', { class: 'notes-graph-head' }, h('h2', { class: 'notes-heading', text: 'Notebook graph' }),
            button('Back to note', () => { if (usable()) app.closeNotebookView(); }), button('Refresh graph', () => { if (usable()) void refresh(); })),
        h('p', { class: 'notes-hint', text: 'Lines show links between saved notes. Use the list to open a note with a keyboard or by tapping it. Showing a link does not share a note with an assistant or a chat.' }),
        filters, caps, views, output);
    }

    function render() {
        if (!graphScopeCurrent(app, scope)) return;
        if (controlsScope !== scope || !output) buildControls();
        for (const [value, control] of limitButtons) setButtonPressed(control, limit === value);
        for (const [value, control] of modeButtons) setButtonPressed(control, mode === value);
        clear(output);
        if (!result) {
            output.append(h('p', { class: 'notes-hint', role: 'status', text: 'Loading notebook links…' }));
            return;
        }
        if (result.status !== 'success') {
            output.append(h('p', { class: 'notes-notice', role: 'status', text: result.message || 'The graph could not be loaded. Try Refresh graph.' }));
            return;
        }
        const nodes = (Array.isArray(result.nodes) ? result.nodes : []).slice(0, 300)
            .filter(node => NODE_ID.test(node?.id) && typeof node.title === 'string' && typeof node.path === 'string');
        const ids = new Set(nodes.map(node => node.id));
        const edges = (Array.isArray(result.edges) ? result.edges : []).slice(0, 1200).filter(edge => ids.has(edge?.source) && ids.has(edge?.target));
        output.append(h('p', { class: 'notes-hint notes-graph-summary', role: 'status', text: `Showing ${nodes.length} of ${result.total} notes, with ${edges.length} connection${edges.length === 1 ? '' : 's'}.` }));
        if (result.truncated?.nodes || result.truncated?.edges) output.append(h('p', { class: 'notes-notice', text: 'This graph is limited in size. Use the folder or tag filters to show a smaller part of the notebook.' }));
        if (!nodes.length) {
            output.append(h('p', { class: 'notes-hint', text: 'No notes match these filters. Clear the filters or make a new note.' }));
            return;
        }
        const diagram = h('div', { class: 'notes-graph-map', hidden: mode !== 'diagram' }, graphDiagram(nodes, edges));
        const neighbours = new Map(nodes.map(node => [node.id, []]));
        for (const edge of edges) {
            neighbours.get(edge.source).push(edge.target);
            neighbours.get(edge.target).push(edge.source);
        }
        const list = h('ul', { class: 'notes-list notes-graph-list', 'aria-label': 'Graph notes' });
        const listScope = scope;
        const listVersion = requestVersion;
        const listCurrent = () => listScope === scope && listVersion === requestVersion && graphScopeCurrent(app, listScope);
        const focusNode = id => {
            for (const node of diagram.querySelectorAll('[data-graph-node]')) node.classList.toggle('is-focused', node.dataset.graphNode === id);
        };
        for (const node of nodes) {
            const connections = neighbours.get(node.id).length;
            const control = h('button', { type: 'button', class: 'notes-note-link', 'data-graph-note': node.id,
                onclick: () => { if (listCurrent()) void app.openNote(listScope.notebookId, node.id, { pushBack: true }); },
                onfocus: () => focusNode(node.id) }, h('span', { class: 'notes-note-title', text: node.title || 'Untitled', 'data-i18n-ignore': node.title ? '' : null }),
            // The path is the user's; the rest of the line stays with the run-time localiser, as before.
            h('span', { class: 'notes-note-meta' }, h('span', { text: node.path, 'data-i18n-ignore': '' }), ` · ${connections} connection${connections === 1 ? '' : 's'}`));
            list.append(h('li', { class: 'notes-list-item' }, control));
        }
        output.append(diagram, h('h3', { class: 'notes-nav-heading', text: 'Notes in this graph' }), list);
    }

    async function refresh() {
        const current = scope;
        if (!graphScopeCurrent(app, current)) return;
        const version = ++requestVersion;
        const body = { notebookId: current.notebookId, folder: folder || null, tag: tag || null, limit };
        result = null;
        render();
        let response;
        try { response = await app.request('/graph', body); } catch { response = { status: 'failure', message: 'The graph could not be loaded. Try Refresh graph.' }; }
        if (version !== requestVersion || scope !== current || !graphScopeCurrent(app, current)) return;
        result = response && typeof response.status === 'string' ? response : { status: 'failure', message: 'The graph could not be loaded. Try Refresh graph.' };
        render();
    }

    return {
        async open() {
            const { state } = app;
            if (scope?.notebookId !== state.notebookId || scope?.account !== state.account) { folder = ''; tag = ''; limit = 100; }
            scope = { account: state.account, notebookId: state.notebookId, workspaceVersion: state.workspaceVersion,
                notebookSelectionVersion: state.notebookSelectionVersion, noteRequestVersion: state.noteRequestVersion };
            await refresh();
        },
        refresh,
        clear() { requestVersion++; scope = null; controlsScope = null; output = null; result = null; folder = ''; tag = ''; clear(container); },
    };
}
