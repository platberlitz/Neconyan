import { sendPrompt } from './ab.js';
import { applyCase, restoreState, snapshotState } from './apply-state.js';
import { captureOnce } from './capture.js';
import { CAVEAT, CAVEAT_TEXT } from './constants.js';
import { ctxOf, getContext } from './host.js';

/**
 * Plays one scene under several presets and puts the replies side by side.
 *
 * Each preset gets its own column. Within a column the scene is built turn by
 * turn: the prompt is rebuilt the way Neconyan would, with everything said so
 * far already in the chat, then sent. The reply becomes part of the scene and
 * the next turn starts from there.
 *
 * This spends tokens, so nothing here runs until the user presses the button.
 * Nothing is written to any chat: the turns live in the in-memory chat for the
 * length of one dry-run build and are taken out again.
 */

export const SCENE_MODE = Object.freeze({
    SCRIPTED: 'scripted',
    CONTINUE: 'continue',
});

/** What drives a turn when the user only wrote the opening. */
export const CONTINUE_NUDGE = 'Continue the scene.';

export const MAX_TURNS = 4;
export const MAX_PRESETS = 4;

/** Said on a column whose character had a saved chat behind the scene. */
export const CAVEAT_EXISTING_CHAT = CAVEAT.EXISTING_CHAT;

function clampCount(value, max) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) {
        return 1;
    }
    return Math.min(Math.max(number, 1), max);
}

/**
 * The user turns a scene will send, in order.
 *
 * Scripted mode sends what the user wrote, so every preset faces the same
 * words. Continue mode sends the opening and then a fixed nudge, so the scene
 * carries on by itself; from the second turn onwards the columns are answering
 * their own replies rather than the same input.
 */
function sceneTurnEntries({ mode = SCENE_MODE.SCRIPTED, turns = [], exchanges = 2 } = {}) {
    const written = (turns ?? [])
        .map((text, index) => ({ index: index + 1, text: String(text ?? '') }))
        .filter(turn => turn.text.trim())
        .slice(0, MAX_TURNS);
    if (mode !== SCENE_MODE.CONTINUE) {
        return written;
    }
    if (!written.length) {
        return [];
    }
    const count = clampCount(exchanges, MAX_TURNS);
    return Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        text: index ? CONTINUE_NUDGE : written[0].text,
    }));
}

export function sceneTurns(options = {}) {
    return sceneTurnEntries(options).map(turn => turn.text);
}

/**
 * What a comparison will cost, worked out before it starts so the number can be
 * shown next to the button rather than discovered afterwards.
 */
export function estimateScene({
    presets = [],
    mode = SCENE_MODE.SCRIPTED,
    turns = [],
    exchanges = 2,
    maxTokens = 300,
} = {}) {
    const script = sceneTurns({ mode, turns, exchanges });
    const presetCount = (presets ?? []).length;
    const requests = script.length * presetCount;
    return {
        turns: script.length,
        presets: presetCount,
        requests,
        replyTokenCeiling: requests * Math.max(0, Math.floor(Number(maxTokens)) || 0),
    };
}

/** How long a reply took, in the units a reader thinks in. */
export function describeDuration(ms) {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    if (seconds < 10) {
        return `${seconds.toFixed(1)} seconds`;
    }
    if (seconds < 60) {
        return `${Math.round(seconds)} seconds`;
    }
    const rounded = Math.round(seconds);
    const minutes = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
}

/** Says in plain language what pressing the button will do. */
export function describeEstimate(estimate) {
    if (!estimate?.requests) {
        return 'Choose at least two presets and write the first message.';
    }
    return `${estimate.requests} request${estimate.requests === 1 ? '' : 's'}: `
        + `${estimate.turns} turn${estimate.turns === 1 ? '' : 's'} for each of ${estimate.presets} presets, `
        + `up to about ${estimate.replyTokenCeiling.toLocaleString()} reply tokens in total, plus the prompt each time.`;
}

