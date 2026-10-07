/* global window, document, globalThis */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Calls the real render code of each surface that shows a name or text a person wrote, and then runs the real run-time localiser over the result
// with the merged pt-pt dictionary. 'Defect' assertions fail on code before the user-text change and pass after it; 'preservation' assertions
// (the interface's own captions on the same elements) pass on both. The render functions are cut out of their modules and run against stubs
// for the app's state (the modules import the whole app), as tests/notes-user-text.e2e.js does; a helper the change adds is defined only when
// this code has it, so the same file runs on code before and after the change.

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const conversation = 'public/scripts/neconyan-conversation';
const quickReply = 'public/scripts/extensions/quick-reply/src';
// What is cut out of which file: top-level functions and classes, by name.
const wanted = {
    [`${conversation}/media.js`]: ['getParticipantNamesForDisplay', 'renderConversationParticipantStack', 'getConversationDisplayName', 'getConversationDisplayLabel'],
    [`${conversation}/render-utils.js`]: ['hashConversationRenderFingerprint', 'escapeHtmlAttribute', 'escapeHtmlText', 'setUserTextSlot'],
    [`${conversation}/thread-store.js`]: ['getConversationMessagePreviewText', 'isConversationPreviewValue'],
    [`${conversation}/typing.js`]: ['stripPreviewText', 'getLastConversationPreview', 'isLastConversationPreviewValue'],
    [`${conversation}/interface.js`]: ['buildBranchListFingerprint', 'buildPalsRailFingerprint', 'buildHeaderParticipantsFingerprint', 'renderHeaderParticipantStack', 'renderPalsRail', 'updateConversationHeader'],
    [`${conversation}/pickers.js`]: ['updateUserFooter', 'toggleAddDmPicker'],
    [`${conversation}/timeline-render.js`]: ['buildPartnerOptions'],
    [`${conversation}/context.js`]: ['normalizeConversationBranch', 'createConversationBranch'],
    [`${conversation}/settings-store.js`]: ['getConversationWelcomeChats'],
    'public/scripts/welcome-screen.js': ['getNeconyanRecentChatLabel', 'isNeconyanRecentChatLabelNamed', 'createNeconyanRailButton', 'renderNeconyanRailRecentChats'],
    'public/script.js': ['openCharacterWorldPopup'],
    'public/scripts/neconyan-tabs.js': ['updateTopBarBrand'],
    [`${quickReply}/QuickReplySetLink.js`]: ['QuickReplySetLink'],
    [`${quickReply}/ui/SettingsUi.js`]: ['SettingsUi'],
    [`${quickReply}/quick-reply-set-list.js`]: ['getUniqueQuickReplySetsByName', 'getQuickReplySetNameKey', 'getQuickReplySetLinkNameKey'],
};

/** A top-level function or class as written in the file, or null when this code does not have it. */
function declaration(text, name) {
    const match = text.match(new RegExp(`^(?:export )?(?:async )?(?:function|class) ${name}\\b[^]*?\\n}$`, 'm'));
    return match ? match[0].replace(/^export /, '') : null;
}

async function mergedDictionary(lang) {
    const readJson = async path => JSON.parse(await read(path));
    return { ...await readJson(`public/locales/${lang}.json`), ...await readJson(`public/locales/neconyan/${lang}.json`) };
}

