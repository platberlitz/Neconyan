import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/variables.js', import.meta.url), 'utf8');

for (const scope of ['Local', 'Global']) {
    function runtime() {
        const values = {};
        const save = jest.fn();
        const context = vm.createContext({
            chat_metadata: { variables: values }, extension_settings: { variables: { global: values } },
            saveMetadataDebounced: save, saveSettingsDebounced: save,
            areVariablesReadOnly: () => false,
            convertValueType: (value, type) => type === 'number' ? Number(value) : value,
        });
        const name = `set${scope}Variable`;
        vm.runInContext(source.match(new RegExp(`export function ${name}[\\s\\S]*?\\n}`))[0].replace('export ', ''), context);
        return { values, save, set: context[name] };
    }

    test(`${scope} repeated prompt variables do not schedule redundant saves`, () => {
        const { values, save, set } = runtime();
        expect(set('genre', 'Narrative')).toBe('Narrative');
        for (let index = 0; index < 50; index++) set('genre', 'Narrative');
        expect(save).toHaveBeenCalledTimes(1);
        set('genre', 'Comedy');
        expect(save).toHaveBeenCalledTimes(2);
        expect(values.genre).toBe('Comedy');
        set('count', '0');
        set('count', 0);
        expect(save).toHaveBeenCalledTimes(4);
        expect(values.count).toBe(0);
    });

    test(`${scope} indexed writes save changes but not identical or failed assignments`, () => {
        const { values, save, set } = runtime();
        set('list', '2', { index: 0, as: 'number' });
        set('list', '2', { index: 0, as: 'number' });
        expect(save).toHaveBeenCalledTimes(1);
        expect(values.list).toBe('[2]');
        set('list', '3', { index: 0, as: 'number' });
        expect(save).toHaveBeenCalledTimes(2);
        expect(values.list).toBe('[3]');
        values.bad = 'not JSON';
        set('bad', 'x', { index: 0 });
        expect(save).toHaveBeenCalledTimes(2);
        const mutable = { field: 1 };
        set('object', mutable);
        mutable.field = 2;
        set('object', mutable);
        expect(save).toHaveBeenCalledTimes(4);
    });
}
