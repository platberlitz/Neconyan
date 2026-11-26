/* global globalThis */
import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import css from '@adobe/css-tools';

const readSource = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

function mockNames(names, overrides = {}) {
    const factory = {};
    for (const name of names) {
        factory[name] = overrides[name] ?? jest.fn();
    }
    return () => ({ ...factory, ...overrides });
}

function makeElement(nodeName, attrs = {}, { classes = [] } = {}) {
    const map = new Map(Object.entries(attrs));
    const el = Object.create(globalThis.Element.prototype);
    el.nodeName = nodeName;
    el.tagName = nodeName;
    el.getAttribute = name => map.has(name) ? map.get(name) : null;
    el.setAttribute = jest.fn((name, value) => map.set(name, String(value)));
    el.removeAttribute = jest.fn(name => map.delete(name));
    el.remove = jest.fn();
    el.classList = Object.assign([...classes], { contains: name => classes.includes(name) });
    return el;
}

function makeAnchor(attrs = {}) {
    const el = makeElement('A', attrs);
    el.target = attrs.target ?? '';
    return el;
}

const encodeCss = cssText => `<custom-style>${encodeURIComponent(cssText)}</custom-style>`;

describe('core macro limits', () => {
    let clampMacroRepeatCount;
    let isRollFormulaWithinLimits;

    beforeAll(async () => {
        ({ clampMacroRepeatCount, isRollFormulaWithinLimits } = await import('../public/scripts/macros/definitions/core-macros.js'));
    });

    test('clamps {{space}} and {{newline}} counts to 0..1000', () => {
        expect(clampMacroRepeatCount(undefined)).toBe(1);
        expect(clampMacroRepeatCount('3')).toBe(3);
        expect(clampMacroRepeatCount('-5')).toBe(0);
        expect(clampMacroRepeatCount('abc')).toBe(0);
        expect(clampMacroRepeatCount('Infinity')).toBe(0);
        expect(clampMacroRepeatCount('100000000')).toBe(1000);
    });

    test('rejects dice formulas with huge counts or sides', () => {
        expect(isRollFormulaWithinLimits('1d20')).toBe(true);
        expect(isRollFormulaWithinLimits('d6')).toBe(true);
        expect(isRollFormulaWithinLimits('1000d1000000+5')).toBe(true);
        expect(isRollFormulaWithinLimits('1001d6')).toBe(false);
        expect(isRollFormulaWithinLimits('1d1000001')).toBe(false);
        expect(isRollFormulaWithinLimits('99999999999d6')).toBe(false);
    });

    test('legacy {{roll}} applies the same limits before droll runs', () => {
        const source = readSource('../public/scripts/macros/legacy-macros.js');
        expect(source).toMatch(/!isLegacyRollFormulaWithinLimits\(formula\) \|\| !droll\.validate\(formula\)/);
        expect(source).toContain('dice <= 1000 && Number(match[2]) <= 1000000');
    });
});

