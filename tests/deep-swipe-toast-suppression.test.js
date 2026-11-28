import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

// Deep Swipe hides the one 'Chat not saved' toast its own truncated save provokes. The extension is too large to load here, so the
// suppression code is cut out of its source as it stands and run against a toastr stand-in.
const source = fs.readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/deep-swipe.js', import.meta.url), 'utf8');
const body = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
const cut = name => {
    const found = body.find(row => row.id?.name === name || row.declarations?.some(item => item.id?.name === name));
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};
const pieces = ['truncationSaveToastHolds', 'filteredToastApis', 'isTruncationSaveMessage', 'installTruncationSaveToastFilter', 'suppressTruncationSaveToast'];

const TRUNCATION_SAVE = 'This save would have deleted messages, so the saved chat was left unchanged. Reload the page to bring it up to date.';

function load() {
    const shown = [];
    const toastr = { error: jest.fn((message, title) => { shown.push([message, title]); return { message }; }) };
    const host = { toastr, console: { debug: jest.fn() }, WeakSet };
    host.globalThis = host;
    vm.runInNewContext(`${pieces.map(cut).join('\n')}\nglobalThis.suppressTruncationSaveToast = suppressTruncationSaveToast;`, host);
    return { host, toastr, shown, suppress: host.suppressTruncationSaveToast };
}

describe('Deep Swipe save toast suppression', () => {
    test('overlapping runs keep the filter until the last one ends, in any order', () => {
        const { host, shown, suppress } = load();

        const releaseFirst = suppress();
        const filtered = host.toastr.error;
        const releaseSecond = suppress();
        expect(host.toastr.error).toBe(filtered);

        releaseFirst();
        host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        expect(shown).toEqual([]);

        releaseSecond();
        host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        expect(shown).toEqual([[TRUNCATION_SAVE, 'Chat not saved']]);
        expect(host.toastr.error).toBe(filtered);
    });

    test('a run that ends twice gives back only its own hold', () => {
        const { host, shown, suppress } = load();

        const releaseFirst = suppress();
        const releaseSecond = suppress();
        releaseFirst();
        releaseFirst();
        host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        expect(shown).toEqual([]);
        releaseSecond();
        host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        expect(shown).toHaveLength(1);
    });

    test('other errors always reach toastr, during a run and after it', () => {
        const { host, toastr, shown, suppress } = load();
        const original = toastr.error;

        const release = suppress();
        expect(host.toastr.error('Network down', 'Save failed')).toEqual({ message: 'Network down' });
        release();
        host.toastr.error('Network down', 'Save failed');
        expect(shown).toEqual([['Network down', 'Save failed'], ['Network down', 'Save failed']]);
        expect(original).toHaveBeenCalledTimes(2);
    });

    test('a wrapper added on top during a run stays in place after every run ends', () => {
        const { host, shown, suppress } = load();

        const releaseFirst = suppress();
        const seen = [];
        const filtered = host.toastr.error;
        const outer = function (message, title) {
            seen.push(message);
            return filtered.call(this, message, title);
        };
        host.toastr.error = outer;
        const releaseSecond = suppress();
        releaseFirst();
        releaseSecond();

        expect(host.toastr.error).toBe(outer);
        host.toastr.error('Network down', 'Save failed');
        expect(seen).toEqual(['Network down']);
        expect(shown).toEqual([['Network down', 'Save failed']]);
    });

    test('many runs started and ended out of order never leave the filter on or swallow a toast', () => {
        const { host, shown, suppress } = load();

        const releases = Array.from({ length: 8 }, () => suppress());
        for (const index of [3, 0, 7, 1, 6, 2, 5]) {
            releases[index]();
            host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        }
        expect(shown).toEqual([]);
        releases[4]();
        host.toastr.error(TRUNCATION_SAVE, 'Chat not saved');
        expect(shown).toHaveLength(1);
    });
});
