import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/swipe-picker.js', import.meta.url), 'utf8');
const menusCss = readFileSync(new URL('../public/css/neconyan-menus.css', import.meta.url), 'utf8');
const styleCss = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const pickerCss = menusCss.slice(menusCss.indexOf('/* Swipe picker'));

function cssBlock(css, selector) {
    const start = css.indexOf(`${selector} {`);
    if (start === -1) return '';
    return css.slice(start, css.indexOf('}', start) + 1);
}

function createElementStub(tag) {
    return {
        tag, attributes: {}, children: [], textContent: '', title: '', type: '',
        classList: { values: [], add(...names) { this.values.push(...names); } },
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { this.children.push(...children); },
    };
}

function createSwipeAction(...args) {
    const start = source.indexOf('function createSwipeAction(');
    const helper = source.slice(start, source.indexOf('\n}\n', start) + 2);
    const context = vm.createContext({ document: { createElement: createElementStub } });
    vm.runInContext(helper, context);
    return context.createSwipeAction(...args);
}

describe('swipe picker cards', () => {
    test('actions are real labelled buttons with a decorative icon', () => {
        const button = createSwipeAction('swipe_picker_copy', 'fa-solid fa-copy', 'Copy', 'Copy this swipe');
        expect(button.tag).toBe('button');
        expect(button.type).toBe('button');
        expect(button.title).toBe('Copy this swipe');
        expect(button.classList.values).toEqual(['swipe_picker_action', 'swipe_picker_copy']);
        const [icon, label] = button.children;
        expect(icon.classList.values).toEqual(['fa-fw', 'fa-solid', 'fa-copy']);
        expect(icon.attributes['aria-hidden']).toBe('true');
        expect(label.classList.values).toEqual(['swipe_picker_action_label']);
        expect(label.textContent).toBe('Copy');
    });

    test('cards are built directly, not cloned from the chat file list', () => {
        expect(source).not.toContain('#past_chat_template');
        expect(source).not.toContain('PastChat_cross');
        expect(source).not.toContain('JSONL');
        for (const action of ['swipe_picker_expand', 'swipe_picker_copy', 'swipe_picker_branch', 'swipe_picker_delete']) {
            expect(source).toContain(`'${action}'`);
        }
    });

    test('the picker has no swipe number field that would raise a phone keyboard', () => {
        expect(source).not.toContain('customInputs');
        expect(source).not.toMatch(/swipeIdInput/);
    });

    test('the confirm button names the swipe it will show and keeps that label', () => {
        expect(source).toContain('t`Show swipe #${');
        expect(source).toContain('t`Keep swipe #${');
        expect(source).toContain('delete popup.okButton.dataset.i18n');
    });

    test('deleting from the picker still offers Undo', () => {
        expect(source).toMatch(/deleteSwipe\(index, messageId, \{[\s\S]*?offerUndo: true,[\s\S]*?onRestored:/);
    });
});

describe('swipe picker styles', () => {
    test('the old picker rules are gone from the blocking stylesheet', () => {
        expect(styleCss).not.toContain('swipe_picker');
    });

    test('colours come from the theme accent, never a fixed hex', () => {
        expect(pickerCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(cssBlock(pickerCss, '.swipe_picker_block[highlight]')).toContain('var(--neco-ginger)');
        expect(cssBlock(pickerCss, '.swipe_picker_badge')).toContain('color: var(--neco-on-accent)');
    });

    test('hover styles only apply to devices that can hover, so a tapped card does not stay grey', () => {
        const hoverStart = pickerCss.indexOf('@media (hover: hover)');
        expect(hoverStart).toBeGreaterThan(-1);
        const outsideHover = pickerCss.slice(0, hoverStart) + pickerCss.slice(pickerCss.indexOf('\n}\n', hoverStart));
        expect(outsideHover).not.toMatch(/:hover/);
    });

    test('phone action buttons meet the 44px touch target', () => {
        const phone = pickerCss.slice(pickerCss.indexOf('@media (max-width: 768px), (pointer: coarse)'));
        const minHeight = Number(cssBlock(phone, '.swipe_picker_action').match(/min-height: (\d+)px/)?.[1]);
        expect(minHeight).toBeGreaterThanOrEqual(44);
    });
});
