import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = relativePath => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const settingsSource = readRepoFile('public/scripts/extensions/in-chat-agents/settings.html');
const editorSource = readRepoFile('public/scripts/extensions/in-chat-agents/editor.html');
const indexSource = readRepoFile('public/scripts/extensions/in-chat-agents/index.js');
const styleSource = readRepoFile('public/scripts/extensions/in-chat-agents/style.css');
const dashboardSource = readRepoFile('public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js');

describe('in-chat agents workspace redesign', () => {
    test('keeps unique editor IDs and preserves conditional panel targets', () => {
        const tags = editorSource.match(/<[^>]+>/g) || [];
        const ids = [];
        for (const tag of tags) {
            const attributes = [...tag.matchAll(/\sid="([^"]+)"/g)];
            expect(attributes.length).toBeLessThanOrEqual(1);
            ids.push(...attributes.map(match => match[1]));
        }
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ['ica--companion-view', 'ica--tracker-builder-view', 'ica--when-view']) {
            expect(ids).toContain(id);
        }
    });

    test('keeps the workbench discoverable while separating management from defaults', () => {
        expect(settingsSource).toContain('data-ica-view="manage"');
        expect(settingsSource).toContain('data-ica-view="connections"');
        expect(settingsSource).toContain('data-workspace-view="manage"');
        expect(settingsSource).toContain('data-workspace-view="connections"');
        expect(settingsSource).toContain('id="ica--agent-count"');
        expect(settingsSource).toContain('id="ica--enabled-count"');
        expect(settingsSource).toContain('id="ica--companion-count"');
        expect(settingsSource).toContain('id="ica--globalEnabled"');
        expect(settingsSource).toContain('id="ica--moreTools"');
        const moreTools = settingsSource.slice(settingsSource.indexOf('id="ica--moreTools"'), settingsSource.indexOf('</details>', settingsSource.indexOf('id="ica--moreTools"')));
        for (const id of ['ica--setupSelect', 'ica--setupSave', 'ica--setupLoad', 'ica--setupDelete', 'ica--setupStatus']) {
            expect(moreTools).toContain(`id="${id}"`);
        }
        expect(settingsSource).toContain('id="ica--workspaceSelect"');
        expect(settingsSource).toContain('id="ica--agentViewSelect"');
        expect(editorSource).toContain('id="ica--editor-section-select"');
        expect(settingsSource).toContain('aria-orientation="vertical"');
        expect(indexSource).toContain('settingsRoot.addEventListener(\'sb:reveal-search-target\'');
        expect(indexSource).toContain('setAgentWorkspaceView(viewPanel.dataset.icaView, { focus: false })');
        expect(indexSource).toContain('tab.setAttribute(\'tabindex\', active ? \'0\' : \'-1\');');
        expect(indexSource).toContain('event.key === \'ArrowDown\'');
        expect(indexSource).toContain('event.key === \'Home\'');
    });

    test('renders pinned agents through the same sortable rows as every other filter', () => {
        expect(indexSource).toContain('if (activeTab === \'quick\')');
        expect(indexSource).toContain('agents = agents.filter(agent => Boolean(agent.favorite));');
        expect(indexSource).toContain('setupCategorySortable(items[0]);');
        expect(indexSource).not.toContain('const showQuickSection');
        expect(indexSource).not.toContain('ica--quick-grid');
        expect(indexSource).toContain('ica--card-primary-actions');
        expect(indexSource).toContain('More actions');
        expect(indexSource).toContain('card.find(\'.ica--card-secondary\').on(\'click\', event => event.stopPropagation());');
        expect(indexSource).toContain('$(this).attr(\'tabindex\', isActive ? \'0\' : \'-1\');');
    });

    test('keeps every editor field in a visible information architecture wrapper', () => {
        expect(editorSource).toContain('id="ica--editor-tabs"');
        expect(editorSource).toContain('id="ica--editor-title"');
        expect(editorSource).toContain('data-editor-tab="basics"');
        expect(editorSource).toContain('data-editor-tab="instructions"');
        expect(editorSource).toContain('data-editor-tab="when"');
        expect(editorSource).toContain('data-editor-tab="reply"');
        expect(editorSource).toContain('data-editor-tab="companion"');
        expect(editorSource).toContain('data-editor-tab="regex"');
        for (const view of ['basics', 'instructions', 'when', 'reply', 'regex', 'companion']) {
            expect(editorSource).toContain(`data-editor-view="${view}"`);
        }

        for (const id of [
            'ica--editor-name',
            'ica--editor-prompt',
            'ica--editor-phase',
            'ica--editor-execution',
            'ica--editor-companion-batchAgentIds',
            'ica--editor-companion-contextRecipientAgentIds',
            'ica--editor-companion-dependencies',
            'ica--editor-pre-mode',
            'ica--editor-pp-promptEnabled',
            'ica--editor-probability',
            'ica--regex-list',
        ]) {
            expect(editorSource).toContain(`id="${id}"`);
        }

        expect(indexSource).toContain('this.id === \'ica--companion-view\'');
        expect(indexSource).toContain('visible = activeEditorView === \'companion\' && companionExecution;');
        expect(indexSource).toContain('this.id === \'ica--tracker-builder-view\'');
        expect(indexSource).toContain('this.id === \'ica--when-view\'');
        expect(indexSource).toContain('visible = activeEditorView === \'when\' && availability.placement;');
        expect(indexSource).toContain('if (!availability.reply && activeEditorView === \'reply\')');
        expect(indexSource).not.toContain('companionExecution && [\'when\', \'reply\'].includes(activeEditorView)');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-tabs\').on(\'click\', \'[data-editor-tab]\'');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-tabs\').on(\'keydown\', \'[data-editor-tab]\'');
    });

    test('uses labelled primary row actions and a compact secondary disclosure', () => {
        expect(indexSource).toContain('<span>${applyLabel}</span>');
        expect(indexSource).toContain('<span>Edit</span>');
        expect(indexSource).toContain('class="ica--card-secondary"');
        expect(styleSource).toContain('.ica--card-primary-actions .ica--btn-run');
        expect(styleSource).toContain('.ica--card-secondary-actions');
        expect(styleSource).toContain('.ica--card-actions .ica--card-btn:not(:has(> i:only-child))');
    });

    test('keeps Edit visible on the card and opens More actions inside the card on phones', () => {
        const primary = indexSource.slice(indexSource.indexOf('<div class="ica--card-primary-actions">'), indexSource.indexOf('<details class="ica--card-secondary">'));
        const secondary = indexSource.slice(indexSource.indexOf('<details class="ica--card-secondary">'), indexSource.indexOf('</details>', indexSource.indexOf('<details class="ica--card-secondary">')));
        expect(primary).toContain('ica--btn-edit');
        expect(secondary).not.toContain('ica--btn-edit');
        const mobileShell = readRepoFile('public/css/neconyan-mobile-shell.css');
        expect(mobileShell).toContain('body.neconyan #ica--settings .ica--card-primary-actions { display: contents; }');
        expect(mobileShell).toContain('body.neconyan #ica--settings .ica--card-primary-actions .ica--btn-edit { order: 2; }');
        expect(mobileShell).toContain('body.neconyan #ica--settings .ica--card-secondary-actions { left: 0; right: auto; }');
    });

    test('keeps More tools above the filters, inside the panel, and in the page flow on phones', () => {
        const toolsRule = styleSource.slice(styleSource.indexOf('.ica--more-tools {'), styleSource.indexOf('}', styleSource.indexOf('.ica--more-tools {')));
        const menuRule = styleSource.slice(styleSource.indexOf('.ica--more-tools-menu {'), styleSource.indexOf('}', styleSource.indexOf('.ica--more-tools-menu {')));
        expect(toolsRule).toContain('margin-left: auto;');
        expect(menuRule).toContain('z-index: 11;');
        const mobileShell = readRepoFile('public/css/neconyan-mobile-shell.css');
        expect(mobileShell).toContain('body.neconyan #ica--settings .ica--more-tools-menu { position: static;');
    });

    test('gives companion activity the same labelled action language', () => {
        expect(dashboardSource).toContain('Companion activity</div>');
        expect(dashboardSource).toContain('Run enabled companions');
        expect(dashboardSource).toContain('<span>${escapeHtml(label)}</span></button>');
        expect(dashboardSource).toContain('buildRowActionHtml(\'run\', \'fa-play\', \'Run\'');
        expect(dashboardSource).toContain('buildRowActionHtml(\'edit\', \'fa-pen-to-square\', \'Edit\'');
        expect(dashboardSource).toContain('Latest results');
    });

    test('keeps companion card buttons inside the card border on phones', () => {
        const phoneStart = styleSource.indexOf('@media (max-width: 768px)');
        const ruleStart = styleSource.indexOf('.ica--companion-actions {', phoneStart);
        const rule = styleSource.slice(ruleStart, styleSource.indexOf('}', ruleStart));
        expect(phoneStart).toBeGreaterThan(-1);
        expect(ruleStart).toBeGreaterThan(phoneStart);
        expect(rule).toContain('flex-wrap: wrap;');
        expect(rule).toContain('gap: 0;');
        expect(rule).toContain('max-width: 100%;');
    });
});

