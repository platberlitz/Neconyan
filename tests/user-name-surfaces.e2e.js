/* global window, document, localStorage, CSS, NodeFilter, globalThis, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// The token sweep. Every kind of named thing the interface lets a person choose is seeded with a token name that is not a dictionary
// key ('NmLorebookQ'). The page's supplement dictionary is served with one extra entry per token, token -> '⟦token⟧'. The real
// run-time localiser then turns any UNPROTECTED occurrence of a token into '⟦token⟧', and a scan of every text node, option text,
// title, aria-label and placeholder records what happened. The scan does not depend on which dictionary keys exist.
//
// Classes: W = the whole string is the name and shows '⟦' (the name was translated); H = the name sits in a composed caption and
// the caption shows '⟦' (a hole lookup translated it); R = the name sits on an unprotected element and shows no '⟦' today;
// P = protected (as written). Each test visits all its screens, writes surfaces.json and preservation.json, and asserts once at the end.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = process.env.NECONYAN_NAME_SWEEP_OUT || '';
const BASE_OUT = process.env.NECONYAN_NAME_SWEEP_BASE || '';
const FULL = process.env.NECONYAN_NAME_SWEEP === 'full';
const SHOTS = process.env.NECONYAN_NAME_SWEEP_SHOTS || '';
const HOLES_OFF = process.env.NECONYAN_NAME_SWEEP_HOLES === 'off';
const ONLY = (process.env.NECONYAN_NAME_SWEEP_ONLY || '').split(',').filter(Boolean);
const LANGS = (process.env.NECONYAN_NAME_SWEEP_LANGS || 'pt-pt').split(',').filter(Boolean);
const OPEN = '⟦';
const CLOSE = '⟧';

/** Every token name. None is a dictionary key; the seeds below use exactly these spellings. */
export const TOKENS = {
    character: 'NmCharacterQ', group: 'NmGroupQ', persona: 'NmPersonaQ', branch: 'NmBranchQ', convGroup: 'NmConvGroupQ',
    chatFile: 'NmChatFileQ', textgenPreset: 'NmTextgenPresetQ', oaiPreset: 'NmOaiPresetQ', contextPreset: 'NmContextPresetQ',
    instructPreset: 'NmInstructPresetQ', syspromptPreset: 'NmSyspromptPresetQ', lorebook: 'NmLorebookQ', lorebookFolder: 'NmLoreFolderQ',
    entryTitle: 'NmEntryTitleQ', entryFolder: 'NmEntryFolderQ', profile: 'NmProfileQ', profile2: 'NmProfileTwoQ', profile3: 'NmProfileThreeQ', profileFolder: 'NmProfileFolderQ',
    movingUI: 'NmMovingUIQ', theme: 'NmThemeQ', notebook: 'NmNotebookQ', note: 'NmNoteQ', template: 'NmTemplateQ', agent: 'NmAgentQ',
    setup: 'NmSetupQ', qrSet: 'NmQrSetQ', qrLabel: 'NmQrLabelQ', prompt: 'NmPromptQ', authorsNote: 'NmAuthorsNoteQ',
    logitBias: 'NmLogitBiasQ', proxy: 'NmProxyQ', endpoint: 'NmEndpointQ', tag: 'NmTagQ', tagFolder: 'NmTagFolderQ', tag2: 'NmTagTwoQ',
    regex: 'NmRegexQ', scratchpad: 'NmScratchpadQ', bookmark: 'NmBookmarkQ',
};
const TOKEN_LIST = Object.values(TOKENS);

/**
 * Occurrences that stay unprotected on purpose (rule C(c)): a caption built with t after initLocales. Entries only by rule C(c), each
 * with file:line and the reason. Starts empty.
 * @type {Array<{screen: string, path: string, attr: string, token: string, source: string, reason: string}>}
 */
export const ACCEPTED_R = [
    { path: '#expression_owner > option[3] > text[1]', attr: '', token: 'NmPersonaQ', source: 'public/scripts/extensions/expressions/index.js:155', reason: 'row 6: built with t after initLocales' },
    { path: '#ica--agentList > div[5] > div[1] > div[1] > div[1] > button[1]', attr: 'aria-label', token: 'NmAgentQ', source: 'public/scripts/extensions/in-chat-agents/index.js:3872', reason: 'row 7: built with t after initLocales' },
    { path: '#ica--agentList > div[5] > div[1] > div[1] > div[3] > div[1] > div[1] > button[2]', attr: 'aria-label', token: 'NmAgentQ', source: 'public/scripts/extensions/in-chat-agents/index.js:3903', reason: 'row 7: built with t after initLocales' },
    { path: '#neconyan-lorebook-library > div[4] > article[1] > button[1]', attr: 'aria-label', token: 'NmLorebookQ', source: 'public/scripts/neconyan-native-workspaces.js:564', reason: 'row 11: built with t after initLocales' },
    { path: '#sb_character_chat_import_target > text[1]', attr: '', token: 'NmCharacterQ', source: 'public/scripts/neconyan-tabs.js:10206', reason: 'row 18: built with t after initLocales' },
    { path: '#sb-bottom-chat-picker-button', attr: 'title', token: 'NmCharacterQ', source: 'public/scripts/neconyan-tabs.js:20814', reason: 'row 19: built with t after initLocales' },
    { path: '#extension_floating_chara_notes > li[2] > label[1] > input[1]', attr: 'aria-label', token: 'NmAuthorsNoteQ', source: 'public/scripts/authors-note.js:723', reason: 'row 56: built with t after initLocales' },
    { path: '#extension_floating_chara_notes > li[2] > button[1]', attr: 'title', token: 'NmAuthorsNoteQ', source: 'public/scripts/authors-note.js:727', reason: 'row 56: built with t after initLocales' },
    { path: '#persona_author_note_status > text[1]', attr: '', token: 'NmAuthorsNoteQ', source: 'public/scripts/authors-note.js:896', reason: 'row 57: built with t after initLocales' },
];

/** The page's own userText selector, read from the checkout so the scan and the localiser cannot disagree. */
async function readUserText() {
    const source = await fs.readFile(path.join(root, 'public/scripts/ui-localization.js'), 'utf8');
    const literal = source.match(/const userText = (\[[^]*?\])\.join\(','\);/)?.[1];
    if (!literal) throw new Error('userText literal not found in ui-localization.js');
    return new Function(`return ${literal};`)().join(',');
}

/** Runs in the page. Returns { surfaces, preservation } for the whole document. */
function scanDocument({ tokens, userText }) {
    const nonTextareaUserText = userText.split(',').filter(selector => selector !== 'textarea').join(',');
    const open = '⟦';
    const close = '⟧';
    // An id with a digit in it is generated (a counter or an index), so it never anchors a path.
    const stable = id => Boolean(id) && /^[A-Za-z][\w-]*$/.test(id) && !/^select2-/.test(id) && !/\d/.test(id)
        && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
    const pathOf = el => {
        const parts = [];
        for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            if (stable(node.id)) { parts.unshift(`#${node.id}`); break; }
            const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
            parts.unshift(`${node.tagName.toLowerCase()}[${siblings.indexOf(node) + 1}]`);
        }
        return parts.join(' > ');
    };
    const shown = el => {
        const host = el.tagName === 'OPTION' || el.tagName === 'OPTGROUP' ? (el.closest('select') || el) : el;
        if (host.closest('.select2-container--open, .select2-dropdown')) return host.checkVisibility?.({ checkVisibilityCSS: true }) ?? true;
        const rect = host.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (host.checkVisibility?.({ checkVisibilityCSS: true }) ?? true);
    };
    const tokenList = Object.values(tokens);
    const surfaces = [];
    const preservation = [];
    const add = (kind, attr, where, string) => {
        const marked = tokenList.filter(token => string.includes(open + token + close));
        const bare = string.split(/⟦[^⟧]*⟧/).join('');
        const plain = tokenList.filter(token => bare.includes(token));
        if (!marked.length && !plain.length) {
            preservation.push({ path: where.path, kind, attr, text: string });
            return;
        }
        let klass;
        let found;
        if (marked.length) {
            const rest = string.split(/⟦[^⟧]*⟧/).join('');
            klass = /[\p{L}\p{N}]/u.test(rest) ? 'H' : 'W';
            found = marked;
        } else {
            klass = where.element.closest(kind === 'attr' ? nonTextareaUserText : userText) ? 'P' : 'R';
            found = plain;
        }
        const bareText = string.split(/⟦[^⟧]*⟧/).join('').trim();
        for (const token of found) {
            surfaces.push({ path: where.path, kind, attr, token, class: klass, string, shown: shown(where.element), whole: string.trim() === token || string.trim() === open + token + close, composed: bareText !== token && string.trim() !== open + token + close });
        }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const counts = new Map();
    let node;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, template, noscript')) continue;
        const text = node.data.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const base = pathOf(parent);
        const index = (counts.get(base) || 0) + 1;
        counts.set(base, index);
        add('text', '', { path: `${base} > text[${index}]`, element: parent }, text);
    }
    for (const el of document.body.querySelectorAll('[title], [aria-label], [placeholder]')) {
        if (el.closest('script, style, template, noscript')) continue;
        for (const attr of ['title', 'aria-label', 'placeholder']) {
            const value = el.getAttribute(attr)?.replace(/\s+/g, ' ').trim();
            if (value) add('attr', attr, { path: pathOf(el), element: el }, value);
        }
    }
    return { surfaces, preservation };
}


const lorebookEntry = (uid, comment, extra = {}) => ({
    uid, key: [`key${uid}`], keysecondary: [], comment, content: 'Some text.', constant: false, vectorized: false, selective: true,
    selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
    delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, sticky: null,
    cooldown: null, delay: null, displayIndex: uid, ...extra,
});

/**
 * Seeds every kind of named thing with its token, through the app's endpoints and in-page APIs. Each seed is tried on its own; a
 * failure is recorded and the screens that need it fail their 'must show' check, so a silent miss cannot pass.
 */