/** Opens a page with the localiser, the merged pt-pt dictionary and a scope that holds the real render code; unknown names are no-op stubs. */
async function openRender(page) {
    const sources = {};
    for (const [file, names] of Object.entries(wanted)) {
        const text = await read(file);
        for (const name of names) if (declaration(text, name)) sources[name] = declaration(text, name);
    }
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({ type: 'module', content: `${await read('public/scripts/ui-localization.js')}\nwindow.localizeControls = localizeControls;` });
    await page.waitForFunction(() => typeof window.localizeControls === 'function');
    await page.addScriptTag({ content: await read('public/lib/jquery-3.5.1.min.js') });
    await page.evaluate(([sources, dictionary]) => {
        const target = {};
        const stubbed = new Set();
        const noop = () => undefined;
        // Free names in the render code resolve here first; anything not defined (and not a browser global) is a no-op.
        const scope = new Proxy(target, {
            has: (object, key) => typeof key === 'string' && (key in object || !(key in globalThis)),
            get: (object, key) => {
                if (typeof key !== 'string' || key in object) return object[key];
                stubbed.add(key);
                return noop;
            },
        });
        const define = name => { if (sources[name]) scope[name] = new Function('scope', `with (scope) { return (${sources[name]}); }`)(scope); };
        Object.keys(sources).forEach(define);
        // translate() and t() as public/scripts/i18n.js defines them, reading the loaded locale.
        scope.translate = (text, key = null) => dictionary[key || text] || text;
        scope.t = (strings, ...values) => scope.translate(strings.reduce((result, string, i) => result + string + (values[i] !== undefined ? `\${${i}}` : ''), ''))
            .replace(/\$\{(\d+)\}/g, (_match, index) => values[index]);
        Object.assign(scope, { DEFAULT_BRANCH_ID: 'main', MAX_STACKED_PARTICIPANT_AVATARS: 4, default_user_avatar: '', getThumbnailUrl: () => '', getSettings: () => ({}),
            getEffectiveConversationStatus: () => 'online', getConversationPersonaId: () => 'persona', getConversationGroupIdForAvatar: () => '', getCurrentCharAvatar: () => '',
            getConversationAttachmentLabels: () => [], parsePositiveInt: (value, fallback, min = 1) => { const number = Number.parseInt(value, 10); return Number.isFinite(number) && number >= min ? number : fallback; } });
        const localise = () => window.localizeControls(document.getElementById('root'), dictionary);
        window.render = { scope, localise, stubbed, dictionary, has: name => Boolean(sources[name]) };
    }, [sources, await mergedDictionary('pt-pt')]);
}

