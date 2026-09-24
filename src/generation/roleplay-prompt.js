import { roleplayError } from '../roleplay-store.js';
import { isDeepStrictEqual } from 'node:util';
import Handlebars from 'handlebars';
import { AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';

const ROLES = ['system', 'user', 'assistant'];

export const isWorldInfoAuthorNoteActive = note => note?.interval === 1
    || note?.interval > 1 && note.userMessages > 0 && note.userMessages % note.interval === 0;

/** Render named lore only where the saved story template explicitly requests it. */
export function insertWorldInfoOutlets(messages, outlets, snapshot, historyStart, userName, characterName, before = '', after = '', forceStory = false) {
    if (!outlets || typeof outlets !== 'object' || Array.isArray(outlets)
        || typeof snapshot?.storyTemplate !== 'string' || snapshot.storyPosition !== 0
        || !Number.isSafeInteger(historyStart) || historyStart !== 0
        || typeof userName !== 'string' || typeof characterName !== 'string'
        || typeof before !== 'string' || typeof after !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'Named World Info outlets need a saved story template.', 409);
    }
    const fields = Object.create(null);
    for (const [name, entries] of Object.entries(outlets)) {
        if (!/^[\w-]{1,128}$/.test(name) || !Array.isArray(entries) || entries.some(value => typeof value !== 'string')
            || !snapshot.storyTemplate.includes(`{{outlet::${name}}}`)) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved story template does not contain this World Info outlet.', 409);
        }
        fields[`outlet::${name}`] = entries.join('\n');
    }
    if (!Object.keys(fields).length && !before && !after && !forceStory) return messages;
    const global = snapshot.global;
    if ((before && !['wiBefore', 'loreBefore'].some(name => snapshot.storyTemplate.includes(`{{${name}}}`)))
        || (after && !['wiAfter', 'loreAfter'].some(name => snapshot.storyTemplate.includes(`{{${name}}}`)))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template does not place its selected World Info.', 409);
    }
    let rendered;
    try {
        const allowed = new Set(['description', 'personality', 'scenario', 'persona', 'user', 'char',
            'system', 'wiBefore', 'wiAfter', 'loreBefore', 'loreAfter', ...Object.keys(fields).map(key => `outlet::${key.slice(8)}`)]);
        const verify = program => {
            for (const statement of program.body) {
                if (statement.type === 'ContentStatement') continue;
                if (statement.type === 'MustacheStatement' && !statement.params.length
                    && allowed.has(statement.path.original)) continue;
                if (statement.type === 'BlockStatement' && statement.path.original === 'if'
                    && statement.params.length === 1 && allowed.has(statement.params[0].original)
                    && !statement.inverse) { verify(statement.program); continue; }
                throw new Error('Unsupported story template expression');
            }
        };
        verify(Handlebars.parse(snapshot.storyTemplate));
        rendered = Handlebars.compile(snapshot.storyTemplate, { noEscape: true })({ ...fields,
            description: global.characterDescription, personality: global.characterPersonality,
            scenario: global.scenario, persona: global.personaDescription, user: userName, char: characterName,
            system: snapshot.systemPrompt ?? '',
            wiBefore: before, wiAfter: after, loreBefore: before, loreAfter: after });
    } catch {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template needs unsupported prompt macros.', 409);
    }
    if (!rendered) throw roleplayError('ROLEPLAY_INVALID', 'The saved story template did not place its World Info outlet.', 409);
    return [{ role: 'system', content: rendered }, ...messages];
}

/** Depth positions may use only an exact plain-text suffix of the protected chat. */
export function assertWorldInfoDepthHistory(records, messages, historyStart, options = {}) {
    if (!Array.isArray(records) || !Array.isArray(messages) || !Number.isSafeInteger(historyStart)
        || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const history = buildPromptHistory(records, options);
    const selected = messages.slice(historyStart);
    if (!selected.length || selected.length > history.length || !isDeepStrictEqual(selected, history.slice(-selected.length))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'World Info depth history differs from the protected chat.', 409);
    }
}

