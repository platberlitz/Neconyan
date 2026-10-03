import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test, jest } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const buttonSource = source.match(/export function button\([\s\S]*?\n\}/)[0].replace('export ', '');

function makeButton(className) {
    const h = (tag, attributes) => ({ tag, attributes, children: [], append(child) { this.children.push(child); }, setAttribute(key, value) { this.attributes[key] = value; } });
    const button = vm.runInNewContext(`${buttonSource}; button`, { h });
    const onClick = jest.fn();
    return { element: button('New note', onClick, { icon: 'fa-file-circle-plus', className }), onClick };
}

describe('Notes button theme roles', () => {
    test('primary Notes actions opt into the native primary palette without losing their icon or action', () => {
        const { element, onClick } = makeButton('custom notes-primary');
        expect(element.attributes.class.split(/\s+/)).toContain('menu_button_primary');
        expect(element.children[0].attributes.class).toBe('fa-solid fa-file-circle-plus');
        expect(element.children[1].attributes.text).toBe('New note');
        element.attributes.onclick();
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    test.each(['notes-quiet', 'not-notes-primary', ''])('ordinary actions keep their existing role: %s', className => {
        expect(makeButton(className).element.attributes.class.split(/\s+/)).not.toContain('menu_button_primary');
    });
});
