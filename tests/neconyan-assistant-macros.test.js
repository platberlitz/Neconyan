import { jest, describe, test, expect } from '@jest/globals';
import { createBrowserMacroAuthoring, reviewAndSaveBrowserMacro } from '../public/scripts/neconyan-assistant-macros.js';
import { withReadOnlyVariables } from '../public/scripts/variable-read-only.js';
import { normaliseBrowserMacroDraft } from '../public/scripts/neconyan-assistant-macro-schema.js';

function fixture(initial = []) {
    let defs = structuredClone(initial);
    let account = 'alice';
    const runtime = {
        account,
        getAccount: () => account,
        assertAvailable: jest.fn(),
        getDefs: () => structuredClone(defs),
        saveDefs: jest.fn(value => { defs = structuredClone(value); }),
        createDef: draft => ({ id: 'new-id', enabled: true, ...draft }),
        validate: jest.fn(() => []),
        preview: jest.fn(() => 'A preview'),
        confirm: jest.fn(async () => true),
        isShadowed: () => false,
        sync: jest.fn(),
    };
    return {
        runtime,
        save: createBrowserMacroAuthoring(() => runtime),
        defs: () => defs,
        replace: value => { defs = value; },
        switchAccount: value => { account = value; },
    };
}

const draft = { name: 'misogreet', template: 'Hello {{user}}', description: 'A greeting', args: [] };
const existing = { id: 'kept-id', ...draft, enabled: true };

