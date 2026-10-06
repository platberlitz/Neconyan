import { expect, jest, test } from '@jest/globals';

class Element {
    constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = { ...attrs }; this.children = children.flat().filter(Boolean); this.hidden = false; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attrs[key] = value; }
    querySelector(tag) { return this.children.find(child => child.tag === tag); }
}
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({
    h: (tag, attrs, ...children) => new Element(tag, attrs, ...children),
    button: (label, onclick, options) => {
        const node = new Element('button', { text: label, ...options }, new Element('i'));
        node.click = onclick;
        return node;
    },
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, i) => text + part + (values[i] ?? ''), '') }));
const { headingTree, renderHeadingOutline } = await import('../public/scripts/notebooks/outline.js');
const headings = [
    { text: 'Parent', level: 1, offset: 0 }, { text: 'Skipped level', level: 3, offset: 10 },
    { text: 'Child', level: 2, offset: 20 }, { text: 'Grandchild', level: 3, offset: 30 }, { text: 'Peer', level: 1, offset: 40 },
];

test('headings form a nested tree with independent peers and skipped levels', () => {
    const tree = headingTree(headings);
    expect(tree.map(item => item.text)).toEqual(['Parent', 'Peer']);
    expect(tree[0].children.map(item => item.text)).toEqual(['Skipped level', 'Child']);
    expect(tree[0].children[1].children[0].text).toBe('Grandchild');
    expect(headings[0]).not.toHaveProperty('children');
});

test('collapsing a parent affects presentation only and is restored on rerender', () => {
    const collapsed = new Set();
    const jump = jest.fn();
    const tree = renderHeadingOutline(headings, { collapsed, onJump: jump });
    const parent = tree.children[0];
    const toggle = parent.children[0].children[0];
    const children = parent.children[1];
    expect(toggle.attrs['aria-expanded']).toBe('true');
    expect(toggle.attrs['aria-controls']).toBe(children.id);
    toggle.click();
    expect(children.hidden).toBe(true);
    expect(toggle.attrs['aria-expanded']).toBe('false');
    expect(toggle.attrs['aria-label']).toBe('Show subsections of Parent');
    expect(renderHeadingOutline(headings, { collapsed }).children[0].children[1].hidden).toBe(true);
    parent.children[0].children[1].click();
    expect(jump).toHaveBeenCalledWith(0);
    expect(headings).toHaveLength(5);
});

test('user heading labels are passed as text, and repeated renders use unique controls', () => {
    const unsafe = [{ text: '<img src=x>', level: 1, offset: 0 }, { text: 'Child', level: 2, offset: 10 }];
    const first = renderHeadingOutline(unsafe);
    const second = renderHeadingOutline(unsafe);
    expect(first.children[0].children[0].children[1].attrs).toMatchObject({ text: '<img src=x>', userText: true });
    expect(first.children[0].children[1].id).not.toBe(second.children[0].children[1].id);
});
