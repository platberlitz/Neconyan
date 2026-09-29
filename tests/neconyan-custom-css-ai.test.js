import { describe, expect, jest, test } from '@jest/globals';

async function importHelper({ resolvedProfileId = 'profile-1', result = { applied: true, customCss: '.done {}', previousVersion: 3, version: 4, settingsRevision: 9 } } = {}) {
    jest.resetModules();

    const resolveConnectionProfile = jest.fn(profileId => String(profileId || resolvedProfileId).trim());
    const run = jest.fn(async (kind, input, options) => {
        await options.prepareInput(input);
        return { state: 'completed', result };
    });
    const saveSettings = jest.fn(async () => true);
    const adoptServerSettingsWrite = jest.fn(() => true);
    const getActiveGenerationAcknowledgement = jest.fn(() => ({ account: 'alice', settingsRevision: 3 }));

    await jest.unstable_mockModule('../public/script.js', () => ({ saveSettings, adoptServerSettingsWrite, getActiveGenerationAcknowledgement }));
    await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'alice' }));
    await jest.unstable_mockModule('../public/scripts/operations-client.js', () => ({ getOperationClient: async () => ({ run }) }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ resolveConnectionProfile }));

    const helper = await import('../public/scripts/neconyan-custom-css-ai.js');
    return { helper, run, saveSettings, adoptServerSettingsWrite, getActiveGenerationAcknowledgement, resolveConnectionProfile };
}

describe('Neconyan Custom CSS AI helper', () => {
    test('preserves the shared abort-like error export', async () => {
        const { helper } = await importHelper();

        expect(helper.isAbortLikeError(new Error('request cancelled'))).toBe(true);
        expect(helper.isAbortLikeError(new Error('request failed'))).toBe(false);
    });

    test('normalizes fenced CSS and style tags', async () => {
        const { helper } = await importHelper();

        expect(helper.normalizeGeneratedCustomCss('```css\n<style>\n.mes { border-radius: 12px; }\n</style>\n```'))
            .toBe('.mes { border-radius: 12px; }');
    });

    test('builds messages with request, current CSS, and theme variables', async () => {
        const { helper } = await importHelper();
        const messages = helper.buildCustomCssAIMessages({
            instruction: 'Make chat bubbles softer.',
            currentCss: '.mes { padding: 1rem; }',
            paletteSnapshot: '--SmartThemeBodyColor: white;',
        });

        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('Output ONLY raw CSS');
        expect(messages[1].content).toContain('Make chat bubbles softer.');
        expect(messages[1].content).toContain('.mes { padding: 1rem; }');
        expect(messages[1].content).toContain('--SmartThemeBodyColor: white;');
        expect(messages[1].content).toContain('Replace mode: return the complete updated stylesheet');
    });

    test('append requests only additions and describes the current shell and both chat renderers', async () => {
        const { helper } = await importHelper();
        const [system, user] = helper.buildCustomCssAIMessages({ instruction: 'Larger DM text', mode: 'append', currentCss: '.existing {}' });
        expect(user.content).toContain('Append mode: return only the new rules');
        expect(user.content).toContain('.existing {}');
        for (const hook of ['data-sb-theme', 'windows-aero', '#sb-mobile-nav-content', '#neconyan-workspace-rail', '#sb-bottom-chat-bar', '#chat .mes', '.sb-conversation-message-text', ':focus-visible', ':not(.reduced-motion)', '44px']) {
            expect(system.content).toContain(hook);
        }
    });

    test('submits one retained server job and adopts its settings write', async () => {
        const { helper, run, saveSettings, adoptServerSettingsWrite, getActiveGenerationAcknowledgement } = await importHelper();
        const result = await helper.generateCustomCssWithAI({ instruction: 'Make it cosy', profileId: 'profile-1', mode: 'append', paletteSnapshot: '--neco-ink: #111;' });

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith('custom-css', { instruction: 'Make it cosy', paletteSnapshot: '--neco-ink: #111;', mode: 'append', profileId: 'profile-1' },
            expect.objectContaining({ scope: 'custom-css' }));
        expect(saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
        expect(getActiveGenerationAcknowledgement).not.toHaveBeenCalled();
        expect(adoptServerSettingsWrite).toHaveBeenCalledWith({ account: 'alice', previousVersion: 3, version: 4, settingsRevision: 9 });
        expect(result.customCss).toBe('.done {}');
    });

    test('uses the acknowledged active connection and never falls back after a failure', async () => {
        const { helper, run, getActiveGenerationAcknowledgement, adoptServerSettingsWrite } = await importHelper({ result: { applied: false, css: '.kept {}', customCss: '.newer {}' } });
        await helper.generateCustomCssWithAI({ instruction: 'Rounder buttons', paletteSnapshot: '' });
        expect(getActiveGenerationAcknowledgement).toHaveBeenCalledTimes(1);
        expect(adoptServerSettingsWrite).not.toHaveBeenCalled();

        run.mockRejectedValueOnce(new Error('connection lost'));
        await expect(helper.generateCustomCssWithAI({ instruction: 'Again', paletteSnapshot: '' })).rejects.toThrow('connection lost');
        expect(run).toHaveBeenCalledTimes(2);
    });
});