test('the Pals rail shows names, branch names and previews as written, translates its own captions, and keeps the default branch Main translated', async ({ page }) => {
    await openRender(page);
    const rows = await page.evaluate(() => {
        const { scope, localise } = window.render;
        document.getElementById('root').innerHTML = '<div id="pals"></div>';
        const branch = (id, name, preview, messages = []) => ({ id, name, preview, unread: 0, messages: messages.map(mes => ({ mes })) });
        const solo = { avatar: 'a.png', name: 'Thoughts' };
        const nameless = { avatar: 'b.png', name: '' };
        const anchor = { avatar: 's.png', name: 'Solo' };
        const blank = { avatar: 'x.png', name: '' };
        const pals = [
            { character: solo, index: 0, settings: {}, groupId: '', group: null },
            { character: nameless, index: 1, settings: {}, groupId: '', group: null },
            { character: anchor, index: 2, settings: {}, groupId: 'g1', group: { id: 'g1', name: 'Group DM' } },
            { character: blank, index: 3, settings: {}, groupId: 'g2', group: { id: 'g2', name: '' } },
        ];
        const stores = {
            '|a.png': { activeBranchId: 'b3', branches: {
                main: branch('main', 'Main', 'Conversation ready'),
                b2: branch('b2', 'Main', 'Conversation ready', ['Conversation ready']),
                b3: branch('b3', 'Conversation', 'Summary', ['Summary']),
            } },
            '|b.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main', 'Conversation ready') } },
            'g1|s.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main', 'Conversation ready') } },
            'g2|x.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main', 'Conversation ready') } },
        };
        const participants = { 'g1|s.png': [anchor], 'g2|x.png': [blank] };
        const key = (avatar, { groupId = '' } = {}) => `${groupId}|${avatar}`;
        Object.assign(scope, {
            CHROME_IDS: { palsList: 'pals' }, conversationState: {}, getConversationRailItems: () => pals, getUnreadCount: () => 0, isConversationActiveThread: () => false,
            getBadgeLabel: () => '', getConversationThreadStore: (avatar, options) => stores[key(avatar, options)],
            getActiveConversationBranch: (avatar, options) => stores[key(avatar, options)]?.branches[stores[key(avatar, options)].activeBranchId],
            getConversationBranches: (avatar, options) => Object.values(stores[key(avatar, options)]?.branches ?? {}),
            getConversationParticipants: (avatar, settings, options) => participants[key(avatar, options)] ?? [{ avatar, name: pals.find(pal => pal.character.avatar === avatar).character.name }],
        });
        scope.renderPalsRail();
        localise();
        const text = (element, selector) => element.querySelector(selector)?.textContent;
        return [...document.querySelectorAll('.sb-conversation-pal-row')].map(row => ({
            name: text(row, '.sb-conversation-pal-name'), kind: text(row, '.sb-conversation-pal-kind'), preview: text(row, '.sb-conversation-pal-preview'),
            stack: row.querySelector('.sb-conversation-pal-avatar').title, stackTranslate: row.querySelector('.sb-conversation-pal-avatar').getAttribute('translate'),
            branches: [...row.querySelectorAll('.sb-conversation-branch-button')].map(button => [text(button, '.sb-conversation-branch-name'), text(button, '.sb-conversation-branch-preview')]),
        }));
    });
    // Defect assertions: a value that equals a key shows as written; a secondary branch named Main or Conversation shows as stored.
    expect.soft([rows[0].name, rows[0].preview, rows[0].stack], 'defect: solo name, preview and stack title as written').toEqual(['Thoughts', 'Summary', 'Thoughts']);
    expect.soft([rows[2].name, rows[2].kind, rows[2].stack], 'defect: group name, kind and stack title as written').toEqual(['Solo', 'Group DM', 'Solo']);
    expect.soft(rows[0].branches, 'defect: secondary branches, and a preview a person wrote, as written').toEqual([
        ['Principal', 'Tudo pronto para conversar'], ['Main', 'Conversation ready'], ['Conversation', 'Summary'],
    ]);
    // Preservation assertions: the built-in fallbacks, the default branch Main (decision D1-A) and the unnamed group's stack stay translated;
    // a stack with no named participant is left unprotected.
    expect(rows[0].kind).toBe('Individual');
    expect(rows[1]).toMatchObject({ name: 'Personagem', kind: 'Individual', preview: 'Tudo pronto para conversar', stack: 'Personagem', stackTranslate: null });
    expect(rows[1].branches).toEqual([['Principal', 'Tudo pronto para conversar']]);
    expect(rows[2].preview).toBe('Tudo pronto para conversar');
    expect(rows[2].branches).toEqual([['Principal', 'Tudo pronto para conversar']]);
    expect(rows[3]).toMatchObject({ name: 'Personagem', kind: 'DM em grupo', preview: 'Tudo pronto para conversar', stack: 'Personagem', stackTranslate: null });
});

test('a participant stack protects names, translates its own Character fallback and avatar captions, and is left unprotected without a name', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(() => {
        const { scope, localise } = window.render;
        const root = document.getElementById('root');
        const build = (participants, options) => {
            const container = document.createElement('div');
            root.append(container);
            scope.renderConversationParticipantStack(container, participants, options);
            return container;
        };
        const mixed = [{ avatar: 'a.png', name: 'Thoughts' }, { avatar: 'b.png', name: '' }];
        const zoom = build(mixed, { zoomable: true });
        const click = build(mixed, { onAvatarClick: () => {} });
        const nameless = build([{ avatar: 'b.png', name: '' }], {});
        const empty = build([], {});
        localise();
        const avatars = container => [...container.querySelectorAll('.sb-conversation-participant-avatar')];
        return {
            zoom: { translate: zoom.getAttribute('translate'), titles: avatars(zoom).map(item => item.title), labels: avatars(zoom).map(item => item.getAttribute('aria-label')) },
            click: { labels: avatars(click).map(item => item.getAttribute('aria-label')) },
            nameless: { translate: nameless.getAttribute('translate'), title: nameless.title, avatar: avatars(nameless)[0].title },
            empty: { translate: empty.getAttribute('translate'), title: empty.title },
        };
    });
    // Defect assertions: the container is protected when a participant has a name, the name is as written, and the avatar captions say it in Portuguese.
    expect.soft(result.zoom.translate, 'defect: container protected').toBe('no');
    expect.soft(result.zoom.titles[0], 'defect: name as written').toBe('Thoughts');
    expect.soft(result.zoom.labels[0], 'defect: caption translated in code, name as written').toBe('Mostrar imagem completa de Thoughts');
    expect.soft(result.click.labels[0], 'defect: caption translated in code, name as written').toBe('Abrir DM individual com Thoughts');
    // Also defects: before the change the over-broad 'Show ${0}' and 'Open ${0}' keys catch these captions ('Mostrar full picture for Character'),
    // so the nameless participant's caption was never fully Portuguese; the code now translates it whole.
    expect.soft(result.zoom.labels[1], 'defect: caption and Character fallback translated in code').toBe('Mostrar imagem completa de Personagem');
    expect.soft(result.click.labels[1], 'defect: caption and Character fallback translated in code').toBe('Abrir DM individual com Personagem');
    // Preservation assertions: the Character title shows in Portuguese in a protected stack (translated in code) and in an unprotected one.
    expect(result.zoom.titles[1]).toBe('Personagem');
    expect(result.nameless).toEqual({ translate: null, title: 'Personagem', avatar: 'Personagem' });
    expect(result.empty).toEqual({ translate: null, title: '' });
});

