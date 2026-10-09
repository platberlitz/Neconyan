/* global window, document, DOMParser, globalThis */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Captions that combine interface wording with a name ('Open chat with Thoughts', 'Edit Thoughts', 'Delete Summary') are built already translated, with
// the name put in unchanged by the app's t tag, and the element that carries the caption is marked so the run-time localiser leaves it alone. Without
// both parts, the localiser translates a name that happens to be a dictionary word ('Editar Pensamentos' for a character called Thoughts), and in German,
// where the name comes first, a group named Draft shows 'Entwurf öffnen'.
// This file calls the real builders, cut out of their modules, and then applies the app's two translation mechanisms to what they built, in the order the
// observer in public/scripts/i18n.js applies them to an added element (lines 85-92): translateElement on the element and its [data-i18n] descendants,
// then localizeControls. The dictionary is built by the real getLocaleData, and t, translate and translateElement are the real ones too, so a reading here
// is what the page shows once the observer has run. 'Defect' assertions fail on code before the change and pass after it; 'preservation' assertions pass
// on both. No server is needed: tests/user-text-render.e2e.js uses the same technique (page.setContent, real functions cut out with a regular
// expression, free names stubbed).

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const conversation = 'public/scripts/neconyan-conversation';
const quickImageGen = 'public/scripts/extensions/quick-image-gen/index.js';
const languages = ['pt-pt', 'de-de'];
const DEFECT = 'defect';
const PRESERVATION = 'preservation';

// What is cut out of which file: top-level functions, by name. A name that cannot be cut is a set-up error, never a skipped check.
const wanted = {
    'public/scripts/i18n.js': ['translateElement', 't', 'translate', 'getLocaleData'],
    'public/script.js': ['getCharacterBlock'],
    'public/scripts/group-chats.js': ['getGroupBlock'],
    [`${conversation}/interface.js`]: ['buildBranchListFingerprint', 'buildPalsRailFingerprint', 'renderPalsRail'],
    [`${conversation}/media.js`]: ['getParticipantNamesForDisplay', 'renderConversationParticipantStack', 'getConversationDisplayName', 'getConversationDisplayLabel'],
    [`${conversation}/render-utils.js`]: ['hashConversationRenderFingerprint', 'escapeHtmlAttribute', 'escapeHtmlText', 'setUserTextSlot'],
    [`${conversation}/thread-store.js`]: ['getConversationMessagePreviewText', 'isConversationPreviewValue'],
    [`${conversation}/typing.js`]: ['stripPreviewText', 'getLastConversationPreview', 'isLastConversationPreviewValue'],
    [quickImageGen]: [
        'getContextualFilterScopeOptions', 'getCardNameForFilters', 'getCharacterNameForFilters', 'getFilterManagerScopeValue',
        'getKnownFilterScopeCardMap', 'getKnownFilterScopeCharacterMap', 'getCurrentCardScopeInfo', 'getCurrentCharId', 'getCurrentCharName',
        'getCurrentCharacterEntry', 'getCharacterEntryById', 'getContextCharactersList', 'getScopedRecordFromEntity', 'getNormalizedScopedRecord',
        'normalizeCardScopeKey', 'normalizeContextLookupValue', 'normalizeScopeLabel', 'formatCardScopeFallbackLabel',
    ],
};

