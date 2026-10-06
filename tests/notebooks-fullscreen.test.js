import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];

function fixture() {
    const label = { textContent: '' };
    const icon = { className: '' };
    const fullscreen = { querySelector: selector => selector === 'span' ? label : icon, setAttribute: jest.fn() };
    const editor = { focus: jest.fn() };
    const app = { state: { open: true, note: { id: 'one' }, workspaceView: 'note', view: 'write', layout: 'beside', pane: 'note', writingFullscreen: false },
        elements: { fullscreen, textarea: editor }, sourceEditor: { composing: false } };
    const context = vm.createContext({ app, applyLayout: jest.fn() });
    vm.runInContext(`${extract('setWritingFullscreen')}\n${extract('onNotesKeydown')}`, context);
    return { app, context, label, icon, editor, fullscreen };
}

describe('Notes full-screen writing state', () => {
    test('keeps the same editor and the previous layout while updating the exit control', () => {
        const f = fixture();
        f.context.setWritingFullscreen(true);
        expect(f.app.state.writingFullscreen).toBe(true);
        expect(f.app.state.layout).toBe('beside');
        expect(f.app.elements.textarea).toBe(f.editor);
        expect(f.label.textContent).toBe('Exit full screen');
        expect(f.icon.className).toContain('fa-compress');
        f.context.setWritingFullscreen(false);
        expect(f.app.state.writingFullscreen).toBe(false);
        expect(f.label.textContent).toBe('Full screen');
        expect(f.editor.focus).toHaveBeenCalledTimes(2);
    });

    test.each(['write', 'read', 'outline'])('allows full screen in %s without changing the editor or layout', view => {
        const f = fixture();
        f.app.state.view = view;
        f.context.setWritingFullscreen(true);
        expect(f.app.state.writingFullscreen).toBe(true);
        expect(f.app.state.layout).toBe('beside');
        expect(f.app.elements.textarea).toBe(f.editor);
        expect(f.label.textContent).toBe('Exit full screen');
        expect(f.editor.focus).toHaveBeenCalledTimes(view === 'write' ? 1 : 0);
    });

    test.each([{ note: null }, { workspaceView: 'graph' }, { open: false }])('cannot enter without an open note workspace: %j', patch => {
        const f = fixture();
        Object.assign(f.app.state, patch);
        f.context.setWritingFullscreen(true);
        expect(f.app.state.writingFullscreen).toBe(false);
    });

    test('Escape exits, but an Escape consumed by suggestions or composing characters does not', () => {
        const f = fixture();
        f.context.setWritingFullscreen(true);
        const event = { key: 'Escape', defaultPrevented: true, isComposing: false, preventDefault: jest.fn() };
        f.context.onNotesKeydown(event);
        expect(f.app.state.writingFullscreen).toBe(true);
        event.defaultPrevented = false;
        event.isComposing = true;
        f.context.onNotesKeydown(event);
        expect(f.app.state.writingFullscreen).toBe(true);
        event.isComposing = false;
        f.context.onNotesKeydown(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(f.app.state.writingFullscreen).toBe(false);
    });
});