test('the Conversation header sets and clears its protection on every write, through both writers', async ({ page }) => {
    await openRender(page);
    const steps = await page.evaluate(() => {
        const { scope, localise } = window.render;
        document.getElementById('root').innerHTML = `<div id="hdr"><div data-sb-conversation-participants></div><div class="sb-conversation-header-kicker">Conversation</div>
            <div data-sb-conversation-name>Conversation</div><div data-sb-conversation-status></div></div>`;
        const person = { avatar: 'a.png', name: 'Thoughts' };
        const state = {};
        Object.assign(scope, {
            CHROME_IDS: { header: 'hdr', stage: 'stage' }, conversationState: {}, getCurrentCharacter: () => state.character, getCurrentCharAvatar: () => state.character?.avatar,
            getConversationGroupIdForAvatar: () => state.groupId || '',
            getConversationParticipants: () => state.participants, getActiveConversationBranch: () => state.branch, getStoredSchedule: () => null,
            getAvailabilityCopy: () => ({ label: 'Online', detail: '' }), getActiveTypingParticipants: () => [],
        });
        const show = (label, next) => {
            Object.assign(state, { character: person, groupId: '', participants: [person], branch: { name: 'Main' }, ...next });
            scope.conversationState.conversationUnavailableGroupId = next.unavailable || '';
            scope.updateConversationHeader({ availability: 'online' });
            localise();
            const element = selector => document.querySelector(selector);
            return [label, element('[data-sb-conversation-name]').textContent, element('[data-sb-conversation-name]').getAttribute('translate'),
                element('.sb-conversation-header-kicker').textContent, element('.sb-conversation-header-kicker').getAttribute('translate'),
                element('[data-sb-conversation-participants]').getAttribute('translate')];
        };
        scope.getConversationGroupById = id => (id === 'g1' ? { id, name: 'Summary' } : id === 'u1' ? { id, name: 'Solo' } : null);
        return [
            show('character', {}),
            show('branch', { branch: { name: 'Continue' } }),
            show('nobody', { character: null, participants: [] }),
            show('unavailable group', { character: null, participants: [], unavailable: 'u1' }),
            show('character again', {}),
            show('group', { groupId: 'g1', participants: [{ avatar: 's.png', name: 'Solo' }] }),
            show('nobody again', { character: null, participants: [] }),
        ];
    });
    // Each row: [step, name, name translate attribute, kicker, kicker attribute, stack attribute].
    // Defect assertions: values as written, protected.
    expect.soft(steps.filter(([label]) => ['character', 'character again'].includes(label)), 'defect: name as written and protected').toEqual([
        ['character', 'Thoughts', 'no', 'Conversa', null, 'no'], ['character again', 'Thoughts', 'no', 'Conversa', null, 'no'],
    ]);
    expect.soft(steps.find(([label]) => label === 'branch'), 'defect: branch name as written as the kicker').toEqual(['branch', 'Thoughts', 'no', 'Continue', 'no', 'no']);
    expect.soft(steps.find(([label]) => label === 'unavailable group'), 'defect: unavailable group name as written').toEqual(['unavailable group', 'Solo', 'no', 'Conversa', null, null]);
    expect.soft(steps.find(([label]) => label === 'group'), 'defect: group name and participant names as written').toEqual(['group', 'Summary', 'no', 'Solo', 'no', 'no']);
    // Preservation assertions: the fallback 'Conversation' is Portuguese and carries no protection, however the element was last written.
    expect(steps.filter(([label]) => label.startsWith('nobody'))).toEqual([
        ['nobody', 'Conversa', null, 'Conversa', null, null], ['nobody again', 'Conversa', null, 'Conversa', null, null],
    ]);
    const markup = await read(`${conversation}/timeline-render.js`);
    expect(markup, 'the initial markup carries no protection').toMatch(/data-sb-conversation-name>Conversation</);
});