async function seedAccount({ account }) {
    const errors = [];
    const attempt = async (label, work) => {
        try { await work(); } catch (error) { errors.push(`${label}: ${String(error.message || error).split('\n')[0]}`); }
    };
    const { post, context, headers } = account;
    // Some endpoints answer with a bare status, not JSON.
    const plain = async (route, data) => { const response = await context.request.post(route, { headers, data }); expect(response.ok(), route).toBe(true); };
    const created = {};
    await attempt('character', async () => {
        const response = await context.request.post('/api/characters/create', { headers, data: {
            ch_name: TOKENS.character, description: `${TOKENS.character} belongs to this account.`, first_mes: 'Hello.', mes_example: '', tags: '',
        } });
        expect(response.ok()).toBe(true);
        created.characterAvatar = await response.text();
    });
    await attempt('group', async () => {
        await post('/api/groups/create', { name: TOKENS.group, members: [account.avatar, created.characterAvatar].filter(Boolean), avatar_url: '', chat_id: '', chats: [] });
    });
    await attempt('conversation branch and group', async () => {
        await account.changeStore(store => {
            const slot = store.characters[account.threadKey];
            slot.branches.br_nm = { ...structuredClone(slot.branches[slot.activeBranchId]), id: 'br_nm', name: TOKENS.branch, lifetimeSeed: 'nm-branch-seed' };
            store.groups = [...(store.groups || []), { id: 'conversation_nm_1', personaId: account.personaId, name: TOKENS.convGroup,
                members: [account.avatar, created.characterAvatar], disabled_members: [], is_conversation_group: true, createdAt: 1700000000000, updatedAt: 1700000000000 }];
        });
    });
    await attempt('notebook', async () => {
        const made = await post('/api/notebooks/create', { name: TOKENS.notebook, operationId: 'nm-notebook-1' });
        const notebookId = made.notebook?.id ?? made.result?.notebook?.id;
        if (!notebookId) throw new Error('no notebook id: ' + JSON.stringify(made).slice(0, 160));
        await post('/api/notebooks/notes/create', { notebookId, operationId: 'nm-note-1', title: TOKENS.note, text: 'A note.' });
    });
    await attempt('lorebook', async () => {
        const entries = { 0: lorebookEntry(0, TOKENS.entryTitle), 1: lorebookEntry(1, 'Plain entry') };
        // Created a second apart, so a list sorted by file time has one order on every run.
        await post('/api/worldinfo/edit', { name: 'Plain lorebook', data: { entries: { 0: lorebookEntry(0, 'Another entry') } } });
        await sleep(1200);
        await post('/api/worldinfo/edit', { name: TOKENS.lorebook, data: { entries } });
    });
    for (const [label, apiId, name, preset] of [
        ['text-generation preset', 'textgenerationwebui', TOKENS.textgenPreset, { temp: 0.7, genamt: 100, max_length: 4096 }],
        ['context preset', 'context', TOKENS.contextPreset, { name: TOKENS.contextPreset, story_string: '{{system}}', example_separator: '', chat_start: '' }],
        ['instruct preset', 'instruct', TOKENS.instructPreset, { name: TOKENS.instructPreset, input_sequence: '', output_sequence: '', system_sequence: '' }],
        ['system prompt preset', 'sysprompt', TOKENS.syspromptPreset, { name: TOKENS.syspromptPreset, content: 'You are helpful.' }],
        ['chat completion preset', 'openai', TOKENS.oaiPreset, { temperature: 1, prompts: [], prompt_order: [] }],
    ]) await attempt(label, () => post('/api/presets/save', { apiId, name, preset }));
    await attempt('moving ui', () => plain('/api/moving-ui/save', { name: TOKENS.movingUI, movingUIState: {} }));
    await attempt('theme', async () => {
        const theme = JSON.parse(await fs.readFile(path.join(root, 'default/content/themes/Amber Dusk.json'), 'utf8'));
        await plain('/api/themes/save', { ...theme, name: TOKENS.theme });
    });
    await attempt('settings', async () => {
        const saved = JSON.parse((await post('/api/settings/get')).settings);
        const cm = saved.extension_settings.connectionManager;
        cm.folders = [{ id: 'nm-folder', name: TOKENS.profileFolder, sortOrder: 1 }];
        cm.profiles.push(
            { id: 'nm-profile-a', name: TOKENS.profile, api: 'custom', mode: 'cc', model: 'm', 'api-url': 'http://127.0.0.1:1/v1', fav: true },
            { id: 'nm-profile-b', name: TOKENS.profile2, api: 'custom', mode: 'cc', model: 'm', 'api-url': 'http://127.0.0.1:1/v1' },
            { id: 'nm-profile-c', name: TOKENS.profile3, api: 'custom', mode: 'cc', model: 'm', 'api-url': 'http://127.0.0.1:1/v1', folderId: 'nm-folder' },
        );
        saved.oai_settings.bias_presets = { ...(saved.oai_settings.bias_presets || {}), [TOKENS.logitBias]: [] };
        saved.proxies = [{ name: 'None', url: '', password: '', source: '' }, { name: TOKENS.proxy, url: 'http://127.0.0.1:1', password: '', source: '' }];
        saved.custom_endpoint_presets = [{ name: 'None', url: '', key: '', model: '', secretId: '' }, { name: TOKENS.endpoint, url: 'http://127.0.0.1:1/v1', key: '', model: 'm', secretId: '' }];
        saved.extension_settings.note = { ...(saved.extension_settings.note || {}), profiles: [{ id: 'default', name: 'Default', prompt: '', position: 0 }, { id: 'nm-note', name: TOKENS.authorsNote, prompt: 'Note.', position: 0 }], activeProfile: 'nm-note' };
        // The persona note slot (#extension_floating_persona_profile) reads the entry under the active persona's avatar
        // (getPersonaNote, authors-note.js 401), and the character note list reads the scoped entry of the open character.
        const noteProfiles = () => [{ id: 'default', name: 'Default', prompt: '', position: 0 }, { id: 'nm-note', name: TOKENS.authorsNote, prompt: 'Note.', position: 0 }];
        const personaAvatar = saved.user_avatar || account.personaId;
        if (personaAvatar) saved.extension_settings.note.persona = { ...(saved.extension_settings.note.persona || {}), [personaAvatar]: { useNote: true, prompt: 'Note.', position: 0, profiles: noteProfiles(), activeProfile: 'nm-note' } };
        if (created.characterAvatar) {
            const noteKey = `individual:${created.characterAvatar.replace(/\.[^.]+$/, '')}`;
            saved.extension_settings.note.chara = [...(saved.extension_settings.note.chara || []).filter(entry => entry?.name !== noteKey),
                { name: noteKey, useChara: true, prompt: 'Note.', position: 0, profiles: noteProfiles(), activeProfile: 'nm-note', activeProfiles: ['nm-note'] }];
        }
        saved.extension_settings.regex = [...(saved.extension_settings.regex || []), { id: 'nm-regex-1', scriptName: TOKENS.regex, findRegex: '/zzz/g', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null }];
        saved.tags = [
            { id: 'nm-tag-a', name: TOKENS.tag, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1700000000000 },
            { id: 'nm-tag-b', name: TOKENS.tag2, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 2, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1700000000000 },
            { id: 'nm-tag-c', name: TOKENS.tagFolder, folder_type: 'OPEN', filter_state: 'UNDEFINED', sort_order: 3, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1700000000000 },
        ];
        saved.tag_map = { ...(saved.tag_map || {}) };
        if (created.characterAvatar) saved.tag_map[created.characterAvatar] = ['nm-tag-a', 'nm-tag-c'];
        // Tier 2 sweeps the Time Machine, which the fixture switches off.
        if (FULL) saved.extension_settings.disabledExtensions = (saved.extension_settings.disabledExtensions || []).filter(name => name !== 'third-party/Neconyan-Time-Machine');
        saved.power_user.theme = TOKENS.theme;
        saved.power_user.movingUIPreset = TOKENS.movingUI;
        await post('/api/settings/save', saved);
    });
    return { errors, created };
}

/** Opens the lorebook editor with the seeded lorebook selected. */
async function openLorebook(page, name = TOKENS.lorebook) {
    await shell(page, 'characters', 'world-info');
    await page.waitForFunction(() => document.querySelector('#world_editor_select option[value="0"]'));
    // The library list is not rebuilt once a book is open, so let it show both books first; otherwise its content depends on timing.
    await page.waitForFunction(() => document.querySelectorAll('#neconyan-lorebook-library .neconyan-lorebook-book').length >= 2);
    await page.evaluate(name => {
        const option = [...document.querySelectorAll('#world_editor_select option')].find(candidate => candidate.value !== '' && candidate.textContent.includes(name));
        window.$('#world_editor_select').val(option.value).trigger('change');
    }, name);
    await page.waitForTimeout(1500);
}

/** Opens the Conversation workspace on the fixture's own thread and runs a Conversation action (a click on its control). */
async function openConversation(page, avatar) {
    // A fresh page, so no popup or panel left open by an earlier screen covers the workspace.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(async value => {
        await window.SillyTavern.getContext().getCharacters();
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(value);
    }, avatar);
    await page.waitForSelector('#sb_conversation_input', { state: 'visible' });
    await page.waitForTimeout(1200);
}
const conversationAction = (page, action) => page.evaluate(name => {
    const control = document.querySelector(`[data-sb-conversation-action="${name}"]`);
    if (!control) throw new Error('no Conversation control ' + name);
    control.click();
}, action);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The ignore list, matched as diff-preservation.mjs matches it (path, text and screen patterns). */
async function readIgnore() {
    const list = JSON.parse(await fs.readFile(path.join(here, 'user-name-surfaces-ignore.json'), 'utf8'));
    const patterns = list.patterns.map(item => ({
        path: item.pathRegex ? new RegExp(item.pathRegex) : null,
        text: item.textRegex ? new RegExp(item.textRegex) : null,
        screen: item.screen ?? null,
    }));
    return entry => patterns.some(item => (!item.path || item.path.test(entry.path)) && (!item.text || item.text.test(entry.text)) && (!item.screen || (entry.screens || []).includes(item.screen)));
}

/**
 * Scans until two scans in a row are identical, or the timeout passes (M71-A1 A1-2). Surfaces compare as path|kind|attr|token|class|shown,
 * preservation as path|kind|attr|text with digits written as '#', after dropping ignored entries. Returns the last scan and whether it settled.
 */
