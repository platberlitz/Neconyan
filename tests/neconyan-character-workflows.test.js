import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const html = read('public', 'index.html');
const script = read('public', 'script.js');
const groups = read('public', 'scripts', 'group-chats.js');
const tabs = read('public', 'scripts', 'neconyan-tabs.js');
const styles = read('public', 'css', 'neconyan.css');
const emptyBlock = read('public', 'scripts', 'templates', 'emptyBlock.html');
const powerUser = read('public', 'scripts', 'power-user.js');

function loadFunctions(context, source, names) {
    for (const name of names) {
        const body = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
        if (!body) throw new Error(`Missing function ${name}`);
        vm.runInContext(body.replace(/^export /, ''), context);
    }
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function saveContext() {
    class HTMLElement {}
    const status = Object.assign(new HTMLElement(), { dataset: {}, dispatchEvent: jest.fn() });
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
        HTMLElement, document: { getElementById: () => status },
        $: () => ({ attr: () => 'editcharacter' }),
        console: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
        DEFAULT_SAVE_EDIT_TIMEOUT: 1,
        createOrEditCharacter: jest.fn(async () => true),
    });
    vm.runInContext(script.slice(script.indexOf('let pendingCharacterSaveTimer ='), script.indexOf('/**\n * Prints the character list')).replace(/^export /gm, ''), context);
    return { context, status, timers };
}