test('the footer persona name, the chiming partner names and the Solo chat picker show names as written and keep their fallbacks translated', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(() => {
        const { scope, localise } = window.render;
        const root = document.getElementById('root');
        root.innerHTML = `<div id="footer"><img id="sb_conv_footer_persona_avatar"><span id="sb_conv_footer_persona_name"></span><span id="sb_conv_footer_user_status"></span></div>
            <div id="partners"></div><div id="sb_conversation_add_dm_picker" hidden></div>`;
        scope.characters = [{ avatar: 'a.png', name: 'Thoughts' }, { avatar: 'b.png', name: '' }];
        Object.assign(scope, { CHROME_IDS: { railFooter: 'footer' }, name1: 'Thoughts', user_avatar: '', getUserStatus: () => 'online', getUserPersonaStatus: () => '',
            AVAILABILITY_COPY: { online: { label: 'Online', detail: '' } }, parseAvatarList: () => [] });
        const name = document.getElementById('sb_conv_footer_persona_name');
        const footer = persona => {
            scope.name1 = persona;
            scope.updateUserFooter();
            localise();
            return [name.textContent, name.getAttribute('translate')];
        };
        const shown = { footer: [footer('Thoughts'), footer(''), footer('Thoughts')] };
        document.getElementById('partners').innerHTML = scope.buildPartnerOptions('');
        scope.toggleAddDmPicker();
        localise();
        shown.partners = [...document.querySelectorAll('.sb-conversation-partner-name')].map(span => span.textContent);
        shown.picker = [...document.querySelectorAll('.sb-conversation-add-dm-option span')].map(span => span.textContent);
        return shown;
    });
    // Defect assertions.
    expect.soft(result.footer, 'defect: persona name as written, protected only while it is a name').toEqual([['Thoughts', 'no'], ['Você', null], ['Thoughts', 'no']]);
    expect.soft(result.partners[0], 'defect: partner name as written').toBe('Thoughts');
    expect.soft(result.picker[0], 'defect: picker name as written').toBe('Thoughts');
    // Preservation assertions: a card with no name shows the Character fallback in Portuguese.
    expect(result.partners[1]).toBe('Personagem');
    expect(result.picker[1]).toBe('Personagem');
});

