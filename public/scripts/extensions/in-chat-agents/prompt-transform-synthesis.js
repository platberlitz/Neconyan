/**
 * Shared planning and merging for post-generation prompt transforms, used by
 * the browser runner and the native Roleplay pipeline.
 *
 * Rewrite agents edit the reply body one after another. Append agents read the
 * same body and return add-on blocks (choices, menus, trackers) that are held
 * aside, so later rewrites never reword them, and are reattached around the
 * finished body once every agent has answered.
 */

const MIN_MATCH_LENGTH = 20;
const RESPONSE_TAG_RE = /^\s*<\/?assistant_response>\s*|\s*<\/?assistant_response>\s*$/gi;

export function normalizeSynthesisText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Orders transform agents into stages. Each stage is either one rewrite agent
 * or a group of append agents that share the same body.
 * Run together: rewrites stay in order and every append agent forms one group
 * that runs beside them. Run one at a time: Order is followed exactly and only
 * neighbouring append agents share a group.
 */
export function planPromptTransformStages(agents, { parallel = false, isAppend } = {}) {
    const list = (Array.isArray(agents) ? agents : []).filter(Boolean);
    if (parallel) {
        const appendAgents = list.filter(agent => isAppend(agent));
        const stages = list.filter(agent => !isAppend(agent)).map(agent => ({ type: 'rewrite', agents: [agent] }));
        if (appendAgents.length > 0) {
            stages.push({ type: 'append', agents: appendAgents });
        }
        return stages;
    }

    const stages = [];
    for (const agent of list) {
        if (!isAppend(agent)) {
            stages.push({ type: 'rewrite', agents: [agent] });
            continue;
        }
        const previous = stages.at(-1);
        if (previous?.type === 'append') {
            previous.agents.push(agent);
        } else {
            stages.push({ type: 'append', agents: [agent] });
        }
    }
    return stages;
}

export function createPromptTransformDraft(body = '') {
    return { body: String(body ?? ''), before: [], after: [] };
}

// Where `body` stops matching the start (or end) of `output`, ignoring whitespace, or null.
function findEdgeMatch(output, body, fromEnd) {
    const step = fromEnd ? -1 : 1;
    const inRange = (text, index) => index >= 0 && index < text.length;
    let outputIndex = fromEnd ? output.length - 1 : 0;
    let bodyIndex = fromEnd ? body.length - 1 : 0;
    for (;;) {
        while (inRange(body, bodyIndex) && /\s/.test(body[bodyIndex])) bodyIndex += step;
        if (!inRange(body, bodyIndex)) return outputIndex;
        while (inRange(output, outputIndex) && /\s/.test(output[outputIndex])) outputIndex += step;
        if (!inRange(output, outputIndex) || output[outputIndex] !== body[bodyIndex]) return null;
        outputIndex += step;
        bodyIndex += step;
    }
}

/**
 * Cleans one append agent's output against the reply body: drops a copy of the
 * reply the model echoed before or after its new content, and drops a block the
 * reply already contains. Returns the block to add, or an empty string.
 */
export function cleanAppendOutput(outputText, bodyText) {
    let output = String(outputText ?? '').replace(RESPONSE_TAG_RE, '').trim();
    const body = String(bodyText ?? '').trim();
    const normalizedBody = normalizeSynthesisText(body);
    if (!output || normalizeSynthesisText(output) === normalizedBody) {
        return '';
    }
    if (normalizedBody.length < MIN_MATCH_LENGTH) {
        return output;
    }

    const leading = findEdgeMatch(output, body, false);
    const trailing = leading === null ? findEdgeMatch(output, body, true) : null;
    if (leading !== null) {
        output = output.slice(leading);
    } else if (trailing !== null) {
        output = output.slice(0, trailing + 1);
    }
    output = output.replace(RESPONSE_TAG_RE, '').trim();

    const normalizedOutput = normalizeSynthesisText(output);
    if (!normalizedOutput || normalizedOutput.length >= MIN_MATCH_LENGTH && normalizedBody.includes(normalizedOutput)) {
        return '';
    }
    return output;
}

/**
 * Adds append outputs to a draft in agent order. Each block is cleaned against
 * the body and skipped when an earlier agent already added the same block.
 */
export function addAppendOutputs(draft, outputs, { isPrepend = () => false, bodyText = draft.body } = {}) {
    const seen = new Set([...draft.before, ...draft.after].map(normalizeSynthesisText));
    const added = [];
    for (const { agent, text } of Array.isArray(outputs) ? outputs : []) {
        const block = cleanAppendOutput(text, bodyText);
        const key = normalizeSynthesisText(block);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        (isPrepend(agent, block) ? draft.before : draft.after).push(block);
        added.push(block);
    }
    return added;
}

/** Joins held add-on blocks around the body; with no blocks the body is returned as is. */
export function composePromptTransformDraft(draft, join) {
    let text = draft.body;
    if (draft.before.length > 0) {
        text = join(draft.before.join('\n\n'), text);
    }
    if (draft.after.length > 0) {
        text = join(text, draft.after.join('\n\n'));
    }
    return text;
}

/**
 * Runs planned stages over one reply.
 * runRewrite(agent, body) resolves to { text?, stop? }: text replaces the body.
 * runAppend(agents, body) resolves to { outputs?: [{ agent, text }], stop? }.
 * With `parallel`, the append group starts on the incoming body at the same
 * time as the rewrite chain. A stop from either side ends the run and leaves
 * outputs from the stopping append group out.
 */
export async function runPromptTransformStages({
    agents,
    text = '',
    parallel = false,
    isAppend,
    isPrepend = () => false,
    runRewrite,
    runAppend,
    shouldStop = () => false,
}) {
    const draft = createPromptTransformDraft(text);
    const stages = planPromptTransformStages(agents, { parallel, isAppend });
    let stopped = false;

    const applyRewrite = async (agent) => {
        if (stopped || shouldStop()) {
            stopped = true;
            return;
        }
        const outcome = await runRewrite(agent, draft.body);
        if (typeof outcome?.text === 'string') {
            draft.body = outcome.text;
        }
        if (outcome?.stop) {
            stopped = true;
        }
    };
    const applyAppend = (outcome, bodyText) => {
        if (stopped || outcome?.stop) {
            stopped = true;
            return;
        }
        addAppendOutputs(draft, outcome?.outputs, { isPrepend, bodyText });
    };

    const appendStage = parallel ? stages.find(stage => stage.type === 'append') : null;
    if (appendStage) {
        const startBody = draft.body;
        const pending = shouldStop()
            ? Promise.resolve({ ok: true, value: { stop: true } })
            : Promise.resolve()
                .then(() => runAppend(appendStage.agents, startBody))
                .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        let rewriteError = null;
        try {
            for (const stage of stages) {
                if (stage.type === 'rewrite') await applyRewrite(stage.agents[0]);
            }
        } catch (error) {
            rewriteError = error;
        }
        const settled = await pending;
        if (rewriteError) throw rewriteError;
        if (!settled.ok) throw settled.error;
        applyAppend(settled.value, startBody);
    } else {
        for (const stage of stages) {
            if (stopped) break;
            if (stage.type === 'rewrite') {
                await applyRewrite(stage.agents[0]);
                continue;
            }
            if (shouldStop()) {
                stopped = true;
                break;
            }
            const body = draft.body;
            applyAppend(await runAppend(stage.agents, body), body);
        }
    }

    return { draft, stopped };
}
