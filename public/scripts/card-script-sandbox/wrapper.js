import { MESSAGE_TYPE, MESSAGE_VERSION, RESIZE_MESSAGE_TYPE, READY_MESSAGE_TYPE } from './messages.js';
import { t } from '../i18n.js';
import { CARD_SCRIPT_SANDBOX_CSP } from './policy.js';
export { CARD_SCRIPT_SANDBOX_CSP, CARD_SCRIPT_PERMISSIONS } from './policy.js';

const policyHead = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CARD_SCRIPT_SANDBOX_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">`;

export function prepareSandboxHtml(html) {
    let source = String(html ?? '');
    const template = document.createElement('template');
    template.innerHTML = source;
    for (let depth = 0; depth < 3; depth++) {
        const sole = template.content.children.length === 1 ? template.content.firstElementChild : null;
        if (sole?.tagName !== 'IFRAME' || !sole.hasAttribute('srcdoc') || template.content.textContent.trim()) break;
        source = sole.getAttribute('srcdoc');
        template.innerHTML = source;
    }
    stripResourceHints(template.content);
    template.content.querySelectorAll('iframe').forEach(element => {
        const fallback = document.createElement('p');
        fallback.textContent = t`Embedded frames are unavailable in card scripts.`;
        element.replaceWith(fallback);
    });
    const body = document.createElement('template');
    const bodyTag = source.match(/<body\b([^>]*)>/i);
    body.innerHTML = bodyTag ? `<div${bodyTag[1]}></div>` : '<div></div>';
    return { html: template.innerHTML, attributes: body.content.firstElementChild.attributes };
}

function stripResourceHints(root) {
    root.querySelectorAll('base, meta[http-equiv], link, object, embed').forEach(element => element.remove());
    root.querySelectorAll('template').forEach(element => stripResourceHints(element.content));
}

export function sanitiseSandboxTheme(theme = {}) {
    const properties = { color: 'color', backgroundColor: 'background-color', fontFamily: 'font-family', fontSize: 'font-size', lineHeight: 'line-height', linkColor: 'color', colorScheme: 'color-scheme' };
    const safe = {};
    for (const [key, property] of Object.entries(properties)) {
        const value = theme[key];
        if (typeof value !== 'string' || value.length > 256 || /[<>;{}\\\x00-\x1f]/.test(value) || /url\s*\(|var\s*\(/i.test(value)) continue;
        if (!globalThis.CSS?.supports?.(property, value)) continue;
        if (['fontSize', 'lineHeight'].includes(key) && (!/^\d+(?:\.\d+)?px$/.test(value) || parseFloat(value) < 8 || parseFloat(value) > 96)) continue;
        if (key === 'colorScheme' && !['light', 'dark', 'normal', 'light dark', 'dark light'].includes(value)) continue;
        safe[key] = value;
    }
    return safe;
}

export function buildCardDocument({ html = '', messageId, nonce, theme = {} } = {}) {
    const doc = prepareSandboxHtml(html);
    const config = { type: MESSAGE_TYPE, resizeType: RESIZE_MESSAGE_TYPE, readyType: READY_MESSAGE_TYPE, version: MESSAGE_VERSION, messageId, nonce, theme: sanitiseSandboxTheme(theme) };
    const bootstrap = `<script>(${cardBootstrap.toString()})(${escapeScriptJson(config)});</script>`;
    const bodyAttributes = Array.from(doc.attributes).map(attr => ` ${attr.name}="${escapeAttribute(attr.value)}"`).join('');
    return `<!doctype html><html><head>${policyHead}<style>html,body{margin:0;padding:0;min-width:0}body{font:16px/1.5 system-ui;background:transparent;overflow-wrap:anywhere}*,*::before,*::after{box-sizing:border-box}#neconyan-card-content{display:flow-root;padding:12px;min-width:0}q{quotes:none}q::before,q::after{content:''}img,video,canvas{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}button{min-height:44px;cursor:pointer}a{color:var(--card-link,inherit)}button:focus-visible,a:focus-visible{outline:2px solid currentColor;outline-offset:2px}</style>${bootstrap}</head><body${bodyAttributes}><div id="neconyan-card-content">${doc.html}</div></body></html>`;
}

function cardBootstrap(config) {
    const send = (type, values = {}) => window.parent.postMessage({ type, version: config.version, messageId: config.messageId, nonce: config.nonce, ...values }, '*');
    window.triggerSlash = input => send(config.type, { command: String(input ?? '') });
    let queued = false;
    let previous = -1;
    let lastSent = 0;
    const measure = () => {
        queued = false;
        const root = document.getElementById('neconyan-card-content') || document.body;
        if (!root) return;
        const bounds = root.getBoundingClientRect();
        let extent = Math.max(bounds.height, document.body.getBoundingClientRect().height);
        for (const node of root.children) extent = Math.max(extent, node.getBoundingClientRect().bottom - bounds.top);
        const height = Math.ceil(extent);
        if (height !== previous) {
            previous = height;
            lastSent = Date.now();
            send(config.resizeType, { height });
        }
    };
    const schedule = () => {
        if (queued) return;
        queued = true;
        setTimeout(() => requestAnimationFrame(measure), Math.max(0, 100 - (Date.now() - lastSent)));
    };
    document.addEventListener('DOMContentLoaded', () => {
        for (const key of ['color', 'backgroundColor', 'fontSize', 'lineHeight', 'colorScheme']) {
            if (config.theme[key]) document.body.style[key] = config.theme[key];
        }
        if (config.theme.fontFamily) document.body.style.fontFamily = `${config.theme.fontFamily}, system-ui, sans-serif`;
        if (config.theme.linkColor) document.body.style.setProperty('--card-link', config.theme.linkColor);
        new ResizeObserver(schedule).observe(document.body);
        new ResizeObserver(schedule).observe(document.getElementById('neconyan-card-content') || document.body);
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        document.addEventListener('load', schedule, true);
        document.fonts?.ready.then(schedule);
        send(config.readyType);
        schedule();
    });
    window.addEventListener('load', schedule);
}

function escapeScriptJson(value) {
    return JSON.stringify(value).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
