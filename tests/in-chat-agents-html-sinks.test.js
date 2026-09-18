import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import css from '@adobe/css-tools';

const extensionDir = new URL('../public/scripts/extensions/in-chat-agents/', import.meta.url);
const readSource = file => fs.readFileSync(new URL(file, extensionDir), 'utf8');

function mockNames(names, overrides = {}) {
    const factory = {};
    for (const name of names) {
        factory[name] = overrides[name] ?? jest.fn();
    }
    return () => ({ ...factory, ...overrides });
}

describe('style decoder cannot break out of its style element', () => {
    let decodeStyleTags;

    beforeAll(async () => {
        jest.resetModules();
        const libNames = ['lodash', 'Fuse', 'DOMPurify', 'hljs', 'localforage', 'Handlebars', 'Bowser', 'DiffMatchPatch',
            'Readability', 'isProbablyReaderable', 'SVGInject', 'showdown', 'moment', 'seedrandom', 'Popper', 'droll',
            'morphdom', 'slideToggle', 'chalk', 'yaml', 'chevrotain', 'gzipSync', 'gzip', 'sha256'];
        await jest.unstable_mockModule('../public/lib.js', () => {
            const stubs = Object.fromEntries(libNames.map(name => [name, {}]));
            return { ...stubs, css, default: { ...stubs, css } };
        });
        await jest.unstable_mockModule('../public/script.js', mockNames([
            'addCopyToCodeBlocks', 'appendMediaToMessage', 'characters', 'chat', 'eventSource', 'event_types',
            'getCurrentChatId', 'getRequestHeaders', 'name2', 'reloadCurrentChat', 'saveSettingsDebounced', 'this_chid',
            'saveChatConditional', 'chat_metadata', 'neutralCharacterName', 'updateChatMetadata', 'system_message_types',
            'converter', 'substituteParams', 'getSystemMessageByType', 'printMessages', 'clearChat', 'refreshSwipeButtons',
            'getMediaIndex', 'getMediaDisplay', 'chatElement',
        ], { this_chid: undefined, characters: [], chat: [], event_types: {}, eventSource: { on: jest.fn() } }));
        const utilNames = [...readSource('../../utils.js').matchAll(/^export (?:async function|function|const|let|class) (\w+)/gm)]
            .map(match => match[1]);
        const escapeHtml = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        await jest.unstable_mockModule('../public/scripts/utils.js', mockNames(utilNames, { escapeHtml }));
        await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
            power_user: { forbid_external_media: false, external_media_allowed_overrides: [], external_media_forbidden_overrides: [] },
        }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', mockNames(['extension_settings', 'renderExtensionTemplateAsync', 'saveMetadataDebounced'], { extension_settings: {} }));
        await jest.unstable_mockModule('../public/scripts/popup.js', mockNames(['POPUP_RESULT', 'POPUP_TYPE', 'Popup', 'callGenericPopup'], { POPUP_RESULT: {}, POPUP_TYPE: {}, Popup: class {} }));
        await jest.unstable_mockModule('../public/scripts/scrapers.js', () => ({ ScraperManager: class {} }));
        await jest.unstable_mockModule('../public/scripts/dragdrop.js', () => ({ DragAndDropHandler: class {} }));
        await jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ humanizedDateTime: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
        await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: {}, MEDIA_SOURCE: {}, MEDIA_TYPE: {}, SCROLL_BEHAVIOR: {}, SWIPE_DIRECTION: {} }));
        ({ decodeStyleTags } = await import('../public/scripts/chats.js'));
    });

    test('a closing style tag hidden in a CSS comment stays inside the style element', () => {
        const hostile = '/* </style><img src=x onerror=alert(1)> */ .a { color: red; }';
        const encoded = `<custom-style>${encodeURIComponent(hostile)}</custom-style>`;
        const decoded = decodeStyleTags(encoded, { prefix: '.ica--companion-body ' });

        expect(decoded.startsWith('<style>')).toBe(true);
        expect(decoded.endsWith('</style>')).toBe(true);
        /* Inside a style element only '</' can end raw text, so its absence keeps the markup inert. */
        expect(decoded.slice(7, -8)).not.toContain('</');
    });

    test('decoder errors are escaped', () => {
        const decoded = decodeStyleTags('<custom-style>%E0%A4%A</custom-style>', { prefix: '.x ' });
        expect(decoded.startsWith('CSS ERROR: ')).toBe(true);
        expect(decoded).not.toMatch(/<[a-z]/i);
    });
});

describe('agent HTML sinks are escaped or sanitised', () => {
    test('prompt transform toast escapes the agent name used as the title', () => {
        const source = readSource('agent-runner.js');
        const toastCall = source.slice(source.indexOf('function showPromptTransformRunningToast'));
        expect(toastCall).toMatch(/toastr\.info\(messageHtml, escapeToastHtml\(agentName\)/);
    });

    test('tracker HTML preview sanitises generated markup before rendering', () => {
        const source = readSource('index.js');
        const preview = source.slice(source.indexOf('function buildTrackerHtmlPreviewNode'), source.indexOf('function buildTrackerPreviewPopupContent'));
        expect(preview).toMatch(/previewFrame\.innerHTML = hasRenderedPreview\s*\?\s*sanitizeCompanionHtml\(renderedOutput/);
        expect(source).toMatch(/import \{[^}]*sanitizeCompanionHtml[^}]*\} from '\.\/companion\/companion-ui\.js'/);
    });

    test('custom kit picker escapes agent ids in attribute values', () => {
        const source = readSource('index.js');
        expect(source).not.toMatch(/value="\$\{agent\.id\}"/);
        expect(source).toMatch(/value="\$\{escapeHtml\(agent\.id\)\}"/);
    });
});