// The expected captions, and the wording that has to stay as it is. 'Thoughts', 'Draft', 'Summary' and 'Main' are keys of the dictionaries, which is
// why a name like them shows the defect before the change.
const wording = {
    'pt-pt': {
        openChatLabel: 'Abrir chat', editCardLabel: 'Editar card', editGroupLabel: 'Editar grupo', newBranchLabel: 'Nova ramificação', defaultBranchRow: 'Principal',
        A1: 'Abrir chat com Thoughts', A2: 'Editar Thoughts', A2Edit: 'Editar Edit Thoughts', A2Ampersand: 'Editar Tom & Jerry', A3: 'Editar Draft', B1: 'Abrir Draft',
        A4Solo: 'Excluir histórico da DM individual com Thoughts', A4Group: 'Excluir histórico de Conversa em grupo com Thoughts',
        A4Fallback: 'Excluir histórico da DM individual com Personagem',
        A5Default: 'Renomear Principal', A5Main: 'Renomear Main', A5Summary: 'Renomear Summary', A5Fallback: 'Renomear conversation',
        A6Default: 'Excluir Principal', A6Main: 'Excluir Main', A6Summary: 'Excluir Summary', A6Fallback: 'Excluir conversation',
        A8CurrentCard: 'Card Atual: Thoughts', A8CurrentCharacter: 'Personagem atual: Thoughts', A8Card: 'Card: X', A8Character: 'Personagem: Tom & Jerry',
        A8GlobalOnly: 'Somente global', A8CharacterMissing: 'Personagem: Character 7',
    },
    'de-de': {
        openChatLabel: 'Chat öffnen', editCardLabel: 'Karte bearbeiten', editGroupLabel: 'Gruppe bearbeiten', newBranchLabel: 'Neuer Zweig', defaultBranchRow: 'Haupt',
        A1: 'Chat mit Thoughts öffnen', A2: 'Thoughts bearbeiten', A2Edit: 'Edit Thoughts bearbeiten', A2Ampersand: 'Tom & Jerry bearbeiten', A3: 'Draft bearbeiten',
        B1: 'Draft öffnen',
        A4Solo: 'Solo-DM-Verlauf mit Thoughts löschen', A4Group: 'Gruppenunterhaltungsverlauf mit Thoughts löschen', A4Fallback: 'Solo-DM-Verlauf mit Charakter löschen',
        A5Default: 'Haupt umbenennen', A5Main: 'Main umbenennen', A5Summary: 'Summary umbenennen', A5Draft: 'Draft umbenennen', A5Fallback: 'conversation umbenennen',
        A6Default: 'Haupt löschen', A6Main: 'Main löschen', A6Summary: 'Summary löschen', A6Draft: 'Draft löschen', A6Fallback: 'conversation löschen',
        A8CurrentCard: 'Aktuelle Karte: Thoughts', A8CurrentCharacter: 'Aktueller Charakter: Thoughts', A8Card: 'Karte: X', A8Character: 'Charakter: Tom & Jerry',
        A8GlobalOnly: 'Nur global', A8CharacterMissing: 'Charakter: Character 7',
    },
};
// B1 ('Open ${0}' on a group named Draft): the pt-pt value reads the same before and after; German moves from 'Entwurf öffnen' to 'Draft öffnen'.
const b1Kind = { 'pt-pt': PRESERVATION, 'de-de': DEFECT };
// A8 'Card: ${0}': the pt-pt value of the key equals the key, so the English label already equals the expected one.
const a8CardKind = { 'pt-pt': PRESERVATION, 'de-de': DEFECT };
// The Draft branch (A5 rename, A6 delete) is checked in German only: the name comes first there, so an unmarked caption holding the word Draft is changed
// to Entwurf by the localiser, and the mark is what stops it.
const draftChecks = {
    'pt-pt': [],
    'de-de': [{ site: 'A5', button: 'rename', verb: 'rename', wording: 'A5Draft' }, { site: 'A6', button: 'remove', verb: 'delete', wording: 'A6Draft' }],
};

/** A top-level function as written in the file, or null when it cannot be cut. */
function declaration(text, name) {
    const match = text.match(new RegExp(`^(?:export )?(?:async )?(?:function|class) ${name}\\b[^]*?\\n}$`, 'm'));
    return match ? match[0].replace(/^export /, '') : null;
}

/** One assertion: what was read, what it should be, and whether it is a defect assertion or a preservation assertion. */
function reading(kind, site, what, received, expected) {
    if (kind !== DEFECT && kind !== PRESERVATION) throw new Error(`Set-up error: ${kind} is neither a defect nor a preservation assertion`);
    return { kind, site, what, received, expected };
}

/** Keeps every reading (passing ones too) and the names that fell through to a no-op stub with the test result. */
async function attachReadings(page, testInfo, language, readings) {
    const stubbed = await page.evaluate(() => [...window.harness.stubbed].sort());
    await testInfo.attach(`readings-${language}.json`, { body: JSON.stringify({ language, readings, stubbed }, null, 2), contentType: 'application/json' });
}

