import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test, jest } from '@jest/globals';
import { setButtonPressed } from '../public/scripts/notebooks/dom.js';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const buttonSource = source.match(/export function button\([\s\S]*?\n\}/)[0].replace('export ', '');

function makeButton(className, pressed = null) {
    const h = (tag, attributes) => ({ tag, attributes, children: [], append(child) { this.children.push(child); }, setAttribute(key, value) { this.attributes[key] = value; } });
    const button = vm.runInNewContext(`${buttonSource}; button`, { h });
    const onClick = jest.fn();
    const element = button('New note', onClick, { icon: 'fa-file-circle-plus', className, pressed });
    element.classList = {
        contains: name => element.attributes.class.split(/\s+/).includes(name),
        toggle(name, active) {
            const classes = new Set(element.attributes.class.split(/\s+/));
            if (active) classes.add(name); else classes.delete(name);
            element.attributes.class = [...classes].join(' ');
        },
    };
    return { element, onClick };
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

    test('selected tabs and AI access choices use the native primary colour pair', () => {
        const { element } = makeButton('notes-choice', true);
        expect(element.attributes['aria-pressed']).toBe('true');
        expect(element.classList.contains('menu_button_primary')).toBe(true);
        expect(makeButton('notes-choice', false).element.classList.contains('menu_button_primary')).toBe(false);
    });

    test('changing a choice updates its colour role together with its selected state', () => {
        const { element } = makeButton('notes-choice', true);
        setButtonPressed(element, false);
        expect(element.attributes['aria-pressed']).toBe('false');
        expect(element.classList.contains('menu_button_primary')).toBe(false);
        setButtonPressed(element, true);
        expect(element.attributes['aria-pressed']).toBe('true');
        expect(element.classList.contains('menu_button_primary')).toBe(true);
    });

    test('choice rows move the selected state and colour to the clicked choice', () => {
        const choiceRowSource = source.match(/export function choiceRow\([\s\S]*?\n\}/)[0].replace('export ', '');
        const h = (tag, attributes, ...children) => ({ tag, attributes, children, append(child) { this.children.push(child); } });
        const buttons = [];
        const button = (text, onClick, { pressed }) => {
            const element = makeButton('notes-choice', pressed).element;
            element.text = text;
            element.click = () => onClick();
            buttons.push(element);
            return element;
        };
        const choiceRow = vm.runInNewContext(`${choiceRowSource}; choiceRow`, { h, button, setButtonPressed });
        const onChoose = jest.fn();
        const group = choiceRow('Start from', [['blank', 'Blank note'], ['location', 'Location'], ['scene', 'Scene plan']], 'blank', onChoose);
        expect(group.children[1].children).toEqual(buttons);
        buttons[1].click();
        expect(onChoose).toHaveBeenCalledWith('location');
        expect(buttons.map(element => element.attributes['aria-pressed'])).toEqual(['false', 'true', 'false']);
        expect(buttons.map(element => element.classList.contains('menu_button_primary'))).toEqual([false, true, false]);
        buttons[2].click();
        expect(buttons.map(element => element.attributes['aria-pressed'])).toEqual(['false', 'false', 'true']);
    });

    test('choice rows mark a user-written choice so the localiser leaves it as written', () => {
        const choiceRowSource = source.match(/export function choiceRow\([\s\S]*?\n\}/)[0].replace('export ', '');
        const h = (tag, attributes, ...children) => ({ tag, attributes, children, append(child) { this.children.push(child); }, setAttribute(key, value) { this.attributes[key] = value; } });
        const choiceRow = vm.runInNewContext(`${buttonSource}; ${choiceRowSource}; choiceRow`, { h, setButtonPressed });
        const group = choiceRow('Start from', [['blank', 'Blank note'], ['mine', 'Blank note', true]], 'blank', jest.fn());
        const [builtIn, written] = group.children[1].children;
        expect(written.attributes['data-i18n-ignore']).toBe('');
        expect(builtIn.attributes['data-i18n-ignore']).toBeNull();
    });

    test('changing a primary action keeps its native colour role even when it is not pressed', () => {
        const { element } = makeButton('notes-primary', true);
        setButtonPressed(element, false);
        expect(element.classList.contains('menu_button_primary')).toBe(true);
    });
});
