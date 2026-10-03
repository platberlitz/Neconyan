import { button, clear, formatTime, h } from './dom.js';
import { attachmentUrl, newOperationId } from './api.js';
import { CANVAS_LIMITS, changeCanvasDocument, serializeCanvasDocument, validateCanvasDocument } from './canvas-format.js';
import { clearCanvasDraft, readCanvasDraft, saveCanvasDraft } from './canvas-drafts.js';
import { canvasTextPrompt, chooseCanvasNote, editCanvasEdge, editCanvasNode } from './canvas-dialogs.js';

export function canvasScopeCurrent(app, snapshot) {
    const state = app.state;
    return state.workspaceView === 'canvas' && state.account === snapshot.account && state.notebookId === snapshot.notebookId
        && state.workspaceVersion === snapshot.workspaceVersion && state.notebookSelectionVersion === snapshot.notebookSelectionVersion
        && state.noteRequestVersion === snapshot.noteRequestVersion;
}

export function canvasBounds(nodes) {
    const left = Math.min(0, ...nodes.map(node => node.x));
    const top = Math.min(0, ...nodes.map(node => node.y));
    const right = Math.max(720, ...nodes.map(node => node.x + Math.max(node.width, 44)));
    const bottom = Math.max(300, ...nodes.map(node => node.y + Math.max(node.height, 44)));
    return { x: left - 32, y: top - 32, width: right - left + 64, height: bottom - top + 64 };
}

