import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');

describe('General Scratchpad persona warning', () => {
    function fixture() {
        const app = { open: true, personaWarning: false };
        const warning = jest.fn();
        const runtime = vm.createContext({ app, toastr: { warning }, sourcePersona: source => source.personaId ? { name: 'Writer' } : null,
            t: parts => parts.join('') });
        vm.runInContext(source.match(/^function warnMissingPersona\([\s\S]*?^}/m)[0], runtime);
        return { app, warning, check: source => runtime.warnMissingPersona(source) };
    }

    test('warns once while General has no persona, then resets when one is equipped', () => {
        const f = fixture();
        const general = { kind: 'general', personaId: '' };
        f.check(general);
        f.check(general);
        expect(f.warning).toHaveBeenCalledTimes(1);
        f.check({ ...general, personaId: 'Writer.png' });
        expect(f.warning).toHaveBeenCalledTimes(1);
        f.check(general);
        expect(f.warning).toHaveBeenCalledTimes(2);
    });

    test.each([null, { kind: 'roleplay' }, { kind: 'conversation' }, { kind: 'notebook' }])('does not warn outside General: %j', source => {
        const f = fixture();
        f.check(source);
        expect(f.warning).not.toHaveBeenCalled();
    });

    test('does not warn while Scratchpad is hidden', () => {
        const f = fixture();
        f.app.open = false;
        f.check({ kind: 'general' });
        expect(f.warning).not.toHaveBeenCalled();
    });
});