async function stableScan(page, { interval, timeout, scanArgs, ignored, screen }) {
    const signature = scan => {
        const surfaces = scan.surfaces.map(entry => [entry.path, entry.kind, entry.attr, entry.token, entry.class, entry.shown].join('|')).sort();
        const preservation = scan.preservation.filter(entry => !ignored({ ...entry, screens: [screen] }))
            .map(entry => [entry.path, entry.kind, entry.attr, entry.text.replace(/\d+/g, '#')].join('|')).sort();
        return JSON.stringify([surfaces, preservation]);
    };
    const until = Date.now() + timeout;
    let scan = await page.evaluate(scanDocument, scanArgs);
    let previous = signature(scan);
    for (;;) {
        if (Date.now() >= until) return { scan, stable: false };
        await sleep(interval);
        scan = await page.evaluate(scanDocument, scanArgs);
        const next = signature(scan);
        if (next === previous) return { scan, stable: true };
        previous = next;
    }
}

/** In-page seeds that have no endpoint: personas, Quick Replies, agents and setups, a Prompt Manager prompt. */
async function seedInPage(page) {
    return page.evaluate(async tokens => {
        const errors = [];
        const attempt = async (label, work) => {
            try { await work(); } catch (error) { errors.push(`${label}: ${String(error?.message || error).split('\n')[0]}`); }
        };
        await attempt('persona', async () => {
            const personas = await import('/scripts/personas.js');
            const context = window.SillyTavern.getContext();
            const id = 'nm-persona.png';
            const blob = await (await fetch('/img/user-default.png')).blob();
            const form = new FormData();
            form.append('avatar', new File([blob], 'avatar.png', { type: 'image/png' }));
            form.append('overwrite_name', id);
            await fetch('/api/avatars/upload', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
            await personas.initPersona(id, tokens.persona, 'A persona.', '');
        });
        await attempt('quick replies', async () => {
            const api = globalThis.quickReplyApi;
            if (!api.getSetByName(tokens.qrSet)) await api.createSet(tokens.qrSet);
            api.createQuickReply(tokens.qrSet, tokens.qrLabel, { message: '/echo x' });
            if (!api.listGlobalSets().includes(tokens.qrSet)) api.addGlobalSet(tokens.qrSet, true);
            const enabled = document.getElementById('qr--isEnabled');
            if (enabled && !enabled.checked) enabled.click();
            // The set is saved a moment after the call; wait until the server has the label, so every run reloads into the same state.
            const context = window.SillyTavern.getContext();
            for (let attempts = 0; attempts < 40; attempts++) {
                const response = await fetch('/api/settings/get', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ sections: ['quickReplies'] }) });
                const sets = (await response.json()).quickReplyPresets ?? [];
                if (sets.some(set => set.name === tokens.qrSet && JSON.stringify(set).includes(tokens.qrLabel))) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        });
        await attempt('agent', async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const agent = store.createDefaultAgent();
            agent.name = tokens.agent;
            // Fixed, so the agent keeps one place in every list across runs.
            agent.id = 'nm-agent-1';
            await store.saveAgent(agent);
            await store.saveAgentSetupPreset(tokens.setup, { snapshot: store.createAgentSetupSnapshot() });
        });
        await attempt('save', async () => { await (await import('/script.js')).saveSettings(); });
        return errors;
    }, TOKENS);
}

/** Opens the chat with the seeded character, once. Screens that need a selected character (Prompt Manager, chat bar) call it. */
async function openChat(page, { pause = true } = {}) {
    await page.evaluate(async name => {
        const context = window.SillyTavern.getContext();
        if (context.characterId !== undefined && context.characters[context.characterId]?.name === name) return;
        await context.selectCharacterById(context.characters.findIndex(character => character.name === name));
    }, TOKENS.character);
    await page.waitForFunction(name => window.SillyTavern.getContext().characters[window.SillyTavern.getContext().characterId]?.name === name, TOKENS.character);
    // The AC 17 test waits on explicit conditions only (M71-A1 A1-9), so it skips this pause.
    if (pause) await page.waitForTimeout(1500);
}

/** Adds the Prompt Manager prompt once a character is selected (the list has no owner before that). */
async function seedPrompt(page) {
    await page.evaluate(async tokens => {
        const { promptManager } = await import('/scripts/openai.js');
        if (!promptManager.getPromptById('nm-prompt')) {
            promptManager.addPrompt({ name: tokens.prompt, role: 'system', content: 'Some prompt text.' }, 'nm-prompt');
            promptManager.appendPrompt(promptManager.getPromptById('nm-prompt'), promptManager.activeCharacter);
        }
        // A second prompt that is not in the list, so the 'Add back' footer select offers it.
        if (!promptManager.getPromptById('nm-prompt-b')) promptManager.addPrompt({ name: tokens.prompt, role: 'system', content: 'Another prompt.' }, 'nm-prompt-b');
        promptManager.saveServiceSettings();
        promptManager.render(false);
    }, TOKENS);
    await page.waitForSelector('#completion_prompt_manager_list li[data-pm-identifier="nm-prompt"]', { state: 'attached' });
}

const shell = (page, key, tab) => page.evaluate(([shellKey, tabId]) => window.NeconyanShell.openTab(shellKey, tabId), [key, tab]);
const dismiss = async page => {
    for (let i = 0; i < 2; i++) await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
        for (const close of document.querySelectorAll('dialog[open] .popup-button-close, .popup[open] .popup-button-close')) close.click();
        window.$?.('.select2-hidden-accessible').each((_, element) => { try { window.$(element).select2('close'); } catch { /* not open */ } });
        for (const button of document.querySelectorAll('.sb-select-picker-button[aria-expanded="true"]')) button.click();
    }).catch(() => {});
};

/** Opens every closed drawer and details around an element, so it is displayed. */
const reveal = async (page, selector) => {
    await page.evaluate(query => {
        const element = document.querySelector(query);
        if (!element) throw new Error('missing ' + query);
        for (let node = element.parentElement; node; node = node.parentElement) {
            if (node.tagName === 'DETAILS') node.open = true;
            if (node.classList?.contains('inline-drawer-content') && getComputedStyle(node).display === 'none') node.parentElement.querySelector(':scope > .inline-drawer-toggle')?.click();
        }
        element.scrollIntoView({ block: 'center' });
    }, selector);
    await page.waitForTimeout(600);
};

/**
 * `ready` (Tier 2 only, M71-A1 A1-11) is the element the tool's open call makes visible; the screen counts as reached only once it shows.
 * openIncludedTool mounts the tool's settings unit (`unit` in NECONYAN_NATIVE_TOOL_DEFINITIONS, neconyan-tabs.js 603-626) into
 * `.neconyan-included-tool-content` (buildIncludedToolPanel, neconyan-tabs.js 2925-2995). Mewmory renders `.mewmory-heading` into
 * `#mewmory-workspace` (neconyan-tabs.js 12811-12820, mewmory/ui.js 2770). focusUnit('Vectorization') shows the `.vectors_settings` unit on
 * the extensions page (vectors/settings.html 1). `ready: null`: the tool has no settings unit (CSS Snippets, Lorebook Distiller,
 * neconyan-tabs.js 615-616), so the screen is 'open call only'.
 * @typedef {{id: string, mode: 'classic'|'conversation', must: string[], found?: string[], ready?: string|null, after?: (ctx: any) => Promise<void>, required?: boolean, full?: boolean, phoneOnly?: boolean, desktopOnly?: boolean, run: (ctx: any) => Promise<void>}} Screen
 */