const getFunction = name => indexSource.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];

describe('agent workbench state', () => {
    test('keeps Stop and the master switch outside either view panel', () => {
        const persistentHeader = settingsSource.slice(0, settingsSource.indexOf('<section class="ica--view-panel"'));
        expect(persistentHeader).toContain('id="ica--cancelGeneration"');
        expect(persistentHeader).toContain('id="ica--globalEnabled"');
        expect(persistentHeader).toContain('id="ica--run-status"');
    });

    test('keeps companion feedback placement and tracker controls reachable without empty reply pages', () => {
        const runtime = vm.createContext({});
        vm.runInContext(getFunction('getEditorSectionAvailability'), runtime);
        const availability = runtime.getEditorSectionAvailability;
        expect(availability({ companion: false, phase: 'pre', category: 'custom', feedback: false }))
            .toMatchObject({ before: true, reply: false, placement: true });
        expect(availability({ companion: false, phase: 'post', category: 'custom', feedback: false }))
            .toMatchObject({ before: false, reply: true, placement: false });
        expect(availability({ companion: true, phase: 'post', category: 'tracker', feedback: true }))
            .toMatchObject({ before: false, reply: false, placement: true, tracker: true });
        expect(availability({ companion: true, phase: 'post', category: 'companion', feedback: false }))
            .toMatchObject({ before: false, reply: false, placement: false });
    });

    test('reports active work even while future runs are paused', () => {
        const elements = new Map();
        const state = { active: true, enabled: false };
        const runtime = vm.createContext({
            document: { querySelectorAll: () => [], querySelector: selector => {
                if (!elements.has(selector)) elements.set(selector, { textContent: '' });
                return elements.get(selector);
            } },
            isAgentEnabledForCurrentScope: agent => agent.enabled,
            isCompanionAgent: agent => agent.execution === 'companion',
            getLastAssistantMessageIndex: () => 0,
            getCurrentChatId: () => 'chat',
            lastManualRunFeedback: null,
            isAgentGenerationActive: () => state.active,
            areAgentsGloballyEnabled: () => state.enabled,
            getGlobalSettings: () => ({ enabled: state.enabled, separateRecentChats: false }),
            getAgentChatScopeLabel: () => 'Individual chats',
        });
        vm.runInContext(getFunction('updateAgentOverview'), runtime);
        const agents = [{ enabled: true, execution: 'companion' }];
        runtime.updateAgentOverview(agents);
        expect(elements.get('#ica--run-status').textContent).toBe('Running; future runs paused');
        expect(elements.get('#ica--scope-description').textContent).toContain('all chats');
        state.active = false;
        runtime.updateAgentOverview(agents);
        expect(elements.get('#ica--run-status').textContent).toBe('Agents paused');
        state.enabled = true;
        runtime.updateAgentOverview(agents);
        expect(elements.get('#ica--run-status').textContent).toBe('Ready for the next reply');
    });

    test('the master switch persists off even when recovery blocks Agent execution', () => {
        const settings = { enabled: true };
        const messages = [];
        const labels = [];
        const button = { toggleClass() {}, attr() {}, find: () => ({ text: value => labels.push(value) }) };
        const runtime = vm.createContext({
            $: () => button,
            getGlobalSettings: () => settings,
            areAgentsGloballyEnabled: () => false,
            setGlobalSettings: update => Object.assign(settings, update),
            persistExtensionState() {}, cancelPathfinderSummary() {}, updateAgentOverview() {},
            syncToolAgentRegistrations() {}, updateFixTrackersButtonVisibility() {}, updateCompanionButtonVisibility() {},
            toastr: { info: text => messages.push(['info', text]), warning: text => messages.push(['warning', text]) },
        });
        vm.runInContext([getFunction('updateGlobalAgentToggle'), getFunction('toggleGlobalAgents')].join('\n'), runtime);
        runtime.updateGlobalAgentToggle();
        expect(labels.at(-1)).toBe('Agents On');
        runtime.toggleGlobalAgents();
        expect(settings.enabled).toBe(false);
        expect(labels.at(-1)).toBe('Agents Off');
        expect(messages.at(-1)).toEqual(['info', 'In-Chat Agents disabled.']);
        runtime.toggleGlobalAgents();
        expect(settings.enabled).toBe(true);
        expect(labels.at(-1)).toBe('Agents On');
        expect(messages.at(-1)[0]).toBe('warning');
    });
});