function buildPromptHistory(records, { reasoningInPrompt = false, reasoning = null, regex = [], characterName,
    group = false, userName = records[0]?.user_name, namesBehavior, attachments = [], images = [], imageDetail = 'auto', mediaDisplay = 'list', toolHistory = false, toolSource = '', toolModel = '' } = {}) {
    if (group && ![-1, 0, 1, 2, 'provider'].includes(namesBehavior)) {
        throw roleplayError('ROLEPLAY_INVALID', 'This group naming policy needs server-side provider formatting.', 409);
    }
    if (!Array.isArray(attachments) || attachments.some(item => !item || !Number.isSafeInteger(item.index)
        || item.index < 0 || item.index >= records.length - 1 || typeof item.text !== 'string')) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file attachments are invalid.', 409);
    }
    if (!Array.isArray(images) || images.some(item => !item || !Number.isSafeInteger(item.index)
        || item.index < 0 || item.index >= records.length - 1 || typeof item.url !== 'string'
        || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(item.url))
        || !['low', 'auto', 'high'].includes(imageDetail)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay images are invalid.', 409);
    }
    const history = records.slice(1).map((record, index) => {
        if (record.extra?.tool_invocations !== undefined) {
            const calls = record.extra.tool_invocations;
            if (!toolHistory || !Array.isArray(calls) || !calls.length || calls.length > 32
                || record.is_system !== true || record.is_user !== false || typeof record.mes !== 'string'
                || record.extra.api !== toolSource || record.extra.model !== toolModel
                || Object.keys(record).some(key => !['name', 'force_avatar', 'is_system', 'is_user', 'mes', 'extra', 'send_date'].includes(key))
                || Object.keys(record.extra).some(key => !['isSmallSys', 'tool_invocations', 'api', 'model'].includes(key))
                || calls.some(call => !call || typeof call.id !== 'string' || !call.id || call.id.length > 256
                    || typeof call.name !== 'string' || !call.name || call.name.length > 256
                    || typeof call.parameters !== 'string' || typeof call.result !== 'string'
                    || call.signature || call.reasoning)
                || new Set(calls.map(call => call.id)).size !== calls.length) {
                throw roleplayError('ROLEPLAY_INVALID', 'This saved tool history needs a bound tool-capable connection.', 409);
            }
            return [{ role: 'assistant', tool_calls: calls.map(call => ({ id: call.id, type: 'function',
                function: { name: call.name, arguments: call.parameters } })) },
            ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: call.result || '[No content]' }))];
        }
        const attachment = attachments.find(item => item.index === index);
        const selectedImages = images.filter(item => item.index === index);
        const media = record.extra?.media;
        if (typeof record.mes !== 'string' || typeof record.is_user !== 'boolean'
            || group && (typeof record.name !== 'string' || !record.name)
            || Object.keys(record).some(key => !['name', 'is_user', 'mes', 'swipes', 'swipe_id', 'swipe_info', 'extra', 'send_date'].includes(key))
            || (record.extra && (typeof record.extra !== 'object' || Array.isArray(record.extra)
                 || Object.keys(record.extra).some(key => !['token_count', 'isSmallSys', 'reasoning', 'files', 'fileLength',
                     'media', 'media_index', 'media_display', 'inline_image'].includes(key))
                 || record.extra.files !== undefined && (!Array.isArray(record.extra.files) || !attachment)
                 || attachment && !Array.isArray(record.extra.files)
                 || media !== undefined && (!Array.isArray(media) || !media.length
                     || selectedImages.length !== ((record.extra.media_display ?? mediaDisplay) === 'gallery' ? 1 : media.length))
                 || selectedImages.length && !Array.isArray(media)
                 || ['media_index', 'media_display', 'inline_image'].some(key => record.extra[key] !== undefined && !Array.isArray(media))
                 || record.extra.fileLength !== undefined && (!Number.isSafeInteger(record.extra.fileLength)
                    || record.extra.fileLength < 0 || record.extra.fileLength > record.mes.length)
                || record.extra.reasoning !== undefined && typeof record.extra.reasoning !== 'string'))) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved chat needs server handling for its non-text content.', 409);
        }
        return { role: record.is_user ? 'user' : 'assistant', content: (attachment?.text ?? '') + record.mes };
    });
    if (reasoningInPrompt && records.some(record => record.extra?.reasoning)) {
        if (!reasoning || !Number.isSafeInteger(reasoning.max_additions) || reasoning.max_additions < 0
            || !Array.isArray(regex) || regex.some(script => script?.placement?.includes(AGENT_REGEX_PLACEMENT.REASONING)
                && !script.disabled && script.promptOnly && !script.markdownOnly)
            || ['prefix', 'suffix', 'separator'].some(key => typeof reasoning[key] !== 'string'
                || reasoning[key].includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(reasoning[key]))) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved reasoning prompt settings need server-side macro handling.', 409);
        }
        let added = 0;
        for (let index = history.length - 1; index >= 0 && added < reasoning.max_additions; index--) {
            const record = records[index + 1];
            if (Array.isArray(history[index])) continue;
            if (group && record.name !== characterName) continue;
            const thought = record.extra?.reasoning;
            if (!thought || thought === '\u200B') continue;
            history[index].content = `${reasoning.prefix}${thought}${reasoning.suffix}${reasoning.separator}${history[index].content}`;
            added++;
        }
    }
    if (group) for (let index = 0; index < history.length; index++) {
        if (Array.isArray(history[index])) continue;
        const name = records[index + 1].name;
        if (namesBehavior === 'provider') {
            history[index].name = name;
        } else if (namesBehavior === 1) {
            const wireName = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
            if (!wireName) throw roleplayError('ROLEPLAY_INVALID', 'The saved group speaker cannot be named by this provider.', 409);
            history[index].name = wireName;
        } else if (namesBehavior === 2 || namesBehavior === 0 && name !== userName) {
            history[index].content = `${name}: ${history[index].content}`;
        }
    }
    for (const [index, message] of history.entries()) {
        if (Array.isArray(message)) continue;
        const selectedImages = images.filter(item => item.index === index);
        if (selectedImages.length) message.content = [{ type: 'text', text: message.content }, ...selectedImages.map(item => ({
            type: 'image_url', image_url: { url: item.url, detail: imageDetail },
        }))];
    }
    return history.flat();
}