/**
 * Opens a page that holds the real run-time localiser, jQuery, the real list templates from public/index.html, and a scope with the real builders and the
 * real t, translate and translateElement over the dictionary the app's own getLocaleData builds. A name that is not defined and not a browser global is
 * a no-op stub (listed in the readings attachment); trackMissingDynamicTranslate is null, as in the app without tracking.
 */
async function openScope(page, language) {
    const sources = {};
    for (const [file, names] of Object.entries(wanted)) {
        const text = await read(file);
        for (const name of names) {
            const source = declaration(text, name);
            if (!source) throw new Error(`Set-up error: ${name} could not be cut out of ${file}`);
            if (sources[name]) throw new Error(`Set-up error: ${name} is cut twice`);
            sources[name] = source;
        }
    }
    // The scope constants of Quick Image Gen, read from its source so that they cannot drift from the real values.
    const constants = Object.fromEntries([...(await read(quickImageGen)).matchAll(/^const (FILTER_(?:MANAGER_)?SCOPE_[A-Z_]+) = "([^"]*)";$/gm)].map(match => [match[1], match[2]]));
    if (Object.keys(constants).length !== 6) throw new Error(`Set-up error: expected 6 Quick Image Gen scope constants, read ${Object.keys(constants).length}`);
    const json = async path => JSON.parse(await read(path));
    // The three files the app's getLocaleData fetches, by the addresses it asks for.
    const files = {
        [`./locales/${language}.json`]: await json(`public/locales/${language}.json`),
        './locales/neconyan/en.json': await json('public/locales/neconyan/en.json'),
        [`./locales/neconyan/${language}.json`]: await json(`public/locales/neconyan/${language}.json`),
    };
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({ type: 'module', content: `${await read('public/scripts/ui-localization.js')}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    await page.addScriptTag({ content: await read('public/lib/jquery-3.5.1.min.js') });
    await page.evaluate(async ([sources, constants, files, indexHtml, language]) => {
        const target = {};
        const stubbed = new Set();
        const noop = () => undefined;
        // Free names in the cut code resolve here first; anything not defined (and not a browser global) is a no-op.
        const scope = new Proxy(target, {
            has: (object, key) => typeof key === 'string' && (key in object || !(key in globalThis)),
            get: (object, key) => {
                if (typeof key !== 'string' || key in object) return object[key];
                stubbed.add(key);
                return noop;
            },
        });
        Object.keys(sources).forEach(name => { scope[name] = new Function('scope', `with (scope) { return (${sources[name]}); }`)(scope); });
        // The dictionary: the app's getLocaleData, given the three files in place of fetch.
        scope.findLang = lang => ({ lang });
        scope.fetch = async url => ({ ok: Object.hasOwn(files, url), json: async () => files[url] });
        scope.localeData = await scope.getLocaleData(language);
        scope.trackMissingDynamicTranslate = null;
        Object.assign(scope, constants, {
            $: window.jQuery, characters: [], selected_group: null, this_chid: undefined, power_user: {}, default_avatar: '', getThumbnailUrlForViewport: () => '',
            getPermanentAssistantAvatar: () => 'assistant.png', printTagList: () => undefined, getGroupAvatar: () => null,
            DEFAULT_BRANCH_ID: 'main', MAX_STACKED_PARTICIPANT_AVATARS: 4, default_user_avatar: '', getThumbnailUrl: () => '', getSettings: () => ({}),
            getEffectiveConversationStatus: () => 'online', getConversationPersonaId: () => 'persona', getConversationGroupIdForAvatar: () => '',
            getCurrentCharAvatar: () => '', getConversationAttachmentLabels: () => [],
            parsePositiveInt: (value, fallback, min = 1) => { const number = Number.parseInt(value, 10); return Number.isFinite(number) && number >= min ? number : fallback; },
        });
        // The real list templates, which the character and group builders clone (index.html: #character_template, #group_list_template).
        const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
        const templates = document.createElement('div');
        templates.hidden = true;
        for (const id of ['character_template', 'group_list_template']) {
            const template = parsed.getElementById(id);
            if (!template) throw new Error(`Set-up error: index.html has no #${id}`);
            templates.append(document.importNode(template, true));
        }
        document.body.append(templates);
        // What the observer in i18n.js does to an added element, and to an added text node (lines 85-95), with the real functions.
        const applyAdded = node => {
            if (node.hasAttribute('data-i18n')) scope.translateElement(node);
            node.querySelectorAll('[data-i18n]').forEach(element => scope.translateElement(element));
            window.localizeControls(node, scope.localeData || {});
        };
        const applyAddedText = text => window.localizeControls(text.parentElement, scope.localeData || {});
        window.harness = { scope, stubbed, applyAdded, applyAddedText, dictionary: scope.localeData };
    }, [sources, constants, files, await read('public/index.html'), language]);
}