/** @type {Screen[]} */
const SCREENS = [
    {
        id: 'home', mode: 'classic', must: [],
        async run({ page }) { await page.evaluate(() => window.NeconyanShell.showHome?.()); },
    },
    {
        id: 'characters', mode: 'classic', must: ['character', 'tag'],
        async run({ page }) { await shell(page, 'characters', 'characters'); },
    },
    {
        id: 'groups', mode: 'classic', must: ['group'],
        async run({ page }) { await shell(page, 'characters', 'groups'); },
    },
    {
        id: 'persona', mode: 'classic', must: ['persona'],
        async run({ page }) { await shell(page, 'characters', 'persona'); },
    },
    {
        id: 'lorebook-editor', mode: 'classic', required: true, must: ['lorebook'],
        async run({ page, phone }) {
            await openLorebook(page);
            if (!phone) {
                await page.evaluate(() => document.getElementById('sb-world_editor_select-picker-button').click());
                await page.waitForTimeout(500);
            }
        },
    },
    {
        id: 'lorebook-global', mode: 'classic', desktopOnly: true, must: ['lorebook'],
        async run({ page }) {
            await shell(page, 'characters', 'world-info');
            await page.waitForFunction(() => document.querySelector('#world_info option[value="0"]'));
            await page.waitForFunction(() => document.querySelectorAll('#neconyan-lorebook-library .neconyan-lorebook-book').length >= 2);
            await page.evaluate(name => {
                const option = [...document.querySelectorAll('#world_info option')].find(candidate => candidate.value !== '' && candidate.textContent.includes(name));
                window.$('#world_info').val([option.value]).trigger('change');
                document.getElementById('sb-world_info-picker-button').click();
            }, TOKENS.lorebook);
            await page.waitForTimeout(500);
        },
    },
    {
        id: 'preset-bar', mode: 'classic', must: ['oaiPreset'],
        async run({ page }) {
            await shell(page, 'left', 'presets');
            await page.locator('#sb-openai-preset-picker-button').click();
            await page.waitForSelector('.sb-chat-picker-row', { state: 'visible' });
        },
    },
    {
        id: 'prompt-manager', mode: 'classic', required: true, must: ['prompt'],
        async run({ page }) {
            await openChat(page);
            await shell(page, 'left', 'presets');
            await page.evaluate(() => document.getElementById('openai-tab-btn-prompts')?.click());
            await seedPrompt(page);
            await page.evaluate(() => document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="nm-prompt"]').scrollIntoView({ block: 'center' }));
        },
    },
    {
        id: 'prompt-editor', mode: 'classic', must: ['prompt'],
        async run({ page }) {
            await openChat(page);
            await shell(page, 'left', 'presets');
            await page.evaluate(() => document.getElementById('openai-tab-btn-prompts')?.click());
            await seedPrompt(page);
            await page.waitForSelector('#completion_prompt_manager_list li[data-pm-identifier="nm-prompt"] .prompt-manager-edit-action', { state: 'attached' });
            await page.evaluate(() => document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="nm-prompt"] .prompt-manager-edit-action').click());
            await page.waitForSelector('#completion_prompt_manager_popup_entry_form_name', { state: 'visible' });
        },
    },
    {
        id: 'prompt-new', mode: 'classic', required: true, must: ['prompt'],
        async run({ page }) {
            await openChat(page);
            await shell(page, 'left', 'presets');
            await page.evaluate(() => document.getElementById('openai-tab-btn-prompts')?.click());
            await seedPrompt(page);
            await page.evaluate(() => document.querySelector('#completion_prompt_manager_prompt_manager_new, #completion_prompt_manager_new')?.click());
            await page.waitForSelector('#completion_prompt_manager_popup_entry_form_placement', { state: 'visible' });
        },
    },
    {
        id: 'preset-delete-picker', mode: 'classic', required: true, must: ['oaiPreset'],
        async run({ page }) {
            await shell(page, 'left', 'presets');
            await page.evaluate(() => document.querySelector('[data-preset-manager-delete-all="openai"]').click());
            await page.waitForSelector('dialog[open] input[type="checkbox"], .popup[open] input[type="checkbox"]', { state: 'visible' });
        },
    },
    {
        // The profile list is shown through the shared picker (the select is hidden), so its names are found, not displayed (M71 A9).
        id: 'connections', mode: 'classic', required: true, must: [], found: ['profile', 'profile2', 'proxy', 'endpoint', 'logitBias'],
        async run({ page }) {
            await shell(page, 'left', 'api');
            for (const selector of ['#openai_logit_bias_preset', '#custom_endpoint_preset', '#openai_proxy_preset', '#connection_profiles']) await reveal(page, selector).catch(() => {});
        },
    },
    {
        // The three lists are shown through the shared picker (the selects are hidden), so their names are found, not displayed (M71 A9).
        id: 'advanced-formatting', mode: 'classic', must: [], found: ['contextPreset', 'instructPreset', 'syspromptPreset'],
        async run({ page }) {
            // The template and system prompt lists belong to Text Completion; the fixture runs Chat Completion.
            await page.evaluate(() => window.$('#main_api').val('textgenerationwebui').trigger('change'));
            await page.waitForTimeout(1000);
            await shell(page, 'left', 'advanced-formatting');
            for (const selector of ['#sysprompt_select', '#instruct_presets', '#context_presets']) await reveal(page, selector).catch(() => {});
        },
        async after({ page }) { await page.evaluate(() => window.$('#main_api').val('openai').trigger('change')); await page.waitForTimeout(800); },
    },
    {
        id: 'sampling', mode: 'classic', must: [],
        async run({ page }) { await shell(page, 'left', 'sampling'); },
    },
    {
        id: 'user-settings', mode: 'classic', required: true, must: ['theme', 'movingUI'],
        async run({ page }) {
            await shell(page, 'right', 'settings');
            await reveal(page, '#MovingUI-presets-block');
            await reveal(page, '#themes');
        },
    },
    {
        id: 'extensions', mode: 'classic', must: [],
        async run({ page }) { await shell(page, 'right', 'extensions'); },
    },
    {
        id: 'ext-quick-reply', mode: 'classic', must: ['qrSet'],
        async run({ page }) {
            await shell(page, 'right', 'extensions');
            await page.waitForFunction(() => window.NeconyanExtensions?.focusUnit);
            await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Reply'));
            await page.waitForSelector('#qr--settings', { state: 'visible' });
        },
    },
    {
        id: 'ext-regex', mode: 'classic', must: ['regex'],
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('regex'));
            await page.waitForSelector('#regex_container', { state: 'visible' });
        },
    },
    {
        id: 'agents', mode: 'classic', must: ['agent', 'setup'],
        async run({ page }) {
            await shell(page, 'left', 'agents');
            await page.waitForSelector('#ica--agentList', { state: 'visible' });
            await reveal(page, '#ica--setupSelect').catch(() => {});
        },
    },
    {
        id: 'agent-editor', mode: 'classic', required: true, must: ['agent'],
        async run({ page }) {
            await shell(page, 'left', 'agents');
            await page.waitForSelector('#ica--agentList', { state: 'visible' });
            await page.evaluate(name => {
                // On base the card's label reads 'Editar ⟦token⟧', so match on the token being contained.
                const button = [...document.querySelectorAll('#ica--agentList .ica--btn-edit')].find(candidate => (candidate.getAttribute('aria-label') || '').includes(name));
                if (!button) throw new Error('no edit control for the seeded agent');
                button.click();
            }, TOKENS.agent);
            await page.waitForSelector('#ica--editor-title', { state: 'visible' });
        },
    },
    {
        id: 'agent-editor-new', mode: 'classic', must: [],
        async run({ page }) {
            await shell(page, 'left', 'agents');
            await page.waitForSelector('#ica--addAgent', { state: 'visible' });
            await page.evaluate(() => document.getElementById('ica--addAgent').click());
            await page.waitForSelector('#ica--editor-title', { state: 'visible' });
        },
    },
    {
        id: 'lorebook-tools', mode: 'classic', must: ['lorebook'],
        async run({ page }) {
            await openLorebook(page, 'Plain lorebook');
            await page.evaluate(() => {
                const tools = document.querySelector('.world_popup_action_group_details .world_popup_action_group_contents');
                tools.closest('details')?.setAttribute('open', '');
                [...tools.querySelectorAll(':scope > button')].at(-1).click();
            });
            await page.waitForSelector('#neco-lore-merge-book', { state: 'visible' });
        },
    },
    {
        id: 'tag-manager', mode: 'classic', must: ['tag'],
        async run({ page }) {
            await shell(page, 'characters', 'characters');
            await page.evaluate(() => document.querySelector('.manageTags').click());
            await page.waitForSelector('.tag_view_item#nm-tag-a', { state: 'visible' });
        },
    },
    {
        id: 'tag-delete', mode: 'classic', must: ['tag2'],
        async run({ page, phone }) {
            await shell(page, 'characters', 'characters');
            await page.evaluate(() => document.querySelector('.manageTags').click());
            await page.waitForSelector('.tag_view_item#nm-tag-a', { state: 'visible' });
            await page.evaluate(() => document.querySelector('.tag_view_item#nm-tag-a .tag_delete').click());
            await page.waitForSelector('#merge_tag_select', { state: 'attached' });
            if (!phone) {
                // The popup gives the merge select the shared picker when it opens; open its list.
                await page.waitForSelector('#sb-merge_tag_select-picker-button', { state: 'attached' });
                await page.evaluate(() => document.getElementById('sb-merge_tag_select-picker-button').click());
                await page.waitForTimeout(400);
            }
        },
    },
    {
        id: 'notebooks', mode: 'classic', must: ['notebook'],
        async run({ page }) {
            await page.evaluate(() => document.querySelector('#neconyan-workspace-rail [data-neconyan-route="notes"]').click());
            await page.waitForTimeout(2000);
        },
    },
    {
        id: 'scratchpad', mode: 'classic', must: [],
        async run({ page }) {
            await page.evaluate(() => document.querySelector('#neconyan-workspace-rail [data-neconyan-route="scratchpad"]').click());
            await page.waitForTimeout(2000);
        },
    },
    {
        id: 'chat-archive', mode: 'classic', full: true, must: [],
        async run({ page }) {
            await page.evaluate(() => document.querySelector('#neconyan-workspace-rail [data-neconyan-route="chat-archive"]').click());
            await page.waitForTimeout(2000);
        },
    },
    {
        id: 'chat-qr-bar', mode: 'classic', must: [],
        async run({ page }) { await openChat(page); await page.waitForSelector('#qr--bar', { state: 'attached' }); },
    },
    {
        id: 'authors-note', mode: 'classic', must: [],
        async run({ page }) {
            await openChat(page);
            await page.evaluate(() => document.querySelector('#option_toggle_AN').click());
            await page.waitForSelector('#floatingPrompt', { state: 'visible' });
        },
    },
    {
        id: 'manage-chats', mode: 'classic', must: [],
        async run({ page }) {
            await openChat(page);
            await page.evaluate(() => document.querySelector('#option_select_chat').click());
            await page.waitForSelector('#select_chat_div, .select_chat_block', { state: 'visible' });
        },
    },
    {
        id: 'tier2-css-snippets', mode: 'classic', full: true, must: [], ready: null,
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('css-snippets'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-mewmory', mode: 'classic', full: true, must: [], ready: '#mewmory-workspace .mewmory-heading',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-vectors', mode: 'classic', full: true, must: [], ready: '.vectors_settings',
        async run({ page }) {
            await page.evaluate(() => (window.NeconyanShell.openTab('right', 'extensions'), window.NeconyanExtensions.focusUnit('Vectorization')));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-quick-image-gen', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content #qig-settings',
        async run({ page }) {
            await page.evaluate(() => (window.NeconyanShell.openTab('right', 'extensions'), window.NeconyanExtensions.focusUnit('Quick Image Gen')));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-dialogue-colors', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content #dc-ext',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('sillytavern-character-colors'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-prompting-lab', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content .sbpl-settings-container',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Prompting-Lab'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-prompt-tags', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content #promptTags-drawer',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-PromptTags'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-story-mode', mode: 'classic', full: true, must: ['agent'], ready: '.neconyan-included-tool-content #sbstory-settings',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Story-Mode'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-worldinfo-lab', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content .sbwil-settings-container',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-WorldInfo-Lab'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-lorebook-distiller', mode: 'classic', full: true, must: [], ready: null,
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Lorebook-Distiller'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-time-machine', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content #sbctm-settings-drawer',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Time-Machine'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'tier2-meower', mode: 'classic', full: true, must: [], ready: '.neconyan-included-tool-content #sbtw-drawer',
        async run({ page }) {
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Hopper'));
            await page.waitForTimeout(2500);
        },
    },
    {
        id: 'conv-header', mode: 'conversation', must: [],
        async run({ page, account }) { await openConversation(page, account.avatar); },
    },
    {
        id: 'conv-pals', mode: 'conversation', must: [],
        async run({ page, account }) {
            await openConversation(page, account.avatar);
            if (!await page.evaluate(() => document.getElementById('sb_conversation_pals_rail')?.dataset.open === 'true')) await conversationAction(page, 'toggle-pals');
            await page.waitForTimeout(800);
        },
    },
    {
        id: 'conv-add-dm', mode: 'conversation', must: [],
        async run({ page, account }) {
            await openConversation(page, account.avatar);
            if (!await page.evaluate(() => document.getElementById('sb_conversation_pals_rail')?.dataset.open === 'true')) await conversationAction(page, 'toggle-pals');
            await conversationAction(page, 'open-add-dm');
            await page.waitForTimeout(800);
        },
    },
    {
        id: 'conv-new-group', mode: 'conversation', must: [],
        async run({ page, account }) {
            await openConversation(page, account.avatar);
            if (!await page.evaluate(() => document.getElementById('sb_conversation_pals_rail')?.dataset.open === 'true')) await conversationAction(page, 'toggle-pals');
            await conversationAction(page, 'open-new-group-chat');
            await page.waitForTimeout(800);
        },
    },
    {
        id: 'conv-persona-picker', mode: 'conversation', must: [],
        async run({ page, account }) {
            await openConversation(page, account.avatar);
            await conversationAction(page, 'open-persona-picker');
            await page.waitForTimeout(800);
        },
    },
    {
        id: 'conv-settings', mode: 'conversation', must: [],
        async run({ page, account }) {
            await openConversation(page, account.avatar);
            await conversationAction(page, 'open-settings');
            await page.waitForTimeout(800);
        },
    },
];

function sweepName(viewport, lang) { return `${viewport}-${lang}`; }

async function dictionaryRoute(context, lang) {
    const entries = Object.fromEntries(TOKEN_LIST.map(token => [token, OPEN + token + CLOSE]));
    await context.route(`**/locales/neconyan/${lang}.json`, async route => {
        const response = await route.fetch();
        const body = response.ok() ? await response.json() : {};
        await route.fulfill({ response, json: { ...body, ...entries } });
    });
}

/** With NECONYAN_NAME_SWEEP_HOLES=off the localiser is served with hole lookup switched off (evidence only). */
async function holesOffRoute(context) {
    const source = await fs.readFile(path.join(root, 'public/scripts/ui-localization.js'), 'utf8');
    const from = '{ translateHoles = true } = {}';
    if (source.split(from).length !== 2) throw new Error('lookup default not found exactly once');
    const patched = source.replace(from, '{ translateHoles = false } = {}');
    if (patched === source) throw new Error('lookup patch changed nothing');
    await context.route('**/scripts/ui-localization.js*', route => route.fulfill({ contentType: 'text/javascript', body: patched }));
}

/** One entry per element, kind, attribute and text, with the screens that showed it (the hidden panels repeat on every screen). */
function dedupePreservation(entries) {
    const merged = new Map();
    for (const { screen, ...entry } of entries) {
        const id = [entry.path, entry.kind, entry.attr, entry.text].join('');
        const known = merged.get(id);
        if (known) known.screens.push(screen); else merged.set(id, { ...entry, screens: [screen] });
    }
    return [...merged.values()];
}

const locationKey = entry => [entry.path, entry.kind, entry.attr, entry.token].join('\u0001');

/** Reads a base run's surfaces for this viewport and language, or null when no base is given. */
async function readBase(viewport, lang) {
    if (!BASE_OUT) return null;
    const dir = path.join(BASE_OUT, sweepName(viewport, lang));
    return {
        surfaces: JSON.parse(await fs.readFile(path.join(dir, 'surfaces.json'), 'utf8')),
        reached: JSON.parse(await fs.readFile(path.join(dir, 'reached.json'), 'utf8')),
    };
}

function judge({ surfaces, reached, base }) {
    const problems = [];
    const notReached = reached.filter(entry => !entry.reached);
    const required = SCREENS.filter(screen => screen.required).map(screen => screen.id);
    for (const entry of notReached) if (required.includes(entry.screen)) problems.push(`required screen not reached: ${entry.screen} (${entry.reason})`);
    for (const screen of SCREENS) {
        if (!reached.find(entry => entry.screen === screen.id)?.reached) continue;
        for (const name of screen.found || []) {
            if (!surfaces.some(entry => entry.screen === screen.id && entry.token === TOKENS[name])) problems.push(`screen ${screen.id} does not contain ${TOKENS[name]}`);
        }
        for (const name of screen.must) {
            if (!surfaces.some(entry => entry.screen === screen.id && entry.token === TOKENS[name] && entry.shown)) problems.push(`screen ${screen.id} does not display ${TOKENS[name]}`);
        }
    }
    const leaks = surfaces.filter(entry => entry.class === 'W' || entry.class === 'H');
    for (const entry of leaks) problems.push(`${entry.class}: ${entry.screen} ${entry.path} [${entry.kind}${entry.attr ? ' ' + entry.attr : ''}] ${JSON.stringify(entry.string)}`);
    // An accepted caption sits in the same hidden panel on every screen, so an entry without a screen holds on all of them.
    const accepted = entry => ACCEPTED_R.some(item => (item.screen === undefined || item.screen === entry.screen) && item.path === entry.path && item.attr === entry.attr && item.token === entry.token);
    for (const entry of surfaces.filter(item => item.class === 'R' && !accepted(item))) problems.push(`R: ${entry.screen} ${entry.path} [${entry.kind}${entry.attr ? ' ' + entry.attr : ''}] ${JSON.stringify(entry.string)}`);
    if (base) {
        // M71-A1 A1-3 (b): a base occurrence is matched by any entry with the same path, kind, attribute and token and, when the base
        // occurrence was displayed, the same screen. A hidden base occurrence matches on any screen. One match must be P or an accepted R.
        const now = new Map();
        for (const entry of surfaces) {
            const id = locationKey(entry);
            now.set(id, [...(now.get(id) || []), entry]);
        }
        for (const entry of base.surfaces) {
            const matches = (now.get(locationKey(entry)) || []).filter(item => !entry.shown || item.screen === entry.screen);
            if (!matches.some(found => found.class === 'P' || (found.class === 'R' && accepted(found)))) problems.push(`base occurrence not P: ${entry.screen}${entry.shown ? '' : ' (hidden)'} ${entry.path} [${entry.kind}${entry.attr ? ' ' + entry.attr : ''}] ${entry.token} (now ${[...new Set(matches.map(found => found.class))].join('/') || 'absent'})`);
        }
        const baseReached = JSON.stringify(base.reached.map(entry => [entry.screen, entry.reached]));
        if (baseReached !== JSON.stringify(reached.map(entry => [entry.screen, entry.reached]))) problems.push(`reached screens differ from base: base ${baseReached}`);
    }
    return { problems, notReached };
}

for (const lang of LANGS) {
    for (const viewport of ['phone', 'desktop']) {
        test(`name sweep: ${viewport} ${lang}`, async ({ app }, info) => {
            info.setTimeout(60 * 60 * 1000);
            const phone = viewport === 'phone';
            const userText = await readUserText();
            const account = await app.account({ phone });
            const seeded = await seedAccount({ account });
            await account.context.addInitScript(value => { localStorage.setItem('language', value); }, lang);
            // The bundled agents are saved under random ids and listed in id order, so their order changes on every fresh data folder.
            // Ids that count up keep the order of creation, so every run lists them the same way.
            await account.context.addInitScript(() => {
                const next = () => {
                    const count = Number(localStorage.getItem('nm-sweep-uuid') || 0) + 1;
                    localStorage.setItem('nm-sweep-uuid', String(count));
                    return `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
                };
                Object.defineProperty(crypto, 'randomUUID', { value: next, configurable: true });
            });
            await dictionaryRoute(account.context, lang);
            if (HOLES_OFF) await holesOffRoute(account.context);
            // Fixed answers for the two keyless third-party provider catalogues, which the server fetches live (M71-A1 A1-1).
            await account.context.route('**/api/nanogpt/providers', route => route.fulfill({ json: [{ id: 'fixture-alpha', label: 'Fixture Provider Alpha' }, { id: 'fixture-beta', label: 'Fixture Provider Beta' }] }));
            await account.context.route('**/api/openrouter/providers', route => route.fulfill({ json: ['Fixture Provider Alpha', 'Fixture Provider Beta'] }));
            await account.context.route('**/api/nanogpt/models/providers', route => route.fulfill({ status: 502, body: '' }));
            await account.context.route('**/api/openrouter/models/providers', route => route.fulfill({ status: 502, body: '' }));
            const requested = [];
            account.context.on('request', request => { requested.push([request.method(), request.url()]); });
            const ignored = await readIgnore();
            const page = await account.open({ workspace: false });
            const inPageErrors = await seedInPage(page);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();
            const seedErrors = [...seeded.errors, ...inPageErrors];
            const surfaces = [];
            const preservation = [];
            const reached = [];
            for (const screen of SCREENS) {
                if (ONLY.length && !ONLY.includes(screen.id)) continue;
                if (screen.full && !FULL) continue;
                if ((screen.phoneOnly && !phone) || (screen.desktopOnly && phone)) continue;
                try {
                    await dismiss(page);
                    if (screen.id.startsWith('tier2-')) {
                        // A fresh page for each tool, so what an earlier tool was still loading cannot show up in this one.
                        await page.reload({ waitUntil: 'domcontentloaded' });
                        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
                        const tour = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
                        if (await tour.isVisible()) await tour.click();
                    }
                    await screen.run({ page, account, app, phone, lang });
                    const tier2 = screen.id.startsWith('tier2-');
                    if (tier2 && screen.ready) {
                        try {
                            await page.locator(screen.ready).first().waitFor({ state: 'visible', timeout: 20000 });
                        } catch {
                            throw new Error(`ready element ${screen.ready} not visible within 20 s`);
                        }
                    }
                    // Tier 2 opens tools that load their pages late, so they get a longer interval.
                    const { scan, stable } = await stableScan(page, {
                        ...(tier2 ? { interval: 2000, timeout: 40000 } : { interval: 1000, timeout: 20000 }),
                        scanArgs: { tokens: TOKENS, userText }, ignored, screen: screen.id,
                    });
                    if (SHOTS) { await fs.mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${viewport}-${lang}-${screen.id}.png`) }); }
                    for (const entry of scan.surfaces) surfaces.push({ screen: screen.id, ...entry });
                    for (const entry of scan.preservation) preservation.push({ screen: screen.id, ...entry });
                    reached.push(stable ? { screen: screen.id, reached: true } : { screen: screen.id, reached: true, stable: false });
                    await screen.after?.({ page, account, app, phone, lang });
                } catch (error) {
                    reached.push({ screen: screen.id, reached: false, reason: String(error.message || error).split('\n')[0] });
                }
            }
            if (OUT) {
                const dir = path.join(OUT, sweepName(viewport, lang));
                await fs.mkdir(dir, { recursive: true });
                await fs.writeFile(path.join(dir, 'surfaces.json'), JSON.stringify(surfaces, null, 1));
                await fs.writeFile(path.join(dir, 'preservation.json'), JSON.stringify(dedupePreservation(preservation)));
                await fs.writeFile(path.join(dir, 'reached.json'), JSON.stringify(reached, null, 1));
                await fs.writeFile(path.join(dir, 'seed-errors.json'), JSON.stringify(seedErrors, null, 1));
                const appOrigin = new URL(page.url()).origin;
                const apiPaths = new Set();
                const otherHosts = new Set();
                for (const [method, url] of requested) {
                    let parsed;
                    try { parsed = new URL(url); } catch { continue; }
                    if (!/^https?:$/.test(parsed.protocol)) continue;
                    if (parsed.origin === appOrigin) {
                        if (parsed.pathname.startsWith('/api/')) apiPaths.add(`${method} ${parsed.pathname}`);
                    } else {
                        otherHosts.add(url);
                    }
                }
                await fs.writeFile(path.join(dir, 'api-requests.json'), JSON.stringify({ api: [...apiPaths].sort(), otherHosts: [...otherHosts].sort() }, null, 1));
            }
            if (process.env.NECONYAN_NAME_SWEEP_VERBOSE) {
                for (const entry of reached) {
                    const mine = surfaces.filter(item => item.screen === entry.screen);
                    const counts = Object.fromEntries(['W', 'H', 'R', 'P'].map(klass => [klass, mine.filter(item => item.class === klass).length]));
                    console.log(`SCREEN ${entry.screen} reached=${entry.reached} ${entry.reason || ''} ${JSON.stringify(counts)} tokens=${[...new Set(mine.map(item => item.token))].join(',')}`);
                }
                console.log(`SEED ERRORS ${JSON.stringify(seedErrors)}`);
            }
            const base = await readBase(viewport, lang);
            const { problems, notReached } = judge({ surfaces, reached, base });
            expect(seedErrors, 'seed errors').toEqual([]);
            if (OUT) await fs.writeFile(path.join(OUT, sweepName(viewport, lang), 'problems.json'), JSON.stringify(problems, null, 1));
            expect(problems.slice(0, 30), `${problems.length} problems (first 30 shown; the rest are in problems.json); not reached: ${notReached.map(entry => `${entry.screen} (${entry.reason})`).join('; ') || 'none'}`).toEqual([]);
        });
    }
}

