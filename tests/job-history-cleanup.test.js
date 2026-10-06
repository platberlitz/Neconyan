/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

class FakeButton {
    constructor() {
        this.disabled = false;
        this.dataset = {};
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {
            toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
        };
        this.listeners = [];
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
}

const original = { document: globalThis.document, HTMLButtonElement: globalThis.HTMLButtonElement, toastr: globalThis.toastr };
let button;

describe('Clear job history button', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ clearJobHistory: jest.fn() }));
        jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: { show: { confirm: jest.fn() } }, POPUP_RESULT: { AFFIRMATIVE: 1 } }));
        jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values) }));
        button = new FakeButton();
        globalThis.HTMLButtonElement = FakeButton;
        globalThis.document = { getElementById: id => (id === 'clear_job_history_button' ? button : null) };
        globalThis.toastr = { success: jest.fn(), error: jest.fn() };
    });

    afterEach(() => {
        Object.assign(globalThis, original);
    });

    test('summaries say what was removed and what stayed', async () => {
        const { describeJobHistoryClear } = await import('../public/scripts/job-history-cleanup.js');
        expect(describeJobHistoryClear({ removed: 0, dismissed: 0, remaining: 3 })).toBe('Job history was already clear.');
        expect(describeJobHistoryClear({ removed: 1, dismissed: 1, remaining: 0 })).toBe('1 job removed.');
        expect(describeJobHistoryClear({ removed: 12, dismissed: 4, remaining: 2 })).toBe('12 jobs removed, 2 still running or just finished.');
    });

    test('a confirmed click clears the history once, reports it and re-enables the button', async () => {
        const { handleClearJobHistoryClick } = await import('../public/scripts/job-history-cleanup.js');
        const clear = jest.fn(async () => {
            expect(button.disabled).toBe(true);
            expect(button.attributes.get('aria-busy')).toBe('true');
            return { removed: 5, dismissed: 3, remaining: 0 };
        });
        const result = await handleClearJobHistoryClick(null, { confirm: async () => true, clear });
        expect(clear).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ removed: 5, dismissed: 3, remaining: 0 });
        expect(globalThis.toastr.success).toHaveBeenCalledWith('5 jobs removed.', 'Job history cleared');
        expect(button.disabled).toBe(false);
        expect(button.attributes.has('aria-busy')).toBe(false);
    });

    test('cancelling the confirmation leaves the history alone', async () => {
        const { handleClearJobHistoryClick } = await import('../public/scripts/job-history-cleanup.js');
        const clear = jest.fn();
        expect(await handleClearJobHistoryClick(null, { confirm: async () => false, clear })).toBeNull();
        expect(clear).not.toHaveBeenCalled();
        expect(button.disabled).toBe(false);
    });

    test('a server error is shown and the button recovers', async () => {
        const { handleClearJobHistoryClick } = await import('../public/scripts/job-history-cleanup.js');
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await handleClearJobHistoryClick(null, { confirm: async () => true, clear: async () => { throw new Error('offline'); } });
        expect(globalThis.toastr.error).toHaveBeenCalledWith('offline', 'Clear failed');
        expect(button.disabled).toBe(false);
        spy.mockRestore();
    });

    test('binding attaches one click listener even when called twice', async () => {
        const { bindClearJobHistoryButton } = await import('../public/scripts/job-history-cleanup.js');
        bindClearJobHistoryButton();
        bindClearJobHistoryButton();
        expect(button.listeners.filter(entry => entry.type === 'click')).toHaveLength(1);
    });
});
