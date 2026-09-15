/**
 * Shareable custom-macro packs: a small JSON format for export/import. Pure
 * serialize/validate logic. file download/upload lives in the gallery UI.
 */
import { validateDef } from './store.js';

export const PACK_FORMAT = 'macro-enhanced-pack';
export const PACK_VERSION = 1;

/** Serializes definitions for sharing (ids and enabled state stay local). */
export function exportPack(defs, { exportedAt = null } = {}) {
    return {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        ...(exportedAt ? { exportedAt } : {}),
        macros: defs.map(def => ({
            name: String(def.name ?? ''),
            description: String(def.description ?? ''),
            template: String(def.template ?? ''),
            args: (def.args ?? []).map(arg => ({
                name: String(arg.name ?? ''),
                ...(arg.optional ? { optional: true } : {}),
                ...(arg.defaultValue !== undefined && arg.defaultValue !== '' ? { defaultValue: String(arg.defaultValue) } : {}),
                ...(arg.description ? { description: String(arg.description) } : {}),
            })),
        })),
    };
}

/**
 * Parses and structurally validates a pack file. Invalid definitions are
 * reported in `problems` and skipped; the valid remainder is returned as
 * id-less partials ready for createDef().
 *
 * @param {string} jsonText
 * @returns {{macros: object[], problems: string[]}}
 */
export function parsePack(jsonText) {
    let data;
    try {
        data = JSON.parse(String(jsonText));
    } catch {
        return { macros: [], problems: ['This is not a valid JSON file.'] };
    }
    if (!data || typeof data !== 'object' || data.format !== PACK_FORMAT) {
        return { macros: [], problems: ['This is not a Macro Enhanced pack file.'] };
    }
    if (data.version !== PACK_VERSION) {
        return { macros: [], problems: [`Unsupported pack version ${data.version} (this build reads version ${PACK_VERSION}).`] };
    }
    if (!Array.isArray(data.macros)) {
        return { macros: [], problems: ['The pack has no macro list.'] };
    }

    const macros = [];
    const problems = [];
    const seenNames = new Set();
    data.macros.forEach((raw, index) => {
        const candidate = {
            id: `pack-${index}`,
            name: String(raw?.name ?? '').trim(),
            description: String(raw?.description ?? ''),
            template: String(raw?.template ?? ''),
            args: Array.isArray(raw?.args)
                ? raw.args.map(arg => ({
                    name: String(arg?.name ?? ''),
                    optional: !!arg?.optional,
                    ...(arg?.defaultValue !== undefined ? { defaultValue: String(arg.defaultValue) } : {}),
                    ...(arg?.description ? { description: String(arg.description) } : {}),
                }))
                : [],
            enabled: true,
        };
        const label = `Macro #${index + 1}${candidate.name ? ` ("${candidate.name}")` : ''}`;
        if (seenNames.has(candidate.name.toLowerCase())) {
            problems.push(`${label}: appears twice in the pack. the first copy wins.`);
            return;
        }
        const errors = validateDef(candidate, {});
        if (errors.length) {
            problems.push(`${label}: ${errors.join(' ')}`);
            return;
        }
        seenNames.add(candidate.name.toLowerCase());
        const { id, ...partial } = candidate;
        macros.push(partial);
    });
    return { macros, problems };
}