const HTML_ESCAPES = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
});

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

/**
 * Replies often carry markup of their own. A saved page keeps benign text
 * formatting, but opening a model-written file must never run a script.
 *
 * In a browser, a native parser copies only inert formatting elements into a
 * new tree. Without a DOM, markup is shown as escaped plain text instead.
 */
const SAFE_REPLY_TAGS = new Set([
    'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'small', 'sub', 'sup', 'mark',
    'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'p', 'br', 'span', 'div',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot',
    'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
]);
const DROP_REPLY_CONTENT = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'canvas',
]);

export function sanitizeReplyHtml(value) {
    const source = String(value ?? '');
    if (typeof globalThis.DOMParser !== 'function'
        || typeof globalThis.document?.createElement !== 'function') {
        return escapeHtml(source);
    }
    try {
        const parsed = new globalThis.DOMParser().parseFromString(source, 'text/html');
        const output = globalThis.document.createElement('div');
        const copy = (node, parent) => {
            if (node.nodeType === 3) {
                parent.append(globalThis.document.createTextNode(node.nodeValue ?? ''));
                return;
            }
            if (node.nodeType !== 1) {
                return;
            }
            const tag = node.tagName.toLowerCase();
            if (DROP_REPLY_CONTENT.has(tag)) {
                return;
            }
            if (!SAFE_REPLY_TAGS.has(tag)) {
                for (const child of node.childNodes) {
                    copy(child, parent);
                }
                return;
            }
            const clean = globalThis.document.createElement(tag);
            for (const child of node.childNodes) {
                copy(child, clean);
            }
            parent.append(clean);
        };
        for (const child of parsed.body.childNodes) {
            copy(child, output);
        }
        return output.innerHTML;
    } catch {
        return escapeHtml(source);
    }
}

/** Elements whose text is not prose, and whose lines must be left alone. */
const RAW_TEXT_TAG = /^<\s*(\/)?\s*(style|pre|textarea)\b/i;

/**
 * A reply is prose with some markup in it, and HTML throws prose line breaks
 * away. Turn the breaks inside text into `<br>`, and leave the whitespace
 * between tags alone: markup arrives indented across lines, and every one of
 * those would otherwise open a gap the model never wrote.
 */
export function breakReplyLines(value) {
    const parts = String(value ?? '').split(/(<[^>]*>)/);
    let raw = false;
    return parts.map((chunk, index) => {
        if (index % 2 === 1) {
            const match = chunk.match(RAW_TEXT_TAG);
            if (match) {
                raw = !match[1];
            }
            return chunk;
        }
        if (raw || !chunk.trim()) {
            return chunk;
        }
        // Only the breaks after the text starts are the model's own. A chunk
        // opening with a newline is markup that was laid out across lines, and
        // breaking there would push every card down a line it never asked for.
        const lead = chunk.match(/^\s*/)[0];
        return lead + chunk.slice(lead.length).replace(/\r?\n/g, '<br>\n');
    }).join('');
}

/** The saved page's own styling, kept small enough to read. */
const SCENE_PAGE_STYLE = `
    :root { color-scheme: light dark; }
    body { margin: 0 auto; padding: 2rem 1.25rem; max-width: 78rem; font-family: system-ui, sans-serif; line-height: 1.5; }
    h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    .facts { margin: 0 0 0.5rem; opacity: 0.75; font-size: 0.9rem; }
    .note { margin: 0 0 2rem; padding: 0.6rem 0.8rem; border-left: 3px solid currentColor; opacity: 0.7; font-size: 0.85rem; }
    .columns { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); align-items: start; }
    .column { padding: 1rem; border: 1px solid rgba(128, 128, 128, 0.4); border-radius: 0.5rem; min-width: 0; }
    .column > h2 { margin: 0 0 0.75rem; font-size: 1.1rem; }
    .meta { margin: 1rem 0 0.25rem; font-family: ui-monospace, monospace; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.6; }
    /* What was typed is plain text, so its own line breaks have to survive. */
    .said { margin: 0 0 0.5rem; padding-left: 0.6rem; border-left: 2px solid rgba(128, 128, 128, 0.5); font-style: italic; opacity: 0.85; white-space: pre-wrap; }
    .reply { overflow-wrap: break-word; }
    .reply table { max-width: 100%; }
    .opening { margin: 0 0 1.5rem; padding: 0 0 0 0.8rem; border-left: 3px solid rgba(128, 128, 128, 0.5); }
    .failed { color: #c0392b; }
`;

