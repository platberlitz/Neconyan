import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { planMissingPlotCompassScripts } from '../public/scripts/extensions/in-chat-agents/companion/plot-compass-regex-migration.js';
import { applyToAgent, inspectAgent } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/apply.js';
import { __setHostForTests } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js';
import { DEFAULTS } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/settings.js';
import { SETTINGS_KEY } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/constants.js';
import { THEMES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/themes/index.js';

const template = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json', import.meta.url), 'utf8'));

function legacyInstall() {
    return {
        id: 'agent-plot',
        name: 'Plot Compass',
        sourceTemplateId: template.id,
        version: 2,
        phaseLocked: true,
        prompt: 'My own objective wording',
        regexScripts: [],
    };
}

describe('Plot Compass saved-agent script migration', () => {
    test('adds every bundled script to a v2 install without touching its saved edits', () => {
        const agent = legacyInstall();
        const added = planMissingPlotCompassScripts(agent, template);

        expect(added).toHaveLength(10);
        expect(new Set(added.map(script => script.id))).toEqual(new Set(template.regexScripts.map(script => script.id)));
        expect(agent).toEqual(legacyInstall());
        added[0].replaceString = 'changed';
        expect(template.regexScripts[0].replaceString).not.toBe('changed');
    });

    test('adds only missing scripts and keeps a saved script under the same id', () => {
        const custom = { ...structuredClone(template.regexScripts[0]), replaceString: '<div>my card</div>' };
        const agent = legacyInstall();
        agent.regexScripts = [custom];

        const added = planMissingPlotCompassScripts(agent, template);

        expect(added).toHaveLength(9);
        expect(added.map(script => script.id)).not.toContain(custom.id);
    });

    test('ignores other templates and templates without scripts', () => {
        expect(planMissingPlotCompassScripts(legacyInstall(), { id: 'tpl-scene-tracker', regexScripts: template.regexScripts })).toEqual([]);
        expect(planMissingPlotCompassScripts(legacyInstall(), { ...template, regexScripts: [] })).toEqual([]);
        expect(planMissingPlotCompassScripts(null, template)).toEqual([]);
    });
});

describe('the Plot Compass script migration runs at start-up', () => {
    test('initialisation calls it right after the bundled script migration', () => {
        const source = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
        const initialisation = source.slice(
            source.indexOf('async function finishAgentLibraryInitialization()'),
            source.indexOf('async function retryAgentSetupLoading'),
        );

        expect(initialisation).toContain('await migrateBundledRegexScriptsToSavedAgents()');
        expect(initialisation).toContain('await migratePlotCompassRegexScriptsToSavedAgents()');
        expect(initialisation.indexOf('await migrateBundledRegexScriptsToSavedAgents()'))
            .toBeLessThan(initialisation.indexOf('await migratePlotCompassRegexScriptsToSavedAgents()'));
    });
});

describe('a migrated Plot Compass install accepts a regex agent theme', () => {
    let agents;
    let saveAgent;

    beforeEach(() => {
        agents = [legacyInstall()];
        saveAgent = jest.fn(async updated => {
            agents[agents.findIndex(agent => agent.id === updated.id)] = structuredClone(updated);
        });
        global.SillyTavern = { getContext: () => ({ extensionSettings: { [SETTINGS_KEY]: { ...structuredClone(DEFAULTS), theme: THEMES[0].slug } }, saveSettingsDebounced: jest.fn(), chat: [] }) };
        __setHostForTests({ ok: true, store: { getAgents: () => agents, saveAgent,
            getAgentById: id => agents.find(agent => agent.id === id) }, scripts: { normalizeRegexScript: value => value } });
    });

    afterEach(() => {
        __setHostForTests(null);
        delete global.SillyTavern;
    });

    test('missing scripts become stock scripts that can be themed', async () => {
        const agent = agents[0];
        expect(inspectAgent(agent).status).toBe('missing');
        expect(await applyToAgent(agent)).toMatchObject({ ok: false, reason: 'required tracker scripts are missing or changed upstream' });

        agent.regexScripts = [...agent.regexScripts, ...planMissingPlotCompassScripts(agent, template)];
        expect(inspectAgent(agent).status).toBe('stock');

        expect(await applyToAgent(agent)).toMatchObject({ ok: true, skipped: [] });
        expect(agent.regexScripts).toHaveLength(10);
        expect(agent.prompt).toBe('My own objective wording');
        expect(agent.phaseLocked).toBe(true);
        expect(inspectAgent(agent).status).toBe('pristine');
    });
});