test('the Recent entry shows chat, branch, character and group names as written, and its own labels and fallbacks in Portuguese', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(() => {
        const { scope, localise } = window.render;
        document.getElementById('root').innerHTML = '<div id="neconyan-workspace-rail"><div data-neconyan-recent-list></div></div>';
        const branch = (id, name) => ({ id, name, preview: 'Conversation ready', unread: 0, messages: [{ mes: 'hello' }], updatedAt: 10 });
        const card = (avatar, name) => ({ avatar, name });
        const stores = {
            'a.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main') } },
            'b.png': { activeBranchId: 'b2', branches: { b2: branch('b2', 'Summary') } },
            'n.png': { activeBranchId: 'b2', branches: { b2: branch('b2', 'Summary') } },
            'm.png': { activeBranchId: 'main', branches: { main: branch('main', 'Main') } },
            'k.png': { activeBranchId: 'b2', branches: { b2: branch('b2', 'Conversation Mode') } },
        };
        const group = { id: 'g1', name: 'Group chat', is_conversation_group: true };
        // Two more groups on the default branch: the anchor member is named 'Group DM', or has no name.
        const groups = [group, { ...group, id: 'g2' }, { ...group, id: 'g3' }];
        const anchors = {
            g1: { character: card('g.png', 'Solo'), threadStore: { activeBranchId: 'b2', branches: { b2: branch('b2', 'Summary') } } },
            g2: { character: card('gd.png', 'Group DM'), threadStore: { activeBranchId: 'main', branches: { main: branch('main', 'Main') } } },
            g3: { character: card('gn.png', ''), threadStore: { activeBranchId: 'main', branches: { main: branch('main', 'Main') } } },
        };
        scope.characters = [card('a.png', 'Thoughts'), card('b.png', 'Thoughts'), card('n.png', ''), card('m.png', ''), card('k.png', 'Solo')];
        Object.assign(scope, { getConversationThreadStore: (avatar, { groupId } = {}) => (groupId ? null : stores[avatar]), getConversationThreadKey: (avatar, groupId) => `${groupId}|${avatar}`,
            getConversationGroups: () => groups, getConversationGroupThreadAnchor: current => anchors[current.id],
            getConversationStore: () => ({ characters: {} }), DEFAULT_SETTINGS: {}, PinnedChatsManager: { getKey: chat => chat.avatar } });
        const records = scope.getConversationWelcomeChats({ max: 20 });
        // Records of the other chat kinds, as the server builds them: no origin fields.
        records.push({ avatar: 'rp1.png', chat_name: 'Summary', char_name: 'Thoughts', is_group: false }, { avatar: 'rp2.png', chat_name: '', char_name: '', is_group: true },
            { avatar: 'rp3.png', chat_name: 'Continue', char_name: '', is_group: false });
        // The rail shows six entries at a time.
        const shown = [];
        for (let start = 0; start < records.length; start += 6) {
            scope.renderNeconyanRailRecentChats(records.slice(start, start + 6));
            localise();
            shown.push(...[...document.querySelectorAll('[data-neconyan-recent-key]')].map(button => ({
                key: button.dataset.neconyanRecentKey, label: button.querySelector('span').textContent, title: button.title, aria: button.getAttribute('aria-label'),
                owner: button.querySelector('small').textContent, buttonTranslate: button.getAttribute('translate'), ownerTranslate: button.querySelector('small').getAttribute('translate'),
            })));
        }
        return shown;
    });
    const by = key => result.find(entry => entry.key === key);
    // Defect assertions: names as written. Entry a.png is unnamed (the Main substitute), so only its owner is a value.
    expect.soft(by('a.png').owner, 'defect: owner as written').toBe('Thoughts');
    expect.soft([by('b.png').label, by('b.png').title, by('b.png').aria, by('b.png').owner], 'defect: named branch and owner as written').toEqual(['Summary', 'Summary', 'Summary', 'Thoughts']);
    expect.soft(by('k.png').label, 'defect: a branch a person named Conversation Mode').toBe('Conversation Mode');
    expect.soft(by('n.png').label, 'defect: named branch of a card with no name, as written').toBe('Summary');
    expect.soft([by('g.png').label, by('g.png').owner], 'defect: group entry as written').toEqual(['Solo · Summary', 'Group chat']);
    // A group entry on the default branch, whose member is named 'Group DM' (a key of the dictionary): the whole label is a name, so the button is marked and the label stays as written.
    expect.soft([by('gd.png').label, by('gd.png').title, by('gd.png').aria, by('gd.png').buttonTranslate], 'defect: group entry on the default branch with a member named Group DM as written, button marked')
        .toEqual(['Group DM · Conversation Mode', 'Group DM · Conversation Mode', 'Group DM · Conversation Mode', 'no']);
    expect.soft([by('rp1.png').label, by('rp1.png').owner], 'defect: roleplay record as written').toEqual(['Summary', 'Thoughts']);
    expect.soft(by('rp3.png').label, 'defect: roleplay chat name as written').toBe('Continue');
    // Preservation assertions: the substitutes and fallbacks translate, in a protected entry (in code) and an unprotected one.
    expect(by('a.png')).toMatchObject({ label: 'Modo Conversa', title: 'Modo Conversa', aria: 'Modo Conversa' });
    expect(by('m.png')).toMatchObject({ label: 'Modo Conversa', owner: 'Personagem' });
    expect(by('n.png').owner).toBe('Personagem');
    expect(by('rp2.png')).toMatchObject({ label: 'Chat sem título', owner: 'Chat em grupo' });
    expect(by('rp3.png').owner).toBe('Chat');
    // A group entry on the default branch whose member has no name stays unprotected, as it is today: the 'Character' part of the label translates, the stand-in's own text stays.
    expect(by('gn.png')).toMatchObject({ buttonTranslate: null, label: 'Personagem · Conversation Mode', title: 'Personagem · Conversation Mode', aria: 'Personagem · Conversation Mode' });
});

