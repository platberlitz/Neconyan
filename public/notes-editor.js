/* This entry is compiled separately and is fetched only when Notes is opened. */
/* Third-party notices are shipped in notes-editor.LICENSE.txt. */
import { EditorSelection, EditorState, RangeSet, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { codeFolding, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import { headingSections, topLevelSections } from './scripts/notebooks/folding.js';
import { continueList, indentLines } from './scripts/notebooks/list-editing.js';

const headingCache = new WeakMap();

export function editorHeadings(state) {
    let headings = headingCache.get(state.doc);
    if (!headings) {
        headings = headingSections(state.doc.toString());
        headingCache.set(state.doc, headings);
    }
    return headings;
}

export function foldedHeadingKeys(state) {
    const positions = new Set();
    foldedRanges(state).between(0, state.doc.length, from => positions.add(from));
    return editorHeadings(state).filter(heading => positions.has(heading.from)).map(heading => heading.key);
}

/** Effects hide text only; they never carry document changes or a new selection. */
export function headingFoldTransaction(state, keys) {
    const wanted = new Set(keys);
    const effects = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => effects.push(unfoldEffect.of({ from, to })));
    for (const heading of editorHeadings(state)) {
        if (wanted.has(heading.key) && heading.to > heading.from) effects.push(foldEffect.of({ from: heading.from, to: heading.to }));
    }
    return { effects, annotations: Transaction.addToHistory.of(false) };
}

/** Browser input must see the original insertion point, not a folded widget boundary. */
export function revealFoldedSelectionTransaction(state) {
    const { from: start, to: end } = state.selection.main;
    const effects = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
        if (start <= to && end >= from) effects.push(unfoldEffect.of({ from, to }));
    });
    return effects.length ? { effects, annotations: Transaction.addToHistory.of(false) } : null;
}

