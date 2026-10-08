import { computeBatchPreview } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/batch.js';
import { auditSnapshot } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/health.js';
import { buildMacroSnapshot, getTimedEffects } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/scan-input.js';
import { simulateWorldInfo } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/simulator/engine.js';
import { getWorldEntries, parseDecorators, sortByStrategy } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/sources.js';
import { POSITION } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/constants.js';
import { normalizeWorldInfoPosition } from '../../public/scripts/world-info-character-book.js';
import { syncLorebookOriginalEntry } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { normalizeWorldInfoProbability, parseWorldInfoKeyRegex } from '../../public/scripts/world-info-scan-core.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { applyRegexScriptList, AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { createMacroEnvironment } from '../macros/index.js';

export async function computeWorldInfoLab(kind, plan, tokenCount) {
    if (kind === 'world-info.batch') {
        const preview = await computeBatchPreview({ ...plan.options, bookName: plan.target.name,
            snapshot: { books: { [plan.target.name]: plan.target.book } } });
        const book = structuredClone(plan.target.book);
        for (const change of preview.changes) {
            const entry = book.entries[change.entryKey];
            entry[change.field] = change.after;
            syncLorebookOriginalEntry(book, change.entryKey);
        }
        return { ...preview, target: plan.target, book };
    }
    const groups = Object.fromEntries(['chat', 'persona', 'character', 'global'].map(source => [source,
        plan.sourcePlan[source].flatMap(name => getWorldEntries(plan.books[name].book, name, source))]));
    const entries = sortByStrategy(groups, plan.settings.characterStrategy).map(raw => {
        const { labSource, ...entry } = raw;
        const decorated = { ...entry, ...parseDecorators(entry.content) };
        return { ...normalizeWorldInfoProbability({ ...decorated,
            position: normalizeWorldInfoPosition(decorated.position, POSITION) ?? POSITION.before }),
        hash: getStringHash(JSON.stringify(decorated)), labSource };
    });
    const environment = createMacroEnvironment(plan.macros);
    const expand = (value, postProcess) => environment.evaluate(String(value ?? ''), {
        legacy: plan.macroEngine === 'legacy', strictCapabilities: true, postProcess,
    });
    if (kind === 'world-info.health') {
        const report = await auditSnapshot({ bookName: plan.sourcePlan.all[0], entries, settings: plan.settings,
            parseRegex: parseWorldInfoKeyRegex, expand, messages: plan.messages, tokenCount,
            haystack: [...plan.messages, ...Object.values(plan.globalScanData)].join('\n'), maxContext: plan.maxContext });
        return { ...report, tokens: { ...report.tokens, outliers: [...report.tokens.outliers] } };
    }
    const macros = buildMacroSnapshot(plan.macroSnapshot, plan.macroEngine, expand);
    const result = await simulateWorldInfo({ ...plan, entries, tokenCount,
        injections: plan.injections.map((value, index) => macros.expand(value, `prompt:${index}`)),
        expand: macros.expand, macroSnapshot: macros.cache, unfrozenMacros: macros.unsafe, volatileMacros: macros.volatile,
        timedEffects: plan.timedEffects ?? getTimedEffects({ chatMetadata: plan.macros.extra.chatMetadata }, entries, plan.chatLength ?? plan.messages.length),
        parseRegex: parseWorldInfoKeyRegex,
        processRegex: (content, depth) => applyRegexScriptList(content, plan.regex, AGENT_REGEX_PLACEMENT.WORLD_INFO,
            { depth, isMarkdown: false, isPrompt: true, substituteParamsFn: value => expand(value),
                substituteParamsExtendedFn: (value, _params, sanitizer) => expand(value, sanitizer) }),
    });
    return { ...result, snapshot: { entries, settings: plan.settings, plan: plan.sourcePlan,
        books: Object.fromEntries(Object.entries(plan.books).map(([name, target]) => [name, target.book])),
        missing: [], warnings: plan.warnings } };
}
