import { describe, expect, test } from '@jest/globals';
import { createVariablePreview, getPreviewVariables } from '../public/scripts/variable-preview.js';
import { areVariablesReadOnly } from '../public/scripts/variable-read-only.js';

describe('temporary preview variables', () => {
    test('writes share one snapshot across substitutions without touching either live store', async () => {
        const local = { length: 'stale', count: '0', list: '[1]', padded: '007', object: { value: 'saved' } };
        const global = { style: 'saved' };
        const original = structuredClone({ local, global });
        const evaluate = createVariablePreview();
        evaluate(() => {
            expect(areVariablesReadOnly()).toBe(true);
            const stores = getPreviewVariables(local, global);
            stores.local.set('length', 'fresh');
            stores.global.set('style', 'fresh');
            stores.local.get('object').value = 'temporary';
            expect(stores.local.inc('count')).toBe(1);
            expect(stores.local.add('list', 'two')).toEqual([1, 'two']);
            expect(stores.local.get('padded')).toBe('007');
        });
        await Promise.resolve();
        expect(areVariablesReadOnly()).toBe(false);
        expect(getPreviewVariables(local, global)).toBeNull();
        evaluate(() => {
            const stores = getPreviewVariables(local, global);
            expect(stores.local.get('length')).toBe('fresh');
            expect(stores.global.get('style')).toBe('fresh');
            expect(stores.local.get('list')).toBe('[1,"two"]');
            expect(stores.local.dec('count')).toBe(0);
            stores.global.del('style');
            expect(stores.global.has('style')).toBe(false);
        });
        expect({ local, global }).toEqual(original);
        createVariablePreview()(() => expect(getPreviewVariables(local, global).local.get('length')).toBe('stale'));
    });

    test('nested previews and failures restore the outer scope and read-only guard', () => {
        const evaluate = createVariablePreview();
        evaluate(() => {
            const outer = getPreviewVariables();
            outer.local.set('value', 'outer');
            expect(() => createVariablePreview()(() => {
                getPreviewVariables().local.set('value', 'inner');
                throw new Error('failed substitution');
            })).toThrow('failed substitution');
            expect(getPreviewVariables().local.get('value')).toBe('outer');
            expect(areVariablesReadOnly()).toBe(true);
        });
        expect(areVariablesReadOnly()).toBe(false);
        expect(getPreviewVariables()).toBeNull();
    });

    test('restricted group history still hides agent variables', () => {
        createVariablePreview()(() => {
            const { local } = getPreviewVariables({ agent_secret: 'hidden', ordinary: 'visible' }, {}, true);
            expect(local.get('agent_secret')).toBe('');
            expect(local.has('agent_secret')).toBe(false);
            expect(local.get('ordinary')).toBe('visible');
        });
    });
});
