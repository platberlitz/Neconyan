import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');
const code = ['activeSession', 'sessionInput', 'currentSettings', 'findContextSetup'].map(name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0]).join('\n');
const setup = { name: 'Quiet replies', settings: { depth: 9, stream: false, include: { persona: true }, prefill: 'Hello' } };

function fixture(session = null, selected = setup.name) {
    const app = { assistant: 'miso', contextSetup: selected, contextSetups: { setups: [structuredClone(setup)] },
        bucket: session ? { activeSessionId: session.id, sessions: [session] } : null };
    const runtime = vm.createContext({ app, structuredClone, DEFAULT_SETTINGS: { depth: 15, include: {}, prefill: '' },
        getAssistantGender: () => 'female', rememberedConnections: () => ({ miso: { kind: 'current' } }) });
    vm.runInContext(code, runtime);
    return { app, runtime };
}

describe('the current Saved setup for fresh Scratchpad sessions', () => {
    test('applies to a new list and its preview without changing the saved setup', () => {
        const { app, runtime } = fixture();
        expect(runtime.sessionInput().settings).toEqual({ ...setup.settings, assistantConnections: { miso: { kind: 'current' } } });
        expect(runtime.currentSettings()).toMatchObject(setup.settings);
        const input = runtime.sessionInput();
        input.settings.include.persona = false;
        expect(app.contextSetups.setups[0].settings.include.persona).toBe(true);
    });

    test('overrides portable choices for ordinary and temporary new sessions, not the open session', () => {
        const session = { id: 'one', settings: { depth: 3, stream: true, notes: ['keep'] } };
        const { runtime } = fixture(session);
        expect(runtime.currentSettings()).toBe(session.settings);
        expect(runtime.sessionInput().settings).toEqual(setup.settings);
        expect(runtime.sessionInput({ temporary: true })).toMatchObject({ temporary: true, settings: setup.settings });
        expect(session.settings).toEqual({ depth: 3, stream: true, notes: ['keep'] });
    });

    test('uses the first available setup if the remembered choice was deleted', () => {
        expect(fixture(null, 'Deleted setup').runtime.sessionInput().settings).toMatchObject(setup.settings);
    });

    test('keeps existing defaults when there are no saved setups', () => {
        const { app, runtime } = fixture();
        app.contextSetups.setups = [];
        expect(runtime.currentSettings().depth).toBe(15);
    });
});