const mergedDictionary = async lang => {
    const read = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    return { ...await read(`public/locales/${lang}.json`), ...await read(`public/locales/neconyan/${lang}.json`) };
};

async function openPlain(account, lang) {
    await account.context.addInitScript(value => { localStorage.setItem('language', value); }, lang);
    const page = await account.open({ workspace: false });
    return page;
}

test('L10N-06: a lorebook stays selected in the editor when its shown text differs from its name', async ({ app }, info) => {
    info.setTimeout(10 * 60 * 1000);
    const account = await app.account({});
    await account.post('/api/worldinfo/edit', { name: 'Default', data: { entries: { 0: lorebookEntry(0, 'An entry') } } });
    await account.post('/api/worldinfo/edit', { name: TOKENS.lorebook, data: { entries: { 0: lorebookEntry(0, 'Another entry') } } });
    // A Kobold preset named 'Default' sits beside the built-in 'gui' option.
    await account.post('/api/presets/save', { apiId: 'kobold', name: 'Default', preset: { temp: 1 } });
    const page = await openPlain(account, 'pt-pt');
    const pt = await mergedDictionary('pt-pt');
    expect(pt.Default, 'Default is a pt-pt key, so the localiser would show it differently').toBeTruthy();

    await shell(page, 'characters', 'world-info');
    await page.waitForFunction(() => document.querySelector('#world_editor_select option[value="0"]'));
    await page.evaluate(() => {
        const option = [...document.querySelectorAll('#world_editor_select option')].find(candidate => candidate.value !== '' && /Default|Padr/.test(candidate.textContent));
        window.$('#world_editor_select').val(option.value).trigger('change');
    });
    await page.waitForTimeout(1500);
    // The localiser used to rewrite the option's text; do what it did, then refresh the list as the app does after a save.
    const selected = await page.evaluate(async shown => {
        const select = document.getElementById('world_editor_select');
        select.selectedOptions[0].textContent = shown;
        await (await import('/scripts/world-info.js')).updateWorldInfoList();
        return { text: select.selectedOptions[0]?.textContent ?? null, value: select.value };
    }, pt.Default);
    // Soft, so the preset picker below is also checked on code that has the first defect.
    expect.soft(selected.text, 'the editor still has Default selected after the list is rebuilt').toBe('Default');

    const stored = await page.evaluate(async () => {
        const response = await fetch('/api/settings/get', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({}) });
        return (await response.json()).koboldai_setting_names;
    });
    expect(stored).toContain('Default');
    await page.evaluate(async () => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        window.__deletionPicker = getPresetManager('kobold').selectPresetsForDeletion();
    });
    await page.waitForSelector('dialog[open] input[type="checkbox"], .popup[open] input[type="checkbox"]', { state: 'attached' });
    const picker = await page.evaluate(() => [...document.querySelectorAll('dialog[open] label.checkbox_label, .popup[open] label.checkbox_label')].map(label => ({
        value: label.querySelector('input').value, label: label.querySelector('span').textContent.trim(),
    })));
    expect(picker.map(row => row.value), 'the checkbox values are exactly the stored preset names').toEqual(stored);
    for (const row of picker) expect(row.label, `label of ${row.value}`).toBe(row.value);
    const guiText = await page.evaluate(() => document.querySelector('#settings_preset option[value="gui"]')?.textContent ?? null);
    expect(guiText).toBeTruthy();
    expect(picker.map(row => row.value)).not.toContain(guiText);
    expect(picker.map(row => row.label)).not.toContain(guiText);
});

