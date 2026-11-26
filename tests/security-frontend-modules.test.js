import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import {
    REMINDER_COMMAND_RE,
    SCHEDULE_UPDATE_RE,
    SELFIE_COMMAND_RE,
} from '../public/scripts/neconyan-conversation/constants.js';
import {
    extractCharacterReplyCommandParts,
    normalizeConversationOutputText,
    parseCommandArgs,
} from '../public/scripts/neconyan-conversation/generation-utils.js';
import { parseDurationToMs, parseScheduleTimeRange } from '../public/scripts/neconyan-conversation/schedule-utils.js';
import { RULES as CHESS } from '../public/scripts/neconyan-conversation/games/rules/chess.js';
import { RULES as PICROSS } from '../public/scripts/neconyan-conversation/games/rules/picross.js';
import { RULES as MINESWEEPER } from '../public/scripts/neconyan-conversation/games/rules/minesweeper.js';
import { extractHeuristicPurrksFromCard, normalizeChatPurrksState, ownPurrkStateValue } from '../public/scripts/purrks/model.js';
import { hasCreatorLoreBrackets, stripCreatorCodeFence } from '../public/scripts/creator/code-fence.js';
import { assertCreatorReplyNotRefused } from '../public/scripts/creator/refusal.js';
import { isAcceptableCreatorMediaValue, isSafeCreatorImageDataUrl } from '../public/scripts/creator/media-url.js';
import { createCreatorDraft, validateCreatorDraft } from '../public/scripts/creator/model.js';
import { previewCreatorRegexInWorker } from '../public/scripts/creator/regex-worker.js';
import { applyCreatorAgentRegexScripts, CREATOR_AGENT_INPUT_LIMIT } from '../public/scripts/creator/agent-regex.js';
import { escapeHtml as scratchpadEscapeHtml } from '../public/scripts/scratchpad/escape-html.js';
import {
    AGENT_FIELDS,
    CSS_SNIPPET_FIELDS,
    isAllowedUndoField,
    isUnsafeUndoKey,
    PERSONA_NOTE_UNDO_FIELDS,
    PERSONA_UNDO_FIELDS,
    REGEX_FIELDS,
} from '../public/scripts/scratchpad/undo-fields.js';
import { getOwnValue, isSafeObjectKey, isUnsafeObjectKey, safeObjectEntries } from '../public/scripts/neconyan-conversation/object-keys.js';
import { setConversationThreadUnreadCount } from '../public/scripts/neconyan-conversation/notification-utils.js';
import { mergeConversationStore } from '../public/scripts/neconyan-conversation/store-sync-utils.js';
import { applySettingsChanges, isUnsafeSettingsKey } from '../public/scripts/mewmory/config-autosave.js';
import {
    getFetchableConversationImagePath,
    getSafeConversationMediaUrl,
    getSafeLocalUserMediaPath,
    isConversationExternalMediaAllowed,
    isSafeConversationDataImageUrl,
} from '../public/scripts/neconyan-conversation/media-url-policy.js';
import {
    STRICT_REPLY_SANITIZER_OVERRIDES,
    strictReplySanitizerOverrides,
    stripForeignPortraitUrls,
} from '../public/scripts/neconyan-conversation/reply-sanitizer.js';
import { CONVERSATION_SAFE_TOAST_OPTIONS, escapeToastText } from '../public/scripts/neconyan-conversation/toast-options.js';

const BUDGET_MS = 50;
const SPACES = ' '.repeat(20000);
const source = path => readFileSync(new URL(`../public/scripts/${path}`, import.meta.url), 'utf8');

function timed(run) {
    const started = performance.now();
    const result = run();
    return { result, elapsed: performance.now() - started };
}

function expectFast(label, run) {
    const { result, elapsed } = timed(run);
    expect({ label, fast: elapsed < BUDGET_MS, elapsed: elapsed < BUDGET_MS ? 0 : elapsed }).toEqual({ label, fast: true, elapsed: 0 });
    return result;
}

function fresh(regex) {
    return new RegExp(regex.source, regex.flags);
}