export function canvasEdgePoint(node, side) {
    if (side === 'top') return { x: node.x + node.width / 2, y: node.y };
    if (side === 'bottom') return { x: node.x + node.width / 2, y: node.y + node.height };
    if (side === 'left') return { x: node.x, y: node.y + node.height / 2 };
    return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function svgElement(name, attributes = {}, text = '') {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    return element;
}

/** Imported preset colours derive their lightness and contrast from the active theme. */
function canvasColor(value) {
    if (/^#[a-f\d]{6}$/i.test(value ?? '')) return value;
    if (!/^[1-6]$/.test(value ?? '')) return null;
    const hue = { 1: 25, 2: 60, 3: 95, 4: 145, 5: 200, 6: 310 }[value];
    return `oklch(from var(--neco-ginger) l c ${hue})`;
}

/** Position changes are explicit and applied once, only after a complete pointer gesture. */
export function canvasDiagram(nodes, edges, { selectedId, move = false, viewportWidth, current = () => true, onSelect, onMove } = {}) {
    const originalBounds = canvasBounds(nodes);
    const width = Number.isFinite(viewportWidth) && viewportWidth > 64 ? viewportWidth : originalBounds.width;
    const padding = Math.max(32, (originalBounds.width - 64) * 32 / (width - 64));
    const bounds = { x: originalBounds.x + 32 - padding, y: originalBounds.y + 32 - padding,
        width: originalBounds.width - 64 + padding * 2, height: originalBounds.height - 64 + padding * 2 };
    const unitsPerPixel = bounds.width / width;
    const svg = svgElement('svg', { viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,
        class: 'notes-canvas-diagram', role: 'group', 'aria-label': 'Canvas board', 'data-move': String(move) });
    const arrowId = `notes-canvas-arrow-${crypto.randomUUID().replaceAll('-', '')}`;
    const defs = svgElement('defs');
    const marker = svgElement('marker', { id: arrowId, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M 0 0 L 8 4 L 0 8 Z', class: 'notes-canvas-arrow' }));
    defs.append(marker);
    svg.append(defs);
    const byId = new Map(nodes.map(node => [node.id, node]));
    let cancelDrag = null;
    for (const edge of edges) {
        if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue;
        const from = canvasEdgePoint(byId.get(edge.fromNode), edge.fromSide ?? 'right');
        const to = canvasEdgePoint(byId.get(edge.toNode), edge.toSide ?? 'left');
        const line = svgElement('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'notes-canvas-line', 'vector-effect': 'non-scaling-stroke',
            ...(edge.fromEnd === 'arrow' ? { 'marker-start': `url(#${arrowId})` } : {}),
            ...(edge.toEnd !== 'none' ? { 'marker-end': `url(#${arrowId})` } : {}) });
        if (canvasColor(edge.color)) line.style.stroke = canvasColor(edge.color);
        if (edge.label) line.append(svgElement('title', {}, edge.label));
        svg.append(line);
    }
    for (const node of nodes) {
        const group = svgElement('g', { class: `notes-canvas-node ${node.id === selectedId ? 'is-selected' : ''}`, tabindex: 0,
            role: 'button', 'aria-label': `Select card: ${node.label}`, 'data-canvas-node': node.id });
        const drawnWidth = Math.max(node.width, 44);
        const drawnHeight = Math.max(node.height, 44);
        const box = svgElement('rect', { x: node.x, y: node.y, width: drawnWidth, height: drawnHeight, rx: 8, 'vector-effect': 'non-scaling-stroke' });
        const hitWidth = Math.max(drawnWidth, 45 * unitsPerPixel);
        const hitHeight = Math.max(drawnHeight, 45 * unitsPerPixel);
        const hit = svgElement('rect', { class: 'notes-canvas-hit', x: node.x - (hitWidth - drawnWidth) / 2,
            y: node.y - (hitHeight - drawnHeight) / 2, width: hitWidth, height: hitHeight, 'pointer-events': 'all' });
        hit.style.fill = 'transparent';
        hit.style.stroke = 'none';
        if (canvasColor(node.color)) box.style.stroke = canvasColor(node.color);
        const labelLength = Math.max(1, Math.min(36, Math.floor((drawnWidth / unitsPerPixel - 24) / 7.5)));
        const caption = svgElement('text', { x: node.x + 12 * unitsPerPixel, y: node.y + 24 * unitsPerPixel },
            node.label.length > labelLength ? node.label.slice(0, Math.max(0, labelLength - 1)) + '…' : node.label);
        caption.style.fontSize = `${12 * unitsPerPixel}px`;
        group.append(hit, box, caption, svgElement('title', {}, node.label));
        let drag = null;
        const cancel = () => {
            drag = null;
            group.removeAttribute('transform');
            if (cancelDrag === cancel) cancelDrag = null;
        };
        group.addEventListener('keydown', event => {
            if ((event.key === 'Enter' || event.key === ' ') && current()) { event.preventDefault(); onSelect?.(node.id); }
        });
        group.addEventListener('click', () => { if (!move && current()) onSelect?.(node.id); });
        group.addEventListener('pointerdown', event => {
            if (!move || !current() || event.button !== 0) return;
            if (event.isPrimary === false || cancelDrag) { cancelDrag?.(); return; }
            const matrix = svg.getScreenCTM();
            if (!matrix) return;
            event.preventDefault();
            group.setPointerCapture?.(event.pointerId);
            const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
            drag = { pointerId: event.pointerId, x: point.x, y: point.y, dx: 0, dy: 0 };
            cancelDrag = cancel;
        });
        group.addEventListener('pointermove', event => {
            if (!drag || drag.pointerId !== event.pointerId || !current()) return;
            const matrix = svg.getScreenCTM();
            if (!matrix) return;
            const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
            drag.dx = Math.round(point.x - drag.x);
            drag.dy = Math.round(point.y - drag.y);
            group.setAttribute('transform', `translate(${drag.dx} ${drag.dy})`);
        });
        group.addEventListener('pointerup', event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const ended = drag;
            cancel();
            if (!current()) return;
            if (ended.dx || ended.dy) onMove?.(node.id, node.x + ended.dx, node.y + ended.dy);
            else onSelect?.(node.id);
        });
        group.addEventListener('pointercancel', cancel);
        group.addEventListener('lostpointercapture', cancel);
        svg.append(group);
    }
    return svg;
}

function downloadCanvas(document, title = 'Planning canvas') {
    const url = URL.createObjectURL(new Blob([serializeCanvasDocument(document)], { type: 'application/json' }));
    const link = h('a', { href: url, download: `${title.replace(/[\\/\x00-\x1f]/g, '_')}.canvas` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createCanvasView(app, container) {
    let scope = null;
    let requestVersion = 0;
    let galleryVersion = 0;
    let previewVersion = 0;
    let documentVersion = 0;
    let canvases = [];
    let warnings = [];
    let canvas = null;
    let document = null;
    let savedDocument = null;
    let preview = null;
    let dirty = false;
    let draftSafe = true;
    let downloadedVersion = -1;
    let confirmedDownloadVersion = -1;
    let staleDraft = null;
    let conflict = false;
    let saving = false;
    let pending = null;
    let selectedId = null;
    let move = false;
    let notice = '';
    let mode = app.isPhone() || app.state.layout === 'beside' ? 'list' : 'board';
    const undo = [];
    const redo = [];
    const usable = (captured = scope) => captured === scope && captured && canvasScopeCurrent(app, captured);
    const operationSnapshot = () => ({ scope, canvas, requestVersion, documentVersion });
    const sameSelection = captured => usable(captured.scope) && canvas === captured.canvas && requestVersion === captured.requestVersion;
    const sameDocument = captured => sameSelection(captured) && documentVersion === captured.documentVersion;
    const remember = () => {
        if (!canvas || !document || !scope) return;
        if (!dirty) { clearCanvasDraft(scope.account, scope.notebookId, canvas.id); draftSafe = true; return; }
        draftSafe = saveCanvasDraft(scope.account, scope.notebookId, canvas.id, document, canvas.revision);
        if (!draftSafe) notice = 'This browser could not keep your canvas draft. Save or download it before leaving this canvas.';
    };
    const pushUndo = () => {
        undo.push(JSON.stringify(document));
        while (undo.length > 30 || undo.reduce((total, item) => total + new TextEncoder().encode(item).length, 0) > 8 * 1024 * 1024) undo.shift();
        redo.length = 0;
    };
    const apply = (next, { history = true } = {}) => {
        if (!usable() || saving || !document || staleDraft) return false;
        validateCanvasDocument(next);
        if (JSON.stringify(next) === JSON.stringify(document)) return true;
        if (history) pushUndo();
        document = next;
        documentVersion++;
        dirty = JSON.stringify(document) !== JSON.stringify(savedDocument);
        preview = null;
        pending = null;
        remember();
        render();
        void refreshPreview();
        return true;
    };
    const change = changes => {
        try { return apply(changeCanvasDocument(document, changes)); } catch (error) { notice = error.message; render(); return false; }
    };
    const nodeLabel = node => preview?.nodes?.find(item => item.id === node.id)?.label ?? (node.type === 'text' ? 'Text card' : node.type === 'group' ? node.label || 'Group' : node.type === 'file' ? 'Note preview pending.' : node.type === 'link' ? 'Web link' : 'Unsupported card type');
    const localPreview = () => (document?.nodes ?? []).map(node => ({ id: node.id, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height,
        color: node.color, label: nodeLabel(node), excerpt: node.type === 'text' ? node.text.slice(0, 1200) : preview?.nodes?.find(item => item.id === node.id)?.excerpt ?? '' }));

    async function refreshPreview() {
        if (!usable() || !canvas || !document) return;
        const captured = operationSnapshot();
        const ticket = ++previewVersion;
        const result = await app.request('/canvas/preview', { notebookId: scope.notebookId, canvasId: canvas.id, document });
        if (!sameDocument(captured) || ticket !== previewVersion) return;
        preview = result?.status === 'success' ? result.preview : null;
        render();
    }

    async function refreshGallery({ renderResult = true } = {}) {
        if (!usable()) return false;
        const captured = scope;
        const ticket = ++galleryVersion;
        const result = await app.request('/canvas/list', { notebookId: captured.notebookId });
        if (!usable(captured) || ticket !== galleryVersion) return false;
        if (result?.status !== 'success') { notice = result?.message || 'Canvases could not be loaded. Try Refresh files.'; if (renderResult) render(); return false; }
        canvases = result.canvases ?? [];
        warnings = result.warnings ?? [];
        if (renderResult) render();
        return true;
    }

    async function selectCanvas(id, { discardDraft = false } = {}) {
        if (!usable() || saving || (!discardDraft && !draftSafe && dirty && confirmedDownloadVersion !== documentVersion)) { app.toast('Save or download your canvas draft before switching.', 'warning'); return false; }
        const captured = scope;
        const ticket = ++requestVersion;
        const previousVersion = documentVersion;
        notice = 'Loading canvas...';
        render();
        const result = await app.request('/canvas/read', { notebookId: captured.notebookId, canvasId: id });
        if (!usable(captured) || ticket !== requestVersion || previousVersion !== documentVersion) return false;
        if (result?.status !== 'success') { notice = result?.message || 'This canvas could not be opened. Its original file is kept unchanged.'; render(); return false; }
        canvas = result.canvas;
        document = structuredClone(canvas.document);
        savedDocument = structuredClone(canvas.document);
        preview = result.preview;
        dirty = false;
        conflict = false;
        pending = null;
        selectedId = null;
        staleDraft = null;
        notice = '';
        documentVersion++;
        undo.length = redo.length = 0;
        downloadedVersion = confirmedDownloadVersion = -1;
        if (discardDraft) clearCanvasDraft(captured.account, captured.notebookId, canvas.id);
        else {
            const draft = readCanvasDraft(captured.account, captured.notebookId, canvas.id);
            if (draft?.baseRevision === canvas.revision) {
                document = draft.document;
                dirty = JSON.stringify(document) !== JSON.stringify(savedDocument);
                notice = dirty ? 'Restored the canvas draft saved on this device. Choose Save canvas when it is ready.' : '';
                if (dirty) preview = null;
            } else staleDraft = draft;
        }
        draftSafe = true;
        const preferences = { ...app.readPrefs().canvases, [captured.notebookId]: canvas.id };
        app.writePrefs({ canvases: Object.fromEntries(Object.entries(preferences).slice(-50)) });
        render();
        if (!preview) void refreshPreview();
        return true;
    }

    async function createNew() {
        if (!usable() || saving) return;
        const captured = operationSnapshot();
        const title = await canvasTextPrompt('Name this portable planning canvas.', 'Planning canvas');
        if (!title || !sameDocument(captured)) return;
        const result = await app.request('/canvas/create', { notebookId: scope.notebookId, operationId: newOperationId('canvas-create'), title, document: { nodes: [], edges: [] } });
        if (!sameDocument(captured)) return;
        if (result?.status !== 'success') { notice = result?.message || 'The canvas was not created. Try again.'; render(); return; }
        await refreshGallery({ renderResult: false });
        if (sameDocument(captured)) await selectCanvas(result.canvasId);
    }

    async function save() {
        if (!usable() || !canvas || !document || saving || conflict || !dirty) return false;
        const captured = operationSnapshot();
        const text = JSON.stringify(document);
        if (!pending || pending.text !== text || pending.revision !== canvas.revision) pending = { text, revision: canvas.revision, operationId: newOperationId('canvas-save') };
        const job = pending;
        saving = true;
        render();
        const result = await app.request('/canvas/update', { notebookId: scope.notebookId, canvasId: canvas.id,
            operationId: job.operationId, expectedRevision: job.revision, document });
        if (!sameSelection(captured)) return false;
        saving = false;
        if (result?.status !== 'success' && result?.status !== 'no_change') {
            conflict = result?.http === 409 || result?.status === 'conflict';
            notice = conflict ? 'This canvas changed after you opened it. Your draft is still here. Choose how to keep it below.'
                : result?.message || 'The canvas could not be saved. Your draft stays on this device; try Save canvas again.';
            remember();
            render();
            return false;
        }
        canvas.revision = result.revision;
        savedDocument = JSON.parse(text);
        dirty = JSON.stringify(document) !== text;
        pending = null;
        notice = dirty ? 'The earlier version was saved. Your newer draft is still here.' : 'Canvas saved. Note access and live lore were not changed.';
        remember();
        await refreshGallery();
        return true;
    }

    async function saveCopy(source = document, title = `${canvas?.title || 'Canvas'} (my copy)`) {
        if (!usable() || !source || saving) return;
        const captured = operationSnapshot();
        const originalId = canvas?.id;
        saving = true;
        render();
        const result = await app.request('/canvas/create', { notebookId: scope.notebookId, operationId: newOperationId('canvas-copy'),
            title, folder: canvas?.path.includes('/') ? canvas.path.slice(0, canvas.path.lastIndexOf('/')) : '', document: source });
        if (!sameDocument(captured)) return;
        saving = false;
        if (result?.status !== 'success') { notice = result?.message || 'The copy was not saved. Your draft is still here.'; render(); return; }
        await refreshGallery({ renderResult: false });
        if (!sameDocument(captured)) return;
        if (await selectCanvas(result.canvasId, { discardDraft: true })) clearCanvasDraft(captured.scope.account, captured.scope.notebookId, originalId);
    }

    async function useSaved() {
        if (!canvas) return;
        await selectCanvas(canvas.id, { discardDraft: true });
    }

    async function keepMine() {
        const captured = operationSnapshot();
        const result = await app.request('/canvas/read', { notebookId: scope.notebookId, canvasId: canvas.id });
        if (!sameDocument(captured) || result?.status !== 'success') return;
        canvas.revision = result.canvas.revision;
        savedDocument = result.canvas.document;
        conflict = false;
        pending = null;
        dirty = JSON.stringify(document) !== JSON.stringify(savedDocument);
        remember();
        await save();
    }

    async function editNode(id = selectedId) {
        const node = document?.nodes?.find(item => item.id === id);
        if (!node || !usable() || saving || staleDraft) return;
        const captured = operationSnapshot();
        await editCanvasNode(document, node, () => sameDocument(captured), next => apply(next));
    }

    async function addCard(type) {
        if (!usable() || !document || saving) return;
        const captured = operationSnapshot();
        const node = { id: newOperationId('card'), type, x: (document.nodes?.length ?? 0) % 3 * 360, y: Math.floor((document.nodes?.length ?? 0) / 3) * 220,
            width: type === 'group' ? 720 : 320, height: type === 'group' ? 420 : 180 };
        if (type === 'file') {
            const note = await chooseCanvasNote(app, scope.notebookId, () => sameDocument(captured));
            if (!note || !sameDocument(captured)) return;
            node.file = note.path;
        } else if (type === 'text') node.text = 'New planning text.';
        else if (type === 'group') node.label = 'New group';
        else if (type === 'link') node.url = 'https://example.com/';
        if (!change([{ type: 'add-node', node }])) return;
        selectedId = node.id;
        render();
        if (type !== 'file') await editNode(node.id);
    }

    async function edgeEditor(edge = null) {
        if (!usable() || !document || saving) return;
        const captured = operationSnapshot();
        await editCanvasEdge(document, edge, () => sameDocument(captured), next => apply(next));
    }

    async function history() {
        if (!usable() || !canvas) return;
        const captured = operationSnapshot();
        const result = await app.request('/canvas/history', { notebookId: scope.notebookId, canvasId: canvas.id });
        if (!sameDocument(captured) || result?.status !== 'success') return;
        const content = h('div', { class: 'notes-canvas-history' }, h('h3', { text: 'Canvas history' }),
            h('p', { class: 'notes-hint', text: 'Use version puts a historical copy in your draft. Save canvas checks the version you opened before replacing the saved file.' }));
        let chosen = null;
        let selectionVersion = 0;
        for (const item of result.history ?? []) content.append(button(`${formatTime(item.at)} (${item.reason})`, async () => {
            const ticket = ++selectionVersion;
            chosen = null;
            output.textContent = 'Loading the selected version...';
            const version = await app.request('/canvas/history/read', { notebookId: captured.scope.notebookId, canvasId: captured.canvas.id, historyId: item.id });
            if (!sameDocument(captured) || ticket !== selectionVersion || version?.status !== 'success') return;
            chosen = version.document;
            output.textContent = version.text;
        }, { className: 'notes-canvas-history-item' }));
        const output = h('pre', { class: 'notes-canvas-history-source', text: 'Choose a saved version.' });
        content.append(output);
        const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('../popup.js');
        if (!sameDocument(captured)) return;
        const decision = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Use version', cancelButton: 'Not now',
            onClosing: popup => popup.result !== POPUP_RESULT.AFFIRMATIVE || Boolean(chosen && sameDocument(captured)) });
        if (decision === POPUP_RESULT.AFFIRMATIVE && chosen && sameDocument(captured)) apply(chosen);
    }

    async function recoveryAction(warning, action) {
        const captured = scope;
        const result = await app.request('/canvas/recovery/decide', { notebookId: captured.notebookId, operationId: newOperationId('canvas-recovery'),
            recoveryOperationId: warning.operationId, action });
        if (!usable(captured)) return;
        notice = result?.status === 'success' ? action === 'save_copy' ? 'The interrupted canvas was saved as a separate copy.' : 'The interrupted save was discarded. The current file was not changed.'
            : result?.message || 'The recovery choice could not be saved. Try again.';
        await refreshGallery();
    }

    function render() {
        if (!usable()) return;
        const captured = operationSnapshot();
        const current = () => sameDocument(captured);
        clear(container);
        container.append(h('div', { class: 'notes-canvas-header' }, h('h2', { text: 'Planning canvases' }),
            button('Back to note', () => { if (current() && view.canLeave()) app.closeNotebookView(); }),
            button('New canvas', () => { if (current()) void createNew(); }, { disabled: saving }),
            button('Refresh files', () => { if (current()) void refreshGallery(); })));
        container.append(h('p', { class: 'notes-hint', text: 'Portable .canvas files live in this notebook. Cards do not change note access or publish lore. Background images and plugins are not run.' }));
        const gallery = h('details', { class: 'notes-canvas-files' }, h('summary', { text: `Canvases in this notebook (${canvases.length})` }));
        const files = h('div', { class: 'notes-canvas-file-list' });
        for (const item of canvases) files.append(button(item.path, () => { if (usable(captured.scope)) void selectCanvas(item.id); }, { pressed: canvas?.id === item.id, className: 'notes-canvas-file' }));
        gallery.append(files);
        container.append(gallery);
        for (const warning of warnings) container.append(h('div', { class: 'notes-notice notes-canvas-recovery' },
            h('p', { text: warning.message || 'An interrupted save could not replace this file. The recovery copy is kept.' }),
            button('Save recovery as copy', () => void recoveryAction(warning, 'save_copy')),
            button('Discard interrupted save', () => void recoveryAction(warning, 'discard'))));
        if (notice) container.append(h('p', { class: 'notes-notice', role: 'status', text: notice }));
        if (!canvas || !document) {
            container.append(h('p', { class: 'notes-hint', text: canvases.length ? 'Choose a .canvas file to open it.' : 'Create a canvas, or import a notebook ZIP containing .canvas files.' }));
            for (const item of canvases) container.append(h('a', { class: 'notes-button notes-canvas-download-original', href: attachmentUrl(scope.notebookId, item.path), download: item.path.split('/').at(-1), text: `Download original: ${item.path}` }));
            return;
        }
        container.append(h('h3', { class: 'notes-canvas-title', text: canvas.path }), h('p', { class: 'notes-hint', 'data-canvas-status': '', text: saving ? 'Saving canvas...' : conflict ? 'Needs your choice' : dirty ? draftSafe ? 'Draft saved on this device. Not saved to the notebook yet.' : 'Draft is only in this window.' : 'Saved canvas' }));
        if (staleDraft) container.append(h('div', { class: 'notes-notice notes-canvas-draft-conflict' },
            h('p', { text: 'This device has an older canvas draft. Keep it as a copy, use it deliberately, or discard it; the saved canvas stays unchanged until you save.' }),
            button('Use device draft', () => { if (current()) { const draft = staleDraft; staleDraft = null; apply(draft.document); } }),
            button('Save device draft as copy', () => { if (current()) void saveCopy(staleDraft.document, `${canvas.title} (device draft)`); }),
            button('Discard device draft', () => { if (current()) { clearCanvasDraft(scope.account, scope.notebookId, canvas.id); staleDraft = null; render(); } })));
        if (conflict) container.append(h('div', { class: 'notes-notice notes-canvas-save-conflict' }, h('p', { text: 'Nothing was overwritten. Choose which version to keep.' }),
            button('Use saved canvas', () => { if (current()) void useSaved(); }),
            button('Save my canvas as copy', () => { if (current()) void saveCopy(); }),
            button('Keep my version', () => { if (current()) void keepMine(); })));
        const actions = h('div', { class: 'notes-canvas-actions' }, button('Save canvas', () => void save(), { disabled: saving || conflict || !dirty, className: 'notes-primary' }),
            button('Download canvas', () => {
                if (!current()) return;
                try {
                    downloadCanvas(document, canvas.title);
                    downloadedVersion = documentVersion;
                    confirmedDownloadVersion = -1;
                    render();
                } catch (error) { notice = error.message; render(); }
            }), button('Canvas history', () => void history()),
            button('Undo canvas change', () => { if (current() && undo.length && !saving) { redo.push(JSON.stringify(document)); apply(JSON.parse(undo.pop()), { history: false }); } }, { disabled: !undo.length || saving }),
            button('Redo canvas change', () => { if (current() && redo.length && !saving) { undo.push(JSON.stringify(document)); apply(JSON.parse(redo.pop()), { history: false }); } }, { disabled: !redo.length || saving }));
        for (const [type, label] of [['text', 'Add text card'], ['file', 'Add note card'], ['link', 'Add web link'], ['group', 'Add group']]) actions.append(button(label, () => void addCard(type), { disabled: saving || (document.nodes?.length ?? 0) >= CANVAS_LIMITS.nodes }));
        actions.append(button('Add connection', () => void edgeEditor(), { disabled: saving || (document.nodes?.length ?? 0) < 2 }));
        if (dirty && !draftSafe && downloadedVersion === documentVersion && confirmedDownloadVersion !== documentVersion) {
            actions.append(button('I\'ve saved the download', () => {
                if (!current()) return;
                confirmedDownloadVersion = documentVersion;
                notice = 'You confirmed a downloaded copy. The notebook version has not changed.';
                render();
            }));
        }
        container.append(actions, h('div', { class: 'notes-canvas-views', role: 'group', 'aria-label': 'Canvas view' },
            button('Board', () => { if (current()) { mode = 'board'; render(); } }, { pressed: mode === 'board' }),
            button('Card list', () => { if (current()) { mode = 'list'; render(); } }, { pressed: mode === 'list' }),
            button('Move cards', () => { if (current() && !saving) { move = !move; render(); } }, { pressed: move, disabled: saving })));
        if (mode === 'board') {
            const stage = h('div', { class: 'notes-canvas-stage' });
            stage.append(canvasDiagram(localPreview(), preview?.edges ?? document.edges ?? [], { selectedId, move: move && !saving,
                viewportWidth: Math.max(1, (container.clientWidth ?? 720) - 32), current,
                onSelect: id => { selectedId = id; render(); }, onMove: (id, x, y) => change([{ type: 'update-node', id, set: { x, y } }]) }));
            container.append(stage, h('p', { class: 'notes-hint', text: 'Select a card, or turn on Move cards before dragging. The card list and Edit card controls work with touch or keyboard.' }));
        }
        if (preview?.limited && Object.values(preview.limited).some(Boolean)) container.append(h('p', { class: 'notes-notice', text: 'This large canvas has a limited preview. All cards, connections and unknown fields stay in the file.' }));
        const list = h('div', { class: 'notes-canvas-card-list', 'aria-label': 'Canvas cards' });
        for (const node of document.nodes ?? []) {
            const item = h('section', { class: `notes-canvas-card ${node.id === selectedId ? 'is-selected' : ''}`, 'data-canvas-card': node.id });
            item.append(button(nodeLabel(node), () => { if (current()) { selectedId = node.id; render(); } }, { pressed: selectedId === node.id, className: 'notes-canvas-card-select' }));
            const body = node.type === 'text' ? node.text.slice(0, 1200) : preview?.nodes?.find(data => data.id === node.id)?.excerpt;
            if (body) item.append(h('pre', { class: 'notes-canvas-excerpt', text: body }));
            const metadata = preview?.nodes?.find(data => data.id === node.id);
            const controls = h('div', { class: 'notes-canvas-card-controls' }, button('Edit card', () => { if (current()) void editNode(node.id); }, { disabled: saving }),
                button('Remove card', () => { if (current()) change([{ type: 'remove-node', id: node.id }]); }, { disabled: saving }));
            if (node.type === 'file' && metadata?.noteId) controls.append(button('Open note', () => { if (current() && view.canLeave()) void app.openNote(scope.notebookId, metadata.noteId, { pushBack: true, fragment: metadata.fragment }); }));
            if (node.type === 'link' && metadata?.url) controls.append(h('a', { class: 'menu_button notes-button', href: metadata.url, target: '_blank', rel: 'noopener noreferrer nofollow', referrerpolicy: 'no-referrer', text: 'Open web address' }));
            item.append(controls, h('p', { class: 'notes-hint', text: `Position ${node.x}, ${node.y}. Size ${node.width} × ${node.height}.` }));
            list.append(item);
        }
        container.append(list);
        if (document.edges?.length) {
            const connections = h('div', { class: 'notes-canvas-connections' }, h('h3', { text: 'Connections' }));
            for (const edge of document.edges) connections.append(h('div', { class: 'notes-canvas-connection' }, h('span', { text: edge.label || 'Connection' }),
                button('Edit connection', () => { if (current()) void edgeEditor(edge); }, { disabled: saving }),
                button('Remove connection', () => { if (current()) change([{ type: 'remove-edge', id: edge.id }]); }, { disabled: saving })));
            container.append(connections);
        }
    }

    const view = {
        async open() {
            scope = { account: app.state.account, notebookId: app.state.notebookId, workspaceVersion: app.state.workspaceVersion,
                notebookSelectionVersion: app.state.notebookSelectionVersion, noteRequestVersion: app.state.noteRequestVersion };
            if (!(await refreshGallery({ renderResult: false }))) { render(); return; }
            if (canvas && dirty) { render(); void refreshPreview(); return; }
            const id = canvas?.id ?? app.readPrefs().canvases?.[scope.notebookId] ?? canvases[0]?.id;
            if (id && canvases.some(item => item.id === id)) await selectCanvas(id);
            else render();
        },
        canLeave() {
            if (saving) { app.toast('The canvas is still saving. Wait for the result before switching.', 'warning'); return false; }
            if (dirty && !draftSafe && confirmedDownloadVersion !== documentVersion) { app.toast('Save or download your canvas draft before leaving. This browser could not keep it.', 'warning'); return false; }
            return true;
        },
        clear() {
            requestVersion++;
            galleryVersion++;
            previewVersion++;
            scope = null;
            canvas = document = savedDocument = preview = staleDraft = null;
            canvases = warnings = [];
            dirty = conflict = saving = false;
            downloadedVersion = confirmedDownloadVersion = -1;
            pending = null;
            undo.length = redo.length = 0;
            clear(container);
        },
    };
    return view;
}
