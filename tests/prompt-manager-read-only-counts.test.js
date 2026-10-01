import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { areVariablesReadOnly, withReadOnlyVariables } from '../public/scripts/variable-read-only.js';

function source(path) {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function loadMethod(context, path, name) {
    const text = source(path);
    const classes = parse(text, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(node => node.declaration ?? node).filter(node => node.type === 'ClassDeclaration');
    const method = classes.flatMap(node => node.body.body).find(node => node.type === 'MethodDefinition' && node.key.name === name);
    return vm.runInContext(`({ ${text.slice(method.start, method.end)} }).${name}`, context);
}

describe('Prompt Manager token counts', () => {
    test('counting prompts for display never writes chat variables or saves the chat', async () => {
        const context = vm.createContext({
            areVariablesReadOnly,
            withReadOnlyVariables,
            chat_metadata: { variables: { mood: 'calm' } },
            saveMetadataDebounced: jest.fn(),
            readVariableValue: value => value,
            isCommentOnlyPromptContent: () => false,
            getPromptSourceTokenCounts: async prompts => Object.fromEntries(prompts.map(prompt => [prompt.identifier, prompt.content.length])),
        });
        const variables = source('../public/scripts/variables.js');
        for (const node of parse(variables, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
            const declaration = node.declaration ?? node;
            if (declaration.id?.name === 'setLocalVariable') vm.runInContext(variables.slice(declaration.start, declaration.end), context);
        }
        const populate = loadMethod(context, '../public/scripts/PromptManager.js', 'populateSourcePromptTokenCounts');
        const manager = {
            activeCharacter: {},
            tokenHandler: { countUntrackedAsync: async () => 0 },
            hasRuntimePromptTokenCounts: () => false,
            getPromptsForCharacter: () => [{ identifier: 'setter', content: '{{setvar::mood::excited}}' }, { identifier: 'main', content: 'Hello' }],
            shouldTrigger: () => true,
            preparePrompt: prompt => ({ ...prompt, content: prompt.identifier === 'setter' ? context.setLocalVariable('mood', 'excited') && '' : prompt.content }),
        };

        await populate.call(manager);

        expect(context.chat_metadata.variables.mood).toBe('calm');
        expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(manager.sourcePromptTokenCounts).toEqual({ setter: '{{setvar::mood::excited}}'.length, main: 5 });
        expect(manager.sourcePromptTokenUsage).toBe(5);
        expect(areVariablesReadOnly()).toBe(false);
    });
});