describe('chat style scoping and DOMPurify hooks', () => {
    let decodeStyleTags;
    let encodeStyleTags;
    let addDOMPurifyHooks;
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
        ], { this_chid: 0, characters: [{ avatar: 'media-test.png' }], chat: [], event_types: {}, eventSource: { on: jest.fn() }, getChatGeneration: () => 1 }));

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
        await jest.unstable_mockModule('../public/scripts/constants.js', () => ({ MEDIA_DISPLAY: {}, MEDIA_SOURCE: {}, MEDIA_TYPE: {}, SCROLL_BEHAVIOR: {}, SWIPE_DIRECTION: {}, debounce_timeout: { short: 100, standard: 300 } }));

        globalThis.window = { location: { origin: 'http://127.0.0.1:8000' } };
        globalThis.HTMLUnknownElement = class {};
        globalThis.HTMLMediaElement = class {};
        globalThis.Element = class {};

        ({ decodeStyleTags, encodeStyleTags, addDOMPurifyHooks } = await import('../public/scripts/chats.js'));
        addDOMPurifyHooks();
    });

    describe('encodeStyleTags', () => {
        test('encodes attributed, spaced and upper-case style tags so none reach DOMPurify raw', () => {
            const input = [
                '<style>.a { color: red; }</style>',
                '<style type="text/css">.b { color: blue; }</style>',
                '<style >.c { color: green; }</style >',
                '<STYLE media="all">\n.d { color: pink; }\n</STYLE>',
            ].join('');
            const encoded = encodeStyleTags(input);
            expect(encoded).not.toMatch(/<style/i);
            expect(encoded.match(/<custom-style>/g)).toHaveLength(4);
            expect(decodeURIComponent(encoded)).toContain('.d { color: pink; }');
        });

        test('does not treat look-alike tags such as <styles> as style blocks', () => {
            expect(encodeStyleTags('<styles>x</styles>')).toBe('<styles>x</styles>');
        });
    });

    describe('decodeStyleTags nested CSS', () => {
        test('keeps safe relative nesting and prefixes nested classes', () => {
            const decoded = decodeStyleTags(encodeCss('.card { color: red; &:hover { color: blue; } & > .title { font-weight: bold; } .child { margin: 0; } }'));
            expect(decoded).toContain('.mes_text .custom-card');
            expect(decoded).toContain('&:hover');
            expect(decoded).toContain('& > .custom-title');
            expect(decoded).toContain('.custom-child');
            expect(decoded).toContain('color: blue');
        });

        test('drops nested selectors that climb out of the message scope', () => {
            const decoded = decodeStyleTags(encodeCss([
                '.card {',
                '  color: red;',
                '  body & { background: black; }',
                '  :root & { --leak: 1; }',
                '  body:has(&) { outline: 1px solid red; }',
                '  :is(body:has(&)) { opacity: 0; }',
                '  :not(&) { display: none; }',
                '  &.ok { color: green; }',
                '}',
            ].join('\n')));
            expect(decoded).toContain('color: green');
            expect(decoded).not.toContain('background: black');
            expect(decoded).not.toContain('--leak');
            expect(decoded).not.toContain('outline');
            expect(decoded).not.toContain('opacity: 0');
            expect(decoded).not.toContain('display: none');
        });

        test('strips external URLs inside nested rules, nested @media and nested @supports', () => {
            const decoded = decodeStyleTags(encodeCss([
                '.card {',
                '  & .x { background: url(https://127.0.0.1:9999/nested.png); color: red; }',
                '  @media (min-width: 1px) { background-image: url(//127.0.0.1:9999/media.png); color: blue; }',
                '  @supports (display: grid) { & .y { border-image: url(https\\3a //127.0.0.1:9999/supports.png); color: green; } }',
                '}',
            ].join('\n')));
            expect(decoded).not.toContain('127.0.0.1:9999');
            expect(decoded).toContain('color: red');
            expect(decoded).toContain('color: blue');
            expect(decoded).toContain('color: green');
        });

        test('drops nested @import and @scope, and top-level @scope declarations that apply outside the message', () => {
            const decoded = decodeStyleTags(encodeCss([
                '.card { @import url(/local.css); @scope (body) { color: red; } color: purple; }',
                '@scope (body) { background: red; }',
            ].join('\n')));
            expect(decoded).not.toMatch(/@import/i);
            expect(decoded).not.toContain('@scope');
            expect(decoded).not.toContain('background: red');
            expect(decoded).toContain('color: purple');
        });

        test('rewrites classes inside nested parentheses with a balanced scan', () => {
            const decoded = decodeStyleTags(encodeCss('.a:has(.b:not(.c)) .d { color: red; }'));
            expect(decoded).toContain('.mes_text .custom-a:has(.custom-b:not(.custom-c)) .custom-d');
        });

        test('prefixes id selectors only when an idPrefix is requested', () => {
            const plain = decodeStyleTags(encodeCss('#hero .x { color: red; }'));
            expect(plain).toContain('.mes_text #hero .custom-x');

            const prefixed = decodeStyleTags(encodeCss('#hero, #user-content-done { color: red; }'), { prefix: '.mes_text ', idPrefix: 'user-content-' });
            expect(prefixed).toContain('.mes_text #user-content-hero');
            expect(prefixed).toContain('.mes_text #user-content-done');
            expect(prefixed).not.toContain('user-content-user-content-');
        });

        test('points local url(#id) references in declarations at prefixed ids only when an idPrefix is requested', () => {
            const source = '#shape { stroke: url(#grad); fill: url("#user-content-done"); mask: url( \'#fade\' ); }';
            const plain = decodeStyleTags(encodeCss(source));
            expect(plain).toContain('url(#grad)');

            const prefixed = decodeStyleTags(encodeCss(source), { prefix: '.mes_text ', idPrefix: 'user-content-' });
            expect(prefixed).toContain('.mes_text #user-content-shape');
            expect(prefixed).toContain('stroke: url(#user-content-grad)');
            expect(prefixed).toContain('url("#user-content-done")');
            expect(prefixed).toContain('url(\'#user-content-fade\')');
            expect(prefixed).not.toContain('user-content-user-content-');
        });

        test('drops leading sibling combinators that would escape the prefix', () => {
            const decoded = decodeStyleTags(encodeCss('+ div { color: red; } ~ p { color: blue; } .ok { color: green; }'));
            expect(decoded).not.toContain('color: red');
            expect(decoded).not.toContain('color: blue');
            expect(decoded).toContain('color: green');
        });
    });

    describe('DOMPurify hooks', () => {
        test('removes raw style elements (HTML or SVG) from sanitised messages', () => {
            const htmlStyle = makeElement('STYLE');
            hooks.uponSanitizeElement(htmlStyle, {}, { MESSAGE_SANITIZE: true });
            expect(htmlStyle.remove).toHaveBeenCalled();

            const svgStyle = makeElement('style');
            hooks.uponSanitizeElement(svgStyle, {}, { MESSAGE_SANITIZE: true });
            expect(svgStyle.remove).toHaveBeenCalled();

            const otherSanitizer = makeElement('STYLE');
            hooks.uponSanitizeElement(otherSanitizer, {}, {});
            expect(otherSanitizer.remove).not.toHaveBeenCalled();
        });

        test('adds target=_blank with noopener noreferrer unless target is forbidden', () => {
            const link = makeAnchor({ href: 'https://example.com' });
            hooks.afterSanitizeAttributes(link, {}, {});
            expect(link.getAttribute('target')).toBe('_blank');
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');

            const forbidden = makeAnchor({ href: 'https://example.com' });
            hooks.afterSanitizeAttributes(forbidden, {}, { FORBID_ATTR: ['target'] });
            expect(forbidden.getAttribute('target')).toBeNull();
            expect(forbidden.setAttribute).not.toHaveBeenCalledWith('target', '_blank');
        });

        test('rewrites in-message anchors to the user-content- id prefix when named props are sanitised', () => {
            const anchor = makeAnchor({ href: '#chapter-2' });
            hooks.afterSanitizeAttributes(anchor, {}, { SANITIZE_NAMED_PROPS: true });
            expect(anchor.getAttribute('href')).toBe('#user-content-chapter-2');

            const bare = makeAnchor({ href: '#' });
            hooks.afterSanitizeAttributes(bare, {}, { SANITIZE_NAMED_PROPS: true });
            expect(bare.getAttribute('href')).toBe('#');

            const already = makeAnchor({ href: '#user-content-x' });
            hooks.afterSanitizeAttributes(already, {}, { SANITIZE_NAMED_PROPS: true });
            expect(already.getAttribute('href')).toBe('#user-content-x');

            const untouched = makeAnchor({ href: '#chapter-2' });
            hooks.afterSanitizeAttributes(untouched, {}, {});
            expect(untouched.getAttribute('href')).toBe('#chapter-2');
        });

        test('keeps label, form, ARIA, image map and SVG references pointing at prefixed ids', () => {
            const named = { SANITIZE_NAMED_PROPS: true };

            const label = makeElement('LABEL', { for: 'tab-a' });
            hooks.afterSanitizeAttributes(label, {}, named);
            expect(label.getAttribute('for')).toBe('user-content-tab-a');

            const output = makeElement('OUTPUT', { for: 'a user-content-b' });
            hooks.afterSanitizeAttributes(output, {}, named);
            expect(output.getAttribute('for')).toBe('user-content-a user-content-b');

            const input = makeElement('INPUT', { list: 'choices', form: 'user-content-f', 'aria-labelledby': ' title  hint ', 'aria-describedby': 'user-content-note' });
            hooks.afterSanitizeAttributes(input, {}, named);
            expect(input.getAttribute('list')).toBe('user-content-choices');
            expect(input.getAttribute('form')).toBe('user-content-f');
            expect(input.getAttribute('aria-labelledby')).toBe('user-content-title user-content-hint');
            expect(input.getAttribute('aria-describedby')).toBe('user-content-note');
            expect(input.setAttribute).not.toHaveBeenCalledWith('form', expect.anything());
            expect(input.setAttribute).not.toHaveBeenCalledWith('aria-describedby', expect.anything());

            const cell = makeElement('TD', { headers: 'row col' });
            hooks.afterSanitizeAttributes(cell, {}, named);
            expect(cell.getAttribute('headers')).toBe('user-content-row user-content-col');

            const image = makeElement('IMG', { usemap: '#map' });
            hooks.afterSanitizeAttributes(image, {}, named);
            expect(image.getAttribute('usemap')).toBe('#user-content-map');

            const rect = makeElement('rect', { fill: 'url(#grad)', stroke: 'red', style: 'clip-path: url(\'#clip\'); mask: url(#user-content-m)' });
            hooks.afterSanitizeAttributes(rect, {}, named);
            expect(rect.getAttribute('fill')).toBe('url(#user-content-grad)');
            expect(rect.getAttribute('stroke')).toBe('red');
            expect(rect.getAttribute('style')).toBe('clip-path: url(\'#user-content-clip\'); mask: url(#user-content-m)');

            const gradient = makeElement('linearGradient', { 'xlink:href': '#base' });
            hooks.afterSanitizeAttributes(gradient, {}, named);
            expect(gradient.getAttribute('xlink:href')).toBe('#user-content-base');

            const plain = makeElement('LABEL', { for: 'tab-a' });
            const plainRect = makeElement('rect', { fill: 'url(#grad)' });
            hooks.afterSanitizeAttributes(plain, {}, {});
            hooks.afterSanitizeAttributes(plainRect, {}, {});
            expect(plain.getAttribute('for')).toBe('tab-a');
            expect(plainRect.getAttribute('fill')).toBe('url(#grad)');
        });

        test('strict mode removes every cross-origin URL attribute even when external media is allowed', () => {
            powerUser.forbid_external_media = false;
            const link = makeAnchor({ href: 'https://evil.example/collect?d=1', ping: '//evil.example/p' });
            hooks.afterSanitizeAttributes(link, {}, { MESSAGE_SANITIZE: true, MESSAGE_BLOCK_EXTERNAL_URLS: true });
            expect(link.getAttribute('href')).toBeNull();
            expect(link.getAttribute('ping')).toBeNull();

            const local = makeAnchor({ href: '/img/local.png' });
            hooks.afterSanitizeAttributes(local, {}, { MESSAGE_SANITIZE: true, MESSAGE_BLOCK_EXTERNAL_URLS: true });
            expect(local.getAttribute('href')).toBe('/img/local.png');

            const img = makeElement('IMG', { src: 'https://evil.example/pixel.png' });
            hooks.uponSanitizeElement(img, {}, { MESSAGE_SANITIZE: true, MESSAGE_BLOCK_EXTERNAL_URLS: true });
            expect(img.remove).toHaveBeenCalled();

            const relaxed = makeElement('IMG', { src: 'https://cdn.example/pixel.png' });
            hooks.uponSanitizeElement(relaxed, {}, { MESSAGE_SANITIZE: true });
            expect(relaxed.remove).not.toHaveBeenCalled();

            const style = { attrName: 'style', attrValue: 'background: url(https://evil.example/bg.png)', keepAttr: true };
            hooks.uponSanitizeAttribute(makeElement('DIV'), style, { MESSAGE_SANITIZE: true, MESSAGE_BLOCK_EXTERNAL_URLS: true });
            expect(style.keepAttr).toBe(false);
        });

        test('class prefixing can be turned off for host-authored popups only', () => {
            const prefixed = { attrName: 'class', attrValue: 'warning big', keepAttr: true };
            hooks.uponSanitizeAttribute(makeElement('DIV'), prefixed, { MESSAGE_SANITIZE: true });
            expect(prefixed.attrValue).toBe('custom-warning custom-big');

            const preserved = { attrName: 'class', attrValue: 'warning big', keepAttr: true };
            hooks.uponSanitizeAttribute(makeElement('DIV'), preserved, { MESSAGE_SANITIZE: true, MESSAGE_PRESERVE_CLASSES: true });
            expect(preserved.attrValue).toBe('warning big');
        });
    });
});