function seededRandom(seed = 7) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

describe('ReDoS: Conversation Mode command parsers', () => {
    test('command regexes stay linear on long whitespace runs', () => {
        for (const [label, regex, text] of [
            ['reminder', REMINDER_COMMAND_RE, `[reminder:${SPACES}|${SPACES}`],
            ['reminder-no-pipe', REMINDER_COMMAND_RE, `[reminder:${SPACES}`],
            ['schedule', SCHEDULE_UPDATE_RE, `[schedule_update:${SPACES}`],
            ['selfie', SELFIE_COMMAND_RE, `[selfie:${SPACES}context=${SPACES}"${SPACES}`],
            ['selfie-bare', SELFIE_COMMAND_RE, `[selfie:${SPACES}`],
        ]) {
            expect(expectFast(label, () => [...text.matchAll(fresh(regex))])).toEqual([]);
        }
    });

    test('command parsing keeps trimmed captures', () => {
        const parts = extractCharacterReplyCommandParts(
            'Hi there [reminder:  10 minutes |  feed the cat  ] [schedule_update:  status=busy] [selfie: context=" on the sofa "] bye',
            { schedule_command_enabled: true, selfie_command_enabled: true },
        );
        expect(parts.reminders).toEqual([{ delay: '10 minutes', memo: 'feed the cat' }]);
        expect(parts.scheduleUpdates).toEqual(['status=busy']);
        expect(parts.selfieRequests).toEqual(['on the sofa']);
    });

    test('reply extraction and output normalisation run in linear time', () => {
        const settings = { schedule_command_enabled: true, selfie_command_enabled: true };
        expect(expectFast('extract', () => extractCharacterReplyCommandParts(`[reminder:${SPACES}[selfie:${SPACES}[schedule_update:${SPACES}`, settings)).reminders).toEqual([]);
        expectFast('normalise-spaces', () => normalizeConversationOutputText(`a${SPACES}b`));
        expectFast('normalise-punctuation', () => normalizeConversationOutputText(`a${SPACES}x${SPACES}?`));
        expectFast('normalise-quotes', () => normalizeConversationOutputText(`a${SPACES}''${SPACES}x`));
        expectFast('normalise-curly', () => normalizeConversationOutputText(`a${'“'.repeat(20000)}x`));
        expectFast('args', () => parseCommandArgs(`status${SPACES}=${SPACES}`));
    });

    test('output normalisation keeps its existing results', () => {
        expect(normalizeConversationOutputText('Hello , world !')).toBe('Hello, world!');
        expect(parseCommandArgs('status = "busy" activity="napping"')).toEqual({ status: 'busy', activity: 'napping' });
    });

    test('schedule time and duration parsers are linear and unchanged', () => {
        expectFast('range', () => parseScheduleTimeRange(`9:00${SPACES}am${SPACES}x`));
        expectFast('range-to', () => parseScheduleTimeRange(`9:00${SPACES}to${SPACES}`));
        expectFast('duration', () => parseDurationToMs(`5${SPACES}x 6${SPACES}y`));
        expectFast('duration-digits', () => parseDurationToMs(`${'1'.repeat(20000)}x`));
        expect(parseScheduleTimeRange('9:00 am - 5:30 pm')).toEqual({ startMinutes: 540, endMinutes: 1050 });
        expect(parseScheduleTimeRange('09:00 to 17:00')).toEqual({ startMinutes: 540, endMinutes: 1020 });
        expect(parseDurationToMs('2 hours 30 min')).toBe(150 * 60000);
        expect(parseDurationToMs('45m')).toBe(45 * 60000);
    });
});