test('manual runs expose failure, cancellation, and completion without leaking results across chats', async () => {
    let chatId = 'one';
    let owner = 'calico.png';
    const runtime = vm.createContext({
        getCurrentChatId: () => chatId,
        getContext: () => ({ characterId: 0, characters: [{ avatar: owner }] }),
        chat: [{}],
        getAgentGenerationCancelRevision: () => 0,
        lastManualRunFeedback: null,
        updateAgentOverview() {},
    });
    const source = indexSource.match(/^async function runAgentWithFeedback\([\s\S]*?^}/m)[0];
    vm.runInContext([getFunction('getAgentWorkspaceIdentity'), getFunction('isCurrentAgentWorkspace'), source].join('\n'), runtime);
    const agent = { name: 'Scene notes' };
    await runtime.runAgentWithFeedback(agent, async () => ({ status: 'error', error: 'Provider unavailable' }));
    expect(runtime.lastManualRunFeedback.text).toContain('Failed: Scene notes. Provider unavailable');
    await runtime.runAgentWithFeedback(agent, async () => ({ text: 'draft', changed: false, promptRuns: [{ status: 'error', error: 'Composer provider failed' }] }));
    expect(runtime.lastManualRunFeedback.text).toContain('Failed: Scene notes. Composer provider failed');
    await runtime.runAgentWithFeedback(agent, async () => ({ status: 'cancelled' }));
    expect(runtime.lastManualRunFeedback.text).toBe('Stopped: Scene notes.');
    await runtime.runAgentWithFeedback(agent, async () => ({ status: 'done' }));
    expect(runtime.lastManualRunFeedback.text).toBe('Finished: Scene notes.');
    await runtime.runAgentWithFeedback(agent, async () => { chatId = 'two'; return { status: 'done' }; });
    expect(runtime.lastManualRunFeedback).toBeNull();
    await runtime.runAgentWithFeedback(agent, async () => { owner = 'other-character.png'; return { status: 'done' }; });
    expect(runtime.lastManualRunFeedback).toBeNull();
});