test('the lorebook pop-up shows the character name as written and Nameless in Portuguese', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(async () => {
        const { scope, localise } = window.render;
        document.getElementById('root').innerHTML = `<div id="set_character_world"></div><div id="character_world_template"><div class="character_world">
            <h3><span>Select a Lorebook file for</span> <span class="character_name"></span>:</h3>
            <select class="character_world_info_selector"></select><select class="character_extra_world_info_selector"></select></div></div>`;
        window.jQuery('#set_character_world').data('chid', 0);
        window.$ = window.jQuery;
        const shown = [];
        scope.Popup = class { constructor(template) { shown.push(template); } show() { return Promise.resolve(); } };
        Object.assign(scope, { $: window.jQuery, menu_type: 'edit', world_names: [], world_info: {}, POPUP_TYPE: { TEXT: 1 }, getCharaFilename: () => 'file', isMobile: () => true });
        const names = ['Thoughts', ''];
        for (const name of names) {
            scope.characters = [{ data: { name } }];
            await scope.openCharacterWorldPopup();
        }
        const spans = shown.map(template => template.find('.character_name')[0]);
        spans.forEach(span => document.getElementById('root').append(span));
        localise();
        return spans.map(span => [span.textContent, span.getAttribute('translate')]);
    });
    // Defect assertion, then a preservation assertion.
    expect.soft(result[0], 'defect: name as written, protected').toEqual(['Thoughts', 'no']);
    expect(result[1]).toEqual(['Sem nome', null]);
});