describe('ReDoS: game move parsers', () => {
    test('chess parses split and tight moves without backtracking on spaces', () => {
        const state = CHESS.createState({ random: seededRandom() });
        expectFast('chess', () => CHESS.parseMoveReply(state, `e2${SPACES}x`));
        expectFast('chess-to', () => CHESS.parseMoveReply(state, `e2${SPACES}to${SPACES}x`));
        expect(CHESS.parseMoveReply(state, 'I play e2 to e4')).toEqual(CHESS.parseMoveReply(state, 'e2e4'));
        expect(CHESS.parseMoveReply(state, 'e2-e4')).toEqual(CHESS.parseMoveReply(state, 'e2e4'));
    });

    test.each([['picross', PICROSS], ['minesweeper', MINESWEEPER]])('%s row/column parsing is linear', (label, rules) => {
        const state = rules.createState({ random: seededRandom() });
        expectFast(label, () => rules.parseMoveReply(state, `row 1${SPACES}x`));
        expectFast(`${label}-separators`, () => rules.parseMoveReply(state, `r1${' ,;'.repeat(7000)}x`));
        expect(rules.parseMoveReply(state, 'row 2, col 3')).toEqual(rules.parseMoveReply(state, 'r2c3'));
    });
});

describe('ReDoS: Purrks and Catelier', () => {
    test('Purrks structured section scan is linear', () => {
        for (const description of [
            `<abcd>${SPACES}`,
            `<abcd>${SPACES}</abce>`,
            `<abcd>${SPACES}x${SPACES}`,
        ]) {
            expect(expectFast('purrks', () => extractHeuristicPurrksFromCard({ data: { description } }))).toEqual([]);
        }
    });

    test('code fences are stripped with a linear helper', () => {
        expect(stripCreatorCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
        expect(stripCreatorCodeFence('  ```JSON {"a":1} ```  ')).toBe('{"a":1}');
        expect(stripCreatorCodeFence('```\nplain\n```')).toBe('plain');
        expect(stripCreatorCodeFence('not fenced')).toBe('not fenced');
        expectFast('fence', () => stripCreatorCodeFence(`\`\`\`json${SPACES}x${SPACES}`));
        expectFast('fence-closed', () => stripCreatorCodeFence(`\`\`\`json${SPACES}x${SPACES}\`\`\``));
        expectFast('refusal', () => {
            try {
                assertCreatorReplyNotRefused(`\`\`\`${SPACES}{"fields":{}}${SPACES}`, []);
            } catch {
                // Only the running time matters here.
            }
        });
        expect(hasCreatorLoreBrackets('[\n{"a":1}\n]')).toBe(true);
        expect(hasCreatorLoreBrackets('[{"a":1}]')).toBe(false);
        expectFast('brackets', () => hasCreatorLoreBrackets(`[${SPACES}\n${SPACES}`));
    });

    test('Catelier sources no longer carry the backtracking fence regex', () => {
        for (const file of ['refusal', 'lore-proposals', 'dossier', 'conversion', 'regex', 'field-generator', 'questions', 'server-generation', 'portrait-prompt']) {
            const text = source(`creator/${file}.js`);
            expect({ file, overlapping: text.includes('\\s*([\\s\\S]*?)\\s*') }).toEqual({ file, overlapping: false });
            expect({ file, helper: text.includes('stripCreatorCodeFence') }).toEqual({ file, helper: true });
        }
    });
});

describe('Stored XSS in confirmation popups', () => {
    test('escapeHtml escapes markup', () => {
        expect(scratchpadEscapeHtml('<img src=x onerror="alert(1)">&\'')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
    });

    test('dynamic names are escaped inside unchanged t`` strings', () => {
        const scratchpad = source('scratchpad/index.js');
        expect(scratchpad).toContain('${escapeHtml(target.name)}');
        expect(scratchpad).toContain('${escapeHtml(setup.name)}');
        expect(scratchpad.match(/\$\{escapeHtml\(session\.name\)\}/g)?.length).toBeGreaterThanOrEqual(2);
        expect(source('scratchpad/assistants.js')).toContain('${escapeHtml(profile.name)}');
        expect(source('purrks/index.js')).toContain('t`Delete the Purrk \'${escapeHtml(item.label || itemId)}\'?`');
    });
});

describe('Prototype pollution and inherited lookups', () => {
    test('object key helpers reject prototype keys', () => {
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            expect(isUnsafeObjectKey(key)).toBe(true);
            expect(isSafeObjectKey(key)).toBe(false);
            expect(isUnsafeSettingsKey(key)).toBe(true);
            expect(isUnsafeUndoKey(key)).toBe(true);
        }
        expect(getOwnValue({}, 'toString')).toBeUndefined();
        expect(getOwnValue({ a: 1 }, 'a')).toBe(1);
        expect(safeObjectEntries(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toEqual([['a', 2]]);
    });

    test('unread counts never write through inherited branch names', () => {
        const store = { branches: {}, activeBranchId: '__proto__' };
        setConversationThreadUnreadCount(store, 3, { branchId: '__proto__' });
        setConversationThreadUnreadCount(store, 3, { branchId: 'constructor' });
        setConversationThreadUnreadCount(store, 3);
        expect({}.unreadCount).toBeUndefined();
        expect(Object.prototype.unreadCount).toBeUndefined();
        expect(Object.prototype.unread_count).toBeUndefined();
    });

    test('store merges drop prototype keys', () => {
        const server = JSON.parse('{"characters":{"__proto__":{"polluted":true},"a.png":{"activeBranchId":"main","branches":{"__proto__":{"polluted":true},"main":{"messages":[]}}}}}');
        const merged = mergeConversationStore(server, JSON.parse(JSON.stringify(server)), {});
        expect({}.polluted).toBeUndefined();
        expect(Object.hasOwn(merged?.characters ?? {}, '__proto__')).toBe(false);
        expect(Object.hasOwn(merged?.characters?.['a.png']?.branches ?? {}, '__proto__')).toBe(false);
    });

    test('Mewmory settings changes ignore prototype keys', () => {
        const target = { nested: { a: 1 } };
        applySettingsChanges(target, { nested: { a: 1 } }, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"a":2}}'));
        expect({}.polluted).toBeUndefined();
        expect(Object.hasOwn(target, '__proto__')).toBe(false);
    });

    test('Purrk cooldown state only reads own keys', () => {
        const state = normalizeChatPurrksState(JSON.parse('{"cooldowns":{"__proto__":5,"constructor":4,"real":2},"overrides":{"__proto__":true}}'));
        expect(ownPurrkStateValue(state.cooldowns, 'constructor')).toBeUndefined();
        expect(ownPurrkStateValue(state.cooldowns, 'toString')).toBeUndefined();
        expect(ownPurrkStateValue({ real: 2 }, 'real')).toBe(2);
        expect(Object.prototype.polluted).toBeUndefined();
    });

    test('Scratchpad undo fields follow each entity allowlist', () => {
        expect(isAllowedUndoField(AGENT_FIELDS, 'prompt')).toBe(true);
        expect(isAllowedUndoField(REGEX_FIELDS, 'findRegex')).toBe(true);
        expect(isAllowedUndoField(CSS_SNIPPET_FIELDS, 'content')).toBe(true);
        expect(isAllowedUndoField(PERSONA_UNDO_FIELDS, 'title')).toBe(true);
        expect(isAllowedUndoField(PERSONA_NOTE_UNDO_FIELDS, 'avatar')).toBe(true);
        for (const field of ['__proto__', 'constructor', 'prototype', 'id', 'enabled', 'toString', undefined]) {
            expect(isAllowedUndoField(AGENT_FIELDS, field)).toBe(false);
        }
        expect(source('scratchpad/change-undo.js')).toContain('isAllowedUndoField(AGENT_FIELDS, undo.field)');
        expect(source('scratchpad/preset-changes.js')).toContain('isAllowedUndoField');
        expect(source('scratchpad/persona-changes.js')).toContain('isAllowedUndoField');
    });
});

describe('Attachment and portrait URLs', () => {
    test('Conversation media URLs allow local and raster data only', () => {
        expect(getSafeConversationMediaUrl('/user/images/Mira/a.png')).toBe('/user/images/Mira/a.png');
        expect(getSafeConversationMediaUrl('user/files/note.txt', { kind: 'file' })).toBe('/user/files/note.txt');
        expect(getSafeConversationMediaUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
        for (const unsafe of [
            'javascript:alert(1)',
            ' JavaScript:alert(1)',
            'data:text/html;base64,PHNjcmlwdD4=',
            'data:image/svg+xml;base64,PHN2Zz4=',
            'data:image/png,<svg>',
            '//evil.example/a.png',
            '/user/images/../../api/secrets/read',
            '/user/images/%2e%2e/%2e%2e/api/secrets',
            '/api/secrets/read',
            'https://evil.example/a.png',
            '\\\\evil\\share',
            42,
        ]) {
            expect({ unsafe, url: getSafeConversationMediaUrl(unsafe) }).toEqual({ unsafe, url: '' });
        }
        expect(getSafeConversationMediaUrl('https://cdn.example/a.png', { allowExternal: true })).toBe('https://cdn.example/a.png');
        expect(getSafeConversationMediaUrl('javascript:alert(1)', { allowExternal: true })).toBe('');
    });

    test('prompt image fetches are limited to user images and files', () => {
        expect(getFetchableConversationImagePath('/user/images/a.png')).toBe('/user/images/a.png');
        expect(getFetchableConversationImagePath('/user/files/a.png')).toBe('/user/files/a.png');
        expect(getFetchableConversationImagePath('/api/secrets/read')).toBe('');
        expect(getFetchableConversationImagePath('/user/images/../../api/secrets')).toBe('');
        expect(getFetchableConversationImagePath('/user/avatars/a.png')).toBe('');
        expect(getSafeLocalUserMediaPath('//user/images/a.png')).toBe('');
        expect(isSafeConversationDataImageUrl('data:image/webp;base64,UklGRg==')).toBe(true);
        expect(isSafeConversationDataImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
        const prompt = source('neconyan-conversation/prompt.js');
        expect(prompt).toContain('getFetchableConversationImagePath');
        expect(prompt).toMatch(/content-type/i);
    });

    test('external media follows the per-character override', () => {
        expect(isConversationExternalMediaAllowed({ forbid_external_media: true }, 'a.png')).toBe(false);
        expect(isConversationExternalMediaAllowed({ forbid_external_media: true, external_media_allowed_overrides: ['a.png'] }, 'a.png')).toBe(true);
        expect(isConversationExternalMediaAllowed({ forbid_external_media: false, external_media_forbidden_overrides: ['a.png'] }, 'a.png')).toBe(false);
    });

    test('Catelier portraits accept only raster base64 data URLs', () => {
        expect(isSafeCreatorImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
        expect(isSafeCreatorImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
        for (const unsafe of ['https://evil.example/a.png', '/api/secrets/read', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'javascript:alert(1)', 'data:image/png;base64,<script>']) {
            expect({ unsafe, safe: isSafeCreatorImageDataUrl(unsafe) }).toEqual({ unsafe, safe: false });
            expect({ unsafe, acceptable: isAcceptableCreatorMediaValue(unsafe) }).toEqual({ unsafe, acceptable: false });
        }
        const draft = createCreatorDraft({ id: 'security', card: { data: { name: 'Mira' } } });
        draft.media = [{ id: 'a', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }];
        expect(() => validateCreatorDraft(draft)).not.toThrow();
        draft.media = [{ id: 'a', dataUrl: '/api/secrets/read' }];
        expect(() => validateCreatorDraft(draft)).toThrow('The draft portraits are invalid.');
        draft.media = [{ id: 'a', dataUrl: 'https://evil.example/a.png' }];
        expect(() => validateCreatorDraft(draft)).toThrow('The draft portraits are invalid.');
        expect(source('creator/portrait.js')).not.toContain('fetch(media.dataUrl)');
    });
});

describe('Notes reader links', () => {
    test('render forbids area and download and marks genuine wikilinks after sanitising', () => {
        const render = source('notebooks/render.js');
        expect(render).toMatch(/FORBID_TAGS:[^\]]*'area'/);
        expect(render).toMatch(/FORBID_ATTR:[^\]]*'download'/);
        expect(render).toContain('genuineWikiLinks');
        expect(render).toContain('querySelectorAll(\'a[href], area[href]\')');
        expect(source('notebooks/notes-app.js')).toContain('hasAttribute(\'data-wiki-target\')');
    });
});

describe('Reply sanitiser overrides', () => {
    test('Conversation and Scratchpad replies forbid styles, forms and foreign content', () => {
        const overrides = strictReplySanitizerOverrides();
        for (const tag of ['style', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math']) {
            expect(overrides.FORBID_TAGS).toContain(tag);
        }
        expect(overrides.FORBID_ATTR).toContain('style');
        expect(overrides.FORBID_TAGS).not.toBe(STRICT_REPLY_SANITIZER_OVERRIDES.FORBID_TAGS);
        expect(source('scratchpad/index.js')).toContain('strictReplySanitizerOverrides()');
        expect(source('neconyan-conversation/timeline-render.js')).toContain('strictReplySanitizerOverrides()');
    });

    test('main-chat portrait URLs are removed from rendered replies', () => {
        const element = attributes => ({
            attributes: { ...attributes },
            hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
            getAttribute(name) { return this.attributes[name]; },
            removeAttribute(name) { delete this.attributes[name]; },
        });
        const portrait = element({ src: '/thumbnail/portrait?type=avatar&file=Main.png', alt: 'x' });
        const link = element({ href: '/thumbnail/portrait?x' });
        const kept = element({ src: '/user/images/a.png' });
        const root = { querySelectorAll: () => [portrait, link, kept] };
        stripForeignPortraitUrls(root);
        expect(portrait.attributes).toEqual({ alt: 'x' });
        expect(link.attributes).toEqual({});
        expect(kept.attributes).toEqual({ src: '/user/images/a.png' });
    });
});

describe('Catelier regex preview and agent rules', () => {
    test('preview expands only real capture groups and own named groups', () => {
        const result = previewCreatorRegexInWorker({ pattern: '/(a)(?<n>b)/g', replacement: '[$1|$<n>|$2|$3|{{match}}|$<constructor>]', sample: 'xabyab' });
        expect(JSON.stringify(result)).toContain('x[a|b|b||ab|]y[a|b|b||ab|]');
    });

    test('preview stops amplification before allocating the whole output', () => {
        const { result, elapsed } = timed(() => {
            try {
                return previewCreatorRegexInWorker({ pattern: '/./g', replacement: '$0'.repeat(5000), sample: 'x'.repeat(100000) });
            } catch (error) {
                return { error: error.message };
            }
        });
        expect(JSON.stringify(result)).toContain('too large');
        expect(elapsed).toBeLessThan(1000);
    });

    test('agent regex rules refuse oversized text', () => {
        expect(applyCreatorAgentRegexScripts([], 'plain')).toBe('plain');
        const scripts = [{ id: 'a', scriptName: 'grow', findRegex: '/x/g', replaceString: 'xxx', disabled: false }];
        expect(() => applyCreatorAgentRegexScripts(scripts, 'x'.repeat(CREATOR_AGENT_INPUT_LIMIT + 1))).toThrow('Nothing was applied.');
    });
});

describe('Conversation toasts', () => {
    test('dynamic toasts escape their text', () => {
        expect(CONVERSATION_SAFE_TOAST_OPTIONS).toEqual({ escapeHtml: true });
        expect(escapeToastText('<img src=x onerror=alert(1)>&')).toBe('&lt;img src=x onerror=alert(1)&gt;&amp;');
        expect(source('neconyan-conversation/chrome.js')).toMatch(/Schedule generated for \$\{character\.name\}\.`, '', SAFE_TOAST_OPTIONS/);
        expect(source('neconyan-conversation/roleplay-workflows.js')).toContain('escapeToastText(notice.message)');
    });
});

describe('Scratchpad PDF import', () => {
    test('pdf.js runs without eval', () => {
        expect(source('scratchpad/attachments.js')).toContain('isEvalSupported: false');
    });
});
