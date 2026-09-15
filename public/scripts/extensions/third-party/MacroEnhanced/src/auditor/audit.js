/**
 * The Cache Auditor pipeline: enumerate sources, statically classify their
 * macros, empirically double-evaluate to catch unknown volatiles, and map chat
 * findings against the configured cache depth.
 */
import { collectSources } from './sources.js';
import { CLASS_PERIODIC, CLASS_STABLE, CLASS_WHY, NAME_NOTES, SEVERITY, classifySource } from './volatility.js';
import { computeMessageDepths, messageVerdict, resolveCachingConfig } from './depth.js';
import { getEffectiveDefs } from '../custom/store.js';

/** Classes that actually break a byte-stable prefix. */
export function isVolatileClass(cls) {
    return SEVERITY[cls] > SEVERITY[CLASS_PERIODIC];
}

function classificationDeps() {
    const ctx = SillyTavern.getContext();
    const registry = ctx.macros?.registry;
    const customTemplates = new Map();
    for (const { def } of getEffectiveDefs()) {
        customTemplates.set(def.name.toLowerCase(), String(def.template ?? ''));
    }
    return {
        getRegistryCategory: (name) => registry?.getMacro?.(name)?.category ?? null,
        getCustomTemplate: (name) => customTemplates.get(name) ?? null,
    };
}

/**
 * Runs a full audit.
 *
 * @param {object} [options]
 * @param {(text: string) => string} [options.sandboxEvaluate] - Sandboxed engine evaluation
 *        for the empirical pass; omit to skip it (e.g. engine off). Both evaluations of
 *        a source run in the SAME sandbox session, so {{freeze}} correctly reads its own
 *        first-pass value on the second pass and reports stable.
 * @param {() => Promise<object>} [options.resolveConfig] - Injectable for tests.
 * @returns {Promise<{config: object, notes: string[], findings: object[]}>}
 */
export async function runAudit({ sandboxEvaluate, resolveConfig = resolveCachingConfig } = {}) {
    const ctx = SillyTavern.getContext();
    const config = await resolveConfig();
    const { sources, notes } = collectSources();
    const deps = classificationDeps();

    if (!sandboxEvaluate) {
        notes.push('The empirical double-evaluation pass was skipped (macro engine unavailable).');
    }

    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const depths = computeMessageDepths(chat.map(message => ({ isUser: !!message?.is_user })));
    const cachingActive = config.cachingAtDepth !== null || config.enableSystemPromptCache === true;

    const findings = [];
    for (const source of sources) {
        const classified = classifySource(source.text, deps);

        let empiricallyVolatile = false;
        if (sandboxEvaluate) {
            try {
                empiricallyVolatile = sandboxEvaluate(source.text) !== sandboxEvaluate(source.text);
            } catch (error) {
                notes.push(`"${source.label}" could not be evaluated: ${error?.message ?? error}`);
            }
        }

        for (const entry of classified) {
            if (entry.cls === CLASS_STABLE) {
                continue;
            }
            const volatile = isVolatileClass(entry.cls);
            let verdict;
            if (!volatile) {
                verdict = 'friendly';
            } else if (source.kind === 'chat') {
                verdict = source.isUser ? 'baked' : messageVerdict(depths[source.index] ?? 0, config.cachingAtDepth);
            } else {
                verdict = cachingActive ? 'costly' : 'no-caching';
            }
            const why = [CLASS_WHY[entry.cls]];
            if (NAME_NOTES[entry.name]) {
                why.push(NAME_NOTES[entry.name]);
            }
            if (entry.via.length) {
                why.push(`via {{${entry.via.join('}} → {{')}}}`);
            }
            findings.push({
                sourceKind: source.kind,
                sourceLabel: source.label,
                name: entry.name,
                cls: entry.cls,
                count: entry.count,
                verdict,
                why: why.join('; '),
                empiric: false,
            });
        }

        if (empiricallyVolatile && !classified.some(entry => isVolatileClass(entry.cls))) {
            findings.push({
                sourceKind: source.kind,
                sourceLabel: source.label,
                name: '(unrecognized)',
                cls: 'random',
                count: 1,
                verdict: source.kind === 'chat'
                    ? (source.isUser ? 'baked' : messageVerdict(depths[source.index] ?? 0, config.cachingAtDepth))
                    : (cachingActive ? 'costly' : 'no-caching'),
                why: 'two back-to-back evaluations produced different text',
                empiric: true,
            });
        }
    }

    findings.sort((a, b) => SEVERITY[b.cls] - SEVERITY[a.cls] || a.sourceLabel.localeCompare(b.sourceLabel));
    return { config, notes, findings };
}

const VERDICT_TEXT = {
    costly: 'inside the cached prefix. costs money every generation',
    harmless: 'below the cache breakpoints. harmless',
    'no-caching': 'caching looks off / unknown. would cost money if enabled',
    baked: 'in one of your messages. already baked in unless literal {{…}} survived',
    friendly: 'cache-friendly by design',
};

/** Renders an audit result as a markdown report (for /me-audit). */
export function formatAuditReport({ config, notes, findings }) {
    const lines = [];
    const depthText = config.cachingAtDepth === null ? 'unknown/off' : String(config.cachingAtDepth);
    const configBits = [`caching depth: ${depthText} (${config.source})`];
    if (config.enableSystemPromptCache !== null && config.source === 'server') {
        configBits.push(`system-prompt cache: ${config.enableSystemPromptCache ? 'on' : 'off'}`);
        configBits.push(`TTL: ${config.extendedTTL ? '1h' : '5m'}`);
    }
    lines.push(`Cache audit. ${configBits.join(', ')}`);

    const problems = findings.filter(finding => isVolatileClass(finding.cls));
    const friendly = findings.filter(finding => !isVolatileClass(finding.cls));
    if (!problems.length) {
        lines.push('No cache-breaking macros found. Nice and byte-stable.');
    } else {
        lines.push('', `${problems.length} cache-breaking finding(s):`);
        for (const finding of problems) {
            lines.push(`- ${finding.sourceLabel}: {{${finding.name}}}${finding.count > 1 ? ` ×${finding.count}` : ''} [${finding.cls}]. ${VERDICT_TEXT[finding.verdict] ?? finding.verdict}. (${finding.why})`);
        }
    }
    if (friendly.length) {
        lines.push('', `${friendly.length} cache-friendly-by-design finding(s): ${[...new Set(friendly.map(finding => `{{${finding.name}}}`))].join(', ')}`);
    }
    for (const note of notes) {
        lines.push(`Note: ${note}`);
    }
    return lines.join('\n');
}