test('Quick Reply set names are protected where each option is built, keep the protection through a rename, and the placeholder still translates', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(async () => {
        const { scope, localise } = window.render;
        const root = document.getElementById('root');
        // The set-link row (QuickReplySetLink.js): a select of set names.
        scope.QuickReplySet = class { static list = [{ name: 'Default' }, { name: 'Summary' }]; static get(name) { return this.list.find(set => set.name === name) ?? null; } };
        const link = Object.assign(new scope.QuickReplySetLink(), { set: { name: 'Summary' }, isVisible: true });
        root.append(link.renderSettings(0) ?? link.settingsDom);
        // The Quick Reply settings (ui/SettingsUi.js): add a set, rename it, duplicate it.
        const select = Object.assign(document.createElement('select'), { id: 'qr--set' });
        root.append(select);
        const sets = [];
        scope.QuickReplySet = class { static list = sets; static get(name) { return sets.find(set => set.name === name) ?? null; } static from(data) { return { ...data, qrList: [], init() {} }; }
            addQuickReply() {} async save() {} };
        scope.QuickReply = { from: data => data };
        scope.toastr = { error() {} };
        let answer = 'Thoughts';
        scope.Popup = { show: { input: async () => answer } };
        const ui = { currentSet: select, settings: { config: { setList: [] }, save() {} }, onQrSetChange() {}, prepareGlobalSetList() {}, prepareChatSetList() {}, prepareCharacterSetList() {}, rerender() {},
            currentQrSet: null };
        await scope.SettingsUi.prototype.addQrSet.call(ui);
        const created = [...select.options].map(item => item.value);
        ui.currentQrSet = sets.find(set => set.name === 'Thoughts');
        answer = 'Summary';
        await scope.SettingsUi.prototype.renameQrSet.call(ui);
        answer = 'Continue';
        ui.currentQrSet = { name: 'Summary', toJSON: () => ({ name: 'Summary' }), qrList: [] };
        await scope.SettingsUi.prototype.duplicateQrSet.call(ui);
        // A placeholder, as the transfer dialog and the context-menu editor add one.
        select.prepend(Object.assign(document.createElement('option'), { value: '', textContent: '-- Select QR Set --' }));
        localise();
        const read = element => [element.textContent, element.getAttribute('translate')];
        return { link: [...root.querySelectorAll('.qr--set option')].map(read), created, sets: [...select.options].filter(item => item.value).map(read).sort(), placeholder: read(select.options[0]) };
    });
    // Defect assertions: set names as written (Default, Summary and Continue are keys of the dictionary), each option marked where it is built.
    expect.soft(result.link, 'defect: set-link row').toEqual([['Default', 'no'], ['Summary', 'no']]);
    expect.soft(result.sets, 'defect: added, renamed (kept its protection) and duplicated sets as written').toEqual([['Continue', 'no'], ['Summary', 'no']]);
    // Preservation assertion: the placeholder is not marked and shows in Portuguese.
    expect(result.placeholder).toEqual(['-- Selecione um conjunto de QR --', null]);
    expect(result.created).toEqual(['Thoughts']);
});

test('the top bar rebuilds its label with the loaded translations, and the shell exposes that rebuild for start-up to call', async ({ page }) => {
    await openRender(page);
    const result = await page.evaluate(() => {
        const { scope, localise, dictionary } = window.render;
        document.getElementById('root').innerHTML = '<div class="sb-topbar-brand"><div id="sb-topbar-title"></div></div>';
        Object.assign(scope, { getSillyTavernContext: () => ({}), getTopBarLabel: () => 'Thoughts', hasActiveTopBarChat: () => true, isTopbarLabelClickCycleEnabled: () => false,
            bindTopBarTitleCycle() {}, queueTopbarBrandFit() {} });
        // The Portuguese entry for the caption; the stored value needs no key of its own.
        scope.dictionary = dictionary;
        const title = document.getElementById('sb-topbar-title');
        const saved = { ...dictionary };
        for (const key of Object.keys(dictionary)) delete dictionary[key];
        scope.updateTopBarBrand();
        const beforeLocale = title.getAttribute('aria-label');
        Object.assign(dictionary, saved);
        localise();
        scope.updateTopBarBrand();
        return { beforeLocale, afterRebuild: title.getAttribute('aria-label'), text: [title.textContent, title.title] };
    });
    // Preservation assertions: built before the locale loads it is English; rebuilt after, it is Portuguese, and the name stays as written
    // (the text and title are protected by the userText list, which tests/ui-localization.e2e.js covers).
    expect(result.beforeLocale).toBe('Thoughts. Tap to return to the chat.');
    expect(result.afterRebuild).toMatch(/^Thoughts\. /);
    expect(result.afterRebuild).not.toBe(result.beforeLocale);
    const tabs = await read('public/scripts/neconyan-tabs.js');
    const script = await read('public/script.js');
    // Defect assertions (structural, as start-up cannot run here; the held start-up is checked on screen).
    expect.soft(tabs, 'defect: the shell exposes the rebuild').toMatch(/refreshTopBarLabel: updateTopBarBrand/);
    expect.soft(script, 'defect: start-up calls it right after the locales load').toMatch(/await initLocales\(\);\s*(?:\/\/[^\n]*\n\s*)?globalThis\.NeconyanShell\?\.refreshTopBarLabel\?\.\(\);/);
});
