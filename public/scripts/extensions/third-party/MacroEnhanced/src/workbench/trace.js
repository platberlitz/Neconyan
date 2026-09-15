/**
 * Per-span macro tracing for the Workbench. Spans are enumerated with the
 * engine's own parser (the same pattern core's {{if}}/{{else}} splitting uses),
 * then each span is evaluated separately. in document order, inside one shared
 * sandbox session, so earlier variable writes stay visible to later spans.
 *
 * Known limits: macros nested inside a span are not timed individually, and the
 * per-span total does not exactly equal a whole-document evaluation.
 */

/** Flat, in-order macro infos from the engine parser (thin adapter, untested). */
export function extractMacroInfos(text, { parser, cstWalker }) {
    const { cst } = parser.parseDocument(String(text ?? ''));
    const infos = [];
    for (const node of cst?.children?.macro ?? []) {
        const info = cstWalker.extractMacroInfo(node);
        if (info) {
            infos.push(info);
        }
    }
    return infos;
}

/**
 * Pairs a flat macro-info list into top-level spans. A scoped block runs from
 * its opener to the matching {{/name}} closer; like core, an opener only counts
 * as scoped when it has at most 1 argument (inline {{if cond::content}} has 2
 * and consumes no closer) and a matching closer actually follows.
 *
 * @param {{name: string, isClosing: boolean, argCount: number, startOffset: number, endOffset: number}[]} infos
 * @param {number} textLength - For closing an unterminated block at the end.
 * @returns {{startOffset: number, endOffset: number}[]}
 */
export function pairSpans(infos, textLength) {
    const spans = [];
    let blockStart = null;
    let blockName = null;
    let depth = 0;

    const scopedOpener = (info, index) => info.argCount <= 1
        && infos.some((other, otherIndex) => otherIndex > index && other.isClosing && other.name === info.name);

    for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        if (blockStart !== null) {
            if (info.name === blockName && info.isClosing) {
                depth--;
                if (depth === 0) {
                    spans.push({ startOffset: blockStart, endOffset: info.endOffset });
                    blockStart = null;
                    blockName = null;
                }
            } else if (info.name === blockName && !info.isClosing && info.argCount <= 1) {
                depth++;
            }
            continue;
        }
        if (info.isClosing) {
            continue; // stray closer. the engine treats it as text
        }
        if (scopedOpener(info, i)) {
            blockStart = info.startOffset;
            blockName = info.name;
            depth = 1;
        } else {
            spans.push({ startOffset: info.startOffset, endOffset: info.endOffset });
        }
    }
    if (blockStart !== null) {
        spans.push({ startOffset: blockStart, endOffset: Math.max(blockStart, textLength - 1) });
    }
    return spans;
}

/**
 * Traces the text: every top-level span evaluated separately with timing.
 *
 * @param {string} text
 * @param {object} deps
 * @param {(text: string) => object[]} deps.extract - Text -> macro infos.
 * @param {(slice: string) => string} deps.evaluate - Sandboxed evaluation, one shared session.
 * @param {() => number} [deps.now]
 * @returns {{text: string, output: string, ms: number, error: string|null}[]}
 */
export function runTrace(text, { extract, evaluate, now = () => performance.now() }) {
    const s = String(text ?? '');
    const spans = pairSpans(extract(s), s.length);
    return spans.map(span => {
        const slice = s.slice(span.startOffset, span.endOffset + 1);
        const started = now();
        let output = '';
        let error = null;
        try {
            output = String(evaluate(slice));
        } catch (evalError) {
            error = evalError?.message ?? String(evalError);
        }
        return { text: slice, output, ms: now() - started, error };
    });
}
