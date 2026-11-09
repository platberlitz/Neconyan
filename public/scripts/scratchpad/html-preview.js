import { DOMPurify } from '../../lib.js';
import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_TYPE } from '../popup.js';

const SAMPLE = '<div class="mes_text"><article class="card"><h2>Sample heading</h2><p>Sample text for this CSS. No HTML block was included.</p><a>Sample link</a><button type="button">Sample button</button></article></div>';

function previewDocument({ html, css }) {
    // No messageFormatting/substituteParams: macros stay literal and private context stays private.
    const clean = DOMPurify.sanitize(html || SAMPLE, {
        WHOLE_DOCUMENT: true,
        ADD_TAGS: ['style'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
        FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'srcdoc', 'target'],
    });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = 'default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'';
    doc.head.prepend(policy);
    const theme = getComputedStyle(document.body);
    for (const name of theme) {
        if (name.startsWith('--neco-') || name.startsWith('--SmartTheme') || ['--mainFontSize', '--mainFontFamily'].includes(name)) {
            doc.documentElement.style.setProperty(name, theme.getPropertyValue(name));
        }
    }
    const style = doc.createElement('style');
    style.textContent = `body { margin: 0; padding: 16px; font-family: sans-serif; overflow-wrap: anywhere; color: var(--neco-ink, #222); background: var(--neco-surface, #fff); } img, video, svg { max-width: 100%; height: auto; }\n${css}`.replace(/<\/style/gi, '<\\/style');
    doc.head.append(style);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export function showHtmlPreview(source) {
    const frame = h('iframe', {
        class: 'scratchpad-html-preview-frame', title: t`HTML and CSS preview`, sandbox: '', referrerpolicy: 'no-referrer',
    });
    frame.srcdoc = previewDocument(source);
    const content = h('div', { class: 'scratchpad-html-preview' },
        h('h3', { text: t`HTML and CSS preview` }),
        h('p', { class: 'scratchpad-muted', text: t`Static preview only. Scripts, external resources and links are blocked. Macros stay as written. Nothing is saved.` }),
        !source.html ? h('p', { class: 'scratchpad-muted', text: t`No HTML block was included, so this CSS is shown on sample content.` }) : null,
        frame);
    return callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: t`Close preview` });
}
