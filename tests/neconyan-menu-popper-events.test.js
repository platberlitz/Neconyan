import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const core = read('script.js');
const extensions = read('scripts/extensions.js');

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'start' || key === 'end' || key === 'loc') continue;
        walk(value, visit);
    }
}

function createPopperCalls(source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = [];
    walk(ast, node => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier'
            || callee.object.name !== 'Popper' || callee.property.name !== 'createPopper') return;
        calls.push(node);
    });
    return calls;
}

function eventListenersDisabled(call) {
    const options = call.arguments[2];
    expect(options?.type).toBe('ObjectExpression');
    const property = options.properties.find(entry => entry.key?.name === 'modifiers');
    expect(property).toBeDefined();
    if (property.value.type === 'Identifier') {
        expect(property.value.name).toBe('CLOSED_MENU_POPPER_MODIFIERS');
        return true;
    }
    expect(property.value.type).toBe('ArrayExpression');
    const modifier = property.value.elements[0];
    expect(modifier.type).toBe('ObjectExpression');
    const enabled = modifier.properties.find(entry => entry.key?.name === 'enabled');
    return enabled.value.value === false;
}

describe('closed menu Popper listeners', () => {
    test('all three permanent menus start without viewport listeners', () => {
        const calls = [...createPopperCalls(core), ...createPopperCalls(extensions)];
        expect(calls).toHaveLength(3);
        expect(calls.map(eventListenersDisabled)).toEqual([true, true, true]);
    });

    test('the shared helper changes only the listener option and tolerates missing poppers', () => {
        const start = core.indexOf('export function setPopperEvents');
        const end = core.indexOf('// Assigned by the options menu setup');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const context = vm.createContext({});
        vm.runInContext(core.slice(start, end).replace(/^export /gm, ''), context);

        const popper = { setOptions: jest.fn() };
        context.setPopperEvents(popper, true);
        expect(popper.setOptions).toHaveBeenLastCalledWith({ modifiers: [{ name: 'eventListeners', enabled: true }] });
        context.setPopperEvents(popper, false);
        expect(popper.setOptions).toHaveBeenLastCalledWith({ modifiers: [{ name: 'eventListeners', enabled: false }] });
        expect(() => context.setPopperEvents(null, true)).not.toThrow();
        expect(() => context.setPopperEvents({}, true)).not.toThrow();
    });

    test('options and export enable on open and disable on every close path', () => {
        const menuSource = core.slice(core.indexOf('let optionsMenuEventsEnabled'), core.indexOf('function isMouseOverButtonOrMenu'));
        expect(menuSource.indexOf('setOptionsMenuEvents(true)')).toBeLessThan(menuSource.indexOf('optionsPopper.update();'));
        expect(menuSource).toContain('setOptionsMenuEvents(false);');
        expect(menuSource).toContain('setPopperEvents(optionsPopper, enabled);');
        expect(menuSource).toContain('optionsMenuState = { show: showMenu, hide: hideMenu };');
        // Legacy chat tools hide the menu without calling hideMenu.
        expect(menuSource).toContain('new MutationObserver');
        expect(menuSource).toContain('optionsMenuNode.style.display !== \'none\'');

        // Deleting and renaming chats close the menu outside its own button.
        expect(core.match(/closeOptionsMenu\(true\)/g)).toHaveLength(3);
        expect(core).not.toContain('$(\'#options\').hide()');

        const exportSource = core.slice(core.indexOf('function setExportPopupOpen'), core.indexOf('// Saved here for performance reasons'));
        expect(exportSource).toContain('$(\'#export_format_popup\').toggle(isExportPopupOpen);');
        expect(exportSource).toContain('setPopperEvents(exportPopper, isExportPopupOpen);');
        expect(exportSource).toContain('exportPopper.update();');
        expect(core.match(/setExportPopupOpen\(/g)).toHaveLength(4);
    });

    test('the wand menu funnels its button and click-away closes through one transition', () => {
        const menuStart = extensions.indexOf('const setPopperEvents = enabled');
        const menuEnd = extensions.indexOf('function notifyUpdatesInputHandler');
        const menuSource = extensions.slice(menuStart, menuEnd);
        expect(menuSource).toContain('popper.setOptions({ modifiers: [{ name: \'eventListeners\', enabled: Boolean(enabled) }] });');
        expect(menuSource).toContain('setPopperEvents(visible);');
        expect(menuSource).toContain('setDropdownVisible(!isDropdownVisible);');
        expect(menuSource).toContain('setDropdownVisible(false);');
        expect(menuSource.match(/setUiVisibility\(dropdown\.get\(0\), false/g)).toHaveLength(1);
    });
});