describe('Neconyan save behaviour', () => {
    test('spoiler mode hides definition fields moved into otherwise visible editor sections', () => {
        class HTMLElement {}
        const active = Object.assign(new HTMLElement(), { dataset: { sbCharacterEditorPanel: 'char-info' } });
        const form = Object.assign(new HTMLElement(), { dataset: {}, querySelector: () => active });
        const visibility = new Map();
        const context = vm.createContext({
            HTMLElement, document: { getElementById: () => form, querySelectorAll: () => [] },
            $: selector => ({ toggle: visible => visibility.set(selector, visible), toggleClass() { return this; } }),
            characterSpoilerFreePanelSelector: '', showCharacterEditorMetadataPanel() {}, syncActiveCharacterEditorPanel() {},
        });
        loadFunctions(context, powerUser, ['setCharacterSpoilerFreeFieldsHidden']);
        const fields = '#form_create #descriptionWrapper, #form_create #personality_div, #form_create .sb-character-editor-prompt-overrides';
        context.setCharacterSpoilerFreeFieldsHidden(true);
        expect(visibility.get(fields)).toBe(false);
        expect(form.dataset.sbSpoilerFreeFieldsHidden).toBe('true');
        context.setCharacterSpoilerFreeFieldsHidden(false);
        expect(visibility.get(fields)).toBe(true);
        context.setCharacterSpoilerFreeFieldsHidden();
        expect(visibility.get(fields)).toBe(true);
        expect(visibility.get('#creators_note_desc_hidden')).toBe(false);
        expect(form.dataset.sbSpoilerFreeFieldsHidden).toBe('false');
    });

    test('drains edits typed during an in-flight character save and exposes a failed result', async () => {
        const { context, timers } = saveContext();
        const first = deferred();
        context.createOrEditCharacter.mockReturnValueOnce(first.promise).mockResolvedValueOnce(false);
        context.saveCharacterDebounced();
        const flush = context.flushCharacterSaveDebounced();
        await tick();
        expect(context.createOrEditCharacter).toHaveBeenCalledTimes(1);
        context.saveCharacterDebounced();
        first.resolve(true);
        await expect(flush).resolves.toBe(false);
        expect(context.createOrEditCharacter).toHaveBeenCalledTimes(2);
        expect(timers.size).toBe(0);
        await expect(context.flushCharacterSaveDebounced()).resolves.toBe(false);
    });

    for (const saved of [true, false]) {
        test(`character navigation waits for the save and respects success=${saved}`, async () => {
            const { context } = saveContext();
            const pending = deferred();
            Object.assign(context, {
                characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }], this_chid: 0,
                selected_group: null, is_group_generating: false, is_send_press: false,
                hasPendingChatSave: () => false, waitForQueuedChatSaves: jest.fn(), waitForQueuedGroupChatSaves: jest.fn(),
                toastr: { error: jest.fn() }, t: strings => strings.join(''),
                setCharacterId: jest.fn(id => { context.this_chid = id; }), setCharacterName: jest.fn(),
                resetSelectedGroup: jest.fn(), clearChat: jest.fn(), cancelTtsPlay: jest.fn(), getChat: jest.fn(),
                window: { dispatchEvent: jest.fn() }, CustomEvent: class CustomEvent {}, syncCharacterMenuActiveEntity: jest.fn(),
            });
            loadFunctions(context, script, ['flushPendingChatSavesForNavigation', 'selectCharacterById']);
            context.createOrEditCharacter.mockReturnValueOnce(pending.promise);
            context.saveCharacterDebounced();
            const navigation = context.selectCharacterById(1);
            await tick();
            expect(context.setCharacterId).not.toHaveBeenCalled();
            pending.resolve(saved);
            await expect(navigation).resolves.toBe(saved);
            expect(context.this_chid).toBe(saved ? 1 : 0);
            expect(context.getChat).toHaveBeenCalledTimes(saved ? 1 : 0);
        });
    }

    test('reopening after a failed save shows the existing form without reloading or resetting it', async () => {
        const { context, status } = saveContext();
        Object.assign(context, {
            getSillyTavernContext: () => ({ characterId: 0, characters: [{ avatar: 'a.png' }] }),
            getOneCharacter: jest.fn(), hasActiveCharacterChat: () => true,
            selectRightMenuWithAnimation: jest.fn(), setCharacterPanelMenuType: jest.fn(), getCharacterPanel: () => ({}),
            setCharacterEditorEmptyState: jest.fn(), setCharacterPersonaPanelVisible: jest.fn(),
            setCharacterImportPanelVisible: jest.fn(), setCharacterWorldInfoPanelVisible: jest.fn(), syncCharacterShellTabs: jest.fn(),
        });
        loadFunctions(context, tabs, ['refreshActiveCharacterBeforeEditorOpen', 'showActiveCharacterEditor']);
        context.createOrEditCharacter.mockResolvedValue(false);
        context.saveCharacterDebounced();
        await expect(context.showActiveCharacterEditor()).resolves.toBe(true);
        expect(context.getOneCharacter).not.toHaveBeenCalled();
        expect(status.dispatchEvent).not.toHaveBeenCalled();
        expect(context.selectRightMenuWithAnimation).toHaveBeenCalledWith('rm_ch_create_block');
    });

    test('a library refresh inside a character save does not wait on itself or reset the form', async () => {
        const { context } = saveContext();
        Object.assign(context, {
            characters: [{ avatar: 'a.png' }], this_chid: 0,
            getRequestHeaders: () => ({}), DOMPurify: { sanitize: value => value },
            fetch: async () => ({ ok: true, json: async () => [{ avatar: 'a.png', name: 'Mira' }] }),
            setCharacterId: id => { context.this_chid = id; },
            selectCharacterById: jest.fn(), getGroups: jest.fn(), printCharacters: jest.fn(),
        });
        loadFunctions(context, script, ['getCharacters']);
        context.createOrEditCharacter.mockImplementation(async () => {
            await context.getCharacters();
            return true;
        });
        context.saveCharacterDebounced();
        await expect(context.flushCharacterSaveDebounced()).resolves.toBe(true);
        expect(context.selectCharacterById).not.toHaveBeenCalled();
        expect(context.printCharacters).toHaveBeenCalledWith(true);
    });

    test('Edit card for the current character opens the recovery editor without selecting again', async () => {
        const row = {};
        const shell = { openTab: jest.fn() };
        const selectCharacterById = jest.fn(async () => false);
        const source = script.match(/\$\(document\)\.on\('click', '\.character_select', (async function \(event\) \{[\s\S]*?^ {4}\})\);/m)?.[1];
        expect(source).toBeDefined();
        const handler = vm.runInNewContext(`(${source})`, {
            $: target => target === row ? { attr: () => '0' } : { closest: () => ({ length: 1, attr: () => 'edit-card' }) },
            this_chid: 0, selected_group: null, NeconyanShell: shell, selectCharacterById,
        });
        await handler.call(row, { target: {}, preventDefault() {}, stopImmediatePropagation() {} });
        expect(shell.openTab).toHaveBeenCalledWith('characters', 'editor');
        expect(selectCharacterById).not.toHaveBeenCalled();
    });

    for (const [name, generating] of [['', false], ['   ', false], ['Mira', true]]) {
        test(`invalid creation stays a draft: name=${name} generating=${generating}`, async () => {
            const context = vm.createContext({
                settingsReady: true, characterSaveRevision: 0, fav_ch_checked: false,
                is_group_generating: generating, is_send_press: false,
                FormData: class FormData extends Map {}, CustomEvent: class CustomEvent {},
                $: () => ({ html() {}, get() {}, attr: () => 'createcharacter', val: () => name }),
                setCharacterSaveStatus: jest.fn(), toastr: { error: jest.fn() }, t: strings => strings.join(''), fetch: jest.fn(),
            });
            loadFunctions(context, script, ['createOrEditCharacter']);
            await expect(context.createOrEditCharacter()).resolves.toBe(false);
            expect(context.setCharacterSaveStatus).toHaveBeenCalledWith('draft', 0);
            expect(context.setCharacterSaveStatus).not.toHaveBeenCalledWith('saving', 0);
            expect(context.fetch).not.toHaveBeenCalled();
        });
    }

    function groupContext() {
        const { context, status, timers } = saveContext();
        Object.assign(context, {
            groups: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }],
            openGroupId: 'a', groupSaveStates: new Map(), groupMetadataSaveQueue: Promise.resolve(), pendingGroupMetadataSaves: new Map(),
            GROUP_SAVE_STATUS_COPY: { draft: 'Draft, not saved', unsaved: 'Unsaved changes', saving: 'Saving...', saved: 'Saved', error: 'Could not save' },
            getRequestHeaders: () => ({}), getCharacters: jest.fn(), printCharacters: jest.fn(), fetch: jest.fn(async () => ({ ok: true })),
            debounce_timeout: { relaxed: 1 },
            structuredClone, groupReadEvidence: new WeakMap(), getCurrentUserHandle: () => 'alice', roleplayAccountStamp: () => ({ account: {} }),
            groupBackgroundState: new WeakMap(), queuedGroupMetadataById: new Map(),
            uuidv4: () => 'group-key', beginRoleplaySave: () => ({}), finishRoleplaySave: async () => {}, refreshCsrfToken: async () => {},
            fetchWithCsrfRetry: async (url, build) => context.fetch(url, await build()),
            sendRoleplaySave: async (_token, payload, send) => {
                const response = await send(JSON.stringify(payload), { owner: 'alice' });
                return { ok: response.ok, data: { roleplay: { source: {} } } };
            },
        });
        loadFunctions(context, groups, ['setGroupSaveStatus', 'markGroupSaveDirty', 'snapshotGroupMetadata', 'saveGroupDebounced', '_save', 'editGroup']);
        return { context, status, timers };
    }

    test('serialises group snapshots and does not let older saves report success', async () => {
        const { context, status } = groupContext();
        const first = deferred();
        const second = deferred();
        context.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const older = context.editGroup('a', true, false);
        await tick();
        context.groups[0].name = 'Latest';
        const newer = context.editGroup('a', true, false);
        await tick();
        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(status.dataset.saveStatus).toBe('unsaved');
        first.resolve({ ok: true });
        await older;
        await tick();
        expect(context.fetch).toHaveBeenCalledTimes(2);
        expect(context.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).name)).toEqual(['First', 'Latest']);
        expect(status.dataset.saveStatus).toBe('saving');
        second.resolve({ ok: true });
        await newer;
        expect(status.dataset.saveStatus).toBe('saved');
    });

    test('keeps debounced saves for separate groups and cancels an older timer before an immediate save', async () => {
        const { context, timers } = groupContext();
        await context.editGroup('a', false, false);
        await context.editGroup('b', false, false);
        expect(timers.size).toBe(2);
        context.groups[0].name = 'Latest';
        await context.editGroup('a', true, false);
        expect(timers.size).toBe(1);
        for (const [id, callback] of timers) { timers.delete(id); callback(); }
        await context.groupMetadataSaveQueue;
        expect(context.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).name)).toEqual(['Latest', 'Second']);
    });

    test('a failed group save rejects its caller without blocking the next save', async () => {
        const { context } = groupContext();
        context.fetch.mockResolvedValueOnce({ ok: false });
        await expect(context.editGroup('a', true, false)).rejects.toThrow('Could not save group a');
        await expect(context.editGroup('a', true, false)).resolves.toBeUndefined();
        expect(context.fetch).toHaveBeenCalledTimes(2);
    });

    test('refreshes the library from local group state after saving', async () => {
        const { context } = groupContext();
        await context.editGroup('a', true);
        expect(context.printCharacters).toHaveBeenCalledTimes(1);
        expect(context.getCharacters).not.toHaveBeenCalled();
    });

    test('another group save does not invalidate the visible group save status', async () => {
        const { context, status } = groupContext();
        const first = deferred();
        context.fetch.mockReturnValueOnce(first.promise);
        const visible = context.editGroup('a', true, false);
        await tick();
        const background = context.editGroup('b', true, false);
        first.resolve({ ok: true });
        await Promise.all([visible, background]);
        expect(status.dataset.saveStatus).toBe('saved');
    });

    test('reopening a group during a save preserves Saving and reports a later failure', async () => {
        const { context, status } = groupContext();
        const controls = {};
        for (const method of ['empty', 'append', 'val', 'trigger', 'prop', 'attr', 'show', 'hide', 'find', 'text', 'addClass', 'removeClass', 'toggle', 'children']) {
            controls[method] = () => controls;
        }
        Object.assign(context, {
            $: () => controls,
            group_activation_strategy: { NATURAL: 0 }, group_generation_mode: { SWAP: 0 },
            ensureGroupEditorLayout() {}, setMenuType() {}, getGroupAvatar() {}, applyTagsOnGroupSelect() {},
            printGroupCandidates() {}, printGroupMembers() {}, toggleHiddenControls() {}, isValidImageUrl() {},
            isExternalMediaAllowed() {}, updateFavButtonState() {}, updateGroupSpeakerControls() {},
            CSS: { supports: () => true }, eventSource: { emit() {} }, t: strings => strings.join(''),
        });
        loadFunctions(context, groups, ['select_group_chats']);
        const pending = deferred();
        context.fetch.mockReturnValueOnce(pending.promise);
        const save = context.editGroup('a', true, false);
        await tick();
        context.select_group_chats('b', true);
        context.select_group_chats('a', true);
        expect(status.dataset.saveStatus).toBe('saving');
        pending.resolve({ ok: false });
        await expect(save).rejects.toThrow('Could not save group a');
        expect(status.dataset.saveStatus).toBe('error');
        context.select_group_chats('b', true);
        context.select_group_chats('a', true);
        expect(status.dataset.saveStatus).toBe('error');
        const drawer = new context.HTMLElement();
        const header = Object.assign(new context.HTMLElement(), { closest: () => drawer });
        context.document.getElementById = id => id === 'groupAddMemberListToggle' ? header : status;
        context.toggleDrawer = jest.fn();
        context.select_group_chats(null, true);
        expect(context.toggleDrawer).toHaveBeenCalledWith(drawer, true);
        expect(status.dataset.saveStatus).toBe('draft');
    });

    test('new groups leave first-chat creation to the existing first-open path', async () => {
        const request = jest.fn(async () => ({ ok: true, json: async () => ({ id: 'new-group' }) }));
        const context = vm.createContext({
            $: selector => {
                const control = { val: () => selector === '#rm_group_chat_name' ? 'New group' : '0', prop: () => false, attr: () => '', find: () => control };
                return control;
            },
            newGroupMembers: ['mira.png'], characters: [{ avatar: 'mira.png', name: 'Mira' }], onlyUnique: () => true,
            findGroupByMembers: () => null, isValidImageUrl: () => false, default_avatar: 'default.png',
            group_activation_strategy: { NATURAL: 0 }, group_generation_mode: { SWAP: 0 }, hideMutedSprites: false,
            GROUP_MEMBER_MODELS_KEY: 'member_models', fav_grp_checked: false, getRequestHeaders: () => ({}), fetch: request,
            createTagMapFromList() {}, getCharacters: async () => {}, select_rm_info() {},
            uuidv4: () => 'key', sendRoleplayLifecycle: (_url, body, _key, send) => send(JSON.stringify(body)),
        });
        loadFunctions(context, groups, ['createGroup']);
        await expect(context.createGroup()).resolves.toBe(true);
        const payload = JSON.parse(request.mock.calls[0][1].body);
        expect(payload.chat_id).toBe('');
        expect(payload.chats).toEqual([]);
        expect(payload.members).toEqual(['mira.png']);
    });
});

