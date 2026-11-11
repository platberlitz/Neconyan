import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { exportReply, replySwipes } from './swipes.js';

/** Import requests are capped at 4 MB; anything above this is retried without its attachments. */
export const MAX_IMPORT_BYTES = 3_500_000;

export function exportFileName(name, extension) {
    return `${String(name ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'scratchpad'}.${extension}`;
}

/** The importable file. Extras are opt-in, so the default stays conversation text only. */
export function buildSessionExport(session, assistants, options = {}) {
    const used = new Set([session.assistant, ...session.settings.participants, ...session.messages.map(item => item.assistant)]);
    return {
        format: 'neconyan-scratchpad',
        version: 1,
        exported: new Date().toISOString(),
        session: {
            name: session.name,
            assistant: session.assistant,
            gender: session.gender,
            settings: { ...session.settings, assistants: Object.fromEntries(assistants.filter(item => item.personality && used.has(item.id)).map(item => [item.id, item])), notes: [], picked: [], pickedSource: undefined },
            messages: session.messages.filter(item => item.state !== 'pending').map(item => exportReply(item, options)),
        },
    };
}

function fenced(text, language = '') {
    const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${language}\n${text}\n${fence}`;
}

function linkText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&').trim();
}

/** A transcript for reading. It cannot be imported again, and shows the chosen version of each reply. */
export function sessionMarkdown(session, { reasoning = false, sources = false, attachments = false, nameOf = message => message.assistantName || '' } = {}) {
    const parts = [`# ${linkText(session.name) || 'Scratchpad'}`];
    for (const message of session.messages) {
        if (message.state === 'pending') continue;
        const user = message.role === 'user';
        const versions = user ? 1 : replySwipes(message).length;
        const heading = user ? t`You` : linkText(nameOf(message)) || t`Assistant`;
        const position = Number(message.swipeIndex) + 1;
        parts.push(versions > 1 ? `## ${heading} (${t`version ${position} of ${versions}`})` : `## ${heading}`);
        if (reasoning && !user && message.reasoning) parts.push(`<details>\n<summary>${t`Thinking`}</summary>\n\n${message.reasoning}\n\n</details>`);
        if (message.text) parts.push(message.text);
        for (const attachment of user && Array.isArray(message.attachments) ? message.attachments : []) {
            const name = linkText(attachment.name) || t`Attachment`;
            if (!attachments) parts.push(`*${t`Attached: ${name}`}*`);
            else if (attachment.kind === 'image' && attachment.dataUrl) parts.push(`![${name}](${attachment.dataUrl})`);
            else parts.push(`**${name}**\n\n${fenced(attachment.text ?? '')}`);
        }
        const found = sources && !user && Array.isArray(message.webSearch?.sources) ? message.webSearch.sources : [];
        if (found.length) {
            parts.push([`**${t`Sources`}**${message.webSearch.query ? ` (${t`Search query: ${linkText(message.webSearch.query)}`})` : ''}`, '',
                ...found.map((source, index) => `${index + 1}. [${linkText(source.title) || linkText(source.url)}](<${String(source.url).replace(/[<>\s]/g, '')}>)`)].join('\n'));
        }
    }
    return `${parts.join('\n\n')}\n`;
}

/** Drops attachments from an export that is too large to send back in one request. */
export function withoutAttachments(session) {
    return { ...session, messages: (Array.isArray(session?.messages) ? session.messages : []).map(message => {
        if (!message || typeof message !== 'object') return message;
        const rest = { ...message };
        delete rest.attachments;
        return rest;
    }) };
}

function choice(type, name, label, hint, checked, onChange) {
    return h('label', { class: 'scratchpad-check' },
        h('input', { type, name, checked, onchange: event => onChange(event.currentTarget.checked) }),
        h('span', { text: label }), h('small', { text: hint }));
}

/** Resolves with `{ format, reasoning, sources, attachments }`, or null when the user cancels. */
export async function chooseSessionExport() {
    const options = { format: 'json', reasoning: false, sources: false, attachments: false };
    const content = h('div', { class: 'scratchpad-review scratchpad-section scratchpad-export' },
        h('h3', { text: t`Export this session` }),
        h('fieldset', { class: 'scratchpad-export-group' },
            h('legend', { text: t`File type` }),
            choice('radio', 'scratchpad-export-format', t`Scratchpad file`, t`Can be imported again, with every version of each reply.`, true, () => { options.format = 'json'; }),
            choice('radio', 'scratchpad-export-format', t`Markdown`, t`A transcript for reading or sharing. It cannot be imported again.`, false, () => { options.format = 'markdown'; })),
        h('fieldset', { class: 'scratchpad-export-group' },
            h('legend', { text: t`Also include` }),
            choice('checkbox', 'scratchpad-export-reasoning', t`Thinking`, t`The assistants' thinking, where a reply saved it.`, false, value => { options.reasoning = value; }),
            choice('checkbox', 'scratchpad-export-sources', t`Web search sources`, t`The query and the numbered links under each reply.`, false, value => { options.sources = value; }),
            choice('checkbox', 'scratchpad-export-attachments', t`Attached files and images`, t`Makes the file much larger. A file too large to import again is imported without them.`, false, value => { options.attachments = value; })),
        h('p', { class: 'scratchpad-review-hint', text: t`With nothing ticked, the file holds the conversation text only. Message picks, saved-note sharing and generated pictures are never included.` }));
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { okButton: t`Export`, cancelButton: t`Cancel` });
    return result === POPUP_RESULT.AFFIRMATIVE ? options : null;
}
