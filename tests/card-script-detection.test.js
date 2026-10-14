import { describe, test, expect, beforeEach } from '@jest/globals';
import {
    CARD_SCRIPT_MARKER_TAG,
    MAX_STASHED_CARD_SCRIPTS,
    buildCardScriptToastKey,
    containsEmbeddedCardScript,
    forgetAllCardScripts,
    getCardScriptSnapshot,
    getShownCardScriptToastCount,
    getStoredCardScriptCount,
    hasCardScriptToastBeenShown,
    hashCardScriptHtml,
    markCardScriptHtml,
    markCardScriptToastShown,
    rememberCardScript,
    protectCardScriptBlocks,
} from '../public/scripts/card-script-detection.js';
import { installCardScriptTestDom } from './card-script-dom.js';

beforeEach(() => {
    forgetAllCardScripts();
    installCardScriptTestDom();
});

describe('card script detection', () => {
    test('detects script tags and appends a marker', () => {
        const html = '<p>Hello</p><script>alert(1)</script>';
        const markedHtml = markCardScriptHtml(html, 7);

        expect(containsEmbeddedCardScript(html)).toBe(true);
        expect(markedHtml).toContain(`<${CARD_SCRIPT_MARKER_TAG} data-msg-id="7" data-card-script-hash=`);
        expect(getCardScriptSnapshot(7)).toMatchObject({
            html,
            hash: hashCardScriptHtml(html + '[]'),
        });
    });

    test('detects iframe tags and appends a marker', () => {
        const html = '<iframe src="https://example.com"></iframe>';
        const markedHtml = markCardScriptHtml(html, 8);

        expect(containsEmbeddedCardScript(html)).toBe(true);
        expect(markedHtml).toContain(`<${CARD_SCRIPT_MARKER_TAG} data-msg-id="8" data-card-script-hash=`);
        expect(getCardScriptSnapshot(8)).toMatchObject({ html });
    });

    test('detects uppercase tags and whitespace before attributes', () => {
        expect(containsEmbeddedCardScript('<SCRIPT type="text/javascript"></SCRIPT>')).toBe(true);
        expect(containsEmbeddedCardScript('<iframe src="https://example.com"></iframe>')).toBe(true);
    });

    test('does not detect lookalike tag names', () => {
        expect(containsEmbeddedCardScript('<scripts>alert(1)</scripts>')).toBe(false);
    });

    test('does not stash or mark plain text', () => {
        const html = '<p>No runnable card script here.</p>';

        expect(markCardScriptHtml(html, 9)).toBe(html);
        expect(getCardScriptSnapshot(9)).toBeNull();
        expect(getStoredCardScriptCount()).toBe(0);
    });

    test('does not stash or mark nullish or empty message ids as message zero', () => {
        const html = '<script>alert(1)</script>';

        expect(markCardScriptHtml(html, null)).toBe(html);
        expect(markCardScriptHtml(html, undefined)).toBe(html);
        expect(markCardScriptHtml(html, '')).toBe(html);

        expect(getCardScriptSnapshot(0)).toBeNull();
        expect(getStoredCardScriptCount()).toBe(0);
    });

    test('a fenced code example does not produce a runnable snapshot', () => {
        const markdown = '```html\n<script>alert(1)</script>\n```';
        const protectedText = protectCardScriptBlocks(markdown);
        const markedHtml = markCardScriptHtml('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>', 10, { fencedPages: protectedText.fencedPages });

        expect(markedHtml).not.toContain(CARD_SCRIPT_MARKER_TAG);
        expect(getCardScriptSnapshot(10)).toBeNull();
    });

    test.each(['html', ''])('a full-page fence with language %s produces an in-place block snapshot', language => {
        const html = '<html><body><script>run()</script></body></html>';
        const protectedText = protectCardScriptBlocks(`Before\n\n\`\`\`${language}\n${html}\n\`\`\`\n\nAfter`);
        const marked = markCardScriptHtml(protectedText.restore(protectedText.text), 10, { scopeKey: 7, fencedPages: protectedText.fencedPages });
        expect(getCardScriptSnapshot(10)).toMatchObject({ scopeKey: '7', blocks: [{ html, index: 0 }] });
        expect(marked).toContain('data-card-script-block="0"');
        expect(marked).toContain('data-card-script-scope="7"');
    });

    test('preserves raw script/style/iframe bytes and leaves examples untouched', () => {
        const script = '<script data-a="x">const x = "<q>"; if (1 < 2) x; const y = `value`;</script>';
        const source = `Hello\n${script}\n<style>.a{color:red}</style>\n\`<script>example()</script>\`\n    <script>indented()</script>`;
        const protectedText = protectCardScriptBlocks(source);
        expect(protectedText.text).not.toContain(script);
        expect(protectedText.text).toContain('example()');
        expect(protectedText.text).toContain('indented()');
        expect(protectedText.restore(protectedText.text)).toBe(source);
        expect(protectCardScriptBlocks('<script>unfinished').text).toBe('<script>unfinished');
    });

    test('restores scripts containing replacement patterns byte for byte', () => {
        const source = 'Intro\n<script>const $$ = s => s; const a = "$&$`$\'$1";</script>\nOutro';
        const protectedText = protectCardScriptBlocks(source);
        expect(protectedText.restore(protectedText.text)).toBe(source);
    });

    test('messages without tags or fences skip protection entirely', () => {
        const protectedText = protectCardScriptBlocks('Just *prose* with `code` and <b>bold</b>.');
        expect(protectedText.text).toBe('Just *prose* with `code` and <b>bold</b>.');
        expect(protectedText.fencedPages).toEqual([]);
        expect(protectedText.restore('<p>x</p>')).toBe('<p>x</p>');
    });

    test.each(['<pre><script>example()</script></pre>', '<code><iframe></iframe></code>', '<!-- <script>example()</script> -->', '&lt;script&gt;example()&lt;/script&gt;', '<template><script>example()</script></template>'])('does not run inert examples: %s', html => {
        markCardScriptHtml(html, 1);
        expect(getCardScriptSnapshot(1)).toBeNull();
    });

    test('a script-free edit removes the old snapshot', () => {
        markCardScriptHtml('<script>run()</script>', 1);
        markCardScriptHtml('<p>Changed</p>', 1);
        expect(getCardScriptSnapshot(1)).toBeNull();
    });

    test('a direct script and a full-page fence both enter the whole-message sandbox, while ordinary code stays text', () => {
        const page = '<body><script>fenced()</script></body>';
        markCardScriptHtml('<script>direct()</script><pre data-card-script-fenced="0"><code>&lt;body&gt;&lt;script&gt;fenced()&lt;/script&gt;&lt;/body&gt;</code></pre><pre><code>example()</code></pre>', 1, { fencedPages: [page] });
        expect(getCardScriptSnapshot(1).blocks).toEqual([]);
        expect(getCardScriptSnapshot(1).html).toContain('<script>fenced()</script>');
        expect(getCardScriptSnapshot(1).html).toContain('<pre><code>example()</code></pre>');
    });

    test('an inline widget and the script that drives it form one block, and the prose stays outside', () => {
        const prose = '<p><font color="#d4a84f"><q>"All of it. I\'m not leaving the room."</q></font> Leonard nudges the wire bridge back.</p>';
        const widget = '<div style="padding:16px"><div style="font-size:26px">Dad</div><div id="dadcall">ringing</div></div>';
        const script = '<script>(function(){var e=document.getElementById(\'dadcall\');if(!e)return;e.textContent=\'ringing.\';})();</script>';
        const marked = markCardScriptHtml(`${prose}${widget}${script}<p><q>"It's your dining room."</q></p>`, 1);
        const { blocks } = getCardScriptSnapshot(1);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].html).toBe(`${widget}${script}`);
        expect(blocks[0].html).not.toContain('Leonard');
        expect(marked).toContain(`${prose}<div data-card-script-block="0">${widget}${script}</div>`);
    });

    test('a script nested inside its widget mounts that widget alone, and separate widgets get separate blocks', () => {
        const first = '<div class="phone"><span id="clock">10:54</span><script>document.getElementById(\'clock\').textContent=\'10:55\';</script></div>';
        const card = '<div><b>HARBOR FEDERAL</b></div>';
        const second = '<div><span class="dots">ringing</span></div><script>document.querySelector(\'.dots\').textContent=\'ringing..\';</script>';
        markCardScriptHtml(`<p>Before</p>${first}${card}<p>Between</p>${second}<p>After</p>`, 1);
        const { blocks } = getCardScriptSnapshot(1);
        expect(blocks.map(block => block.html)).toEqual([first, second]);
        expect(blocks.map(block => block.index)).toEqual([0, 1]);
    });

    test('a widget that Markdown split into several pieces stays together with its script', () => {
        const widget = '<p id="status">Static fallback</p>\n<p><button id="grow">Grow</button></p><div id="panel"></div><p></p>\n';
        const script = '<script>document.getElementById(\'status\').textContent=\'Ran\';document.getElementById(\'grow\').onclick=()=>{document.getElementById(\'panel\').style.height=\'9px\';};</script>';
        markCardScriptHtml(`<h3>Card scripts</h3>\n${widget}${script}`, 1);
        expect(getCardScriptSnapshot(1).blocks.map(block => block.html)).toEqual([`${widget}${script}`]);
    });

    test('a script that Markdown tucked into a paragraph still brings the earlier elements it names', () => {
        const widget = '<p id="status">Waiting</p>\n';
        const button = '<p><button id="go">Go</button><script>document.getElementById(\'go\').onclick=()=>{document.getElementById(\'status\').textContent=\'Gone\';};</script></p>';
        markCardScriptHtml(`<p>Prose</p>\n${widget}${button}`, 1);
        expect(getCardScriptSnapshot(1).blocks.map(block => block.html)).toEqual([`${widget}${button}`]);
    });

    test.each([
        ['a nested script that reaches for the page', '<p>Prose</p><div id="a">A<script>document.body.dataset.ran = "1";</script></div>'],
        ['a script whose elements are missing', '<p>Prose</p><script>document.getElementById(\'later\').remove();</script>'],
        ['an untargeted script', '<p>Prose</p><script>direct()</script>'],
        ['a script that rewrites the page', '<div id="a">A</div><script>document.body.innerHTML = document.getElementById(\'a\').outerHTML;</script>'],
        ['a computed selector', '<div id="a">A</div><script>document.getElementById(name).remove();</script>'],
    ])('%s keeps the whole-message sandbox', (_label, html) => {
        markCardScriptHtml(html, 1);
        expect(getCardScriptSnapshot(1).blocks).toEqual([]);
        expect(getCardScriptSnapshot(1).html).toBe(html);
    });

    test('full-page fences preserve literal entities and identical indented examples stay inert', () => {
        const page = '<body><p>&nbsp;</p><script>const text="&amp;";</script></body>';
        const protectedText = protectCardScriptBlocks(`\`\`\`html\n${page}\n\`\`\``);
        const formatted = '<pre><code>&lt;body&gt;indented example&lt;/body&gt;</code></pre>' + protectedText.restore(protectedText.text);
        markCardScriptHtml(formatted, 1, { fencedPages: protectedText.fencedPages });
        expect(getCardScriptSnapshot(1).blocks).toEqual([{ html: page, index: 1 }]);
        expect(protectedText.text).not.toContain('&amp;');
    });

    test('Windows line endings work, but an invalid or missing closing fence is not runnable', () => {
        const page = '<body>\r\n<script>run()</script>\r\n</body>';
        const protectedText = protectCardScriptBlocks(`\`\`\`html\r\n${page}\r\n\`\`\``);
        markCardScriptHtml(protectedText.restore(protectedText.text), 1, { fencedPages: protectedText.fencedPages });
        expect(getCardScriptSnapshot(1).blocks[0].html).toContain('run()');
        expect(protectCardScriptBlocks('```html\n<body><script>run()</script></body>\n```not-a-closing-fence').fencedPages).toEqual([]);
    });

    test('dedupes the same message id and content', () => {
        const html = '<script>console.log("same")</script>';
        const firstSnapshot = rememberCardScript(11, html);
        const secondSnapshot = rememberCardScript(11, html);

        expect(secondSnapshot).toBe(firstSnapshot);
        expect(getStoredCardScriptCount()).toBe(1);
    });

    test('evicts the oldest snapshots beyond the LRU limit', () => {
        for (let index = 0; index <= MAX_STASHED_CARD_SCRIPTS; index++) {
            markCardScriptHtml(`<script>${index}</script>`, index);
        }

        expect(getStoredCardScriptCount()).toBe(MAX_STASHED_CARD_SCRIPTS);
        expect(getCardScriptSnapshot(0)).toBeNull();
        expect(getCardScriptSnapshot(1)).toMatchObject({ html: '<script>1</script>' });
    });

    test('refreshes a reused message id so recent snapshots are retained', () => {
        const html = '<script>still-recent</script>';
        markCardScriptHtml(html, 0);

        for (let index = 1; index < MAX_STASHED_CARD_SCRIPTS; index++) {
            markCardScriptHtml(`<script>${index}</script>`, index);
        }

        rememberCardScript(0, html);
        markCardScriptHtml('<script>new-oldest</script>', MAX_STASHED_CARD_SCRIPTS);

        expect(getStoredCardScriptCount()).toBe(MAX_STASHED_CARD_SCRIPTS);
        expect(getCardScriptSnapshot(0)).toMatchObject({ html });
        expect(getCardScriptSnapshot(1)).toBeNull();
    });

    test('clears stored snapshots and toast keys', () => {
        const html = '<script>alert(1)</script>';
        const snapshot = rememberCardScript(12, html);
        const toastKey = buildCardScriptToastKey('chat-a', 12, snapshot.hash);
        markCardScriptToastShown(toastKey);

        forgetAllCardScripts();

        expect(getStoredCardScriptCount()).toBe(0);
        expect(getShownCardScriptToastCount()).toBe(0);
        expect(getCardScriptSnapshot(12)).toBeNull();
        expect(hasCardScriptToastBeenShown(toastKey)).toBe(false);
    });

    test('includes chat id, message id, and hash in toast keys so cross-chat messages re-toast', () => {
        const hash = hashCardScriptHtml('<script>alert(1)</script>');
        const firstChatKey = buildCardScriptToastKey('chat-a', 13, hash);
        const secondChatKey = buildCardScriptToastKey('chat-b', 13, hash);

        markCardScriptToastShown(firstChatKey);

        expect(firstChatKey).toBe(`chat-a:13:${hash}`);
        expect(secondChatKey).toBe(`chat-b:13:${hash}`);
        expect(hasCardScriptToastBeenShown(firstChatKey)).toBe(true);
        expect(hasCardScriptToastBeenShown(secondChatKey)).toBe(false);
    });
});
