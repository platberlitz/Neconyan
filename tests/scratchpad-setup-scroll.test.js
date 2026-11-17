import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');
const show = source.slice(source.indexOf('function showContextSetups('), source.indexOf('async function saveContextSetup('));
const apply = source.slice(source.indexOf('async function applyContextSetup('), source.indexOf('async function deleteContextSetup('));

function fixture(saved = {}) {
    const focus = jest.fn();
    const renderContext = jest.fn();
    const success = jest.fn();
    const reportError = jest.fn();
    const runtime = vm.createContext({
        app: { open: true, contextSetup: 'Quiet replies', el: { panels: { context: { querySelector: () => ({ focus }) } } } },
        renderContext, toastr: { success }, reportError, structuredClone,
        findContextSetup: () => ({ settings: { depth: 9 } }),
        updateSettings: async () => saved,
        t: strings => strings[0],
    });
    vm.runInContext(`${show}\n${apply}`, runtime);
    return { runtime, focus, renderContext, success, reportError };
}

describe('Scratchpad Saved setup focus', () => {
    test('restores the setup control without scrolling after Save or Delete', () => {
        const { runtime, focus, renderContext } = fixture();
        runtime.showContextSetups('.scratchpad-setup-save');
        expect(renderContext).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('Apply restores focus without scrolling after a successful save', async () => {
        const { runtime, focus, success, reportError } = fixture();
        await runtime.applyContextSetup();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(success).toHaveBeenCalledTimes(1);
        expect(reportError).not.toHaveBeenCalled();
    });

    test('a refused Apply does not claim success or move focus', async () => {
        const { runtime, focus, success } = fixture(null);
        await runtime.applyContextSetup();
        expect(focus).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
    });
});