/** Derive the plain-text history from the protected chat, rather than an accepted page payload. */
export function buildRoleplaySavedHistory(records, options) {
    if (!Array.isArray(records) || !records.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'A saved Roleplay chat is required for prompt construction.', 409);
    }
    if (records.length === 1) return [];
    const messages = buildPromptHistory(records, options);
    assertWorldInfoDepthHistory(records, messages, 0, options);
    return messages;
}

/** Place saved depth entries within the captured history, never among system prompts. */
export function insertWorldInfoDepth(messages, entries, historyStart) {
    if (!Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length
        || !Array.isArray(entries) || entries.some(value => !value || !Number.isSafeInteger(value.depth)
            || value.depth < 0 || value.depth > 10000 || !Number.isInteger(value.role) || !ROLES[value.role]
            || !Array.isArray(value.entries) || value.entries.some(text => typeof text !== 'string'))) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const prefix = messages.slice(0, historyStart);
    const history = messages.slice(historyStart).reverse();
    let inserted = 0;
    for (const depth of [...new Set(entries.map(value => value.depth))].sort((a, b) => a - b)) {
        const injections = ROLES.flatMap((role, index) => entries
            .filter(value => value.depth === depth && value.role === index)
            .map(value => ({ role, content: value.entries.join('\n') })).filter(value => value.content));
        history.splice(depth + inserted, 0, ...injections);
        inserted += injections.length;
    }
    return [...prefix, ...history.reverse()];
}

/** Keep saved card examples between lore's before/after example blocks. */
export function insertWorldInfoExamples(messages, entries, cardExamples, historyStart, userName, characterName, groupNames = []) {
    if (!Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length
        || typeof cardExamples !== 'string' || typeof userName !== 'string' || !userName
        || typeof characterName !== 'string' || !characterName || !Array.isArray(groupNames)
        || groupNames.some(name => typeof name !== 'string')
        || !Array.isArray(entries) || entries.some(item => !item || ![0, 1].includes(item.position)
            || typeof item.content !== 'string')
        || messages.slice(0, historyStart).some(item => ['example_user', 'example_assistant'].includes(item?.name))) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info examples need a saved card and an unambiguous history boundary.', 409);
    }
    const blocks = text => text ? (text.startsWith('<START>') ? text : `<START>\n${text.trim()}`)
        .split(/<START>/gi).slice(1).map(block => block.trim()) : [];
    const parse = text => blocks(text).flatMap(block => {
        const lines = (`<START>\n${block}`).split('\n').slice(1);
        const result = [];
        let current;
        const flush = () => {
            if (!current) return;
            const content = current.lines.join('\n').replace(current.name + ':', '').trim();
            result.push({ role: 'system', content: groupNames.length ? `${current.name}: ${content}` : content,
                name: current.name === userName ? 'example_user' : 'example_assistant' });
        };
        for (const line of lines) {
            const speaker = [userName, characterName, ...groupNames].find(name => line.startsWith(name + ':'));
            if (speaker && speaker !== current?.name) { flush(); current = { name: speaker, lines: [] }; }
            if (current) current.lines.push(line);
        }
        flush();
        return result;
    });
    const before = entries.filter(item => item.position === 0).reverse().flatMap(item => parse(item.content));
    const after = entries.filter(item => item.position === 1).flatMap(item => parse(item.content));
    return [...messages.slice(0, historyStart), ...before, ...parse(cardExamples), ...after, ...messages.slice(historyStart)];
}

