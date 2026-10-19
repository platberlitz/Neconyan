import { regexFromString } from '../../regex-utils.js';

/** Profile id that means 'use the connection the chat is using'. */
export const CURRENT_CONNECTION_ID = '';

const SAMPLE_LIMIT = 1500;
const RESPONSE_TOKENS = 4096;

/** Where a rule can run, keyed by the short names the model answers with. */
export const REGEX_DRAFT_AFFECTS = Object.freeze({
    user: 1,
    ai: 2,
    slash: 3,
    world: 5,
    reasoning: 6,
});

const CHANGE_MODES = Object.freeze({
    display: { markdownOnly: true, promptOnly: false },
    prompt: { markdownOnly: false, promptOnly: true },
    both: { markdownOnly: true, promptOnly: true },
    chat: { markdownOnly: false, promptOnly: false },
});

const SYSTEM_PROMPT = [
    'You write find-and-replace rules (regex scripts) for a roleplay chat app.',
    'A rule has a JavaScript regular expression, a replacement and some switches.',
    'Answer with one JSON object and nothing else. Use exactly these keys:',
    '{',
    '  "name": short title for the rule, at most 6 words,',
    '  "find": JavaScript regex literal such as "/<think>[\\\\s\\\\S]*?<\\\\/think>/gi", always with slashes and flags, backslashes escaped as JSON needs,',
    '  "replace": replacement text; $1, $2 insert capture groups, {{match}} inserts the whole match, "" removes the match,',
    '  "trim": array of plain strings to cut from the match before replacing, usually [],',
    '  "affects": array with any of "ai" (AI replies), "user" (user messages), "slash" (slash commands), "world" (World Info), "reasoning" (model reasoning),',
    '  "changes": "display" (only what the user sees), "prompt" (only what the model is sent), "both" (what the user sees and what the model is sent, the saved chat stays as it is), or "chat" (edits the saved messages themselves),',
    '  "example": a short sample text, under 300 characters, that the rule changes,',
    '  "explanation": one or two plain sentences, for someone who does not know regex, on what the rule does',
    '}',
    'Prefer lazy quantifiers like [\\s\\S]*? for spans, escape special characters, and use the g flag unless one match is enough.',
    'Default to "affects": ["ai"] and "changes": "display" unless the request says otherwise.',
].join('\n');

/**
 * Cuts a sample to a size that keeps the request small.
 * @param {string} text Sample text
 * @returns {string}
 */
export function trimRegexDraftSample(text) {
    const value = String(text ?? '').trim();
    return value.length > SAMPLE_LIMIT ? `${value.slice(0, SAMPLE_LIMIT)}\n[...]` : value;
}

/**
 * Builds the chat messages that ask a model for a rule.
 * @param {object} options
 * @param {string} options.request What the user wants the rule to do
 * @param {string} [options.sample] Text the rule should work on
 * @param {{ name?: string, find?: string, replace?: string }} [options.current] Rule being refined
 * @returns {{ role: 'system'|'user', content: string }[]}
 */
