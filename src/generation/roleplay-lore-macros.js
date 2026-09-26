import { fnv1a } from '../../public/scripts/extensions/third-party/MacroEnhanced/src/state-impl.js';

/** Request-local lore helpers shared by saved replies and read-only prompt tests. */
export function createRoleplayLoreMacros(worldInfo, snapshot) {
    const inFlight = new Set();
    const lookup = (title, book) => worldInfo.boundLore.find(item => (!book || item.book === book)
        && ((String(item.entry.comment ?? '').trim()
            && String(item.entry.comment).trim().toLowerCase() === String(title).trim().toLowerCase())
            || String(item.entry.uid) === String(title).trim()));
    const content = (item, resolve) => {
        if (!item) return '';
        const identity = `${item.book}::${item.entry.uid}`;
        if (inFlight.has(identity)) return item.content;
        inFlight.add(identity);
        try { return resolve(item.content); } finally { inFlight.delete(identity); }
    };
    const fields = {
        title: item => item.title, keys: item => (item.entry.key ?? []).join(', '),
        secondarykeys: item => (item.entry.keysecondary ?? []).join(', '), content: item => item.content,
        position: item => String(item.entry.position ?? ''), depth: item => String(item.entry.depth ?? ''),
        order: item => String(item.entry.order ?? ''), probability: item => String(item.entry.probability ?? ''),
        constant: item => item.entry.constant ? 'true' : 'false', enabled: item => item.entry.disable ? 'false' : 'true',
        uid: item => String(item.entry.uid),
    };
    const args = [{ name: 'entry' }, { name: 'book', optional: true }];
    const lore = { unnamedArgs: args, handler: ({ unnamedArgs: [title, book], resolve }) => content(lookup(title, book), resolve) };
    const scope = value => !value || value === 'active' ? worldInfo.activeLore : value === 'bound' ? worldInfo.boundLore : null;
    return {
        lore, wi: lore,
        lorekeys: { unnamedArgs: args, handler: ({ unnamedArgs: [title, book] }) => (lookup(title, book)?.entry.key ?? []).join(', ') },
        loreexists: { unnamedArgs: args, handler: ({ unnamedArgs: [title, book] }) => String(Boolean(lookup(title, book))) },
        lorefield: { unnamedArgs: [{ name: 'entry' }, { name: 'field' }, { name: 'book', optional: true }],
            handler: ({ unnamedArgs: [title, field, book] }) => {
                const item = lookup(title, book), name = String(field ?? '').trim().toLowerCase();
                return item && Object.hasOwn(fields, name) ? fields[name](item) : '';
            } },
        lorepick: { unnamedArgs: [{ name: 'book', optional: true }, { name: 'key', optional: true }],
            handler: ({ unnamedArgs: [book, key], resolve }) => {
                const candidates = worldInfo.boundLore.filter(item => !book || item.book === book)
                    .sort((a, b) => String(a.entry.uid).localeCompare(String(b.entry.uid), undefined, { numeric: true }));
                const seed = `${snapshot.metadata.chat_id_hash ?? ''}:${String(book ?? '')}:${String(key ?? '')}`;
                return candidates.length ? content(candidates[fnv1a(seed) % candidates.length], resolve) : '';
            } },
        loreactive: { unnamedArgs: [{ name: 'separator', optional: true }], handler: ({ unnamedArgs: [separator] }) =>
            worldInfo.activeLore.map(entry => entry.title).join(separator || ', ') },
        lorebooks: { unnamedArgs: [{ name: 'separator', optional: true }], handler: ({ unnamedArgs: [separator] }) =>
            [...new Set([...snapshot.names.chat, ...snapshot.names.character, ...snapshot.names.global])].join(separator || ', ') },
        loreentries: { unnamedArgs: [{ name: 'book', optional: true }, { name: 'separator', optional: true }],
            handler: ({ unnamedArgs: [book, separator] }) => worldInfo.boundLore.filter(entry => !book || entry.book === book)
                .map(entry => entry.title).join(separator || ', ') },
        lorecount: { unnamedArgs: [{ name: 'scope', optional: true }], handler: ({ unnamedArgs: [value] }) =>
            scope(value) ? String(scope(value).length) : '' },
        loretokens: { unnamedArgs: [{ name: 'scope', optional: true }], handler: ({ unnamedArgs: [value] }) =>
            scope(value) ? String(Math.ceil(scope(value).map(entry => entry.content).join('\n').length / 4)) : '' },
    };
}