describe('source-level hardening', () => {
    const script = readSource('../public/script.js');
    const chats = readSource('../public/scripts/chats.js');
    const slash = readSource('../public/scripts/slash-commands.js');
    const i18n = readSource('../public/scripts/i18n.js');
    const groupChats = readSource('../public/scripts/group-chats.js');
    const tabs = readSource('../public/scripts/neconyan-tabs.js');
    const androidBridge = readSource('../public/scripts/android-native-bridge.js');
    const push = readSource('../public/scripts/push-notifications.js');

    test('message and creator-note sanitisers always forbid <style> and data-i18n and prefix named props', () => {
        expect(script).toContain('FORBID_TAGS: [...new Set([\'style\', ...forbidTags])]');
        expect(script).toContain('FORBID_ATTR: [...new Set([\'data-i18n\', ...forbidAttr])]');
        expect(script).toMatch(/SANITIZE_NAMED_PROPS/);
        const start = chats.indexOf('export function formatCreatorNotes');
        const creatorNotes = chats.slice(start, start + 1500);
        expect(creatorNotes).toContain('SANITIZE_NAMED_PROPS: true');
        expect(creatorNotes).toContain('FORBID_TAGS: [\'style\']');
        expect(creatorNotes).toContain('FORBID_ATTR: [\'data-i18n\']');
    });

    test('character source links only open http(s) URLs, escape popup text and drop the opener', () => {
        expect(script).toContain('function isHttpCharacterSourceUrl(');
        expect(script).toContain('${escapeHtml(url.hostname)}');
        expect(script).toContain('<var>${escapeHtml(url.toString())}</var>');
        expect(script).toContain('window.open(url.toString(), \'_blank\', \'noopener,noreferrer\')');
        expect(script).toContain('t`This character was downloaded from: <var>${safeOnlineUrl}</var>');
    });

    test('card-script sandbox popups use the strict sanitiser and plain popups forbid <style>', () => {
        expect(slash).toContain('const CARD_SCRIPT_SANDBOX_SOURCE_PREFIX = \'card-script-sandbox:\';');
        expect(slash).toContain('MESSAGE_BLOCK_EXTERNAL_URLS: true');
        expect(slash).toContain('DOMPurify.sanitize(text || \'\', getPopupSanitizeConfig(args))');
        expect(slash).toContain('DOMPurify.sanitize(value || \'\', getPopupSanitizeConfig(args))');
        expect(slash).toContain('DOMPurify.sanitize(prompt || \'\', getPopupSanitizeConfig(args))');
        expect(slash).toContain('cardScriptSandboxScopes.add(sandboxScope)');
        expect(slash).toContain('/^[a-z0-9-]+$/i.test(token)');
    });

    test('i18n allow-list never names class, id, style, href or src', () => {
        expect(i18n).toContain('Object.hasOwn');
        expect(i18n).toContain('.mes_text, #creator_notes_spoiler');
        const start = i18n.indexOf('const translatableAttributes');
        const allowList = i18n.slice(start, i18n.indexOf('];', start));
        for (const unsafe of ['\'class\'', '\'id\'', '\'style\'', '\'href\'', '\'src\'']) {
            expect(allowList).not.toContain(unsafe);
        }
    });

    test('group avatars are built with attributes and only accept raster data URLs', () => {
        expect(groupChats).toContain('data:image\\/(?:png|jpeg|jpg|webp|gif|avif);base64,');
        expect(groupChats).toContain('.attr(\'title\', t`[Group] ${group.name}`)');
        expect(groupChats).toContain('.attr(\'src\', group.avatar_url)');
    });

    test('recent chats, quick actions and external links avoid HTML interpolation and the opener', () => {
        expect(tabs).toContain('window.open(releaseUrl, \'_blank\', \'noopener,noreferrer\')');
        expect(tabs).toMatch(/NN_PERSONA_HELP_LINK_HTML[\s\S]{0,400}rel="noopener noreferrer"/);
        expect(tabs).toContain('function readNativeHostGlobal(');
        expect(androidBridge).toContain('if (!String(url).startsWith(\'blob:\')) return false;');
        expect(androidBridge).toContain('target instanceof globalThis.Node');
        expect(push).toContain('nativeGlobal(\'webkit\')');
    });
});