test('mechanism (preservation): a caption built with t inside a marked element is left alone, a data-i18n label inside it and an unmarked sibling still translate', async ({ page }, testInfo) => {
    const language = 'de-de';
    await openScope(page, language);
    const result = await page.evaluate(() => {
        const { scope, applyAdded, applyAddedText } = window.harness;
        document.getElementById('root').innerHTML = `<div id="host">
            <button type="button" id="marked" data-i18n-ignore><span id="label" data-i18n="Open chat">Open chat</span></button>
            <button type="button" id="sibling" title="Reset override"></button>
            <button type="button" id="control"></button>
            <span id="written" data-i18n-ignore></span>
            <span id="written-control"></span>
        </div>`;
        const element = id => document.getElementById(id);
        // The German caption a builder makes with t: the name comes first, so the localiser would match 'Draft' as a word if it looked at the text.
        const caption = scope.t`Open ${'Draft'}`;
        for (const id of ['marked', 'control']) {
            element(id).setAttribute('title', caption);
            element(id).setAttribute('aria-label', caption);
        }
        applyAdded(element('host'));
        const pair = id => [element(id).getAttribute('title'), element(id).getAttribute('aria-label')];
        const result = { marked: pair('marked'), label: element('label').textContent, sibling: element('sibling').getAttribute('title'), control: pair('control') };
        // The observer's text-node path (i18n.js:93-95): a rewrite of an existing span adds a text node, and the localiser looks at its parent.
        result.written = [];
        result.writtenControl = [];
        for (const text of [scope.t`Open ${'Draft'}`, scope.t`Edit ${'Draft'}`]) {
            for (const [id, into] of [['written', result.written], ['written-control', result.writtenControl]]) {
                element(id).textContent = text;
                applyAddedText(element(id).firstChild);
                into.push(element(id).textContent);
            }
        }
        return result;
    });
    const readings = [
        reading(PRESERVATION, 'mechanism', 'title and aria-label of a marked button holding a German t caption stay as built', result.marked, ['Draft öffnen', 'Draft öffnen']),
        reading(PRESERVATION, 'mechanism', 'a data-i18n span inside the marked button is translated by translateElement', result.label, wording[language].openChatLabel),
        reading(PRESERVATION, 'mechanism', 'an unmarked sibling control is still translated by the localiser', result.sibling, 'Überschreibung zurücksetzen'),
        reading(PRESERVATION, 'mechanism', 'control: the same caption on an unmarked button is changed by the localiser (so the test can see the defect)', result.control, ['Entwurf öffnen', 'Entwurf öffnen']),
        reading(PRESERVATION, 'mechanism', 'observer text-node path: a marked span rewritten with German t captions stays as written', result.written, ['Draft öffnen', 'Draft bearbeiten']),
        reading(PRESERVATION, 'mechanism', 'control: the same rewrites of an unmarked span are changed by the localiser', result.writtenControl, ['Entwurf öffnen', 'Entwurf bearbeiten']),
    ];
    await attachReadings(page, testInfo, language, readings);
    for (const r of readings) expect.soft(r.received, `${r.kind}: ${r.site} (${language}): ${r.what}`).toEqual(r.expected);
});