test('L10N-31: the favourite connection profiles heading is translated', async ({ app }, info) => {
    info.setTimeout(10 * 60 * 1000);
    const account = await app.account({});
    const saved = JSON.parse((await account.post('/api/settings/get')).settings);
    saved.extension_settings.connectionManager.profiles.push({ id: 'nm-profile-a', name: TOKENS.profile, api: 'custom', mode: 'cc', model: 'm', 'api-url': 'http://127.0.0.1:1/v1', fav: true });
    await account.post('/api/settings/save', saved);
    const page = await openPlain(account, 'pt-pt');
    const pt = await mergedDictionary('pt-pt');
    expect(pt['★ Favorites'], '★ Favorites is a pt-pt key').toBeTruthy();
    await page.waitForSelector('#connection_profiles optgroup', { state: 'attached' });
    const labels = await page.evaluate(() => [...document.querySelectorAll('#connection_profiles optgroup')]
        .filter(group => [...group.querySelectorAll('option')].some(option => option.dataset.favorite === 'true')).map(group => group.label));
    expect(labels).toEqual([pt['★ Favorites']]);
});

test('AC 17: a reset Nsfw and Jailbreak prompt keep their translated names in the Prompt Manager', async ({ app }, info) => {
    info.setTimeout(10 * 60 * 1000);
    const account = await app.account({});
    await account.post('/api/characters/create', { ch_name: TOKENS.character, description: 'A character.', first_mes: 'Hello.', mes_example: '' }).catch(() => {});
    const page = await openPlain(account, 'pt-pt');
    const pt = await mergedDictionary('pt-pt');
    expect(pt['Nsfw Prompt'], 'Nsfw Prompt is a pt-pt key').toBeTruthy();
    expect(pt['Jailbreak Prompt'], 'Jailbreak Prompt is a pt-pt key').toBeTruthy();
    await openChat(page, { pause: false });
    await shell(page, 'left', 'presets');
    await page.evaluate(() => document.getElementById('openai-tab-btn-prompts')?.click());
    await page.waitForSelector('#completion_prompt_manager_list li[data-pm-identifier="nsfw"]', { state: 'attached' });
    const resetNames = { nsfw: 'Nsfw Prompt', jailbreak: 'Jailbreak Prompt' };
    // The name shown in the prompt list row of one identifier (the inspect link, or the plain name span).
    const rowName = id => page.evaluate(identifier => {
        const holder = document.querySelector(`#completion_prompt_manager_list li[data-pm-identifier="${identifier}"] [data-pm-name]`);
        const name = holder?.querySelector(':scope > a.prompt-manager-inspect-action, :scope > span[title]:not([class])');
        return name ? name.textContent.trim() : null;
    }, id);
    for (const [identifier, resetName] of Object.entries(resetNames)) {
        await page.evaluate(id => document.querySelector(`#completion_prompt_manager_list li[data-pm-identifier="${id}"] .prompt-manager-edit-action`).click(), identifier);
        await page.waitForSelector('#completion_prompt_manager_popup_entry_form_reset', { state: 'visible' });
        await page.evaluate(() => document.getElementById('completion_prompt_manager_popup_entry_form_reset').click());
        await page.waitForFunction(name => document.getElementById('completion_prompt_manager_popup_entry_form_name')?.value === name, resetName);
        await page.evaluate(() => document.getElementById('completion_prompt_manager_popup_entry_form_save').click());
        await expect.poll(() => rowName(identifier), { message: `the prompt list row of ${identifier}`, timeout: 10000 }).toBe(pt[resetName]);
    }
    // The prompt list and its selects are drawn again; read the 'Place after' select of a new prompt.
    await page.evaluate(() => document.querySelector('#completion_prompt_manager_new, #completion_prompt_manager_prompt_manager_new').click());
    await page.waitForSelector('#completion_prompt_manager_popup_entry_form_placement', { state: 'visible' });
    const placeAfter = () => page.evaluate(() => Object.fromEntries(['nsfw', 'jailbreak'].map(id => {
        const option = document.querySelector(`#completion_prompt_manager_popup_entry_form_placement option[value="${id}"]`);
        return [id, option ? { text: option.textContent.trim(), marked: option.hasAttribute('data-i18n-ignore') } : null];
    })));
    await expect.poll(placeAfter, { message: 'the Place after options of the Nsfw and Jailbreak prompts', timeout: 10000 }).toEqual({
        nsfw: { text: pt['Nsfw Prompt'], marked: false },
        jailbreak: { text: pt['Jailbreak Prompt'], marked: false },
    });
});