describe('reviewed browser macro authoring', () => {
    test('a synchronous read-only caller cannot queue an asynchronous save', async () => {
        await expect(withReadOnlyVariables(() => reviewAndSaveBrowserMacro(draft))).resolves.toMatchObject({ status: 'error', committed: false });
    });

    test('saves the reviewed definition and synchronises registrations once', async () => {
        const f = fixture();
        await expect(f.save(draft)).resolves.toEqual({ status: 'success', committed: true, name: 'misogreet', scope: 'browser' });
        expect(f.runtime.confirm).toHaveBeenCalledWith(expect.objectContaining({ before: null, after: { ...draft, enabled: true }, preview: 'A preview' }));
        expect(f.defs()).toEqual([{ id: 'new-id', enabled: true, ...draft }]);
        expect(f.runtime.saveDefs).toHaveBeenCalledTimes(1);
        expect(f.runtime.sync).toHaveBeenCalledTimes(1);
    });

    test('declining never writes or registers a macro', async () => {
        const f = fixture();
        f.runtime.confirm.mockResolvedValue(false);
        expect(await f.save(draft)).toMatchObject({ status: 'cancelled', declined: true });
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
        expect(f.runtime.sync).not.toHaveBeenCalled();
    });

    test('requires the exact old template when replacing a name', async () => {
        const f = fixture([existing]);
        expect((await f.save({ ...draft, template: 'Changed' })).status).toBe('conflict');
        expect(f.runtime.confirm).not.toHaveBeenCalled();
        expect((await f.save({ ...draft, template: 'Changed', expectedTemplate: draft.template })).committed).toBe(true);
        expect(f.defs()[0]).toMatchObject({ id: 'kept-id', template: 'Changed' });
    });

    test('refuses a target changed by another tab during review', async () => {
        const f = fixture([existing]);
        f.runtime.confirm.mockImplementation(async () => {
            f.replace([{ ...existing, description: 'Edited elsewhere' }]);
            return true;
        });
        expect((await f.save({ ...draft, template: 'Changed', expectedTemplate: draft.template })).status).toBe('conflict');
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });

    test('preserves unrelated macros created during review', async () => {
        const f = fixture();
        const other = { ...existing, id: 'other', name: 'other' };
        f.runtime.confirm.mockImplementation(async () => { f.replace([other]); return true; });
        expect((await f.save(draft)).committed).toBe(true);
        expect(f.defs()).toContainEqual(other);
    });

    test('checks the account again after an asynchronous currentness check', async () => {
        const f = fixture();
        const isCurrent = jest.fn(async () => true);
        isCurrent.mockImplementationOnce(async () => true).mockImplementationOnce(async () => { f.switchAccount('bob'); return true; });
        expect(await f.save(draft, { isCurrent })).toMatchObject({ status: 'cancelled', declined: false });
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });

    test('a cancelled request cannot save after the popup closes', async () => {
        const f = fixture();
        const isCurrent = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect(await f.save(draft, { isCurrent })).toMatchObject({ status: 'cancelled', committed: false, declined: false });
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });

    test('pins the caller account before runtime loading and refuses a different account', async () => {
        const f = fixture();
        const load = jest.fn(() => f.runtime);
        const save = createBrowserMacroAuthoring(load);
        expect(await save(draft, { account: 'bob' })).toMatchObject({ status: 'cancelled', declined: false });
        expect(load).toHaveBeenCalledWith({ account: 'bob' });
        expect(f.runtime.confirm).not.toHaveBeenCalled();
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });

    test('a stale popup cancellation is not reported as a user decline', async () => {
        const f = fixture();
        f.runtime.confirm.mockImplementation(async () => { f.switchAccount('bob'); return false; });
        expect(await f.save(draft)).toMatchObject({ status: 'cancelled', declined: false });
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });

    test('an approval retry recognises the saved definition without another popup', async () => {
        const f = fixture();
        const options = { proposalId: 'alice/job/approval' };
        expect((await f.save(draft, options)).committed).toBe(true);
        expect((await f.save(draft, options)).committed).toBe(true);
        expect(f.runtime.confirm).toHaveBeenCalledTimes(1);
        expect(f.runtime.saveDefs).toHaveBeenCalledTimes(1);
        f.replace([{ ...f.defs()[0], template: 'Later manual change' }]);
        expect((await f.save(draft, options)).status).toBe('conflict');
        expect(f.runtime.saveDefs).toHaveBeenCalledTimes(1);
    });

    test('reports storage refusal without claiming a save', async () => {
        const f = fixture();
        f.runtime.saveDefs.mockImplementation(() => { throw new Error('Storage is full'); });
        await expect(f.save(draft)).resolves.toMatchObject({ status: 'error', committed: false, message: 'Storage is full' });
        expect(f.runtime.sync).not.toHaveBeenCalled();
    });

    test('refuses read-only or disabled runtime before preview', async () => {
        const f = fixture();
        f.runtime.assertAvailable.mockImplementation(() => { throw new Error('Read-only preview'); });
        expect((await f.save(draft)).committed).toBe(false);
        expect(f.runtime.preview).not.toHaveBeenCalled();
        expect(f.runtime.confirm).not.toHaveBeenCalled();
    });

    test('revalidates name ownership after review', async () => {
        const f = fixture();
        f.runtime.validate.mockReturnValueOnce([]).mockReturnValueOnce(['A new extension owns this name.']);
        expect((await f.save(draft)).status).toBe('conflict');
        expect(f.runtime.saveDefs).not.toHaveBeenCalled();
    });
});

describe('browser macro tool input', () => {
    test.each([
        { name: 'me-owned' },
        { name: 'bad name' },
        { template: ' ' },
        { template: 'x'.repeat(20001) },
        { args: [{ name: 'char' }] },
        { args: [{ name: 'one' }, { name: 'ONE' }] },
        { args: [{ name: 'one', optional: true }, { name: 'two' }] },
        { args: [{ name: 'one', optional: 'false' }] },
    ])('rejects malformed definition %#', changes => {
        expect(() => normaliseBrowserMacroDraft({ ...draft, ...changes })).toThrow();
    });

    test('keeps nested template syntax and normalises optional arguments', () => {
        const result = normaliseBrowserMacroDraft({ name: ' mymacro ', template: '{{if::{{hasvar::x}}::{{getvar::x}}::none}}', args: [{ name: 'genre', optional: true, defaultValue: 'mystery' }] });
        expect(result.name).toBe('mymacro');
        expect(result.template).toBe('{{if::{{hasvar::x}}::{{getvar::x}}::none}}');
        expect(result.args[0]).toEqual({ name: 'genre', optional: true, defaultValue: 'mystery', description: '' });
    });
});
