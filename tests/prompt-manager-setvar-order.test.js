import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { promptSetsVariables } from '../public/scripts/prompt-variable-names.js';

function loadGetPromptCollection(context) {
    const text = readFileSync(new URL('../public/scripts/PromptManager.js', import.meta.url), 'utf8');
    const method = parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(node => node.declaration ?? node)
        .filter(node => node.type === 'ClassDeclaration')
        .flatMap(node => node.body.body)
        .find(node => node.type === 'MethodDefinition' && node.key.name === 'getPromptCollection');
    return vm.runInContext(`({ ${text.slice(method.start, method.end)} }).getPromptCollection`, context);
}

class FakePromptCollection {
    collection = [];
    add(...prompts) {
        this.collection.push(...prompts);
    }
}

function createManager(prompts, order) {
    const variables = {};
    const prepared = [];
    const context = vm.createContext({ PromptCollection: FakePromptCollection, promptSetsVariables, structuredClone });
    const getPromptCollection = loadGetPromptCollection(context);
    const manager = {
        activeCharacter: {},
        getPromptOrderForCharacter: () => order,
        getPromptById: identifier => prompts.find(prompt => prompt.identifier === identifier),
        shouldTrigger: () => true,
        preparePrompt: prompt => {
            prepared.push(prompt.identifier);
            const content = String(prompt.content ?? '')
                .replace(/{{setvar::([^:]+)::([^}]*)}}/g, (_, name, value) => {
                    variables[name] = value;
                    return '';
                })
                .replace(/{{getvar::([^}]+)}}/g, (_, name) => variables[name] ?? '');
            return { ...prompt, content };
        },
    };
    return { manager, variables, prepared, getPromptCollection };
}

describe('Prompt Manager variable order', () => {
    test('a prompt above a setvar toggle reads the value set in the same reply', () => {
        const prompts = [
            { identifier: 'main', content: 'Main prompt' },
            { identifier: 'formatting', content: 'Rules: {{getvar::writefor}} / {{getvar::length}}' },
            { identifier: 'writeForUser', content: '{{setvar::writefor::Write for the user too.}}' },
            { identifier: 'flexible', content: '{{setvar::length::Any length.}}' },
        ];
        const order = prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true }));
        const { manager, variables, prepared, getPromptCollection } = createManager(prompts, order);

        const collection = getPromptCollection.call(manager, 'normal');

        expect(collection.collection.map(prompt => prompt.identifier)).toEqual(['main', 'formatting', 'writeForUser', 'flexible']);
        expect(collection.collection[1].content).toBe('Rules: Write for the user too. / Any length.');
        expect(variables).toEqual({ writefor: 'Write for the user too.', length: 'Any length.' });
        expect(prepared).toEqual(['writeForUser', 'flexible', 'main', 'formatting']);
    });

    test('disabled setters are skipped and a disabled main prompt keeps its empty placeholder', () => {
        const prompts = [
            { identifier: 'main', content: 'Main prompt' },
            { identifier: 'formatting', content: '[{{getvar::writefor}}]' },
            { identifier: 'writeForUser', content: '{{setvar::writefor::yes}}' },
        ];
        const order = [
            { identifier: 'main', enabled: false },
            { identifier: 'formatting', enabled: true },
            { identifier: 'writeForUser', enabled: false },
            { identifier: 'missing', enabled: true },
        ];
        const { manager, variables, getPromptCollection } = createManager(prompts, order);

        const collection = getPromptCollection.call(manager, 'normal');

        expect(collection.collection.map(prompt => [prompt.identifier, prompt.content])).toEqual([['main', ''], ['formatting', '[]']]);
        expect(variables).toEqual({});
    });

    test('detects inline, spaced and scoped setvar macros only', () => {
        expect(promptSetsVariables('{{setvar::a::b}}')).toBe(true);
        expect(promptSetsVariables('{{setGlobalVar flag on}}')).toBe(true);
        expect(promptSetsVariables('{{setvar::a}}long text{{/setvar}}')).toBe(true);
        expect(promptSetsVariables('{{getvar::a}} {{incvar::count}}')).toBe(false);
        expect(promptSetsVariables(undefined)).toBe(false);
    });
});