// Rule D (M71-A7). An account whose saved settings hold no prompts gets its own copy of the defaults.
// Names chosen in that copy stay as written and untouched default names still translate.
test('rule D: a prompt a person adds or renames keeps its name when the account uses the default prompt list', async ({ app }, info) => {
    info.setTimeout(10 * 60 * 1000);
    const account = await app.account({});
    await account.post('/api/characters/create', { ch_name: TOKENS.character, description: 'A character.', first_mes: 'Hello.', mes_example: '' }).catch(() => {});
    const page = await openPlain(account, 'pt-pt');
    const pt = await mergedDictionary('pt-pt');
    for (const key of ['Draft', 'Notes', 'Main Prompt']) {
        expect(pt[key], `${key} is a pt-pt key`).toBeTruthy();
        expect(pt[key], `${key} has its own pt-pt value`).not.toBe(key);
    }
    await openChat(page, { pause: false });
    await shell(page, 'left', 'presets');
    await page.evaluate(() => document.getElementById('openai-tab-btn-prompts')?.click());
    await page.waitForSelector('#completion_prompt_manager_list li[data-pm-identifier="nsfw"]', { state: 'attached' });
    // Exercise the app's fallback for an empty prompt list.
    const ownership = await page.evaluate(async () => {
        const { promptManager } = await import('/scripts/openai.js');
        const { chatCompletionDefaultPrompts } = await import('/scripts/PromptManager.js');
        promptManager.serviceSettings.prompts = [];
        promptManager.sanitizeServiceSettings();
        await promptManager.render(false);
        const prompts = promptManager.serviceSettings.prompts;
        const defaults = chatCompletionDefaultPrompts.prompts;
        return { sharedList: prompts === defaults, sharedEntries: prompts.some(prompt => defaults.includes(prompt)) };
    });
    expect(ownership, 'the account owns its fallback list and entries').toEqual({ sharedList: false, sharedEntries: false });
    await page.waitForFunction(() => { const list = document.querySelector('#completion_prompt_manager_list'); if (!list?.querySelector('li[data-pm-identifier="nsfw"] .prompt-manager-edit-action')) return false; if (window.a7SettledList !== list) { window.a7SettledList = list; window.a7SettledSince = Date.now(); return false; } return Date.now() - window.a7SettledSince >= 3000; }, undefined, { polling: 250, timeout: 30000 });
    // A new prompt named Draft, made in the prompt editor.
    await page.evaluate(() => document.querySelector('#completion_prompt_manager_new, #completion_prompt_manager_prompt_manager_new').click());
    await page.waitForSelector('#completion_prompt_manager_popup_entry_form_name', { state: 'visible' });
    await page.fill('#completion_prompt_manager_popup_entry_form_name', 'Draft');
    await page.fill('#completion_prompt_manager_popup_entry_form_prompt', 'Some prompt text.');
    await page.evaluate(() => document.getElementById('completion_prompt_manager_popup_entry_form_save').click());
    await page.waitForSelector('#completion_prompt_manager_list [data-pm-name="Draft"]', { state: 'attached' });
    // The default nsfw prompt, renamed Notes in the prompt editor.
    await page.evaluate(() => document.querySelector('#completion_prompt_manager_list li[data-pm-identifier="nsfw"] .prompt-manager-edit-action').click());
    await page.waitForFunction(() => document.getElementById('completion_prompt_manager_popup_entry_form_save')?.dataset.pmPrompt === 'nsfw');
    await page.fill('#completion_prompt_manager_popup_entry_form_name', 'Notes');
    await page.evaluate(() => document.getElementById('completion_prompt_manager_popup_entry_form_save').click());
    // The name shown in each prompt list row (the inspect link, or the plain name span), found by the stored name, and the main prompt.
    const rows = () => page.evaluate(() => Object.fromEntries([['Draft', '[data-pm-name="Draft"]'], ['Notes', '[data-pm-name="Notes"]'], ['main', 'li[data-pm-identifier="main"] [data-pm-name]']].map(([key, query]) => {
        const name = document.querySelector(`#completion_prompt_manager_list ${query}`)?.querySelector(':scope > a.prompt-manager-inspect-action, :scope > span[title]:not([class])');
        return [key, name ? { text: name.textContent.trim(), marked: name.hasAttribute('data-i18n-ignore') } : null];
    })));
    await expect.poll(rows, { message: 'the prompt list rows of the added prompt, the renamed nsfw prompt and the main prompt', timeout: 10000 }).toEqual({
        Draft: { text: 'Draft', marked: true },
        Notes: { text: 'Notes', marked: true },
        main: { text: pt['Main Prompt'], marked: false },
    });
    // The 'Place after' select of a new prompt lists the same prompts.
    const added = await page.evaluate(() => document.querySelector('#completion_prompt_manager_list [data-pm-name="Draft"]')?.closest('li')?.dataset.pmIdentifier);
    expect(added, 'the added prompt has an identifier').toBeTruthy();
    await page.evaluate(() => document.querySelector('#completion_prompt_manager_new, #completion_prompt_manager_prompt_manager_new').click());
    await page.waitForSelector('#completion_prompt_manager_popup_entry_form_placement', { state: 'visible' });
    const placeAfter = () => page.evaluate(ids => Object.fromEntries(ids.map(id => {
        const option = document.querySelector(`#completion_prompt_manager_popup_entry_form_placement option[value="${id}"]`);
        return [id, option ? { text: option.textContent.trim(), marked: option.hasAttribute('data-i18n-ignore') } : null];
    })), [added, 'nsfw', 'main']);
    await expect.poll(placeAfter, { message: 'the Place after options of the added, renamed and main prompts', timeout: 10000 }).toEqual({
        [added]: { text: 'Draft', marked: true },
        nsfw: { text: 'Notes', marked: true },
        main: { text: pt['Main Prompt'], marked: false },
    });
});