describe('i18n attribute translation', () => {
    test('translateElement refuses unsafe attributes, inherited keys and message content', () => {
        const source = readSource('../public/scripts/i18n.js');
        const slice = name => {
            const start = source.indexOf(`function ${name}`);
            return source.slice(start, source.indexOf('\n}\n', start) + 3);
        };
        const context = {
            localeData: { evil: 'javascript:alert(1)', tip: 'Consejo' },
            scopedData: {},
        };
        context.tableForKey = () => context.localeData;
        vm.createContext(context);
        vm.runInContext(`${slice('lookupTable')}\n${slice('translateElement')}\nthis.translateElement = translateElement;`, context);

        const makeI18nElement = (key, insideMessage = false) => {
            const attrs = new Map([['data-i18n', key]]);
            return {
                attrs,
                textContent: '',
                getAttribute: name => attrs.get(name) ?? null,
                setAttribute: (name, value) => attrs.set(name, value),
                closest: () => insideMessage ? {} : null,
                parentElement: { closest: () => null },
            };
        };

        const safe = makeI18nElement('[title]tip');
        context.translateElement(safe);
        expect(safe.attrs.get('title')).toBe('Consejo');

        const unsafe = makeI18nElement('[href]evil;[onclick]evil;[class]tip;[style]tip');
        context.translateElement(unsafe);
        expect([...unsafe.attrs.keys()]).toEqual(['data-i18n']);

        const inherited = makeI18nElement('[title]constructor;toString');
        context.translateElement(inherited);
        expect(inherited.attrs.has('title')).toBe(false);
        expect(inherited.textContent).toBe('');

        const inMessage = makeI18nElement('[title]tip', true);
        context.translateElement(inMessage);
        expect(inMessage.attrs.has('title')).toBe(false);
    });
});
