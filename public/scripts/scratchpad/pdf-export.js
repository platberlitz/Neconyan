import { DOMPurify, showdown } from '../../lib.js';
import { t } from '../i18n.js';
import { replySwipes } from './swipes.js';

const converter = new showdown.Converter({ tables: true, strikethrough: true, simpleLineBreaks: true });
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[character]);
const tags = ['p', 'br', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

function prose(text) {
    const fragment = DOMPurify.sanitize(converter.makeHtml(String(text ?? '')), {
        ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'], RETURN_DOM_FRAGMENT: true,
    });
    for (const link of fragment.querySelectorAll('a')) {
        if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
        link.setAttribute('rel', 'noreferrer noopener');
        link.setAttribute('target', '_blank');
    }
    const wrapper = document.createElement('div');
    wrapper.append(fragment);
    return wrapper.innerHTML;
}

/** Only the chosen replies and requested extras enter the separate printable document. */
export function sessionPrintHtml(session, { reasoning = false, sources = false, attachments = false, nameOf = message => message.assistantName || '' } = {}) {
    const parts = [`<h1>${escape(session.name || 'Scratchpad')}</h1>`];
    if (session.pinnedNote?.trim()) parts.push(`<section><h2>${escape(t`Pinned note`)}</h2>${prose(session.pinnedNote)}</section>`);
    for (const message of session.messages) {
        if (message.state === 'pending') continue;
        const user = message.role === 'user';
        const versions = user ? 1 : replySwipes(message).length;
        const name = user ? t`You` : nameOf(message) || t`Assistant`;
        const version = versions > 1 ? ` (${t`version ${Number(message.swipeIndex) + 1} of ${versions}`})` : '';
        parts.push(`<section><h2>${escape(name + version)}</h2>`);
        if (message.rehearsal) parts.push(`<p><em>${escape(t`Rehearsal: a draft, not an event in the story.`)}</em></p>`);
        if (reasoning && !user && message.reasoning) parts.push(`<h3>${escape(t`Thinking`)}</h3>${prose(message.reasoning)}`);
        parts.push(prose(message.text));
        for (const attachment of user && Array.isArray(message.attachments) ? message.attachments : []) {
            const name = attachment.name || t`Attachment`;
            parts.push(`<p><strong>${escape(t`Attached: ${name}`)}</strong></p>`);
            if (!attachments) continue;
            if (attachment.kind === 'image') {
                if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(attachment.dataUrl || '')) {
                    parts.push(`<img src="${escape(attachment.dataUrl)}" alt="${escape(name)}">`);
                }
            } else parts.push(`<pre>${escape(attachment.text)}</pre>`);
        }
        const found = sources && !user && Array.isArray(message.webSearch?.sources) ? message.webSearch.sources : [];
        if (found.length) {
            parts.push(`<h3>${escape(t`Sources`)}</h3>`);
            const queries = Array.isArray(message.webSearch.queries) ? message.webSearch.queries.filter(item => typeof item === 'string' && item) : [];
            if (queries.length > 1) parts.push(`<p>${escape(t`Search queries: ${queries.join('; ')}`)}</p>`);
            else if (queries[0] || message.webSearch.query) parts.push(`<p>${escape(t`Search query: ${queries[0] || message.webSearch.query}`)}</p>`);
            parts.push('<ol>');
            for (const source of found) {
                const url = String(source.url ?? '');
                parts.push(`<li>${escape(source.title || url)}${/^https?:\/\//i.test(url) ? `<br><a href="${escape(url)}" rel="noreferrer noopener" target="_blank">${escape(url)}</a>` : ''}</li>`);
            }
            parts.push('</ol>');
        }
        parts.push('</section>');
    }
    return parts.join('\n');
}

/** Called directly from the export confirmation click, before popup animations can lose browser activation. */
export function openSessionPrint(session, options) {
    const html = sessionPrintHtml(session, options);
    const view = window.open('', '_blank');
    if (!view) throw new Error(t`The print view was blocked. Allow pop-ups for this site and try again.`);
    view.opener = null;
    const colours = getComputedStyle(document.body);
    const css = `
        :root{color-scheme:light}*{box-sizing:border-box}
        body{margin:0;color:#202020;background:#fff;font:11pt/1.5 system-ui,sans-serif}
        main{max-width:190mm;margin:auto;padding:12mm 5mm;overflow-wrap:anywhere}
        h1{font-size:22pt}h2{font-size:15pt;margin:1.5em 0 .5em}h3{font-size:12pt}
        h1,h2,h3{break-after:avoid}p{orphans:3;widows:3}section{border-bottom:1px solid #ddd;padding-bottom:1em}
        pre,code{font-family:monospace}pre{white-space:pre-wrap;padding:8px;background:#f3f3f3}
        img{max-width:100%;max-height:230mm;object-fit:contain;break-inside:avoid}
        table{border-collapse:collapse;table-layout:fixed;width:100%}th,td{border:1px solid #aaa;padding:5px;overflow-wrap:anywhere}
        blockquote{margin-left:0;padding-left:1em;border-left:2px solid #aaa}a{color:inherit}
        header{padding:12px;background:#f5f5f5;color:#202020;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
        header p{margin:0;flex:1 1 240px}
        button{font:inherit;border:1px solid var(--neco-ginger);border-radius:8px;min-height:44px;padding:8px 14px;background:var(--neco-ginger);color:var(--neco-on-accent);cursor:pointer}
        button:hover{background:var(--neco-ginger-hover)}button:focus-visible{outline:2px solid var(--neco-ginger);outline-offset:3px}
        button:disabled{opacity:.6;cursor:wait}
        @page{size:auto;margin:16mm}@media print{header{display:none}main{max-width:none;margin:0;padding:0}body{font-size:11pt}}
    `;
    view.document.open();
    view.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(session.name || 'Scratchpad')}</title><style>${css}</style></head><body><header><button type="button" disabled>${escape(t`Print / save PDF`)}</button><p>${escape(t`Choose Save as PDF in your browser's print options. On iPhone, open the print preview and use Share to save it. This view can be closed afterwards.`)}</p></header><main>${html}</main></body></html>`);
    view.document.close();
    view.document.documentElement.lang = document.documentElement.lang || 'en';
    for (const key of ['--neco-ginger', '--neco-ginger-hover', '--neco-on-accent']) view.document.documentElement.style.setProperty(key, colours.getPropertyValue(key));
    const button = view.document.querySelector('button');
    button.addEventListener('click', () => { view.focus(); view.print(); });
    // Decode included images before enabling Print, so the first PDF cannot silently omit them.
    Promise.all([...view.document.images].map(image => image.decode().catch(() => {}))).then(() => { button.disabled = false; });
    return view;
}
