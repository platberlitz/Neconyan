import { button, h } from './dom.js';
import { t } from '../i18n.js';

let nextOutline = 0;

/** Skipped heading levels still belong to their nearest preceding parent. */
export function headingTree(headings) {
    const roots = [];
    const parents = [];
    for (const heading of headings) {
        const node = { ...heading, children: [] };
        while (parents.length && parents.at(-1).level >= node.level) parents.pop();
        (parents.at(-1)?.children ?? roots).push(node);
        parents.push(node);
    }
    return roots;
}

export function renderHeadingOutline(headings, { onJump, collapsed = new Set() } = {}) {
    const prefix = `notes-outline-${++nextOutline}`;
    function list(nodes, depth = 0) {
        const root = h('ul', { class: `notes-outline-list notes-outline-tree${depth ? ' notes-outline-children' : ''}` });
        for (const node of nodes) {
            const key = node.key ?? `${node.level}:${node.offset}:${node.text}`;
            const row = h('div', { class: 'notes-outline-row' });
            const item = h('li', { class: 'notes-outline-node' }, row);
            if (node.children.length) {
                const children = list(node.children, depth + 1);
                children.id = `${prefix}-${node.offset}`;
                let control;
                function update() {
                    const hidden = collapsed.has(key);
                    children.hidden = hidden;
                    control.setAttribute('aria-expanded', String(!hidden));
                    const label = hidden ? t`Show subsections of ${node.text}` : t`Hide subsections of ${node.text}`;
                    control.title = label;
                    control.setAttribute('aria-label', label);
                    control.querySelector('i').className = `fa-solid ${hidden ? 'fa-chevron-right' : 'fa-chevron-down'}`;
                }
                control = button('', () => {
                    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
                    update();
                }, { icon: 'fa-chevron-down', title: 'Hide subsections', className: 'notes-outline-toggle', userText: true });
                control.setAttribute('aria-controls', children.id);
                update();
                row.append(control);
                item.append(children);
            } else row.append(h('span', { class: 'notes-outline-spacer', 'aria-hidden': 'true' }));
            row.append(button(node.text || '(untitled heading)', () => onJump?.(node.offset),
                { className: 'notes-outline-item notes-quiet', userText: Boolean(node.text) }));
            root.append(item);
        }
        return root;
    }
    return list(headingTree(headings));
}