function sceneCompletion(result) {
    const columns = result?.columns ?? [];
    const counted = columns.reduce(
        (total, column) => total + (column.turns ?? []).filter(turn => !turn.waiting).length,
        0,
    );
    const completed = result?.completedRequests === undefined
        ? counted
        : Math.max(0, Math.floor(Number(result.completedRequests) || 0));
    const expected = result?.expectedRequests === undefined
        ? (Array.isArray(result?.script) ? result.script.length * columns.length : completed)
        : Math.max(0, Math.floor(Number(result.expectedRequests) || 0));
    const aborted = Boolean(result?.aborted);
    const incomplete = aborted || Boolean(result?.incomplete) || completed < expected;
    return {
        completed,
        expected,
        status: aborted ? 'Aborted (incomplete)' : (incomplete ? 'Incomplete' : 'Complete'),
    };
}

function sceneCaveats(result) {
    return [...new Set([
        ...(result?.caveats ?? []),
        ...(result?.columns ?? []).flatMap(column => column.caveats ?? []),
    ].filter(Boolean))].map(code => CAVEAT_TEXT[code] ?? String(code));
}

/**
 * A standalone page: every column side by side, each reply rendered as the
 * model wrote it. No file it does not carry itself, and nothing it may fetch.
 */
function sceneHtmlPage(result, { characterName, connectionName, modelName, savedAt }) {
    const completion = sceneCompletion(result);
    const facts = [
        `Status: ${completion.status}`,
        `Requests: ${completion.completed} of ${completion.expected} completed`,
        characterName ? `Character: ${characterName}` : '',
        connectionName ? `Connection: ${connectionName}` : '',
        modelName ? `Model: ${modelName}` : '',
        savedAt ? `Saved: ${savedAt}` : '',
    ].filter(Boolean).join(' · ');

    const opening = result?.opening
        ? `<section class="opening"><p class="meta">The scene opened with</p>`
            + `<div class="reply">${breakReplyLines(sanitizeReplyHtml(result.opening))}</div></section>`
        : '';
    const caveats = sceneCaveats(result);
    const caveatBlock = caveats.length
        ? `<section class="note"><strong>What these replies cannot show</strong><ul>${caveats
            .map(caveat => `<li>${escapeHtml(caveat)}</li>`).join('')}</ul></section>`
        : '';

    const columns = (result?.columns ?? []).map((column) => {
        const parts = [`<h2>${escapeHtml(column.label)}</h2>`];
        if (column.error) {
            parts.push(`<p class="failed">${escapeHtml(column.error)}</p>`);
        }
        for (const turn of column.turns ?? []) {
            const timing = `${describeDuration(turn.durationMs)} · prompt ${Number(turn.promptTokens ?? 0).toLocaleString()} tokens`;
            parts.push(`<p class="meta">Turn ${escapeHtml(turn.index)} · ${escapeHtml(timing)}</p>`);
            parts.push(`<p class="said">${escapeHtml(turn.userText)}</p>`);
            if (String(turn.text ?? '').trim()) {
                parts.push(`<div class="reply">${breakReplyLines(sanitizeReplyHtml(turn.text))}</div>`);
            }
            if (turn.error) {
                parts.push(`<p class="failed">${escapeHtml(turn.error)}</p>`);
            }
        }
        return `<section class="column">\n${parts.join('\n')}\n</section>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">
<title>Scene comparison${characterName ? `: ${escapeHtml(characterName)}` : ''}</title>
<style>${SCENE_PAGE_STYLE}</style>
</head>
<body>
<h1>Scene comparison</h1>
${facts ? `<p class="facts">${escapeHtml(facts)}</p>` : ''}
<p class="note">Replies keep safe text formatting. Scripts, forms, links, styles, and anything this
page would have to fetch are removed, so a reply cannot do anything when this file is opened.</p>
${caveatBlock}
${opening}
<div class="columns">
${columns}
</div>
</body>
</html>
`;
}

/**
 * Writes a finished comparison out as something a person can keep, read
 * elsewhere, or send to someone else. Markdown keeps the headings, plain text
 * uses rules instead, and a web page renders the markup a reply carried.
 */
export function formatScene(result, {
    format = 'md',
    characterName = '',
    connectionName = '',
    modelName = '',
    savedAt = '',
} = {}) {
    if (format === 'html') {
        return sceneHtmlPage(result, { characterName, connectionName, modelName, savedAt });
    }
    const markdown = format !== 'txt';
    const completion = sceneCompletion(result);
    const caveats = sceneCaveats(result);
    const lines = [];
    const heading = (level, text) => lines.push(markdown ? `${'#'.repeat(level)} ${text}` : text.toUpperCase());
    const rule = () => lines.push(markdown ? '' : '-'.repeat(60));

    heading(1, 'Scene comparison');
    lines.push('');
    for (const [label, value] of [
        ['Status', completion.status],
        ['Requests', `${completion.completed} of ${completion.expected} completed`],
        ['Character', characterName],
        ['Connection', connectionName],
        // The connection says where the replies came from; the model says who
        // wrote them, and a profile can be pointed somewhere else later.
        ['Model', modelName],
        ['Saved', savedAt],
    ]) {
        if (value) {
            lines.push(markdown ? `- **${label}:** ${value}` : `${label}: ${value}`);
        }
    }
    lines.push('');

    if (caveats.length) {
        heading(2, 'What these replies cannot show');
        lines.push('');
        for (const caveat of caveats) {
            lines.push(`- ${caveat}`);
        }
        lines.push('');
    }

    if (result?.opening) {
        heading(2, 'The scene opened with');
        lines.push('', result.opening, '');
    }

    for (const column of result?.columns ?? []) {
        rule();
        heading(2, column.label);
        lines.push('');
        if (column.error) {
            lines.push(markdown ? `> ${column.error}` : `! ${column.error}`, '');
        }
        for (const turn of column.turns ?? []) {
            heading(3, `Turn ${turn.index}`);
            lines.push('');
            lines.push(markdown ? `**You:** ${turn.userText}` : `You: ${turn.userText}`);
            lines.push('');
            const text = String(turn.text ?? '');
            const body = turn.error && !text.trim() ? `(${turn.error})` : text;
            lines.push(markdown ? `**${column.label}:** ${body}` : `${column.label}: ${body}`);
            lines.push('');
            if (turn.error && text.trim()) {
                lines.push(markdown ? `> Error: ${turn.error}` : `! Error: ${turn.error}`, '');
            }
            const facts = `${describeDuration(turn.durationMs)}, prompt ${turn.promptTokens.toLocaleString()} tokens`;
            lines.push(markdown ? `*${facts}*` : `(${facts})`);
            lines.push('');
        }
    }

    return `${lines.join('\n').trimEnd()}\n`;
}

/** A file name that says what the file holds and stays safe on every system. */
export function sceneFileName({ characterName = '', format = 'md', savedAt = '' } = {}) {
    const safe = String(characterName || 'scene')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'scene';
    const stamp = String(savedAt).slice(0, 10);
    const extension = { txt: 'txt', html: 'html' }[format] ?? 'md';
    return `prompting-lab-scene-${safe}${stamp ? `-${stamp}` : ''}.${extension}`;
}

/**
 * Runs the comparison. Apply, build and send are injectable so the sequencing
 * can be tested without a live Neconyan or a real model.
 *
 * @returns {Promise<{columns: object[], script: string[], restoreProblems: string[], aborted: boolean}>}
 */
export async function runSceneComparison({
    presets = [],
    characterAvatar = '',
    personaKey = null,
    connectionProfileId = '',
    greeting = '',
    mode = SCENE_MODE.SCRIPTED,
    turns = [],
    exchanges = 2,
    // Resuming: the turn to start at, and what was already said before it, so
    // one turn can be played again without paying for the ones before it.
    startAt = 1,
    history = [],
    maxTokens = 300,
    context = getContext,
    host = null,
    signal = null,
    onProgress = null,
    onUpdate = null,
    live = false,
    captureFn = captureOnce,
    applyFn = applyCase,
    sendFn = sendPrompt,
    snapshotFn = snapshotState,
    restoreFn = restoreState,
} = {}) {
    const fullTurns = sceneTurnEntries({ mode, turns, exchanges });
    const requestedStart = Math.max(Math.floor(Number(startAt)) || 1, 1);
    let startIndex = fullTurns.findIndex(turn => turn.index >= requestedStart);
    if (startIndex < 0) {
        startIndex = Math.max(fullTurns.length - 1, 0);
    }
    const selectedTurns = fullTurns.slice(startIndex);
    const script = selectedTurns.map(turn => turn.text);
    const chosen = (presets ?? []).filter(preset => preset?.name).slice(0, MAX_PRESETS);
    const opening = String(greeting ?? '').trim() ? String(greeting) : '';
    const columns = [];
    const expectedRequests = script.length * chosen.length;
    const finish = (restoreProblems = []) => {
        const completedRequests = columns.reduce(
            (total, column) => total + column.turns.filter(turn => !turn.waiting).length,
            0,
        );
        const aborted = Boolean(signal?.aborted);
        return {
            columns,
            script,
            opening,
            restoreProblems,
            aborted,
            expectedRequests,
            completedRequests,
            incomplete: aborted || completedRequests < expectedRequests,
        };
    };
    if (!script.length || !chosen.length || signal?.aborted) {
        return finish();
    }

    // Snapshotted before the first preset is applied and restored no matter how
    // this ends, so a failed send cannot leave the user on another preset.
    const snapshot = await snapshotFn(context);
    let restoreProblems = [];

    try {
        for (const [presetIndex, preset] of chosen.entries()) {
            if (signal?.aborted) {
                break;
            }
            if (presetIndex) {
                let columnRestoreProblems = [];
                try {
                    columnRestoreProblems = await restoreFn(context, snapshot) ?? [];
                } catch (error) {
                    columnRestoreProblems = [String(error?.message ?? error)];
                }
                if (columnRestoreProblems.length) {
                    restoreProblems.push(...columnRestoreProblems);
                    break;
                }
            }
            const column = {
                preset,
                label: preset.name,
                turns: [],
                caveats: [],
                error: '',
                done: false,
            };
            columns.push(column);
            onUpdate?.({ columns });
            if (signal?.aborted) {
                column.done = true;
                onUpdate?.({ columns });
                break;
            }

            try {
                await applyFn(context, {
                    characterAvatar,
                    personaKey,
                    connectionProfileId,
                    presets: [preset],
                }, { signal, originalState: snapshot });
                if (signal?.aborted) {
                    column.done = true;
                    onUpdate?.({ columns });
                    break;
                }
            } catch (error) {
                column.error = String(error?.message ?? error);
                column.done = true;
                onUpdate?.({ columns });
                continue;
            }

            // The chat that was opened is part of every prompt built from here,
            // and a greeting laid on top of a saved conversation reads as a
            // second opening. Say so rather than let it pass unnoticed.
            if ((ctxOf(context)?.chat ?? []).length) {
                column.caveats.push(CAVEAT_EXISTING_CHAT);
            }

            // The chosen greeting opens the scene, so every preset answers the
            // same first message rather than whatever its chat happened to hold.
            const scene = opening ? [{ role: 'assistant', text: opening }] : [];
            // What was already said, when only part of the scene is replayed.
            for (const entry of history ?? []) {
                if (String(entry?.text ?? '').trim()) {
                    scene.push({
                        role: entry.role === 'assistant' ? 'assistant' : 'user',
                        text: String(entry.text),
                    });
                }
            }

            for (const turn of selectedTurns) {
                if (signal?.aborted) {
                    break;
                }
                const turnNumber = turn.index;
                const userText = turn.text;
                onProgress?.({
                    presetName: preset.name,
                    presetIndex: columns.length,
                    presetTotal: chosen.length,
                    turn: turnNumber,
                    turnTotal: fullTurns.at(-1)?.index ?? 0,
                });
                if (signal?.aborted) {
                    break;
                }

                scene.push({ role: 'user', text: userText });
                let capture;
                try {
                    capture = await captureFn({ scene: [...scene], context, host, signal });
                } catch (error) {
                    column.error = String(error?.message ?? error);
                    column.done = true;
                    onUpdate?.({ columns });
                    break;
                }
                if (signal?.aborted) {
                    break;
                }
                for (const caveat of capture?.caveats ?? []) {
                    if (!column.caveats.includes(caveat)) {
                        column.caveats.push(caveat);
                    }
                }

                // The record exists before the reply does, so a watcher can
                // show the turn filling in rather than a blank wait.
                const record = {
                    index: turnNumber,
                    userText,
                    text: '',
                    error: null,
                    promptTokens: Number(capture?.tokenTable?.total ?? 0),
                    durationMs: 0,
                    waiting: true,
                };
                column.turns.push(record);
                onUpdate?.({ columns });
                if (signal?.aborted) {
                    column.turns.pop();
                    onUpdate?.({ columns });
                    break;
                }

                const startedMs = Date.now();
                const prompt = capture?.messages ?? capture?.combinedPrompt ?? '';
                const reply = await sendFn(connectionProfileId, prompt, {
                    hostRef: context,
                    maxTokens,
                    signal,
                    presetName: ['openai', 'textgenerationwebui'].includes(preset.apiId)
                        ? preset.name
                        : undefined,
                    includePreset: true,
                    includeInstruct: preset.apiId !== 'instruct',
                    onDelta: live
                        ? (text) => {
                            record.text = text;
                            record.durationMs = Date.now() - startedMs;
                            onUpdate?.({ columns, streaming: record });
                        }
                        : null,
                });
                const returnedText = String(reply?.text ?? '');
                if (returnedText.trim() || !record.text) {
                    record.text = returnedText;
                }
                record.error = reply?.error
                    ?? (record.text.trim() ? null : 'The model returned an empty reply.');
                record.durationMs = Date.now() - startedMs;
                record.waiting = false;
                onUpdate?.({ columns });

                // A scene that stalled cannot be continued honestly: the next
                // turn would be answering a reply that never arrived.
                if (record.error || !record.text.trim()) {
                    break;
                }
                scene.push({ role: 'assistant', text: record.text });
            }
            column.done = true;
            onUpdate?.({ columns });
        }
    } finally {
        try {
            restoreProblems = [...new Set([
                ...restoreProblems,
                ...(await restoreFn(context, snapshot) ?? []),
            ])];
        } catch (error) {
            restoreProblems = [...new Set([
                ...restoreProblems,
                String(error?.message ?? error),
            ])];
        }
    }

    return finish(restoreProblems);
}