/** A textarea-compatible interface keeps saving, recovery and selection tools on the same document. */
export function createNotesEditor(parent, options = {}) {
    let documentKey = null;
    let loading = false;
    let composing = false;
    function revealSelection(view) {
        const transaction = revealFoldedSelectionTransaction(view.state);
        if (transaction) view.dispatch(transaction);
    }
    function applyEdit(edit) {
        if (!edit || composing || view.composing) return false;
        view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: edit.selection,
            annotations: isolateHistory.of('full'), userEvent: 'input.list', scrollIntoView: true });
        return true;
    }
    function listCommand(view, action) {
        if (composing || view.composing) return false;
        const selection = view.state.selection.main;
        return applyEdit(action(view.state.doc.toString(), selection.from, selection.to));
    }
    const extensions = [
        history(),
        keymap.of([
            { key: 'Enter', run: view => listCommand(view, continueList) },
            { key: 'Tab', run: view => listCommand(view, (text, from, to) => indentLines(text, from, to, false, { listsOnly: true })),
                shift: view => listCommand(view, (text, from, to) => indentLines(text, from, to, true, { listsOnly: true })) },
        ]),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        EditorView.lineWrapping,
        EditorState.tabSize.of(4),
        EditorView.contentAttributes.of({ 'aria-label': 'Note text (Markdown)', spellcheck: 'true', autocapitalize: 'sentences' }),
        codeFolding({
            preparePlaceholder: (state, range) => editorHeadings(state).find(heading => heading.from === range.from)?.text ?? 'Section',
            placeholderDOM: (view, onclick, title) => {
                const control = parent.ownerDocument.createElement('button');
                control.type = 'button';
                control.className = 'menu_button notes-button notes-fold-placeholder';
                control.textContent = 'Show section';
                control.setAttribute('aria-label', `Show ${title || 'section'}`);
                control.setAttribute('aria-expanded', 'false');
                control.addEventListener('mousedown', event => event.preventDefault());
                control.addEventListener('click', event => {
                    if (!composing && !view.composing) onclick(event);
                });
                return control;
            },
        }),
        EditorView.updateListener.of(update => {
            if (loading) return;
            if (update.docChanged) options.onChange?.();
            if (update.selectionSet) options.onSelect?.();
            if (update.docChanged || !RangeSet.eq([foldedRanges(update.startState)], [foldedRanges(update.state)])) {
                options.onFolds?.(foldedHeadingKeys(update.state));
            }
        }),
        EditorView.domEventHandlers({
            keydown(event, view) {
                if (event.isComposing || event.keyCode === 229 || composing || view.composing) return false;
                options.onKeyDown?.(event);
                return event.defaultPrevented;
            },
            blur() { options.onBlur?.(); },
            focus(event, view) { revealSelection(view); },
            beforeinput(event, view) {
                revealSelection(view);
                if (!event.isComposing && ['insertParagraph', 'insertLineBreak'].includes(event.inputType) && listCommand(view, continueList)) {
                    event.preventDefault();
                    return true;
                }
                return false;
            },
            scroll() { options.onScroll?.(); },
            compositionstart(event, view) {
                revealSelection(view);
                composing = true;
                options.onComposition?.(true);
            },
            compositionend() {
                composing = false;
                setTimeout(() => options.onComposition?.(false), 20);
            },
        }),
    ];
    const view = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent });

    function setDocument(text, key = documentKey, folds = [], { force = false } = {}) {
        const next = String(text ?? '').replace(/\r\n?/g, '\n');
        if (!force && key === documentKey && next === view.state.doc.toString()) return true;
        if (!force && (composing || view.composing)) return false;
        if (force) composing = false;
        const selection = key === documentKey ? view.state.selection.main : EditorSelection.cursor(0);
        loading = true;
        try {
            documentKey = key;
            view.setState(EditorState.create({ doc: next, selection: { anchor: Math.min(selection.anchor, next.length), head: Math.min(selection.head, next.length) }, extensions }));
            if (folds.length) view.dispatch(headingFoldTransaction(view.state, folds));
        } finally {
            loading = false;
        }
        return true;
    }

    function setFolds(keys) {
        if (composing || view.composing) return false;
        view.dispatch(headingFoldTransaction(view.state, keys));
        return true;
    }

    function replace(text, from = view.state.selection.main.from, to = view.state.selection.main.to, mode = 'end') {
        const insert = String(text ?? '');
        const selection = mode === 'select' ? { anchor: from, head: from + insert.length } : { anchor: from + insert.length };
        view.dispatch({ changes: { from, to, insert }, selection, userEvent: 'input', scrollIntoView: true });
    }

    const adapter = {
        get value() { return view.state.doc.toString(); },
        set value(text) { setDocument(text); },
        get selectionStart() { return view.state.selection.main.from; },
        get selectionEnd() { return view.state.selection.main.to; },
        get selectionDirection() { return view.state.selection.main.anchor > view.state.selection.main.head ? 'backward' : 'forward'; },
        get scrollTop() { return view.scrollDOM.scrollTop; },
        set scrollTop(value) { view.scrollDOM.scrollTop = value; },
        get hidden() { return parent.hidden; },
        set hidden(value) { parent.hidden = value; if (!value) view.requestMeasure(); },
        get isConnected() { return parent.isConnected; },
        get element() { return view.contentDOM; },
        focus() { view.focus(); },
        setSelectionRange(start, end, direction = 'forward') {
            const length = view.state.doc.length;
            const from = Math.max(0, Math.min(start, length));
            const to = Math.max(from, Math.min(end, length));
            view.dispatch({ selection: { anchor: direction === 'backward' ? to : from, head: direction === 'backward' ? from : to }, annotations: Transaction.addToHistory.of(false) });
        },
        setRangeText: replace,
        insertText: text => replace(text),
        applyEdit,
        scrollToOffset: offset => view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(offset, view.state.doc.length)), { y: 'center' }), annotations: Transaction.addToHistory.of(false) }),
        setAttribute: (name, value) => view.contentDOM.setAttribute(name, value),
        removeAttribute: name => view.contentDOM.removeAttribute(name),
    };

    return {
        view, adapter, setDocument, setFolds,
        get composing() { return composing || view.composing; },
        headings: () => editorHeadings(view.state),
        folds: () => foldedHeadingKeys(view.state),
        toggle(key) {
            const folds = new Set(foldedHeadingKeys(view.state));
            if (folds.has(key)) folds.delete(key);
            else folds.add(key);
            return setFolds([...folds]);
        },
        foldAll: () => setFolds(topLevelSections(editorHeadings(view.state)).map(heading => heading.key)),
        showAll: () => setFolds([]),
        destroy: () => view.destroy(),
    };
}
