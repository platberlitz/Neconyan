import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { ARCHETYPES, SPECS, THEMABLE_TEMPLATE_IDS, getSpec } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/specs.js';
import { STOCK, getStock } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/stock.js';
import { TRACKER_FAMILIES, TEMPLATE_LABELS } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/template-catalog.js';
import { buildAgentScripts } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/build.js';
import { buildReplaceString } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/render/index.js';
import { applyList, regexFromString } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/interpolate.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';
import { THEMES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/themes/index.js';
import { applyAll, applyToAgent, inspectAgent, reconcile } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/apply.js';
import { __setHostForTests } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js';
import { DEFAULTS, getSettings, resolveThemeSlug, updateSettings } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/settings.js';
import { SETTINGS_KEY, STOCK_THEME } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/constants.js';

const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, templates), 'utf8'));
const bundles = read('regex-bundles.json');
const scriptsFor = id => structuredClone(bundles[id] ?? read(`${id.slice(4)}.json`).regexScripts);
const theme = THEMES[0];
const settings = () => ({ ...structuredClone(DEFAULTS), theme: theme.slug });
const agentFor = id => ({ id: `agent-${id}`, name: id, sourceTemplateId: id, version: 5,
    phaseLocked: false, prompt: 'Keep my instructions', regexScripts: scriptsFor(id) });

