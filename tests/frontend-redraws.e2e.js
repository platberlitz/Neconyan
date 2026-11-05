/* global window, MutationObserver */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

function source(file, ...names) {
    const text = readFileSync(new URL(`../public/scripts/${file}`, import.meta.url), 'utf8');
    return names.map(name => {
        const match = text.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
        if (!match) throw new Error(`Missing function: ${name}`);
        return match[0].replace(/^export /, '');
    }).join('\n');
}

const common = `
    const t = (strings, ...values) => strings.reduce((text, part, i) => text + part + (values[i] ?? ''), '');
    function mutations(root) {
        const observer = new MutationObserver(records => { observer.total += records.length; });
        observer.total = 0;
        observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
        return observer;
    }
`;

for (const phone of [false, true]) {
    test.describe(`${phone ? 'phone' : 'desktop'} redraws`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone });

        test('model searches retain identical results and refresh changed source options', async ({ page }) => {
            await page.setContent('<select id="models"><option value="alpha">Alpha model</option><option value="beta">Beta model</option></select>');
            await page.addScriptTag({ content: `${common}
                const lists = new WeakMap();
                const groupByModelFamily = items => [{ label: null, items }];
                ${source('model-list-search.js', 'attachModelListSearch')}
                window.list = attachModelListSearch(document.querySelector('select'));
            ` });
            const result = await page.evaluate(() => {
                const list = window.list;
                list.input.value = 'model';
                list.input.dispatchEvent(new Event('input'));
                const first = list.results.firstElementChild;
                const observer = new MutationObserver(() => {});
                observer.observe(list.results, { childList: true, subtree: true, attributes: true });
                for (const query of ['mo', 'MOD', 'model ', ' model']) {
                    list.input.value = query;
                    list.input.dispatchEvent(new Event('input'));
                }
                const idleMutations = observer.takeRecords().length;
                const retained = first === list.results.firstElementChild;
                list.select.options[0].textContent = 'Updated model';
                list.input.dispatchEvent(new Event('input'));
                const renamed = list.results.textContent;
                list.input.value = 'beta';
                list.input.dispatchEvent(new Event('input'));
                return { idleMutations, retained, renamed, remaining: list.results.textContent };
            });
            expect(result).toMatchObject({ idleMutations: 0, retained: true });
            expect(result.renamed).toContain('Updated model');
            expect(result.remaining).toContain('Beta model');
            expect(result.remaining).not.toContain('Updated model');
        });

        test('live replies retain their bubble, dots and stop button while text and counts update', async ({ page }) => {
            await page.setContent('<div id="timeline"><div id="saved">Saved message</div></div>');
            await page.addScriptTag({ content: `${common}
                const conversationState = { imageGenerationActive: true };
                const getCurrentCharName = () => 'Aster';
                const getThumbnailUrlForViewport = () => 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
                const default_user_avatar = '';
                const getPrimaryTypingParticipant = () => null;
                const getPositiveTokenCount = value => Math.max(0, Number(value) || 0);
                ${source('message-token-counts.js', 'updateMessageTokenCounts')}
                ${source('neconyan-conversation/timeline-render.js', 'placeTimelineChildAfter', 'syncTimelineTransientNodes')}
                window.run = () => {
                    const timeline = document.querySelector('#timeline');
                    const participant = { avatar: 'a.png', name: 'Aster', token_count: 0 };
                    const options = { avatar: 'a.png', settings: { streaming: true }, followingLatest: true };
                    const render = () => syncTimelineTransientNodes(timeline, [participant], options);
                    render();
                    const bubble = timeline.querySelector('.sb-conversation-typing-indicator');
                    const dots = bubble.querySelector('.sb-conversation-typing-dots').firstElementChild;
                    const stop = timeline.querySelector('button');
                    stop.focus();
                    const observer = mutations(timeline);
                    for (let i = 0; i < 20; i++) render();
                    const idleMutations = observer.takeRecords().length;
                    const dotsRetained = dots === bubble.querySelector('.sb-conversation-typing-dots').firstElementChild;
                    for (let i = 1; i <= 50; i++) {
                        participant.text = 'Reply ' + i;
                        participant.token_count = i;
                        render();
                    }
                    const result = { idleMutations, dotsRetained,
                        bubbleRetained: bubble === timeline.querySelector('.sb-conversation-typing-indicator'),
                        stopRetained: stop === timeline.querySelector('button') && document.activeElement === stop,
                        text: bubble.querySelector('.sb-conversation-live-text').textContent,
                        count: bubble.querySelector('.nn-output-tokens').textContent };
                    options.settings.streaming = false;
                    render();
                    result.dotsRestored = bubble.querySelectorAll('.sb-conversation-typing-dots > span').length;
                    options.followingLatest = false;
                    render();
                    result.historyOnly = timeline.children.length === 1 && timeline.firstElementChild.id === 'saved';
                    options.followingLatest = true;
                    conversationState.imageGenerationActive = false;
                    syncTimelineTransientNodes(timeline, [participant, { avatar: 'b' }, { avatar: 'c' }].map(p => ({ ...p, token_count: undefined })), options);
                    result.groupTyping = timeline.textContent.includes('Several people are typing');
                    const partner = { avatar: 'b', name: 'Partner', text: 'Still typing', token_count: 3 };
                    syncTimelineTransientNodes(timeline, [participant, partner], options);
                    const partnerNode = timeline.lastElementChild;
                    syncTimelineTransientNodes(timeline, [partner], options);
                    result.partnerRetained = timeline.lastElementChild === partnerNode;
                    return result;
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, dotsRetained: true,
                bubbleRetained: true, stopRetained: true, text: 'Reply 50', count: '50t', dotsRestored: 3, historyOnly: true, groupTyping: true, partnerRetained: true });
        });

        test('history controls retain focus and only change their disabled state while editing', async ({ page }) => {
            await page.setContent('<div id="timeline"><div class="sb-conversation-message" data-message-id="saved">Saved message</div></div>');
            await page.addScriptTag({ content: `${common}
                ${source('neconyan-conversation/timeline-render.js', 'placeTimelineChildAfter', 'findTimelineHistoryControl', 'createTimelineHistoryControlButton', 'syncConversationTimelineHistoryControls', 'syncConversationTimelineHistoryControlsDisabledState', 'hasActiveTimelineMessageEdit', 'getPersistedConversationMessageNodes', 'isPersistedConversationMessageNode')}
                window.run = () => {
                    const timeline = document.querySelector('#timeline');
                    const descriptor = { hasOlder: true, hasNewer: true };
                    syncConversationTimelineHistoryControls(timeline, descriptor);
                    const newer = timeline.querySelector('[data-sb-conversation-action="timeline-newer"]'); newer.focus();
                    const observer = mutations(timeline);
                    for (let i = 0; i < 20; i++) syncConversationTimelineHistoryControls(timeline, descriptor);
                    const idleMutations = observer.takeRecords().length;
                    const retained = newer.isConnected && document.activeElement === newer;
                    const message = timeline.querySelector('[data-message-id]'); message.classList.add('is-editing');
                    syncConversationTimelineHistoryControls(timeline, descriptor);
                    const disabled = [...timeline.querySelectorAll('button')].every(button => button.disabled);
                    message.classList.remove('is-editing'); syncConversationTimelineHistoryControls(timeline, descriptor);
                    const enabled = [...timeline.querySelectorAll('button')].every(button => !button.disabled);
                    syncConversationTimelineHistoryControls(timeline, { hasOlder: true, hasNewer: false });
                    return { idleMutations, retained, disabled, enabled, newerRemoved: !newer.isConnected, older: timeline.querySelectorAll('button').length };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, retained: true, disabled: true, enabled: true, newerRemoved: true, older: 1 });
        });

        test('lorebooks keep rows on duplicate events and apply hidden changes when reopened', async ({ page }) => {
            await page.setContent('<select id="world_editor_select"><option value="">None</option><option value="0">Alpha</option></select><div id="WorldInfo"><section id="library"><p class="neconyan-lorebook-selected"></p><div class="neconyan-lorebook-folders"></div><div class="neconyan-lorebook-books"></div></section></div>');
            await page.addScriptTag({ content: `${common}
                const nativeState = { lorebookFolder: 'all', lorebookQuery: '', lorebookBrowsing: false };
                const lorebookLibrarySnapshots = new WeakMap();
                const metadata = { folders: [{ id: 'folder', name: 'Folder' }], assignments: {} };
                const names = ['Alpha', 'Beta'];
                const getNeconyanLorebookFolders = () => metadata;
                const getLorebookNames = () => names;
                const getLorebookFolderName = (metadata, id) => metadata.folders.find(f => f.id === id)?.name || 'Unfiled';
                function element(tag, className, text = '') { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
                const button = (text, className) => element('button', className, text);
                const selectLorebook = name => { window.selected = name; };
                ${source('neconyan-native-workspaces.js', 'renderLorebookLibrary')}
                window.run = () => {
                    const library = document.querySelector('#library');
                    const books = library.querySelector('.neconyan-lorebook-books');
                    renderLorebookLibrary(library);
                    const first = books.firstElementChild;
                    const observer = mutations(library);
                    for (let i = 0; i < 20; i++) renderLorebookLibrary(library);
                    const idleMutations = observer.takeRecords().length;
                    const retained = books.firstElementChild === first;
                    document.querySelector('select').value = '0';
                    renderLorebookLibrary(library);
                    names.push('Gamma');
                    metadata.assignments.Gamma = 'folder';
                    metadata.folders[0].name = 'Renamed folder';
                    renderLorebookLibrary(library);
                    const hiddenRetained = books.firstElementChild === first && books.children.length === 2;
                    nativeState.lorebookBrowsing = true;
                    renderLorebookLibrary(library);
                    const latest = books.textContent.includes('Gamma') && books.textContent.includes('Renamed folder');
                    nativeState.lorebookQuery = 'gamma';
                    renderLorebookLibrary(library);
                    books.querySelector('button').click();
                    return { idleMutations, retained, hiddenRetained, latest, filtered: books.children.length, selected: window.selected };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, retained: true, hiddenRetained: true, latest: true, filtered: 1, selected: 'Gamma' });
        });

        test('top bar and guide counter do not rewrite unchanged labels', async ({ page }) => {
            await page.setContent('<div class="sb-topbar-brand"><span id="sb-topbar-title"></span></div><button id="gg_flush_guides_button"></button>');
            await page.addScriptTag({ content: `${common}
                let label = 'Aster'; let count = 0; let fits = 0;
                const nnState = { topbarLabel: { renderFrame: 0 } };
                const getSillyTavernContext = () => ({});
                const getTopBarLabel = () => label;
                const hasActiveTopBarChat = () => true;
                const bindTopBarTitleCycle = () => {};
                const isTopbarLabelClickCycleEnabled = () => true;
                const queueTopbarBrandFit = () => fits++;
                const getActiveGuides = () => Array(count).fill({});
                ${source('neconyan-tabs.js', 'updateTopBarBrand', 'queueTopBarBrandUpdate')}
                ${source('extensions/guided-generations/index.js', 'updateFlushGuideButton', 'getFlushGuideButtonLabel')}
                window.run = async () => {
                    updateTopBarBrand(); updateFlushGuideButton(); fits = 0;
                    const observer = mutations(document.body);
                    for (let i = 0; i < 20; i++) { queueTopBarBrandUpdate(); updateFlushGuideButton(); }
                    await new Promise(requestAnimationFrame);
                    const idleMutations = observer.total + observer.takeRecords().length;
                    const renders = fits;
                    label = 'Changed'; count = 2;
                    updateTopBarBrand(); updateFlushGuideButton();
                    return { idleMutations, renders, title: document.querySelector('#sb-topbar-title').textContent,
                        guides: document.querySelector('button').dataset.activeCount };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, renders: 1, title: 'Changed', guides: '2' });
        });

        test('terminal status bursts share an observer and unchanged status leaves the page untouched', async ({ page }) => {
            await page.setContent('<div id="sb_conversation_timeline"></div><div id="status"></div><button id="details"></button>');
            await page.addScriptTag({ content: `${common}
                let active = true, renderSequence = 0, lastStatusText = '', lastPromptIdentity = '', lastPromptTokens = null;
                let conversationObserver = null, observedConversationTimeline = null, conversationStatusTimer = null;
                let refreshes = 0, disconnected = false;
                const STATUS_DETAILS_ID = 'details';
                const getSettings = () => ({ enabled: true });
                const ensureStatusline = () => document.querySelector('#status');
                const ctx = () => ({});
                const isConversationMode = () => true;
                const conversationStatus = async () => ({ name: 'Aster' });
                const scopedConversationConnection = () => null;
                const connectionSummary = async () => ({ text: 'Connected' });
                const statusIdentity = () => '';
                const parseCount = () => 100;
                const formatCount = String;
                const cleanStatusPart = value => value;
                const currentRunState = () => disconnected ? 'disconnected' : 'idle';
                const ensureConversationAutocomplete = () => { refreshes++; };
                ${source('extensions/third-party/Neconyan-Terminal-UI/index.js', 'renderStatusline', 'observeConversationTimeline', 'queueConversationStatusRefresh')}
                window.run = async () => {
                    await renderStatusline(); observeConversationTimeline();
                    const original = conversationObserver;
                    const observer = mutations(document.body);
                    for (let i = 0; i < 20; i++) queueConversationStatusRefresh();
                    await new Promise(resolve => setTimeout(resolve, 20));
                    const idleMutations = observer.total + observer.takeRecords().length;
                    const sameObserver = original === conversationObserver;
                    const burstRefreshes = refreshes;
                    disconnected = true;
                    await renderStatusline();
                    const action = document.querySelector('#details').dataset.action;
                    const old = document.querySelector('#sb_conversation_timeline');
                    const replacement = old.cloneNode(); old.replaceWith(replacement);
                    observeConversationTimeline();
                    const replacedObserver = conversationObserver !== original && observedConversationTimeline === replacement;
                    active = false;
                    queueConversationStatusRefresh();
                    return { idleMutations, sameObserver, burstRefreshes, action, replacedObserver, timer: conversationStatusTimer };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, sameObserver: true,
                burstRefreshes: 1, action: 'connect', replacedObserver: true, timer: null });
        });

        test('recent chats retain unchanged rows and refresh changed click targets', async ({ page }) => {
            await page.setContent('<div id="neconyan-workspace-rail"><div data-neconyan-recent-list></div></div>');
            await page.addScriptTag({ content: `${common}
                const neconyanRailRecentSnapshots = new WeakMap();
                const translate = text => text;
                const PinnedChatsManager = { getKey: chat => chat.file_name };
                const openNeconyanRecentChat = chat => { window.opened = chat.file_name; };
                function createNeconyanRailButton({label, onClick}) {
                    const button = document.createElement('button'); button.textContent = label;
                    button.addEventListener('click', onClick); return button;
                }
                ${source('welcome-screen.js', 'getNeconyanRecentChatLabel', 'isNeconyanRecentChatLabelNamed', 'renderNeconyanRailRecentChats')}
                window.run = () => {
                    const chats = [{ chat_name: 'Chat one', char_name: 'Aster', file_name: 'one.jsonl' }];
                    renderNeconyanRailRecentChats(chats);
                    const first = document.querySelector('button'); first.focus();
                    const observer = mutations(document.body);
                    for (let i = 0; i < 20; i++) renderNeconyanRailRecentChats(structuredClone(chats));
                    const idleMutations = observer.takeRecords().length;
                    const retained = document.activeElement === first && first.isConnected;
                    chats[0].file_name = 'two.jsonl';
                    renderNeconyanRailRecentChats(chats); document.querySelector('button').click();
                    const opened = window.opened;
                    renderNeconyanRailRecentChats([]);
                    return { idleMutations, retained, opened, empty: document.querySelector('[data-neconyan-recent-list]').textContent };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, retained: true, opened: 'two.jsonl', empty: 'No recent chats' });
        });

        test('Story Mode leaves unchanged passage markers and reasoning editors untouched', async ({ page }) => {
            await page.setContent('<div id="chat"><div class="mes" mesid="0"><details><textarea class="reasoning_edit_textarea"></textarea></details></div></div>');
            await page.addScriptTag({ content: `${common}
                const BODY_CLASS = 'story'; document.body.classList.add(BODY_CLASS);
                const api = { ctx: () => ({ chat: [{}] }), getSettings: () => ({ shading: false }) };
                let origin = 'model';
                const computeJoins = () => new Set([0]);
                const classifyBlock = () => ({ origin });
                const unwrapTail = () => {}; const updateThinkingButton = () => {};
                let transformRequest = null, lastEditor = null, cancelEditorReveal = null;
                const hideRow = () => {};
                ${source('extensions/third-party/Neconyan-Story-Mode/src/ui.js', 'stampBlocks', 'checkEditor')}
                window.run = () => {
                    stampBlocks(); checkEditor();
                    const observer = mutations(document.body);
                    for (let i = 0; i < 20; i++) { stampBlocks(); checkEditor(); }
                    const idleMutations = observer.takeRecords().length;
                    origin = 'user'; stampBlocks();
                    return { idleMutations, origin: document.querySelector('.mes').dataset.sbstoryOrigin,
                        open: document.querySelector('details').open };
                };
            ` });
            expect(await page.evaluate(() => window.run())).toEqual({ idleMutations: 0, origin: 'user', open: true });
        });
    });
}
