import { POSITION, entryId } from '../constants.js';

const DEFAULT_DEPTH = 4;
const SYSTEM_ROLE = 0;

function knownPosition(value) {
    return Object.values(POSITION).includes(value) ? value : POSITION.before;
}

export function buildPlacements(entries, processRegex = null) {
    const before = [];
    const after = [];
    const examples = [];
    const authorNoteBefore = [];
    const authorNoteAfter = [];
    const atDepth = [];
    const outlets = Object.create(null);
    const records = [];

    [...entries].sort((a, b) => b.order - a.order).forEach((entry) => {
        const position = knownPosition(entry.position);
        const depth = position === POSITION.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const raw = String(entry.content ?? '');
        const content = processRegex ? String(processRegex(raw, depth) ?? '') : raw;
        const record = {
            id: entryId(entry),
            hash: String(entry.hash ?? ''),
            world: entry.world,
            uid: entry.uid,
            label: entry.comment || `Entry ${entry.uid}`,
            order: entry.order,
            position,
            depth,
            role: entry.role ?? SYSTEM_ROLE,
            outlet: entry.outletName ?? '',
            rawContent: raw,
            renderedContent: content,
            included: Boolean(content),
            placementStatus: content ? 'inserted' : 'omitted',
            omissionReason: content ? '' : 'empty-after-regex',
        };
        records.unshift(record);
        if (!content) {
            return;
        }
        switch (position) {
            case POSITION.before:
                before.unshift(content);
                break;
            case POSITION.after:
                after.unshift(content);
                break;
            case POSITION.EMTop:
                examples.unshift({ position: 0, content });
                break;
            case POSITION.EMBottom:
                examples.unshift({ position: 1, content });
                break;
            case POSITION.ANTop:
                authorNoteBefore.unshift(content);
                record.placementStatus = 'conditional-author-note';
                break;
            case POSITION.ANBottom:
                authorNoteAfter.unshift(content);
                record.placementStatus = 'conditional-author-note';
                break;
            case POSITION.atDepth: {
                const role = entry.role ?? SYSTEM_ROLE;
                const group = atDepth.find(item => item.depth === depth && item.role === role);
                if (group) {
                    group.entries.unshift(content);
                } else {
                    atDepth.push({ depth, role, entries: [content] });
                }
                break;
            }
            case POSITION.outlet:
                if (entry.outletName) {
                    outlets[entry.outletName] ??= [];
                    outlets[entry.outletName].unshift(content);
                    record.placementStatus = 'outlet-value';
                } else {
                    record.included = false;
                    record.placementStatus = 'omitted';
                    record.omissionReason = 'missing-outlet-name';
                }
                break;
        }
    });

    return {
        records,
        worldInfoBefore: before.join('\n'),
        worldInfoAfter: after.join('\n'),
        examples,
        authorNoteBefore,
        authorNoteAfter,
        atDepth,
        outlets,
    };
}
