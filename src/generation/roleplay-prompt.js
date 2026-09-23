import { roleplayError } from '../roleplay-store.js';
import { isDeepStrictEqual } from 'node:util';
import Handlebars from 'handlebars';

const ROLES = ['system', 'user', 'assistant'];

/** Render named lore only where the saved story template explicitly requests it. */
export function insertWorldInfoOutlets(messages, outlets, snapshot, historyStart, userName, characterName) {
    if (!outlets || typeof outlets !== 'object' || Array.isArray(outlets)
        || typeof snapshot?.storyTemplate !== 'string' || snapshot.storyPosition !== 0
        || !Number.isSafeInteger(historyStart) || historyStart !== 0
        || typeof userName !== 'string' || typeof characterName !== 'string') {
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
    if (!Object.keys(fields).length) return messages;
    const global = snapshot.global;
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
            wiBefore: '', wiAfter: '', loreBefore: '', loreAfter: '' });
    } catch {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template needs unsupported prompt macros.', 409);
    }
    if (!rendered) throw roleplayError('ROLEPLAY_INVALID', 'The saved story template did not place its World Info outlet.', 409);
    return [{ role: 'system', content: rendered }, ...messages];
}

/** Depth positions may use only an exact plain-text suffix of the protected chat. */
export function assertWorldInfoDepthHistory(records, messages, historyStart) {
    if (!Array.isArray(records) || !Array.isArray(messages) || !Number.isSafeInteger(historyStart)
        || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const history = records.slice(1).map(record => {
        if (typeof record.mes !== 'string' || typeof record.is_user !== 'boolean'
            || Object.keys(record).some(key => !['name', 'is_user', 'mes', 'swipes', 'swipe_id', 'swipe_info', 'extra', 'send_date'].includes(key))
            || (record.extra && Object.keys(record.extra).length)) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved chat needs server handling for its non-text content.', 409);
        }
        return { role: record.is_user ? 'user' : 'assistant', content: record.mes };
    });
    const selected = messages.slice(historyStart);
    if (!selected.length || selected.length > history.length || !isDeepStrictEqual(selected, history.slice(-selected.length))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'World Info depth history differs from the protected chat.', 409);
    }
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
export function insertWorldInfoAuthorNote(messages, before, after, note, historyStart) {
    if (!Array.isArray(before) || !Array.isArray(after) || [...before, ...after].some(value => typeof value !== 'string')
        || !note || typeof note.prompt !== 'string' || !Number.isSafeInteger(note.interval)
        || !Number.isSafeInteger(note.depth) || note.depth < 0 || note.depth > 10000
        || ![0, 1, 2].includes(note.position) || ![0, 1, 2].includes(note.role)
        || !Number.isSafeInteger(note.userMessages) || note.userMessages < 0
        || !Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Author\'s Note cannot be placed in this prompt.', 409);
    }
    if (!before.length && !after.length) return messages;
    const active = note.interval === 1 || note.interval > 1 && note.userMessages > 0 && note.userMessages % note.interval === 0;
    if (!active) return messages;
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
    if (note.position !== 1) {
        throw roleplayError('ROLEPLAY_INVALID', 'This Author\'s Note position needs server story prompt construction.', 409);
    }
    return insertWorldInfoDepth(messages, [{ depth: note.depth, role: note.role, entries: [content] }], historyStart);
}
