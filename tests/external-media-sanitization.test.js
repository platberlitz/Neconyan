/* global globalThis */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import css from '@adobe/css-tools';

const readSource = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

function mockNames(names, overrides = {}) {
    const factory = {};
    for (const name of names) {
        factory[name] = overrides[name] ?? jest.fn();
    }
    return () => ({ ...factory, ...overrides });
}

describe('external media privacy boundary', () => {
    let decodeStyleTags;
    let addDOMPurifyHooks;
    let isExternalMediaUrl;
    let hasExternalCssUrl;
    let powerUser;
    let hooks;

    beforeEach(async () => {
        jest.resetModules();
        hooks = {};
        powerUser = {
            forbid_external_media: true,
            external_media_allowed_overrides: [],
            external_media_forbidden_overrides: [],
        };

        const DOMPurify = {
            addHook: jest.fn((name, fn) => {
                hooks[name] = fn;
            }),
        };

        const libNames = ['lodash', 'Fuse', 'hljs', 'localforage', 'Handlebars', 'Bowser', 'DiffMatchPatch',
            'Readability', 'isProbablyReaderable', 'SVGInject', 'showdown', 'moment', 'seedrandom', 'Popper', 'droll',
            'morphdom', 'slideToggle', 'chalk', 'yaml', 'chevrotain', 'gzipSync', 'gzip', 'sha256'];
        await jest.unstable_mockModule('../public/lib.js', () => {
            const stubs = Object.fromEntries(libNames.map(name => [name, {}]));
            return { ...stubs, DOMPurify, css, default: { ...stubs, DOMPurify, css } };
        });
        await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => 'test' }));
        await jest.unstable_mockModule('../public/script.js', mockNames([
            'addCopyToCodeBlocks', 'appendMediaToMessage', 'characters', 'chat', 'eventSource', 'event_types',
            'getCurrentChatId', 'getRequestHeaders', 'name2', 'reloadCurrentChat', 'saveSettingsDebounced', 'this_chid',
            'saveChatConditional', 'chat_metadata', 'neutralCharacterName', 'updateChatMetadata', 'system_message_types',
            'converter', 'substituteParams', 'getSystemMessageByType', 'printMessages', 'clearChat', 'refreshSwipeButtons',
            'getMediaIndex', 'getMediaDisplay', 'chatElement', 'getChatGeneration',
        ], { this_chid: undefined, characters: [], chat: [], event_types: {}, eventSource: { on: jest.fn() }, getChatGeneration: () => 1 }));

        const utilNames = [...readSource('../public/scripts/utils.js').matchAll(/^export (?:async function|function|const|let|class) (\w+)/gm)]
            .map(match => match[1]);
        const escapeHtml = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const primitives = await import('../public/scripts/macro-primitives.js');
        await jest.unstable_mockModule('../public/scripts/utils.js', mockNames(utilNames, { ...primitives, escapeHtml }));
        await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: powerUser }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', mockNames(['extension_settings', 'renderExtensionTemplateAsync', 'saveMetadataDebounced'], { extension_settings: {} }));
        await jest.unstable_mockModule('../public/scripts/popup.js', mockNames(['POPUP_RESULT', 'POPUP_TYPE', 'Popup', 'callGenericPopup'], { POPUP_RESULT: {}, POPUP_TYPE: {}, Popup: class {} }));
        await jest.unstable_mockModule('../public/scripts/scrapers.js', () => ({ ScraperManager: class {} }));
        await jest.unstable_mockModule('../public/scripts/dragdrop.js', () => ({ DragAndDropHandler: class {} }));
        await jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join(''), translate: text => text }));
        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ humanizedDateTime: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(() => 'true'), setItem: jest.fn() } }));
        await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: {}, MEDIA_SOURCE: {}, MEDIA_TYPE: {}, SCROLL_BEHAVIOR: {}, SWIPE_DIRECTION: {} }));

        globalThis.window = { location: { origin: 'http://127.0.0.1:8000' } };
        globalThis.HTMLUnknownElement = class {};
        globalThis.HTMLMediaElement = class {};
        globalThis.Element = class {};

        ({ decodeStyleTags, addDOMPurifyHooks, isExternalMediaUrl, hasExternalCssUrl } = await import('../public/scripts/chats.js'));
        addDOMPurifyHooks();
    });

    test('detects external URLs and CSS escape / protocol-relative variants while allowing local and data URLs', () => {
        expect(isExternalMediaUrl('https://127.0.0.1:9999/pixel.png')).toBe(true);
        expect(isExternalMediaUrl('//127.0.0.1:9999/pixel.png')).toBe(true);
        expect(isExternalMediaUrl('/\\127.0.0.1:9999/backslash-img.png')).toBe(true);
        expect(isExternalMediaUrl('\\\\127.0.0.1:9999/backslash-img.png')).toBe(true);
        expect(isExternalMediaUrl('https:127.0.0.1:9999/schemeless-https.png')).toBe(true);
        expect(isExternalMediaUrl('https:/127.0.0.1:9999/single-slash.png')).toBe(true);
        expect(isExternalMediaUrl('https:\\\\127.0.0.1:9999/backslash-https.png')).toBe(true);
        expect(isExternalMediaUrl('http://127.0.0.1:8000/img/local.png')).toBe(false);
        expect(isExternalMediaUrl('/img/local.png')).toBe(false);
        expect(isExternalMediaUrl('img/local.png')).toBe(false);
        expect(isExternalMediaUrl('#section-anchor')).toBe(false);
        expect(isExternalMediaUrl('data:image/png;base64,AAAA')).toBe(false);
        expect(isExternalMediaUrl('blob:http://127.0.0.1:8000/abc-123')).toBe(false);
        expect(isExternalMediaUrl('blob:http://127.0.0.1:9999/abc-123')).toBe(true);

        expect(hasExternalCssUrl('url(//127.0.0.1:9999/pixel.png)')).toBe(true);
        expect(hasExternalCssUrl('url(https\\://127.0.0.1:9999/pixel.png)')).toBe(true);
        expect(hasExternalCssUrl('url(https\\3a //127.0.0.1:9999/pixel.png)')).toBe(true);
        expect(hasExternalCssUrl('image-set("https://127.0.0.1:9999/pixel.png" 1x)')).toBe(true);
        expect(hasExternalCssUrl('\'//127.0.0.1:9999/var-imageset.png\'')).toBe(true);
        expect(hasExternalCssUrl('url(\'/local.png?a=/*\'), url(\'https://127.0.0.1:9999/comment-in-string.png?b=*/\')')).toBe(true);
        expect(hasExternalCssUrl('url(\'//127.0.0.1:9999/escaped-quote.png?a=\\\'\')')).toBe(true);
        expect(hasExternalCssUrl('url(//127.0.0.1:9999/escaped-paren.png?a=\\))')).toBe(true);
        expect(hasExternalCssUrl('url(\'/\\\\127.0.0.1:9999/backslash-css.png\')')).toBe(true);
        expect(hasExternalCssUrl('url("/img/local.png")')).toBe(false);
        expect(hasExternalCssUrl('url(\'/local.png?a=/*\'), url(\'/local2.png?b=*/\')')).toBe(false);
        expect(hasExternalCssUrl('url(\'/local.png?a=\\\'\')')).toBe(false);
        expect(hasExternalCssUrl('"Inter", sans-serif')).toBe(false);
        expect(hasExternalCssUrl('"hello /* world */"')).toBe(false);
        expect(hasExternalCssUrl('url("data:image/png;base64,AAAA")')).toBe(false);
    });

    test('decodeStyleTags strips @keyframes external URLs, @IMPORT / escaped @import, protocol-relative URLs, and CSS escapes when external media is forbidden', () => {
        const cssText = [
            '@IMPORT "http://127\\2e 0\\2e 0\\2e 1:9999/imp.css";',
            '@\\69mport "http://127.0.0.1:9999/imp2.css";',
            '@keyframes kf { from { background-image: url(http://127.0.0.1:9999/keyframes.png); opacity: 0; } to { background-image: url(/img/local-kf.png); opacity: 1; } }',
            '.proto { background-image: url(//127.0.0.1:9999/proto.png); color: green; }',
            '.escaped { background-image: url(https\\://127.0.0.1:9999/escaped.png); }',
            '.hex { background-image: url(https\\3a //127.0.0.1:9999/hex.png); }',
            '.var-leak { --u: \'//127.0.0.1:9999/var-imageset.png\'; }',
            '.local { background-image: url(/img/local.png); }',
        ].join('\n');
        const decoded = decodeStyleTags(`<custom-style>${encodeURIComponent(cssText)}</custom-style>`, { prefix: '' });

        expect(decoded).not.toContain('127.0.0.1:9999');
        expect(decoded).not.toContain('imp.css');
        expect(decoded).not.toContain('imp2.css');
        expect(decoded).not.toMatch(/@import/i);
        expect(decoded).toContain('color: green');
        expect(decoded).toContain('opacity: 0');
        expect(decoded).toContain('opacity: 1');
        expect(decoded).toContain('/img/local-kf.png');
        expect(decoded).toContain('/img/local.png');
    });

    test('uponSanitizeAttribute strips external CSS URLs (including custom property strings, comment-in-string, and escaped quotes) and table background attributes while keeping benign declarations', () => {
        const data = {
            attrName: 'style',
            attrValue: [
                'color: red',
                '--u: \'//127.0.0.1:9999/var-imageset.png\'',
                'background-image: url(\'/local.png?a=/*\'), url(\'https://127.0.0.1:9999/comment-in-string.png?b=*/\')',
                'mask-image: url(\'//127.0.0.1:9999/escaped-quote.png?a=\\\'\')',
                'border-image: url(\'/\\\\127.0.0.1:9999/backslash-css.png\')',
                'transform: scale(1.1)',
                'content: "hello /* world */"',
            ].join('; '),
            keepAttr: true,
        };
        hooks.uponSanitizeAttribute({ nodeName: 'SPAN', classList: { contains: () => false } }, data, { MESSAGE_SANITIZE: true });

        expect(data.keepAttr).toBe(true);
        expect(data.attrValue).toContain('color: red');
        expect(data.attrValue).toContain('transform: scale(1.1)');
        expect(data.attrValue).toContain('content: "hello /* world */"');
        expect(data.attrValue).not.toContain('127.0.0.1:9999');

        const onlyExternal = {
            attrName: 'style',
            attrValue: 'background: url(//127.0.0.1:9999/bg.png)',
            keepAttr: true,
        };
        hooks.uponSanitizeAttribute({ nodeName: 'DIV', classList: { contains: () => false } }, onlyExternal, { MESSAGE_SANITIZE: true });
        expect(onlyExternal.keepAttr).toBe(false);

        const tableExternalBg = {
            attrName: 'background',
            attrValue: 'http://127.0.0.1:9999/table-bg.png',
            keepAttr: true,
        };
        hooks.uponSanitizeAttribute({ nodeName: 'TABLE', classList: { contains: () => false } }, tableExternalBg, { MESSAGE_SANITIZE: true });
        expect(tableExternalBg.keepAttr).toBe(false);

        const tableLocalBg = {
            attrName: 'background',
            attrValue: '/img/local-table.png',
            keepAttr: true,
        };
        hooks.uponSanitizeAttribute({ nodeName: 'TD', classList: { contains: () => false } }, tableLocalBg, { MESSAGE_SANITIZE: true });
        expect(tableLocalBg.keepAttr).toBe(true);
    });

    test('uponSanitizeElement strips video poster and removes input[src], img with backslash/schemeless URLs, and SVG image/feImage with external href', () => {
        const makeElement = (tagName, attrs) => {
            const map = new Map(Object.entries(attrs));
            const el = Object.create(globalThis.Element.prototype);
            el.tagName = tagName;
            el.getAttribute = name => map.get(name) ?? null;
            el.removeAttribute = jest.fn(name => map.delete(name));
            el.remove = jest.fn();
            return el;
        };

        const video = makeElement('VIDEO', { poster: 'https://127.0.0.1:9999/poster.png' });
        hooks.uponSanitizeElement(video, {}, { MESSAGE_SANITIZE: true });
        expect(video.removeAttribute).toHaveBeenCalledWith('poster');

        const inputImage = makeElement('INPUT', { type: 'image', src: 'http://127.0.0.1:9999/input-image.png' });
        hooks.uponSanitizeElement(inputImage, {}, { MESSAGE_SANITIZE: true });
        expect(inputImage.remove).toHaveBeenCalled();

        const backslashImg = makeElement('IMG', { src: '/\\127.0.0.1:9999/backslash-img.png' });
        hooks.uponSanitizeElement(backslashImg, {}, { MESSAGE_SANITIZE: true });
        expect(backslashImg.remove).toHaveBeenCalled();

        const schemelessImg = makeElement('IMG', { src: 'https:127.0.0.1:9999/schemeless-https.png' });
        hooks.uponSanitizeElement(schemelessImg, {}, { MESSAGE_SANITIZE: true });
        expect(schemelessImg.remove).toHaveBeenCalled();

        const localImg = makeElement('IMG', { src: '/img/local.png' });
        hooks.uponSanitizeElement(localImg, {}, { MESSAGE_SANITIZE: true });
        expect(localImg.remove).not.toHaveBeenCalled();

        const svgImage = makeElement('image', { href: 'https://127.0.0.1:9999/svg.png' });
        hooks.uponSanitizeElement(svgImage, {}, { MESSAGE_SANITIZE: true });
        expect(svgImage.remove).toHaveBeenCalled();

        const feImage = makeElement('feImage', { 'xlink:href': '//127.0.0.1:9999/filter.png' });
        hooks.uponSanitizeElement(feImage, {}, { MESSAGE_SANITIZE: true });
        expect(feImage.remove).toHaveBeenCalled();
    });

    test('backgrounds and Preset Tools check external media allowance before applying chat_metadata.custom_background', () => {
        const bgSource = readSource('../public/scripts/backgrounds.js');
        expect(bgSource).toContain('const allowLockedUrl = Boolean(lockedUrl) && (isExternalMediaAllowed() || !hasExternalCssUrl(lockedUrl));');

        const presetToolsSource = readSource('../public/scripts/extensions/third-party/Neconyan-Preset-Tools/content.js');
        expect(presetToolsSource).toContain('if (isExternalMediaAllowed() || (!isExternalMediaUrl(lockedBackground) && !hasExternalCssUrl(rawLocked)))');
        expect(presetToolsSource).toContain('if (!mediaAllowed && (isExternalMediaUrl(currentReference) || hasExternalCssUrl(currentReference)))');
    });
});