for (const language of languages) {
    const words = wording[language];

    test(`getCharacterBlock (${language}): A1 and A2 captions keep the name as written, and the visible labels still translate`, async ({ page }, testInfo) => {
        await openScope(page, language);
        const blocks = await page.evaluate(() => {
            const { scope, applyAdded } = window.harness;
            const list = document.getElementById('root');
            // The names: a dictionary word, a name that starts with a dictionary caption, and one with an ampersand.
            return ['Thoughts', 'Edit Thoughts', 'Tom & Jerry'].map((name, id) => {
                const block = scope.getCharacterBlock({ name, avatar: `card${id}.png`, fav: false, data: {} }, id);
                list.append(block[0]);
                applyAdded(block[0]);
                const button = action => block[0].querySelector(`[data-entity-action="${action}"]`);
                return {
                    name,
                    open: button('open-chat').getAttribute('aria-label'),
                    edit: button('edit-card').getAttribute('aria-label'),
                    openLabel: button('open-chat').querySelector('span').textContent,
                    editLabel: button('edit-card').querySelector('span').textContent,
                };
            });
        });
        const readings = [
            reading(DEFECT, 'A1', 'aria-label of the Open chat button, character Thoughts', blocks[0].open, words.A1),
            reading(DEFECT, 'A2', 'aria-label of the Edit card button, character Thoughts', blocks[0].edit, words.A2),
            reading(PRESERVATION, 'A2', 'aria-label of the Edit card button, character named Edit Thoughts', blocks[1].edit, words.A2Edit),
            reading(PRESERVATION, 'A2', 'aria-label of the Edit card button, character named Tom & Jerry', blocks[2].edit, words.A2Ampersand),
            reading(PRESERVATION, 'labels', 'visible Open chat label (data-i18n) of the character block', blocks[0].openLabel, words.openChatLabel),
            reading(PRESERVATION, 'labels', 'visible Edit card label (data-i18n) of the character block', blocks[0].editLabel, words.editCardLabel),
        ];
        await attachReadings(page, testInfo, language, readings);
        for (const r of readings) expect.soft(r.received, `${r.kind}: ${r.site} (${language}): ${r.what}`).toEqual(r.expected);
    });

    test(`getGroupBlock (${language}): A3 and B1 captions keep a group name as written, and the visible labels still translate`, async ({ page }, testInfo) => {
        await openScope(page, language);
        const block = await page.evaluate(() => {
            const { scope, applyAdded } = window.harness;
            const group = scope.getGroupBlock({ id: 'group1', name: 'Draft', members: [], fav: false });
            document.getElementById('root').append(group[0]);
            applyAdded(group[0]);
            const button = action => group[0].querySelector(`[data-entity-action="${action}"]`);
            return {
                open: button('open-chat').getAttribute('aria-label'),
                edit: button('edit-group').getAttribute('aria-label'),
                openLabel: button('open-chat').querySelector('span').textContent,
                editLabel: button('edit-group').querySelector('span').textContent,
            };
        });
        const readings = [
            reading(DEFECT, 'A3', 'aria-label of the Edit group button, group Draft', block.edit, words.A3),
            reading(b1Kind[language], 'B1', 'aria-label of the Open chat button of the group Draft', block.open, words.B1),
            reading(PRESERVATION, 'labels', 'visible Open chat label (data-i18n) of the group block', block.openLabel, words.openChatLabel),
            reading(PRESERVATION, 'labels', 'visible Edit group label (data-i18n) of the group block', block.editLabel, words.editGroupLabel),
        ];
        await attachReadings(page, testInfo, language, readings);
        for (const r of readings) expect.soft(r.received, `${r.kind}: ${r.site} (${language}): ${r.what}`).toEqual(r.expected);
    });

    test(`renderPalsRail (${language}): A4, A5 and A6 captions keep names as written, the Main exception holds, and the rows still translate`, async ({ page }, testInfo) => {
        await openScope(page, language);
        const rail = await page.evaluate(() => {
            const { scope, applyAdded } = window.harness;
            const list = document.createElement('div');
            list.id = 'pals';
            document.getElementById('root').append(list);
            const branch = (id, name) => ({ id, name, preview: 'Conversation ready', unread: 0, messages: [] });
            const solo = { avatar: 'a.png', name: 'Thoughts' };
            const nameless = { avatar: 'b.png', name: '' };
            const anchor = { avatar: 's.png', name: 'Thoughts' };
            const pals = [
                { character: solo, index: 0, settings: {}, groupId: '', group: null },
                { character: nameless, index: 1, settings: {}, groupId: '', group: null },
                { character: anchor, index: 2, settings: {}, groupId: 'g1', group: { id: 'g1', name: 'Group chat' } },
            ];
            // Thoughts: the default branch Main, another branch named Main, and Summary. The card with no name has one branch with no name (a controlled
            // fixture: the app always names a branch). The group row's anchor member is Thoughts.
            const stores = {
                '|a.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main'), b2: branch('b2', 'Main'), b3: branch('b3', 'Summary'), b4: branch('b4', 'Draft') } },
                '|b.png': { activeBranchId: 'main', branches: { main: branch('main', '') } },
                'g1|s.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main') } },
            };
            const participants = { 'g1|s.png': [anchor] };
            const key = (avatar, { groupId = '' } = {}) => `${groupId}|${avatar}`;
            Object.assign(scope, {
                CHROME_IDS: { palsList: 'pals' }, conversationState: {}, getConversationRailItems: () => pals, getUnreadCount: () => 0, isConversationActiveThread: () => false,
                getBadgeLabel: () => '', getConversationThreadStore: (avatar, options) => stores[key(avatar, options)],
                getActiveConversationBranch: (avatar, options) => stores[key(avatar, options)]?.branches[stores[key(avatar, options)].activeBranchId],
                getConversationBranches: (avatar, options) => Object.values(stores[key(avatar, options)]?.branches ?? {}),
                getConversationParticipants: (avatar, settings, options) => participants[key(avatar, options)] ?? [{ avatar, name: pals.find(pal => pal.character.avatar === avatar).character.name }],
            });
            scope.renderPalsRail();
            // Each row is a node added to the list, as the observer sees it.
            [...list.children].forEach(applyAdded);
            const pair = element => [element?.getAttribute('title'), element?.getAttribute('aria-label')];
            const action = (parent, name) => parent.querySelector(`:scope > [data-sb-conversation-action="${name}"]`);
            return [...list.querySelectorAll(':scope > .sb-conversation-pal-row')].map(row => ({
                avatar: row.querySelector('.sb-conversation-pal').dataset.avatar,
                name: row.querySelector('.sb-conversation-pal-name').textContent,
                deleteDm: pair(action(row, 'delete-dm')),
                newBranch: row.querySelector('.sb-conversation-new-branch span').textContent,
                branches: [...row.querySelectorAll('.sb-conversation-branch-row')].map(branchRow => ({
                    id: branchRow.querySelector('.sb-conversation-branch-button').dataset.branchId,
                    name: branchRow.querySelector('.sb-conversation-branch-name').textContent,
                    rename: pair(action(branchRow, 'rename-branch')),
                    remove: pair(action(branchRow, 'delete-branch')),
                })),
            }));
        });
        const [thoughts, nameless, group] = rail;
        const [defaultBranch, otherMain, summary, draft] = thoughts.branches;
        const twice = value => [value, value];
        const readings = [
            reading(DEFECT, 'A4', 'title and aria-label of the delete button, solo row, character Thoughts', thoughts.deleteDm, twice(words.A4Solo)),
            reading(DEFECT, 'A4', 'title and aria-label of the delete button, group row, member Thoughts', group.deleteDm, twice(words.A4Group)),
            reading(PRESERVATION, 'A4', 'title and aria-label of the delete button, solo row, character with no name (Character fallback; controlled fixture)', nameless.deleteDm, twice(words.A4Fallback)),
            reading(PRESERVATION, 'A5', 'title and aria-label of the rename button, the default branch named Main', defaultBranch.rename, twice(words.A5Default)),
            reading(DEFECT, 'A5', 'title and aria-label of the rename button, another branch named Main', otherMain.rename, twice(words.A5Main)),
            reading(DEFECT, 'A5', 'title and aria-label of the rename button, branch Summary', summary.rename, twice(words.A5Summary)),
            reading(PRESERVATION, 'A5', 'title and aria-label of the rename button, branch with no name (conversation fallback; controlled fixture)', nameless.branches[0].rename, twice(words.A5Fallback)),
            reading(PRESERVATION, 'A6', 'title and aria-label of the delete button, the default branch named Main', defaultBranch.remove, twice(words.A6Default)),
            reading(DEFECT, 'A6', 'title and aria-label of the delete button, another branch named Main', otherMain.remove, twice(words.A6Main)),
            reading(DEFECT, 'A6', 'title and aria-label of the delete button, branch Summary', summary.remove, twice(words.A6Summary)),
            reading(PRESERVATION, 'A6', 'title and aria-label of the delete button, branch with no name (conversation fallback; controlled fixture)', nameless.branches[0].remove, twice(words.A6Fallback)),
            reading(PRESERVATION, 'rows', 'branch row of the default branch named Main still translates', defaultBranch.name, words.defaultBranchRow),
            reading(PRESERVATION, 'rows', 'branch row of another branch named Main shows the name as stored', otherMain.name, 'Main'),
            reading(PRESERVATION, 'rows', 'branch row of the branch Summary shows the name as stored', summary.name, 'Summary'),
            reading(PRESERVATION, 'rows', 'pal row of the character Thoughts shows the name as stored', thoughts.name, 'Thoughts'),
            reading(PRESERVATION, 'rows', 'the New branch label still translates', thoughts.newBranch, words.newBranchLabel),
        ];
        for (const check of draftChecks[language]) {
            readings.push(reading(DEFECT, check.site, `title and aria-label of the ${check.verb} button, branch Draft (German: the mark stops the localiser changing the name)`, draft[check.button], twice(words[check.wording])));
        }
        await attachReadings(page, testInfo, language, readings);
        for (const r of readings) expect.soft(r.received, `${r.kind}: ${r.site} (${language}): ${r.what}`).toEqual(r.expected);
    });

    test(`getContextualFilterScopeOptions (${language}): A8 label data has the translated wording, the names as written and 'Global only' translated`, async ({ page }, testInfo) => {
        await openScope(page, language);
        const labels = await page.evaluate(() => {
            const { scope } = window.harness;
            // The page state the helpers read: character 0 (Thoughts) is open, a second character is Tom & Jerry, a filter belongs to another card (stored
            // label X), one to character 1, and one to character 7, which the list no longer holds (the numbered fallback; a controlled fixture).
            scope.getContext = () => ({ characterId: '0', characters: [{ name: 'Thoughts', avatar: 'thoughts.png' }, { name: 'Tom & Jerry', avatar: 'tom.png' }] });
            scope.resolveChatProfileContext = () => ({ charIds: [], charNames: [] });
            scope.contextualFilters = [
                { id: 'f1', scope: 'card', cardKey: 'other.png', cardLabel: 'X' },
                { id: 'f2', scope: 'char', charId: '1' },
                { id: 'f3', scope: 'char', charId: '7' },
            ];
            scope.filterPools = [];
            return Object.fromEntries(scope.getContextualFilterScopeOptions().map(option => [option.value, option.label]));
        });
        const readings = [
            reading(DEFECT, 'A8', 'label of the Current Card option, card Thoughts', labels.__qig_scope_current_card__, words.A8CurrentCard),
            reading(DEFECT, 'A8', 'label of the Current Character option, character Thoughts', labels.__qig_scope_current_char__, words.A8CurrentCharacter),
            reading(a8CardKind[language], 'A8', 'label of the Card option for the scope of another card, stored label X', labels['card:other.png'], words.A8Card),
            reading(DEFECT, 'A8', 'label of the Character option for the scope of another character, Tom & Jerry', labels['char:1'], words.A8Character),
            reading(DEFECT, 'A8', 'label of the Global only option', labels.__qig_scope_global_only__, words.A8GlobalOnly),
            reading(DEFECT, 'A8', 'label of the Character option for a character no longer listed (numbered fallback Character 7; controlled fixture)', labels['char:7'], words.A8CharacterMissing),
        ];
        await attachReadings(page, testInfo, language, readings);
        for (const r of readings) expect.soft(r.received, `${r.kind}: ${r.site} (${language}): ${r.what}`).toEqual(r.expected);
    });
}
