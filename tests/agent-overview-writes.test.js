import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const names = ['updateAgentTokenCounter', 'updateAgentOverview'];
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => names.includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

class FakeHTMLElement {
    constructor({ id = '', classes = [], textContent = '', title = '', disabled = false } = {}) {
        this.id = id;
        this.dataset = {};
        const classSet = new Set(classes);
        this.classList = {
            contains: name => classSet.has(name),
            toggle: (name, force) => {
                const next = force === undefined ? !classSet.has(name) : Boolean(force);
                if (next) classSet.add(name);
                else classSet.delete(name);
                return next;
            },
        };
        let currentText = textContent;
        let currentTitle = title;
        let currentDisabled = disabled;
        this.writes = { textContent: 0, title: 0, disabled: 0 };

        Object.defineProperties(this, {
            textContent: {
                get: () => currentText,
                set: value => {
                    this.writes.textContent += 1;
                    currentText = String(value);
                },
            },
            title: {
                get: () => currentTitle,
                set: value => {
                    this.writes.title += 1;
                    currentTitle = String(value);
                },
            },
            disabled: {
                get: () => currentDisabled,
                set: value => {
                    this.writes.disabled += 1;
                    currentDisabled = Boolean(value);
                },
            },
        });
    }
}

function createRuntime() {
    const state = {
        tokens: 42,
        agents: [{ enabled: true, execution: 'companion' }],
        active: false,
        enabled: true,
        globalEnabled: true,
        separateRecentChats: false,
        lastAssistantIndex: 1,
        currentWorkspace: true,
    };

    const tokenCounter = new FakeHTMLElement({ id: 'ica--agent-token-counter' });
    const tokenValue = new FakeHTMLElement({ id: 'ica--total-tokens-val' });
    const byId = new Map([
        ['ica--agent-token-counter', tokenCounter],
        ['ica--total-tokens-val', tokenValue],
    ]);
    const overviewElements = new Map();
    const runButton = new FakeHTMLElement({ classes: ['ica--btn-run'], title: '', disabled: true });
    runButton.dataset.runTitle = 'Run on latest reply';
    const targetButton = new FakeHTMLElement({ classes: ['ica--btn-run-target'], title: '', disabled: true });
    targetButton.dataset.runTitle = 'Run on chosen message';
    const buttons = [runButton, targetButton];

    const context = vm.createContext({
        HTMLElement: FakeHTMLElement,
        getInChatAgentTokenUsage: () => state.tokens,
        getVisibleInChatAgents: () => state.agents,
        isAgentEnabledForCurrentScope: agent => Boolean(agent.enabled),
        isCompanionAgent: agent => agent.execution === 'companion',
        updatePathfinderStatusLine() {},
        isAgentGenerationActive: () => state.active,
        areAgentsGloballyEnabled: () => state.enabled,
        getGlobalSettings: () => ({ enabled: state.globalEnabled, separateRecentChats: state.separateRecentChats }),
        getAgentChatScopeLabel: () => 'Individual chats',
        getLastAssistantMessageIndex: () => state.lastAssistantIndex,
        isCurrentAgentWorkspace: () => state.currentWorkspace,
        lastManualRunFeedback: null,
        document: {
            getElementById: id => byId.get(id) ?? null,
            querySelector: selector => {
                if (!overviewElements.has(selector)) {
                    overviewElements.set(selector, new FakeHTMLElement({ id: selector }));
                }
                return overviewElements.get(selector);
            },
            querySelectorAll: selector => selector.includes('.ica--btn-run') ? buttons : [],
        },
    });
    vm.runInContext(functions, context);

    return { context, state, tokenCounter, tokenValue, overviewElements, runButton, targetButton };
}

describe('Agents overview and token counter DOM write guards', () => {
    test('writes initial values, skips unchanged repeats, and writes once when state changes', () => {
        const { context, state, tokenCounter, tokenValue, runButton, targetButton } = createRuntime();

        context.updateAgentTokenCounter();
        context.updateAgentOverview();

        expect(tokenValue.textContent).toBe('42');
        expect(tokenValue.writes.textContent).toBe(1);
        expect(tokenCounter.classList.contains('is-empty')).toBe(false);
        expect(runButton.disabled).toBe(false);
        expect(runButton.title).toBe('Run on latest reply');
        expect(runButton.writes).toEqual({ textContent: 0, title: 1, disabled: 1 });
        expect(targetButton.disabled).toBe(false);
        expect(targetButton.title).toBe('Run on chosen message');
        expect(targetButton.writes).toEqual({ textContent: 0, title: 1, disabled: 1 });

        context.updateAgentTokenCounter();
        context.updateAgentOverview();

        expect(tokenValue.writes.textContent).toBe(1);
        expect(runButton.writes).toEqual({ textContent: 0, title: 1, disabled: 1 });
        expect(targetButton.writes).toEqual({ textContent: 0, title: 1, disabled: 1 });

        state.enabled = false;
        state.globalEnabled = false;
        state.tokens = 0;
        context.updateAgentTokenCounter();
        context.updateAgentOverview();

        expect(tokenValue.textContent).toBe('0');
        expect(tokenValue.writes.textContent).toBe(2);
        expect(tokenCounter.classList.contains('is-empty')).toBe(true);
        expect(runButton.disabled).toBe(true);
        expect(runButton.title).toBe('Enable Agents to run this action.');
        expect(runButton.writes).toEqual({ textContent: 0, title: 2, disabled: 2 });
        expect(targetButton.disabled).toBe(true);
        expect(targetButton.title).toBe('Enable Agents to run this action.');
        expect(targetButton.writes).toEqual({ textContent: 0, title: 2, disabled: 2 });

        context.updateAgentTokenCounter();
        context.updateAgentOverview();

        expect(tokenValue.writes.textContent).toBe(2);
        expect(runButton.writes).toEqual({ textContent: 0, title: 2, disabled: 2 });
        expect(targetButton.writes).toEqual({ textContent: 0, title: 2, disabled: 2 });
    });
});
