import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = tabsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = tabsSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return tabsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('chat bar refresh guard', () => {
    test('skips the chat list request while both lists are closed and nothing changed', () => {
        const source = getFunctionSource('refreshChatbarState');

        expect(source).toContain('const listsVisible = areChatFileListsVisible();');
        expect(source).toContain('!listsVisible');
        expect(source).toContain('chatbarState.renderedListing?.contextKey === contextKey');
        expect(source).toContain('chatbarState.renderedListing?.revision === chatbarListingRevision');
        expect(source).toContain('chatbarState.renderedListing = { contextKey, revision: chatbarListingRevision };');
    });

    test('rebuilds a chat list only when the rows differ or the list is open', () => {
        const source = getFunctionSource('refreshChatbarState');

        expect(source).toContain('const filesSignature = JSON.stringify([chatContext.chatId, files.map(chat => [');
        expect(source).toContain('renderedFiles.sidebarSignature !== filesSignature');
        expect(source).toContain('if (isChatSidebarOpen() && renderedFiles.sidebarSignature !== filesSignature) {');
        expect(source).toContain('if (isMobileViewport() && chatbarState.mobileToolsOpen && renderedFiles.mobileSignature !== filesSignature) {');
    });

    test('skips rebuilding a chat select whose options already match', () => {
        const source = getFunctionSource('populateChatSelector');

        expect(source).toContain('const signature = JSON.stringify([placeholder, currentValue, uniqueChats.map(chat => [chat.fileName, chat.tokenEstimate])]);');
        expect(source).toContain('if (select.dataset.nnChatSelectorSignature === signature) {');
        expect(source).toContain('select.dataset.nnChatSelectorSignature = signature;');
    });

    test('keeps the bottom chat picker list until it opens or the listing changes', () => {
        const source = getFunctionSource('refreshBottomChatSelect');

        expect(source).toContain('const pickerOpen = state.chatPickerButton?.getAttribute(\'aria-expanded\') === \'true\';');
        expect(source).toContain('const hasCachedListing = !pickerOpen');
        expect(source).toContain('state.chatList?.revision === chatbarListingRevision');
        expect(source).toContain('if (!chatContext.context || hasCachedListing) {');
        expect(source).toContain('revision: chatbarListingRevision');
    });

    test('marks the listing stale on a rename, create, delete or switch', () => {
        const source = getFunctionSource('invalidateInFlightCharacterChatFileListings');

        expect(source).toContain('characterChatFileListingGeneration += 1;');
        expect(source).toContain('chatbarListingRevision += 1;');
    });

    test('keeps connection-only events away from the chat list request', () => {
        const source = getFunctionSource('bindChatbarEvents');

        expect(source).toContain('const refreshConnection = () => scheduleChatbarConnectionRefresh(0);');
        expect(source).toContain('const connectionEvents = [');
        expect(source).toContain('eventTypes.CONNECTION_PROFILE_LOADED,');
        expect(source).toContain('eventTypes.MAIN_API_CHANGED,');
        expect(source).toContain('eventTypes.ONLINE_STATUS_CHANGED,');
        expect(source).toContain('eventTypes.SETTINGS_UPDATED,');
        expect(source).toContain('eventSource.on(eventName, refreshConnection);');
    });
});
