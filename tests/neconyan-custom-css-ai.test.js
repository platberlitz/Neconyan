/* global globalThis */
import fs from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

async function importHelper({ resolvedProfileId = 'profile-1', result = { applied: true, customCss: '.done {}', previousVersion: 3, previousSettingsRevision: 8, version: 4, settingsRevision: 9 } } = {}) {
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

    test('reads active body colours and inherited fonts, while respecting an explicit snapshot element', async () => {
        const { helper } = await importHelper();
        const body = {};
        const root = {};
        const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const oldComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
        Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, documentElement: root } });
        Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: element => ({
            getPropertyValue: name => ({
                '--neco-ginger': element === body ? ' #aabbcc ' : '',
                '--neco-on-accent': element === body ? '#111111' : '',
                '--sb-font-display': 'Fredoka One',
                '--sb-font-chat': element === body ? ' Lora ' : '',
                '--monoFontFamily': element === body ? 'Fira Code, monospace' : '',
            })[name] ?? '',
        }) });
        try {
            const [, user] = helper.buildCustomCssAIMessages({ instruction: 'Rounder buttons' });
            expect(user.content).toContain('--neco-ginger: #aabbcc;');
            expect(user.content).toContain('--neco-on-accent: #111111;');
            expect(user.content).toContain('--sb-font-display: Fredoka One;');
            expect(user.content).toContain('--sb-font-chat: Lora;');
            expect(user.content).toContain('--monoFontFamily: Fira Code, monospace;');
            expect(helper.getCustomCssPaletteSnapshot(root)).toBe('--sb-font-display: Fredoka One;');
            expect(helper.getCustomCssPaletteSnapshot(null)).toBe('');
        } finally {
            if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
            else delete globalThis.document;
            if (oldComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldComputedStyle);
            else delete globalThis.getComputedStyle;
        }
    });

    test('append requests only additions and describes the current shell and both chat renderers', async () => {
        const { helper } = await importHelper();
        const [system, user] = helper.buildCustomCssAIMessages({ instruction: 'Larger DM text', mode: 'append', currentCss: '.existing {}' });
        expect(user.content).toContain('Append mode: return only the new rules');
        expect(user.content).toContain('.existing {}');
        for (const hook of ['data-sb-theme', 'windows-aero', '#sb-mobile-nav-content', '#neconyan-workspace-rail', '#sb-bottom-chat-bar', '#chat .mes', '.sb-conversation-message-text', ':focus-visible', ':not(.reduced-motion)', '44px', '--neco-on-accent', '--sb-font-display', '--mainFontSize', '.custom-example', 'Append or Replace']) {
            expect(system.content).toContain(hook);
        }
    });

    test('points light and dark rules at the tone attributes every UI theme sets', async () => {
        const { helper } = await importHelper();
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Softer dark panels', mode: 'append' });
        const powerUser = fs.readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');

        expect(system.content).toContain(':root[data-sb-surface-tone="light"]');
        expect(system.content).toMatch(/data-neconyan-calico-tone="light"\] or "dark" matches only the stock Calico/);
        expect(system.content).not.toContain('custom accents use data-neconyan-accent="custom"');
        expect(powerUser).toMatch(/dataset\.sbSurfaceTone = isLightSurface \? 'light' : 'dark'/);
        expect(powerUser).toMatch(/dataset\.sbTextTone = /);
        expect(powerUser).toMatch(/dataset\.neconyanCalicoTone = isDarkCalico \? 'dark' : isLightCalico \? 'light' : 'custom'/);
        expect(powerUser).toMatch(/dataset\.neconyanAccent = isThemeAccent \? 'theme' : 'custom'/);
    });

    test('covers every shell style in the catalogue and scopes the stage shells', async () => {
        const { helper } = await importHelper();
        const [system, user] = helper.buildCustomCssAIMessages({ instruction: 'Hide the Starlight trail and lower its overlay', mode: 'append' });
        const tabsSource = fs.readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        const starlightCss = fs.readFileSync(new URL('../public/css/shell-styles/starlight-conservatory.css', import.meta.url), 'utf8');
        const reefCss = fs.readFileSync(new URL('../public/css/shell-styles/sunken-reef.css', import.meta.url), 'utf8');
        const themes = tabsSource.match(/const NN_THEMES = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
        const themeIds = [...themes.matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);

        expect(themeIds).toEqual(expect.arrayContaining(['starlight-conservatory', 'sunken-reef']));
        for (const themeId of themeIds) {
            expect(system.content).toContain(themeId);
        }
        expect(system.content).toContain(':root[data-sb-theme="starlight-conservatory"]');
        expect(system.content).toContain(':root[data-sb-theme="sunken-reef"]');
        expect(system.content).toContain('--starlight-*');
        expect(system.content).toContain('--reef-*');
        expect(system.content).toContain('#sb-starlight-conservatory-stage');
        expect(system.content).toContain('#sb-sunken-reef-stage');
        expect(system.content).toContain('Starlight also restyles the Conversation timeline');
        expect(starlightCss).toMatch(/#sb-starlight-conservatory-stage \{\n\s{4}display: contents;/);
        expect(reefCss).toMatch(/#sb-sunken-reef-stage \{\n\s{4}display: contents;/);
        expect(starlightCss).toMatch(/#sb-starlight-conservatory-stage canvas \{[\s\S]*?position: fixed;[\s\S]*?pointer-events: none;/);
        expect(reefCss).toMatch(/#sb-sunken-reef-stage canvas \{[\s\S]*?position: fixed;[\s\S]*?pointer-events: none;/);
        expect(starlightCss).toMatch(/#sb-starlight-conservatory-sky \{\n\s{4}z-index: -1;/);
        expect(starlightCss).toMatch(/#sb-starlight-conservatory-overlay \{\n\s{4}z-index: calc\(var\(--sb-z-shell-panel, 1100\) - 1\);/);
        expect(starlightCss).toMatch(/#sb-starlight-conservatory-trail \{\n\s{4}z-index: calc\(var\(--sb-z-critical, 10000\) - 1\);/);
        expect(reefCss).toMatch(/#sb-sunken-reef-backdrop \{\n\s{4}z-index: -1;/);
        expect(reefCss).toMatch(/#sb-sunken-reef-creatures \{\n\s{4}z-index: 0;/);
        expect(reefCss).toMatch(/#sb-sunken-reef-wake \{\n\s{4}z-index: calc\(var\(--sb-z-critical, 10000\) - 1\);/);
        expect(starlightCss).toContain('--starlight-brass');
        expect(starlightCss).toMatch(/#sheld\[data-sb-conversation-mode='on'\] \.sb-conversation-timeline/);
        expect(reefCss).toContain('--reef-lagoon');
        expect(system.content).toContain('display: contents stages');
        expect(system.content).toContain('individual canvases are position: fixed and pointer-events: none');
        expect(system.content).toContain('Preserve those canvases and their stacking unless the request explicitly asks to change them');
        expect(system.content).toContain('Starlight\'s sky sits behind');
        expect(system.content).toContain('overlay above content but below shell panels');
        expect(system.content).toContain('trail above content');
        expect(system.content).toContain('Sunken Reef\'s backdrop sits behind');
        expect(system.content).toContain('creatures behind panels and messages');
        expect(system.content).toContain('wake above content');
        expect(system.content).toContain('Do not flatten, hide, reorder or change their z-index as a side effect');
        expect(system.content).not.toContain('Do not flatten, hide, reorder or change the z-index of those canvases');
        expect(system.content).not.toContain('fixed decorative canvas stages');
        expect(system.content).not.toContain('behind content');
        expect(user.content).toContain('Hide the Starlight trail and lower its overlay');
    });

    test('keeps the inset Conversation timeline scrollable and reachable in the prompt', async () => {
        const { helper } = await importHelper();
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Restyle Conversation bubbles', mode: 'append' });
        const conversationCss = fs.readFileSync(new URL('../public/css/neconyan-conversation.css', import.meta.url), 'utf8');
        const neconyanCss = fs.readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');

        expect(conversationCss).toMatch(/\.sb-conversation-timeline \{\n\s{4}min-block-size: 0;[\s\S]*?overflow-y: auto;[\s\S]*?touch-action: pan-y;/);
        expect(neconyanCss).toMatch(/body\.neconyan \.sb-conversation-timeline \{[^}]*margin: 8px 10px 4px;[^}]*border-radius:[^}]*background: color-mix/);
        expect(neconyanCss).toMatch(/\.sb-conversation-pals-list > \.sb-conversation-empty \{ display: grid; place-items: center;/);
        expect(system.content).toContain('#sb_conversation_stage');
        expect(system.content).toContain('.sb-conversation-composer');
        expect(system.content).toContain('#sb_conversation_pals_rail');
        expect(system.content).toContain('translucent inset scroll pane');
        expect(system.content).toContain('Keep the timeline scrollable');
        expect(system.content).toContain('composer reachable');
        expect(system.content).toContain('centred empty Pals state');
    });

    test('adds the secondary accent to the prompt and the live palette snapshot', async () => {
        const { helper } = await importHelper();
        const { CUSTOM_CSS_AI_PALETTE_VARIABLES } = await import('../public/scripts/neconyan-custom-css-core.js');
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Tint the active tab', paletteSnapshot: '' });
        const neconyanCss = fs.readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');
        const themeCss = fs.readFileSync(new URL('../public/css/neconyan-theme.css', import.meta.url), 'utf8');
        const tabsSource = fs.readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        const body = {};
        const oldComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
        Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: element => ({
            getPropertyValue: name => element === body && name === '--neco-accent-secondary' ? ' #aabbcc ' : '',
        }) });
        try {
            expect(helper.getCustomCssPaletteSnapshot(body)).toBe('--neco-accent-secondary: #aabbcc;');
            expect(helper.getCustomCssPaletteSnapshot({})).toBe('');
        } finally {
            if (oldComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldComputedStyle);
            else delete globalThis.getComputedStyle;
        }
        expect(CUSTOM_CSS_AI_PALETTE_VARIABLES).toContain('--neco-accent-secondary');
        expect(CUSTOM_CSS_AI_PALETTE_VARIABLES).toContain('--sb-shell-surface-opacity');
        expect(system.content).toContain('--neco-accent-secondary');
        expect(system.content).toContain('--sb-shell-surface-opacity');
        expect(system.content).toContain('shell surface opacity at --sb-shell-surface-opacity');
        expect(system.content).toContain('1 is opaque');
        expect(system.content).not.toContain('surface transparency from --sb-shell-surface-opacity');
        expect(tabsSource).toMatch(/const surfaceOpacity = Math\.max\(0, 1 - \(nextTransparency \/ 100\)\);/);
        expect(tabsSource).toMatch(/setProperty\('--sb-shell-surface-opacity', surfaceOpacity\.toFixed\(2\)\)/);
        expect(themeCss).toContain('--sb-shell-surface-opacity: 1;');
        expect(themeCss).toMatch(/opacity: var\(--sb-shell-surface-opacity\)/);
        expect(neconyanCss).toContain('--neco-accent-secondary: var(--neco-ginger);');
        expect(neconyanCss).toMatch(/:root\[data-neconyan-accent='custom'\] body\.neconyan \{ --neco-accent-secondary: var\(--SmartThemeUnderlineColor\); \}/);
    });

    test('names the active mode, Structured Prefill card and phone viewport hooks', async () => {
        const { helper } = await importHelper();
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Style the Formatting card on a phone', mode: 'append' });
        const tabsSource = fs.readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
        const mobileCss = fs.readFileSync(new URL('../public/css/neconyan-mobile-shell.css', import.meta.url), 'utf8');
        const definitions = tabsSource.match(/const NECONYAN_MODE_DEFINITIONS = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
        const modeIds = [...definitions.matchAll(/id:\s*'([^']+)'/g)].map(match => match[1]);

        expect(modeIds).toEqual(['roleplay', 'conversation', 'meower', 'story']);
        expect(system.content).toContain('with the value "roleplay", "conversation", "meower" or "story"');
        for (const modeId of modeIds) {
            expect(tabsSource).toContain(`return '${modeId}'`);
        }
        expect(tabsSource).toMatch(/document\.body\.dataset\.neconyanChatMode = activeMode/);
        expect(indexHtml).toContain('id="structured-prefill-settings"');
        expect(mobileCss).toContain('var(--sb-shell-viewport-height, 100dvh)');
        expect(system.content).toContain('body[data-neconyan-chat-mode]');
        expect(system.content).toContain('#structured-prefill-settings');
        expect(system.content).toContain('var(--sb-shell-viewport-height, 100dvh)');
        expect(system.content).toContain('var(--sb-mobile-touch-target, 44px)');
    });

    test('documents the JS rail allowlist behind horizontal phone scrolling', async () => {
        const { helper } = await importHelper();
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Widen the phone tab rail', mode: 'append' });
        const lifecycle = fs.readFileSync(new URL('../public/scripts/mobile-shell-lifecycle/index.js', import.meta.url), 'utf8');
        const design = fs.readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');

        expect(lifecycle).toContain('export const MOBILE_SWIPE_RAIL_SELECTOR');
        expect(lifecycle).toMatch(/const MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR = \[\s*MOBILE_SWIPE_RAIL_SELECTOR,/);
        expect(lifecycle).toMatch(/elementMatchesSelector\(scrollElement, MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR\)/);
        expect(design).toContain('Any horizontally scrolling rail needs both `touch-action: pan-x` and an entry in `MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR`');
        expect(system.content).toContain('touch-action: pan-x');
        expect(system.content).toContain('MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR');
        expect(system.content).toContain('CSS alone cannot add that allowlist entry');
        expect(system.content).toContain('reuse an existing allowlisted rail');
        expect(system.content).not.toContain('Give horizontal rails touch-action: pan-x');
    });

    test('covers every selectable font role in the prompt and palette snapshot', async () => {
        const { helper } = await importHelper();
        const { CUSTOM_CSS_AI_PALETTE_VARIABLES } = await import('../public/scripts/neconyan-custom-css-core.js');
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Larger chat text', paletteSnapshot: '' });
        const powerUser = fs.readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
        const roles = powerUser.match(/const GOOGLE_FONT_ROLES = Object\.freeze\(\{([\s\S]*?)\n\}\);/)[1];
        const variables = [...roles.matchAll(/cssVariable: '([^']+)'/g)].map(match => match[1]);

        expect(variables).toHaveLength(4);
        for (const variable of variables) {
            expect(CUSTOM_CSS_AI_PALETTE_VARIABLES).toContain(variable);
            expect(system.content).toContain(variable);
        }
        expect(system.content).toContain('var(--sb-font-chat, var(--mainFontFamily))');
        expect(system.content).toContain('four independently selected font roles');
    });

    test('keeps the contrast-matched primary fill through hover and active states', async () => {
        const { helper } = await importHelper();
        const [system] = helper.buildCustomCssAIMessages({ instruction: 'Softer buttons', paletteSnapshot: '' });

        expect(system.content).toContain('keep --neco-ginger as the solid primary fill in normal, hover and active states');
        expect(system.content).toContain('with --neco-on-accent for text');
        expect(system.content).toContain('Show hover and active feedback through borders or inset shadows');
        expect(system.content).toContain('--neco-ginger-hover can be much lighter');
        expect(system.content).not.toContain('use --neco-ginger and --neco-ginger-hover for primary fills');
    });

    test('submits one retained server job and adopts its settings write', async () => {
        const { helper, run, saveSettings, adoptServerSettingsWrite, getActiveGenerationAcknowledgement } = await importHelper();
        const result = await helper.generateCustomCssWithAI({ instruction: 'Make it cosy', profileId: 'profile-1', mode: 'append', paletteSnapshot: '--neco-ink: #111;' });

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith('custom-css', { instruction: 'Make it cosy', paletteSnapshot: '--neco-ink: #111;', mode: 'append', profileId: 'profile-1' },
            expect.objectContaining({ scope: 'custom-css' }));
        expect(saveSettings).toHaveBeenCalledWith(0, { returnResult: true });
        expect(getActiveGenerationAcknowledgement).not.toHaveBeenCalled();
        expect(adoptServerSettingsWrite).toHaveBeenCalledWith({ account: 'alice', previousVersion: 3, previousSettingsRevision: 8, version: 4, settingsRevision: 9 });
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
