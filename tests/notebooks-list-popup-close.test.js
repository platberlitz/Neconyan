import fs from 'node:fs';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, jest, test } from '@jest/globals';

const dialogs = fs.readFileSync(new URL('../public/scripts/notebooks/notes-dialogs.js', import.meta.url), 'utf8');
const dom = fs.readFileSync(new URL('../public/scripts/notebooks/dom.js', import.meta.url), 'utf8');
const popupTypes = fs.readFileSync(new URL('../public/scripts/popup.js', import.meta.url), 'utf8').match(/export const POPUP_TYPE = [^]*?\n};/)[0].replace(/^export /, '');
const extract = (text, name) => text.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');

function element(tag, attributes = {}, ...children) {
    return {
        tagName: tag.toUpperCase(), attributes, children: children.flat().filter(Boolean), textContent: attributes.text ?? '',
        onclick: attributes.onclick,
        append(...values) { this.children.push(...values.flat().filter(Boolean)); },
        setAttribute(key, value) { this.attributes[key] = String(value); },
    };
}
const all = node => [node, ...(node?.children ?? []).flatMap(all)];
const text = node => `${node.textContent ?? ''}${(node.children ?? []).map(text).join('')}`;

// The opening animation has not finished, so onOpen never runs during these tests.
function fixture() {
    const popups = [];
    class Popup {
        constructor(content, type, value, options) {
            Object.assign(this, { content, type, value, options });
            this.completeCancelled = jest.fn();
            this.completeAffirmative = jest.fn();
            popups.push(this);
        }
        show() { return new Promise(() => {}); }
    }
    const reviewProposal = jest.fn(async () => {});
    const request = jest.fn(async () => ({ status: 'success', proposals: [{ id: 'proposal-1', summary: { label: 'Add to note' }, createdAt: 1 }] }));
    const app = { state: { notebookId: 'first' }, request, failed: () => false };
    const context = vm.createContext({ app, Popup, h: element, reviewProposal, formatTime: value => String(value),
        proposalLabel: summary => summary.label, document: { body: element('body') },
        callGenericPopup: (content, type, value, options) => new Popup(content, type, value, options).show() });
    vm.runInContext(`${popupTypes}\n${extract(dom, 'button')}\n${extract(dialogs, 'listPopup')}\n${extract(dialogs, 'proposals')}\n${extract(dialogs, 'chooseNote')}`, context);
    const control = (popup, label) => all(popup.content).find(node => node.tagName === 'BUTTON' && text(node).includes(label));
    return { app, context, popups, reviewProposal, control };
}

test('Review closes the Assistant changes list even while it is still opening', async () => {
    const f = fixture();
    void f.context.proposals(f.app);
    await nextTurn();
    const [list] = f.popups;
    await f.control(list, 'Review').onclick();
    expect(list.completeCancelled).toHaveBeenCalledTimes(1);
    expect(f.reviewProposal).toHaveBeenCalledWith(f.app, 'proposal-1');
});

test('choosing a note closes the picker even while it is still opening', async () => {
    const f = fixture();
    void f.context.chooseNote(f.app, 'Pick one', [{ title: 'First', path: 'First.md' }]);
    const [picker] = f.popups;
    f.control(picker, 'First').onclick();
    expect(picker.completeAffirmative).toHaveBeenCalledTimes(1);
});