describe('bundled tracker contracts', () => {
    test('covers both current tracker groups and each bundled script exactly', () => {
        const groups = read('groups.json');
        for (const [group, family] of [['grp-pura-trackers', 'pura'], ['grp-pura-ethereality-trackers', 'ethereal']]) {
            const ids = groups.find(item => item.id === group).agentTemplateIds;
            expect(Object.keys(TRACKER_FAMILIES).filter(id => TRACKER_FAMILIES[id] === family).sort()).toEqual([...ids].sort());
        }
        expect(new Set(THEMABLE_TEMPLATE_IDS)).toEqual(new Set(Object.keys(TEMPLATE_LABELS)));
        expect(SPECS).toHaveLength(STOCK.length);
        for (const id of THEMABLE_TEMPLATE_IDS) {
            expect(TEMPLATE_LABELS[id]).toBe(read(`${id.slice(4)}.json`).name);
            expect(SPECS.filter(spec => spec.templateId === id).map(spec => spec.scriptId).sort())
                .toEqual(scriptsFor(id).map(script => script.id).sort());
            for (const script of scriptsFor(id)) {
                const spec = getSpec(id, script.id);
                const baseline = getStock(id, script.id);
                expect(baseline).toMatchObject({ findRegex: script.findRegex, replaceString: script.replaceString });
                const regex = regexFromString(script.findRegex);
                const count = new RegExp(`${regex.source}|`, regex.flags.replace(/[gy]/g, '')).exec('').length - 1;
                expect(spec.groups).toBe(count);
                expect(baseline.groups).toBe(count);
            }
            const report = inspectAgent(agentFor(id), settings());
            expect(report.perScript.filter(entry => !entry.owned && !['stock', 'pristine'].includes(entry.status))).toEqual([]);
        }
    });

    test('all themes preserve every display capture and source-facing pattern', () => {
        for (const selected of THEMES) {
            for (const id of THEMABLE_TEMPLATE_IDS) {
                const originals = scriptsFor(id);
                const built = buildAgentScripts(id, originals, selected, { meters: true });
                expect(built.skipped).toEqual([]);
                for (const original of originals.filter(script => !getSpec(id, script.id).regenerateFindRegex)) {
                    const script = built.scripts.find(item => item.id === original.id);
                    expect(script.findRegex).toBe(original.findRegex);
                    expect({ ...script, replaceString: original.replaceString }).toEqual(original);
                }
                for (const original of originals.filter(script => !getSpec(id, script.id).passthrough && !getSpec(id, script.id).regenerateFindRegex)) {
                    const spec = getSpec(id, original.id);
                    const script = built.scripts.find(item => item.id === original.id);
                    const refs = new Set([...script.replaceString.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
                    const required = Array.from({ length: spec.groups }, (_, i) => i + 1).filter(g => g !== spec.hue?.g);
                    expect({ id: original.id, missing: required.filter(g => !refs.has(g)), invalid: [...refs].filter(g => g > spec.groups) })
                        .toEqual({ id: original.id, missing: [], invalid: [] });
                }
            }
        }
    });

    for (const id of ['tpl-cyoa-choices', 'tpl-cyoa-choices-skill-checks']) {
        test(`${id} retains seven choices and removes unused rows`, () => {
            const built = buildAgentScripts(id, scriptsFor(id), theme);
            const text = '[CHOICES]\n' + Array.from({ length: 7 }, (_, i) => `${i + 1}. Action ${i + 1}`).join('\n') + '\n[/CHOICES]';
            const full = applyList(text, built.scripts);
            expect(full.match(/data-rat-part="slot"/g)).toHaveLength(7);
            for (let i = 1; i <= 7; i++) expect(full).toContain(`>${i}.</span> Action ${i}`);
            const partial = applyList(SAMPLES.choices.partial, built.scripts);
            expect(partial.match(/data-rat-part="slot"/g)).toHaveLength(2);
            expect(partial).not.toContain('[CHOICES]');
            expect(built.added).toEqual([]);
        });
    }

    test('current relationship card retains portrait, every field and concealed thoughts', () => {
        const id = 'tpl-relationship-tracker';
        const built = buildAgentScripts(id, scriptsFor(id), theme, { meters: true });
        const rendered = applyList(SAMPLES['relationship-bond'].full, built.scripts);
        expect(rendered).toContain('/thumbnail/portrait?name=Mira&amp;char={{char}}');
        expect(rendered).toContain('Tell her who sent you');
        expect(rendered).toMatch(/<details data-rat-part="row"[^>]*><summary>.*?Unsaid:.*?<\/summary><span data-rat-part="row-value">I hoped you would stay<\/span><\/details>/);
        expect(rendered.match(/role="progressbar"/g)).toHaveLength(4);
        expect(rendered).not.toContain('[METER');
        expect(rendered).not.toMatch(/\$\d+/);
    });

    for (const [id, text, values, parts] of [
        ['tpl-the-ledger', '[LEDGER|Mira|A lost hour|Before dawn]\ncontext: The clerk is waiting\n[/LEDGER]', ['Mira', 'A lost hour', 'Before dawn', 'The clerk is waiting'], {}],
        ['tpl-the-census', '[CENSUS:LODGER|Mira]\nb: Archivist\n[/CENSUS]', ['Mira', 'Archivist'], { section: 1 }],
        ['tpl-doors-fate-checks', '[DOORS]\n1. Take the stairs [LUCK 12]\n2. Knock\n[/DOORS]', ['Take the stairs [LUCK 12]', 'Knock'], {}],
        ['tpl-four-winds', '[WINDS]\nA. North\nB. South\n[/WINDS]', ['A. North', 'B. South'], { slot: 2 }],
    ]) {
        test(`${id} renders current Ethereal output`, () => {
            const built = buildAgentScripts(id, scriptsFor(id), theme);
            const rendered = applyList(text, built.scripts);
            expect(rendered).toContain('data-rat=');
            for (const value of values) expect(rendered).toContain(value);
            expect(rendered).not.toMatch(/\[\/?(?:LEDGER|CENSUS|DOORS|WINDS)/);
            for (const [part, count] of Object.entries(parts)) expect(rendered.match(new RegExp(`data-rat-part="${part}"`, 'g'))).toHaveLength(count);
        });
    }

    test('all preview samples still match the current display scripts', () => {
        for (const spec of SPECS.filter(item => item.family === 'tracker' && !item.passthrough && item.archetype !== ARCHETYPES.CLEANUP && SAMPLES[item.key])) {
            const sample = SAMPLES[spec.key];
            for (const text of Object.values(sample)) {
                expect({ id: spec.scriptId, matched: regexFromString(getStock(spec.templateId, spec.scriptId).findRegex).test(text) })
                    .toEqual({ id: spec.scriptId, matched: true });
                expect(buildReplaceString(spec, theme)).toBeTruthy();
            }
        }
    });
});

describe('tracker-family selection through the real apply path', () => {
    let agents;
    let saveAgent;
    let context;
    beforeEach(() => {
        agents = THEMABLE_TEMPLATE_IDS.map(agentFor);
        saveAgent = jest.fn(async updated => {
            agents[agents.findIndex(agent => agent.id === updated.id)] = structuredClone(updated);
        });
        context = { extensionSettings: { [SETTINGS_KEY]: settings() }, saveSettingsDebounced: jest.fn(), chat: [] };
        global.SillyTavern = { getContext: () => context };
        __setHostForTests({ ok: true, store: { getAgents: () => agents, saveAgent,
            getAgentById: id => agents.find(agent => agent.id === id) }, scripts: { normalizeRegexScript: value => value } });
    });
    afterEach(() => {
        __setHostForTests(null);
        delete global.SillyTavern;
    });

    test('migrates missing or invalid selections to both and honours overrides only within scope', () => {
        for (const trackerScope of [undefined, 'bogus', null]) {
            updateSettings({ trackerScope });
            expect(getSettings().trackerScope).toBe('both');
        }
        updateSettings({ trackerScope: 'pura', overrides: { 'tpl-the-ledger': THEMES[1].slug } });
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(STOCK_THEME);
        expect(resolveThemeSlug('tpl-scene-tracker')).toBe(theme.slug);
        expect(resolveThemeSlug('tpl-chatroom-companion')).toBe(theme.slug);
        updateSettings({ trackerScope: 'ethereal' });
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(THEMES[1].slug);
    });

    test('applies both, restores excluded trackers exactly, resumes overrides and persists scope', async () => {
        const original = structuredClone(agents);
        updateSettings({ overrides: { 'tpl-the-ledger': THEMES[1].slug } });
        expect(await applyAll()).toMatchObject({ ok: true, applied: 39, blocked: [], failed: [] });
        for (const agent of agents) expect(inspectAgent(agent).status).toBe('pristine');
        saveAgent.mockClear();
        expect(await reconcile()).toMatchObject({ repaired: 0, reverted: 0, needsAttention: [] });
        expect(saveAgent).not.toHaveBeenCalled();

        for (const scope of ['pura', 'ethereal', 'both']) {
            updateSettings({ trackerScope: scope });
            expect(await applyAll()).toMatchObject({ ok: true, blocked: [], failed: [] });
            expect(getSettings().trackerScope).toBe(scope);
            const excluded = agents.filter(agent => {
                const family = TRACKER_FAMILIES[agent.sourceTemplateId];
                return family && scope !== 'both' && family !== scope;
            });
            for (const agent of excluded) {
                expect(agent).toEqual(original.find(item => item.id === agent.id));
                expect(getSettings().ledger[agent.id]).toBeUndefined();
            }
            for (const agent of agents.filter(item => !excluded.includes(item))) {
                expect(inspectAgent(agent).status).toBe('pristine');
                expect(agent.prompt).toBe(original.find(item => item.id === agent.id).prompt);
                expect(agent.version).toBe(original.find(item => item.id === agent.id).version);
            }
        }
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(THEMES[1].slug);
        updateSettings({ theme: STOCK_THEME, overrides: {} });
        expect(await applyAll()).toMatchObject({ reverted: 39, blocked: [], failed: [] });
        expect(agents).toEqual(original);
    });

    test('direct apply and reload reconciliation honour selection', async () => {
        await applyAll();
        updateSettings({ trackerScope: 'pura' });
        const ledger = agents.find(agent => agent.sourceTemplateId === 'tpl-the-ledger');
        expect(await applyToAgent(ledger)).toMatchObject({ ok: true });
        expect(ledger.regexScripts).toEqual(scriptsFor('tpl-the-ledger'));
        expect(await reconcile()).toMatchObject({ repaired: 0, reverted: 20, needsAttention: [] });
        updateSettings({ trackerScope: 'ethereal' });
        expect(await reconcile()).toMatchObject({ repaired: 21, reverted: 15, needsAttention: [] });
    });

    test('scope changes protect manual edits and altered source patterns', async () => {
        await applyAll();
        const ledger = agents.find(agent => agent.sourceTemplateId === 'tpl-the-ledger');
        ledger.regexScripts[0].replaceString = '<div>My custom card</div>';
        updateSettings({ trackerScope: 'pura' });
        const result = await applyAll();
        expect(result.blocked.map(entry => entry.agentId)).toContain(ledger.id);
        expect(ledger.regexScripts[0].replaceString).toBe('<div>My custom card</div>');
        updateSettings({ trackerScope: 'both' });
        ledger.regexScripts[0].findRegex = '/custom (pattern)/g';
        expect(await applyToAgent(ledger, { force: true })).toMatchObject({ ok: false });
        expect(ledger.regexScripts[0].findRegex).toBe('/custom (pattern)/g');
    });
});
