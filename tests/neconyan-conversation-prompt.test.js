import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeChatroomPromptSettings, compileChatroomPrompt } from '../public/scripts/neconyan-conversation/shared-helpers.js';
import { DEFAULT_CHATROOM_PROMPT } from '../public/scripts/neconyan-conversation/constants.js';

describe('conversation instruction compatibility', () => {
    test('preserves older saved text without mutating the saved object', () => {
        const old = { legacy_chatroom_prompt: 'My instructions for {{char}} and {{user}}', other: 3 };
        expect(normalizeChatroomPromptSettings(old)).toEqual({ chatroom_prompt: old.legacy_chatroom_prompt, other: 3 });
        expect(old.legacy_chatroom_prompt).toBe('My instructions for {{char}} and {{user}}');
        expect(compileChatroomPrompt(old, 'Mira', 'Alex')).toBe('My instructions for Mira and Alex');
    });
    test('prefers explicitly saved current text and leaves ambiguous legacy data intact', () => {
        expect(normalizeChatroomPromptSettings({ legacy_chatroom_prompt: 'old', chatroom_prompt: 'new' })).toEqual({ chatroom_prompt: 'new' });
        const ambiguous = { first_chatroom_prompt: 'one', second_chatroom_prompt: 'two' };
        expect(normalizeChatroomPromptSettings(ambiguous)).toEqual(ambiguous);
    });
    test('normalizes each client settings layer before merging defaults', () => {
        const source = readFileSync(new URL('../public/scripts/neconyan-conversation/settings-store.js', import.meta.url), 'utf8');
        const method = source.match(/export function mergeConversationSettingsLayers\([\s\S]*?^}/m)[0].replace('export ', '');
        const context = vm.createContext({ normalizeChatroomPromptSettings });
        vm.runInContext(method, context);
        expect(context.mergeConversationSettingsLayers({ chatroom_prompt: 'default' }, { legacy_chatroom_prompt: 'custom' }).chatroom_prompt).toBe('custom');
    });
    test('normalizes server overrides before applying defaults', () => {
        const source = readFileSync(new URL('../src/endpoints/conversation-generation.js', import.meta.url), 'utf8');
        const method = source.match(/export function getConversationSettings\([\s\S]*?^}/m)[0].replace('export ', '');
        const context = vm.createContext({
            normalizeChatroomPromptSettings, getObject: value => value || {},
            DEFAULT_SETTINGS: { chatroom_prompt: 'default' },
            getConversationThreadStore: () => ({ settings: { legacy_chatroom_prompt: 'thread' } }),
            getGroupConversationSettings: () => ({}), normalizeConversationSettings: value => value,
        });
        vm.runInContext(method, context);
        const resolved = context.getConversationSettings({}, { settings: {} }, 'mira.png', '', { legacy_chatroom_prompt: 'override' });
        expect(resolved.chatroom_prompt).toBe('override');
    });
    test('new default instructions preserve character and custom-instruction placeholders', () => {
        const result = compileChatroomPrompt({ custom_instructions: 'Keep replies short.' }, 'Mira', 'Alex', DEFAULT_CHATROOM_PROMPT);
        expect(result).toContain('Mira');
        expect(result).toContain('Alex');
        expect(result).toContain('Keep replies short.');
        expect(result).not.toContain('{{');
    });
});
