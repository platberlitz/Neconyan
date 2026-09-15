import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const method = source.match(/function syncNeconyanSectionSelect\([\s\S]*?^}/m)[0];

describe('compact character navigation', () => {
    test('uses existing tab actions and stays synchronized without rebuilding stable options', () => {
        class HTMLElement {}
        class HTMLSelectElement extends HTMLElement {
            options = [];
            value = '';
            replacements = 0;
            addEventListener(_event, handler) { this.change = handler; }
            replaceChildren(...options) { this.options = options; this.replacements++; }
        }
        let active = 'library';
        const buttons = ['library', 'editor'].map(value => ({
            value, hidden: false, disabled: false,
            querySelector: () => ({ textContent: value }),
            getAttribute: name => name === 'data-tab' ? value : name === 'aria-selected' ? String(active === value) : null,
            click: () => { active = value; },
        }));
        const nav = new HTMLElement();
        const parent = { querySelector: () => parent.select, insertBefore: select => { parent.select = select; } };
        nav.parentElement = parent;
        nav.querySelectorAll = () => buttons;
        const context = vm.createContext({
            HTMLElement, HTMLSelectElement,
            document: { body: { classList: { contains: () => true } } },
            createElement: (tag, options) => tag === 'select' ? new HTMLSelectElement() : { value: options.attrs.value, textContent: options.text, disabled: false },
        });
        vm.runInContext(method, context);
        context.syncNeconyanSectionSelect(nav, 'data-tab', 'Section');
        const select = parent.select;
        expect(select.value).toBe('library');
        expect(select.options.map(option => option.value)).toEqual(['library', 'editor']);
        select.value = 'editor';
        select.change();
        expect(active).toBe('editor');
        context.syncNeconyanSectionSelect(nav, 'data-tab', 'Section');
        expect(parent.select).toBe(select);
        expect(select.replacements).toBe(1);
        active = 'library';
        context.syncNeconyanSectionSelect(nav, 'data-tab', 'Section');
        expect(select.value).toBe('library');
        buttons[1].disabled = true;
        context.syncNeconyanSectionSelect(nav, 'data-tab', 'Section');
        expect(select.options[1].disabled).toBe(true);
    });
    test('normalizes the old horizontal preference to the vertical workspace design', () => {
        const normalize = source.match(/function normalizeMobileNavLayout\([\s\S]*?}/)[0];
        const context = vm.createContext({});
        vm.runInContext(normalize, context);
        expect(context.normalizeMobileNavLayout('horizontal')).toBe('vertical');
        expect(context.normalizeMobileNavLayout()).toBe('vertical');
    });
});