export function buildRegexDraftMessages({ request, sample = '', current = null }) {
    const parts = [`Request: ${String(request ?? '').trim()}`];
    if (current?.find) {
        parts.push([
            'Improve this existing rule rather than starting again:',
            `name: ${current.name ?? ''}`,
            `find: ${current.find}`,
            `replace: ${current.replace ?? ''}`,
        ].join('\n'));
    }
    const trimmed = trimRegexDraftSample(sample);
    if (trimmed) {
        parts.push(`Text the rule will run on, between the markers:\n<<<\n${trimmed}\n>>>`);
    }
    parts.push('Reply with the JSON object only.');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

/**
 * Finds the JSON object in a model reply, ignoring reasoning blocks and code fences.
 * @param {string} text Model reply
 * @returns {object|null}
 */
function extractJsonObject(text) {
    const cleaned = String(text ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim();
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced?.[1], cleaned];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end <= start) continue;
        try {
            const parsed = JSON.parse(candidate.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}

/**
 * Turns a pattern into a regex literal the editor understands.
 * @param {string} find Pattern from the model
 * @returns {string}
 */
function normaliseFind(find) {
    const value = String(find ?? '').trim();
    if (!value) return '';
    if (/^\/[\s\S]+\/[dgimsuvy]*$/.test(value)) return value;
    return `/${value}/g`;
}

/**
 * Reads a model reply into editor values, or explains why it cannot.
 * @param {string} text Model reply
 * @returns {{ ok: true, draft: { name: string, find: string, replace: string, trim: string[], placement: number[], markdownOnly: boolean, promptOnly: boolean, example: string, explanation: string } } | { ok: false, error: string }}
 */
export function parseRegexDraftResponse(text) {
    const data = extractJsonObject(text);
    if (!data) {
        return { ok: false, error: 'The model did not answer with a rule. Try again, or pick another connection.' };
    }

    const find = normaliseFind(data.find);
    if (!find) {
        return { ok: false, error: 'The model left the pattern empty. Describe what to find in a little more detail.' };
    }
    const match = find.match(/^\/([\s\S]+)\/([a-z]*)$/i);
    try {
        new RegExp(match[1], match[2]);
    } catch {
        return { ok: false, error: `The model wrote a pattern that does not work: ${find}` };
    }
    if (!regexFromString(find)) {
        return { ok: false, error: `The model wrote a pattern that does not work: ${find}` };
    }

    const affects = Array.isArray(data.affects) ? data.affects : [data.affects];
    const placement = [...new Set(affects
        .map(value => REGEX_DRAFT_AFFECTS[String(value ?? '').trim().toLowerCase()])
        .filter(Number.isInteger))].sort((a, b) => a - b);
    const mode = CHANGE_MODES[String(data.changes ?? '').trim().toLowerCase()] ?? CHANGE_MODES.display;
    const trim = (Array.isArray(data.trim) ? data.trim : [])
        .map(value => String(value ?? ''))
        .filter(value => value.length > 0);

    return {
        ok: true,
        draft: {
            name: String(data.name ?? '').trim().slice(0, 80),
            find,
            replace: typeof data.replace === 'string' ? data.replace : String(data.replace ?? ''),
            trim,
            placement: placement.length ? placement : [REGEX_DRAFT_AFFECTS.ai],
            markdownOnly: mode.markdownOnly,
            promptOnly: mode.promptOnly,
            example: String(data.example ?? '').trim(),
            explanation: String(data.explanation ?? '').trim(),
        },
    };
}

/**
 * Lists the saved connection profiles that can send a request.
 * @param {any} service ConnectionManagerRequestService, if available
 * @returns {{ id: string, name: string, mode: string }[]}
 */
export function listRegexDraftProfiles(service) {
    if (!service?.getSupportedProfiles) return [];
    try {
        return service.getSupportedProfiles()
            .filter(profile => profile?.id)
            .map(profile => ({
                id: String(profile.id),
                name: String(profile.name || profile.id),
                mode: profile.mode === 'tc' ? 'Text Completion' : 'Chat Completion',
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

/**
 * Picks the profile to show: the saved choice when it still exists, otherwise the current connection.
 * @param {{ id: string }[]} profiles Available profiles
 * @param {string} savedId Saved choice
 * @returns {string}
 */
export function resolveRegexDraftProfileId(profiles, savedId) {
    const id = String(savedId ?? '');
    return profiles.some(profile => profile.id === id) ? id : CURRENT_CONNECTION_ID;
}

/**
 * Reads the text out of whatever a request returned.
 * @param {any} result Request result
 * @returns {string}
 */
function readResultText(result) {
    if (typeof result === 'string') return result;
    if (typeof result?.content === 'string') return result.content;
    return '';
}

/**
 * Asks a model for a rule through a saved connection profile or the current connection.
 * @param {object} options
 * @param {any} [options.service] ConnectionManagerRequestService
 * @param {(options: object) => Promise<string>} [options.generateRaw] Request through the current connection
 * @param {string} options.profileId Profile id, or '' for the current connection
 * @param {string} options.request What the rule should do
 * @param {string} [options.sample] Text the rule should work on
 * @param {{ name?: string, find?: string, replace?: string }} [options.current] Rule being refined
 * @param {AbortSignal} [options.signal] Stops the request
 * @returns {Promise<ReturnType<typeof parseRegexDraftResponse>>}
 */
export async function requestRegexDraft({ service, generateRaw, profileId, request, sample, current, signal }) {
    const messages = buildRegexDraftMessages({ request, sample, current });
    let text;
    if (profileId) {
        if (!service?.sendRequest) {
            return { ok: false, error: 'Connection profiles are switched off. Turn on Connection Manager, or use the current connection.' };
        }
        const prompt = service.constructPrompt ? service.constructPrompt(messages, profileId) : messages;
        text = readResultText(await service.sendRequest(profileId, prompt, RESPONSE_TOKENS, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        }));
    } else {
        if (typeof generateRaw !== 'function') {
            return { ok: false, error: 'No connection is ready. Connect to a model first.' };
        }
        text = readResultText(await generateRaw({
            systemPrompt: messages[0].content,
            prompt: messages[1].content,
            responseLength: RESPONSE_TOKENS,
            signal,
        }));
    }
    return parseRegexDraftResponse(text);
}