/** Browser Author's Note timing comes from saved chat metadata and saved extension defaults. */
export function insertWorldInfoAuthorNote(messages, before, after, note, historyStart, storyBound = false) {
    if (!Array.isArray(before) || !Array.isArray(after) || [...before, ...after].some(value => typeof value !== 'string')
        || !note || typeof note.prompt !== 'string' || !Number.isSafeInteger(note.interval)
        || !Number.isSafeInteger(note.depth) || note.depth < 0 || note.depth > 10000
        || ![0, 1, 2].includes(note.position) || ![0, 1, 2].includes(note.role)
        || !Number.isSafeInteger(note.userMessages) || note.userMessages < 0
        || !Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Author\'s Note cannot be placed in this prompt.', 409);
    }
    if (!before.length && !after.length) return messages;
    if (!isWorldInfoAuthorNoteActive(note)) return messages;
    let prompt = note.prompt;
    const scoped = note.scoped;
    if (scoped?.useChara) {
        if (typeof scoped.prompt !== 'string' || ![0, 1, 2].includes(Number(scoped.position))) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved character Author\'s Note is invalid.', 409);
        }
        prompt = Number(scoped.position) === 1 ? [scoped.prompt, prompt].filter(Boolean).join('\n')
            : Number(scoped.position) === 2 ? [prompt, scoped.prompt].filter(Boolean).join('\n') : scoped.prompt;
    }
    const content = [...before, prompt, ...after].join('\n').replace(/(^\n)|(\n$)/g, '');
    if (!content) return messages;
    if (note.position === 1) {
        return insertWorldInfoDepth(messages, [{ depth: note.depth, role: note.role, entries: [content] }], historyStart);
    }
    if (!storyBound || historyStart < 1 || messages[0]?.role !== 'system') {
        throw roleplayError('ROLEPLAY_INVALID', 'This Author\'s Note position needs a bound story prompt.', 409);
    }
    const injection = { role: ROLES[note.role], content };
    return note.position === 2 ? [injection, ...messages] : [messages[0], injection, ...messages.slice(1)];
}

/** Text completion puts saved post-history instructions after chat, except before a continued reply. */
export function insertRoleplayPostHistory(messages, saved, backend, effect, material) {
    if (!saved || typeof saved.character !== 'string' || typeof saved.text !== 'string'
        || typeof saved.textEnabled !== 'boolean') {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved post-history instructions are invalid.', 409);
    }
    if (backend === 'chat') {
        if (!saved.character.trim()) return messages;
        const controls = material?.preset ?? material?.active;
        const order = controls?.prompt_order?.find(value => String(value?.character_id) === '100001')?.order;
        const prompt = controls?.prompts?.find(value => value?.identifier === 'jailbreak');
        if (!Array.isArray(order) || !Array.isArray(controls?.prompts) || !prompt) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Chat Completion prompt order is unavailable.', 409);
        }
        const position = order.findIndex(value => value?.identifier === 'jailbreak');
        if (position < 0 || order[position].enabled !== true) return messages;
        const history = order.findIndex(value => value?.identifier === 'chatHistory');
        if (history < 0 || history >= position || order[history].enabled !== true
            || order.slice(history + 1).some(value => value?.enabled && value.identifier !== 'jailbreak')
            || prompt.forbid_overrides === true || prompt.role !== 'system' || prompt.system_prompt !== true
            || prompt.injection_position != null
            || saved.character.includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(saved.character)
            || (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length
                && !prompt.injection_trigger.includes(effect === 'append' ? 'normal' : effect === 'replace' ? 'regenerate' : effect))) {
            throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion post-history instruction needs full prompt-manager ordering.', 409);
        }
        return [...messages, { role: 'system', content: saved.character.trim() }];
    }
    if (!['text', 'kobold', 'novel', 'horde'].includes(backend)) {
        throw roleplayError('ROLEPLAY_INVALID', 'This connection cannot place saved post-history instructions.', 409);
    }
    if (!saved.textEnabled) return messages;
    const instruction = saved.character.trim() || saved.text.trim();
    if (!instruction) return messages;
    if (instruction.includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(instruction)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved post-history macros need server-side prompt substitution.', 409);
    }
    if (effect === 'continue' && messages.at(-1)?.role !== 'assistant') {
        throw roleplayError('ROLEPLAY_INVALID', 'Continuation instructions need the saved assistant reply at the end of the prompt.', 409);
    }
    const position = effect === 'continue' ? messages.length - 1 : messages.length;
    return [...messages.slice(0, position), { role: 'user', content: instruction }, ...messages.slice(position)];
}