// Coverage proofs (M71-A1 A1-12 item 5; Run 3 hand-back ruling R1 and R2; M71-A3 A3-1). Each element below is changed by this fix and
// has no sweep row, or is a markup case the ruling names. Each case runs the shipped code in a durable-fixture page: the real template
// read from disk and rendered, or the app's own builder reached through an exported entry point or the app's own UI action. It then
// reads the live DOM after the run-time localiser has run. A name equal to a pt-pt key must stay as written (and, where the fix marks
// the option, carry data-i18n-ignore); the element's built-in options must carry no data-i18n-ignore and show the merged pt-pt value.
// Each case fails on code without the change, where the name option is unmarked and a whole name is translated.
test('changed select options the sweep does not reach keep a chosen name and still translate their built-in options (pt-pt)', async ({ app }, info) => {
    info.setTimeout(10 * 60 * 1000);
    const pt = await mergedDictionary('pt-pt');
    for (const key of ['Summary', 'Notes', 'Default', '--- None ---', 'Root (No Folder)', '[No presets saved]', 'Add styles below', 'No companion agents available']) {
        expect(pt[key], `${key} is a pt-pt key`).toBeTruthy();
    }
    // 'Current chat model' is built with t and is a key in no pt-pt dictionary today, so it shows its English.
    const shown = key => pt[key] ?? key;
    const options = (page, selector) => page.evaluate(query => [...document.querySelectorAll(query)].map(option => ({
        value: option.value, text: option.textContent.trim(), marked: option.hasAttribute('data-i18n-ignore'),
    })), selector);
    const account = await app.account({});

    // Regex preset list (RegexPresetManager.renderPresetList): its one built-in option shows only while no preset is saved, so it is
    // read before the seed.
    {
        const page = await openPlain(account, 'pt-pt');
        await page.waitForSelector('#regex_presets option', { state: 'attached' });
        expect.soft(await options(page, '#regex_presets option'), 'regex preset list: the fallback option').toEqual([
            { value: '', text: pt['[No presets saved]'], marked: false },
        ]);
        await page.close();
    }

    const characterResponse = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
        ch_name: 'Summary', description: 'A character.', first_mes: 'Hello.', mes_example: '',
    } });
    expect(characterResponse.ok()).toBe(true);
    const characterAvatar = await characterResponse.text();
    await account.post('/api/worldinfo/edit', { name: 'Plain lorebook', data: { entries: { 0: lorebookEntry(0, 'An entry') } } });
    const saved = JSON.parse((await account.post('/api/settings/get')).settings);
    saved.extension_settings.connectionManager.profiles.push({ id: 'nm-profile-summary', name: 'Summary', api: 'custom', mode: 'cc', model: 'm', 'api-url': 'http://127.0.0.1:1/v1' });
    saved.extension_settings.regex_presets = [{ id: 'nm-regex-preset', name: 'Summary', isSelected: true, global: [], scoped: [], preset: [] }];
    saved.tags = [...(saved.tags || []), { id: 'nm-tag-notes', name: 'Notes', folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1,
        is_hidden_on_character_card: false, color: '', color2: '', create_date: 1700000000000 }];
    // The persona note slot (#extension_floating_persona_profile) reads the entry under the active persona's avatar. A profile with no
    // name shows the t`Default` fallback (authors-note.js 137).
    const personaAvatar = saved.user_avatar || account.personaId;
    saved.extension_settings.note = { ...(saved.extension_settings.note || {}) };
    saved.extension_settings.note.persona = { ...(saved.extension_settings.note.persona || {}), [personaAvatar]: {
        useNote: true, prompt: 'Note.', position: 0, activeProfile: 'nm-note',
        profiles: [{ id: 'default', name: '', prompt: '', position: 0 }, { id: 'nm-note', name: 'Summary', prompt: 'Note.', position: 0 }],
    } };
    await account.post('/api/settings/save', saved);

    const page = await openPlain(account, 'pt-pt');
    // Three companion agents: the chatroom companion whose editor is read, a chosen name, and one with its bundled template's name.
    const companionOrder = 37;
    await page.evaluate(async order => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const make = (fields, settings = {}) => {
            const agent = Object.assign(store.createDefaultAgent(), { category: 'companion', execution: 'companion' }, fields);
            agent.settings = { ...agent.settings, ...settings };
            return agent;
        };
        await store.saveAgent(make({ id: 'nm-agent-summary', name: 'Summary', sourceTemplateId: 'tpl-chatroom-companion' },
            { chatroomStyle: 'custom', chatroomCustomStyles: 'Notes: Keep it short.', chatroomCustomStyleName: 'Notes' }));
        const chosen = make({ id: 'nm-agent-default', name: 'Default' });
        chosen.injection.order = order;
        await store.saveAgent(chosen);
        await store.saveAgent(make({ id: 'nm-agent-bundled', name: 'Chat Only', sourceTemplateId: 'tpl-chat-only-companion' }));
        await (await import('/script.js')).saveSettings();
    }, companionOrder);
    const reload = async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
    };
    await reload();

    // Tag merge list (row 36): templates/deleteTag.html, rendered by the app's template loader as onTagDeleteClick renders it.
    await page.evaluate(async () => {
        const { renderTemplateAsync } = await import('/scripts/templates.js');
        const host = document.createElement('div');
        host.id = 'nm-coverage-tag-merge';
        host.innerHTML = await renderTemplateAsync('deleteTag', { otherTags: [{ id: 'nm-tag-notes', name: 'Summary' }] });
        document.body.append(host);
    });
    expect.soft(await options(page, '#nm-coverage-tag-merge #merge_tag_select option'), 'tag merge list (deleteTag.html)').toEqual([
        { value: '', text: pt['--- None ---'], marked: false },
        { value: 'nm-tag-notes', text: 'Summary', marked: true },
    ]);

    // Profile folder list: connection-manager/edit.html, rendered as the profile editor renders it.
    await page.evaluate(async () => {
        const { renderExtensionTemplateAsync } = await import('/scripts/extensions.js');
        const host = document.createElement('div');
        host.id = 'nm-coverage-profile-folder';
        host.innerHTML = await renderExtensionTemplateAsync('connection-manager', 'edit', { name: 'Summary', settings: {}, folders: [{ id: 'nm-folder', name: 'Summary', selected: false }] });
        document.body.append(host);
    });
    expect.soft(await options(page, '#nm-coverage-profile-folder #profile_folder_select option'), 'profile folder list (connection-manager edit.html)').toEqual([
        { value: '', text: pt['Root (No Folder)'], marked: false },
        { value: 'nm-folder', text: 'Summary', marked: true },
    ]);

    // Regex preset list, with a preset saved: the options RegexPresetManager.renderPresetList built at start-up.
    await page.waitForSelector('#regex_presets option[value="nm-regex-preset"]', { state: 'attached' });
    expect.soft(await options(page, '#regex_presets option'), 'regex preset list (RegexPresetManager): the saved preset').toEqual([
        { value: 'nm-regex-preset', text: 'Summary', marked: true },
    ]);

    // Group director profiles: populateGroupDirectorProfiles, run by the app's own handler when the reply order becomes Scene Director.
    await page.evaluate(async () => {
        const { group_activation_strategy } = await import('/scripts/group-chats.js');
        window.$('#rm_group_activation_strategy').val(String(group_activation_strategy.DIRECTOR)).trigger('change');
    });
    await page.waitForSelector('#rm_group_director_profile option[value="nm-profile-summary"]', { state: 'attached' });
    const director = await options(page, '#rm_group_director_profile option');
    expect.soft(director[0], 'group director profiles: the built-in first option').toEqual({ value: '', text: shown('Current chat model'), marked: false });
    expect.soft(director.find(option => option.value === 'nm-profile-summary'), 'group director profiles: the chosen profile').toEqual({ value: 'nm-profile-summary', text: 'Summary', marked: true });

    // Author's Note persona profile list (row 53, rule A): renderNoteSlot fills #extension_floating_persona_profile, which is marked in
    // index.html; its only app-made text is the t`Default` fallback. The app's own opener renders the slot (loadSettings).
    await page.evaluate(async () => { (await import('/scripts/authors-note.js')).openAuthorsNotePanel('persona'); });
    await page.waitForSelector('#extension_floating_persona_profile option[value="nm-note"]', { state: 'attached' });
    expect.soft(await page.evaluate(() => document.getElementById('extension_floating_persona_profile').hasAttribute('data-i18n-ignore')), 'Author\'s Note profile select is marked').toBe(true);
    expect.soft(await options(page, '#extension_floating_persona_profile option'), 'Author\'s Note profile list (renderNoteSlot)').toEqual([
        { value: 'default', text: pt.Default, marked: false },
        { value: 'nm-note', text: 'Summary', marked: false },
    ]);

    // Lorebook entry character filter (R2): fillCharacterAndTagOptionsHelper, run by the exported getWorldEntry when the entry opens.
    await page.evaluate(async () => {
        await window.SillyTavern.getContext().getCharacters();
        const worldInfo = await import('/scripts/world-info.js');
        const data = await worldInfo.loadWorldInfo('Plain lorebook');
        const block = await worldInfo.getWorldEntry('Plain lorebook', data, data.entries[0], { isDesktopSplit: false });
        window.$('<div id="nm-coverage-entry"></div>').appendTo(document.body).append(block);
        block.find('.inline-drawer').trigger('inline-drawer-toggle');
    });
    await page.waitForSelector('#nm-coverage-entry select[name="characterFilter"] option[data-type="tag"]', { state: 'attached' });
    const filter = await page.evaluate(async () => {
        const select = document.querySelector('#nm-coverage-entry select[name="characterFilter"]');
        const read = option => ({ text: option.textContent.trim(), marked: option.hasAttribute('data-i18n-ignore') });
        // The shared picker puts its button just before the select.
        const button = select.previousElementSibling?.matches('.sb-select-picker-button') ? select.previousElementSibling : null;
        const result = {
            // On code without the change the localiser shows the character named Summary as 'Resumo'.
            character: [...select.options].filter(option => option.dataset.type === 'character' && ['Summary', 'Resumo'].includes(option.textContent.trim())).map(read),
            tag: [...select.options].filter(option => option.dataset.type === 'tag' && option.value === 'nm-tag-notes').map(read),
            // The filter has no built-in option; its built-in caption is the picker's placeholder, built with t (world-info.js 3742).
            placeholder: button?.querySelector('.sb-select-picker-value')?.textContent.trim() ?? null,
        };
        // Choosing the character named Summary puts the name on the button (the picker follows option.selected), which must then be protected.
        const summary = [...select.options].find(option => option.dataset.type === 'character' && ['Summary', 'Resumo'].includes(option.textContent.trim()));
        if (summary) summary.selected = true;
        await new Promise(resolve => setTimeout(resolve, 0));
        result.protectedSelection = Boolean(button?.hasAttribute('data-i18n-ignore'));
        return result;
    });
    expect.soft(filter.character, 'lorebook entry character filter: the character named Summary').toEqual([{ text: 'Summary', marked: true }]);
    expect.soft(filter.tag, 'lorebook entry character filter: the tag named Notes').toEqual([{ text: '[Tag] Notes', marked: true }]);
    expect.soft(filter.placeholder, 'lorebook entry character filter: the placeholder').toBe(pt['Tie this entry to specific characters or characters with specific tags']);
    expect.soft(filter.protectedSelection, 'lorebook entry character filter: the picker button is protected once a name is chosen').toBe(true);

    // Agent companion references (refreshAgentReferenceOptions), built-in branch: a new agent is no companion, so the list offers none.
    await shell(page, 'left', 'agents');
    await page.waitForSelector('#ica--addAgent', { state: 'visible' });
    await page.evaluate(() => document.getElementById('ica--addAgent').click());
    await page.waitForSelector('#ica--editor-companion-batchAgentIds option', { state: 'attached' });
    expect.soft(await options(page, '#ica--editor-companion-batchAgentIds option'), 'agent companion references: the built-in empty option').toEqual([
        { value: '', text: pt['No companion agents available'], marked: false },
    ]);
    await reload();

    // The chatroom companion's editor (openEditor): chatroom styles, chatroom extra characters and the companion references.
    await shell(page, 'left', 'agents');
    await page.waitForSelector('#ica--agentList [data-agent-id="nm-agent-summary"] .ica--btn-edit', { state: 'attached' });
    await page.evaluate(() => document.querySelector('#ica--agentList [data-agent-id="nm-agent-summary"] .ica--btn-edit').click());
    await page.waitForSelector('#ica--editor-companion-dependencies option[value="nm-agent-default"]', { state: 'attached' });
    expect.soft(await options(page, '#ica--editor-chatroom-custom-style-name option'), 'agent chatroom styles: the chosen style').toEqual([
        { value: 'Notes', text: 'Notes', marked: true },
    ]);
    // The 'Missing or active' options are unmarked base behaviour and are not asserted (M71-CHECK, 'Amendment A3 check'); with
    // character cards present, 'No other character cards available' does not show.
    expect.soft(await options(page, `#ica--editor-chatroom-extra-character-avatars option[value="${characterAvatar}"]`), 'chatroom extra character options: the character named Summary').toEqual([
        { value: characterAvatar, text: `Summary (${characterAvatar})`, marked: true },
    ]);
    const orderLabelKey = '${0} (Order ${1})';
    const orderLabel = pt[orderLabelKey];
    expect(orderLabel, 'the order label is translated').not.toBe(orderLabelKey);
    expect(orderLabel).toContain('${0}');
    expect(orderLabel).toContain('${1}');
    const chosenLabel = orderLabel.replace('${0}', 'Default').replace('${1}', String(companionOrder));
    for (const id of ['ica--editor-companion-dependencies', 'ica--editor-companion-contextRecipientAgentIds', 'ica--editor-pp-companionTargets']) {
        const list = await options(page, `#${id} option`);
        const chosen = list.find(option => option.value === 'nm-agent-default');
        expect.soft(chosen, `${id}: the agent named Default`).toEqual({ value: 'nm-agent-default', text: chosenLabel, marked: true });
        expect.soft(list.find(option => option.value === 'nm-agent-bundled')?.marked, `${id}: the agent with its bundled name`).toBe(false);
    }
    // With the styles cleared, the style list shows its built-in option.
    await page.evaluate(() => window.$('#ica--editor-chatroom-custom-styles').val('').trigger('input'));
    expect.soft(await options(page, '#ica--editor-chatroom-custom-style-name option'), 'agent chatroom styles: the built-in empty option').toEqual([
        { value: '', text: pt['Add styles below'], marked: false },
    ]);
});