describe('Neconyan character and group workflows', () => {
    test('keeps the editor form contract while exposing named sections and a persistent save bar', () => {
        expect(html).toContain('id="form_create"');
        expect(html).toContain('id="create_button_label"');
        expect(html).toContain('id="rm_button_back"');
        expect(html).toContain('id="sb_character_commit_bar"');
        expect(html).toContain('data-i18n="Basics"');
        expect(html).toContain('data-i18n="Definition"');
        expect(html).toContain('data-i18n="Advanced"');
        expect(tabs).toContain('function ensureCharacterEditorLayout()');
        expect(tabs).toContain('advanced.prepend(promptOverrides);');
        expect(tabs).toContain('commitActions.append(createButton);');
    });

    test('renders deterministic empty states and explicit entity actions', () => {
        expect(script).toContain('t`No characters yet`');
        expect(script).toContain('t`No groups yet`');
        expect(script).toContain('t`No matches`');
        expect(script).toContain('img/neconyan/curious-search.webp');
        expect(script).toContain('img/neconyan/cozy-library.webp');
        expect(emptyBlock).toContain('src="{{illustration}}"');
        expect(emptyBlock).toContain('data-empty-action="create-character"');
        expect(emptyBlock).toContain('data-empty-action="clear-search"');
        expect(html).toContain('data-entity-action="open-chat"');
        expect(html).toContain('data-entity-action="edit-card"');
        expect(html).toContain('data-entity-action="edit-group"');
        expect(script).toContain('globalThis.NeconyanShell?.closeWorkspace?.();');
        expect(script).toContain('globalThis.NeconyanShell?.openTab?.(\'characters\', \'editor\');');
    });

    test('guards group creation from the member array and returns to the groups library', () => {
        expect(groups).toContain('if (members.length === 0)');
        expect(groups).toContain('Add at least one character before creating a group.');
        expect(groups).toContain('globalThis.NeconyanShell?.openTab?.(\'characters\', \'groups\');');
        expect(groups).toContain('let membersGrid = block.querySelector(\'.sb-group-members-grid\');');
        expect(html).toContain('id="sb_group_commit_bar"');
    });

    test('gates stale character saves and hides one page of pagination', () => {
        expect(script).toContain('let characterSaveRevision = 0;');
        expect(script).toContain('if (revision !== characterSaveRevision)');
        expect(script).toContain('clearTimeout(pendingCharacterSaveTimer);');
        expect(script).toContain('paginationNav.hidden = entities.length <= pageSize;');
        expect(groups).toContain('const groupSaveStates = new Map();');
        expect(groups).toContain('if (revision !== (state?.revision ?? 0))');
    });

    test('keeps primary library actions and member controls touch safe', () => {
        expect(tabs).toContain('sb-character-library-primary-actions');
        expect(tabs).toContain('sb-character-library-secondary-actions');
        expect(styles).toContain('min-height: 44px;');
        // Two columns only when both member lists fit, so a pinned panel and a phone stack them.
        expect(styles).toContain('.sb-group-members-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));');
        expect(styles).not.toContain('.sb-group-members-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    });

    test('keeps the Import tab and empty-list import action visible on desktop', () => {
        expect(html).toContain('id="sb_character_tab_import"');
        expect(tabs).toContain('importTab.addEventListener(\'click\', () => openCharacterImportTab());');
        expect(styles).not.toMatch(/#sb_character_tab_import\s*[,{]/);
        expect(styles).not.toMatch(/\[data-empty-action='import-character'\]\s*\{\s*display:\s*none/);
    });
});