test('new generation clears the previous manual result', () => {
    const runtime = vm.createContext({
        lastManualRunFeedback: { text: 'Finished: previous agent.' },
        updateCancelGenerationButton() {}, updateAgentGenerationSendControls() {}, updateAgentTokenCounter() {}, updateAgentOverview() {},
    });
    vm.runInContext(getFunction('refreshGenerationUi'), runtime);
    runtime.refreshGenerationUi(true);
    runtime.refreshGenerationUi(false);
    expect(runtime.lastManualRunFeedback).toBeNull();
});

test('Pawthfinder opens its own panel and the settings cards do not stretch', () => {
    expect(settingsSource).toContain('Open Pawthfinder');
    expect(settingsSource).toContain('Opens the full Pawthfinder settings panel.');
    expect(settingsSource).not.toContain('Detailed Pawthfinder controls are in Extensions.');
    expect(indexSource).not.toContain('PATHFINDER_EXTENSIONS_HOST_ID');
    expect(indexSource).not.toContain('openPathfinderExtensionsDrawer');
    expect(indexSource).not.toContain('schedulePathfinderExtensionsMount');
    expect(indexSource).toContain('openPathfinder: (...args)');
    expect(indexSource).toContain('mountPathfinderSettings: (...args)');
    expect(styleSource).toContain('.ica--settings-groups {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 10px;\n    align-items: start;\n}');
    expect(styleSource).toContain('#ica--settings .ica--settings-group > * { flex: 0 0 auto; }');
});

test('composer post passes preserve provider failure metadata without changing draft text', async () => {
    const runner = readRepoFile('public/scripts/extensions/in-chat-agents/agent-runner.js');
    const source = runner.match(/^export async function runSingleAgentPostPassesOnText\([\s\S]*?^}/m)[0].replace('export ', '');
    const runtime = vm.createContext({
        agentGenerationCancelRevision: 0,
        runPromptTransformAgentsForText: async () => ({ text: 'draft', changed: false, promptRuns: [{ status: 'error', error: 'Provider unavailable' }] }),
        isAgentRuntimeAllowed: () => true,
        getAgentRegexScripts: () => [],
    });
    vm.runInContext(source, runtime);
    const result = await runtime.runSingleAgentPostPassesOnText({ prompt: 'Edit this' }, 'draft', 'impersonate');
    expect(result.text).toBe('draft');
    expect(result.changed).toBe(false);
    expect(result.promptRuns).toEqual([{ status: 'error', error: 'Provider unavailable' }]);
});
