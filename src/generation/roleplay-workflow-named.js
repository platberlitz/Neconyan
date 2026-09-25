/**
 * Named Roleplay workflows: the server's own semantics for the browser's controls.
 *
 * The browser names a workflow and supplies only what a user typed or what the
 * saved extension had already written down. The server owns the effect, the
 * prompt window, the anchor and the prompt contributions, so a named workflow
 * is one bounded model turn whose durable write is the only result.
 *
 * Named workflows never capture an automatic policy: Story, Guided and Deep
 * Swipe each ask for one specific generation, and the absence of a policy is
 * what ends the workflow after its first turn.
 */
import { roleplayError, roleplayHash } from '../roleplay-store.js';

const ROLES = ['system', 'user', 'assistant'];
const MAX_INSTRUCTION_BYTES = 20 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_DEPTH = 10000;

const invalid = (message, status = 409) => roleplayError('ROLEPLAY_WORKFLOW_INVALID', message, status);

/**
 * The complete named vocabulary. `anchor` names how the server resolves the one
 * message the effect writes, and `prompt` names the saved contribution the
 * server adds to the assembled prompt.
 */
export const ROLEPLAY_WORKFLOW_NAMES = Object.freeze({
    'roleplay.reply': { effect: 'append', anchor: 'end', prompt: 'none', instruction: 'none' },
    'roleplay.continue': { effect: 'continue', anchor: 'last', prompt: 'none', instruction: 'optional' },
    'roleplay.swipe': { effect: 'swipe', anchor: 'last', prompt: 'none', instruction: 'none' },
    'roleplay.correct': { effect: 'replace', anchor: 'assistant', prompt: 'none', instruction: 'none' },
    'story.passage': { effect: 'continue', anchor: 'last', prompt: 'story', instruction: 'none' },
    'guided.response': { effect: 'append', anchor: 'end', prompt: 'guided', instruction: 'none' },
    'guided.swipe': { effect: 'swipe', anchor: 'last', prompt: 'guided', instruction: 'none' },
    'guided.correction': { effect: 'replace', anchor: 'assistant', prompt: 'guided', instruction: 'none' },
    'deep-swipe.reply': { effect: 'alternative', anchor: 'chosen', prompt: 'none', instruction: 'required' },
    'deep-swipe.user': { effect: 'alternative', anchor: 'chosen', prompt: 'none', instruction: 'required' },
});

export function roleplayWorkflowName(name) {
    const named = ROLEPLAY_WORKFLOW_NAMES[name];
    if (!named) throw invalid('Unknown named Roleplay workflow.', 400);
    return named;
}

function text(value, label, maxBytes) {
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) {
        throw invalid(`The named ${label} text is invalid.`, 400);
    }
    return value;
}

function optionalText(value, label, maxBytes) {
    if (value === undefined || value === null || value === '') return '';
    return text(value, label, maxBytes);
}

/** Deep Swipe's saved prompt is a user instruction, never a system override. */
function normalizeInstruction(value) {
    const instruction = text(value, 'workflow instruction', MAX_INSTRUCTION_BYTES);
    if (instruction.includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(instruction)) {
        throw invalid('The named workflow instruction needs server-side macro handling.', 400);
    }
    return instruction;
}

/** Guided Generations injects an in-chat prompt at the saved depth and role. */
function normalizeGuided(prompt) {
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)
        || Object.keys(prompt).some(key => !['text', 'depth', 'role', 'scan'].includes(key))
        || !Number.isSafeInteger(prompt.depth) || prompt.depth < 0 || prompt.depth > MAX_DEPTH
        || !ROLES.includes(prompt.role) || typeof prompt.scan !== 'boolean') {
        throw invalid('The named Guided prompt is invalid.', 400);
    }
    return { text: text(prompt.text, 'Guided', MAX_PROMPT_BYTES), depth: prompt.depth, role: prompt.role, scan: prompt.scan };
}

/** Story Mode keeps its manuscript rules and its one-passage direction apart. */
function normalizeStory(prompt) {
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)
        || Object.keys(prompt).some(key => !['rules', 'rulesDepth', 'direction', 'directionDepth'].includes(key))
        || !Number.isSafeInteger(prompt.rulesDepth) || prompt.rulesDepth < 0 || prompt.rulesDepth > MAX_DEPTH
        || !Number.isSafeInteger(prompt.directionDepth) || prompt.directionDepth < 0 || prompt.directionDepth > MAX_DEPTH) {
        throw invalid('The named Story prompt is invalid.', 400);
    }
    return { rules: text(prompt.rules, 'Story rules', MAX_PROMPT_BYTES), rulesDepth: prompt.rulesDepth,
        direction: optionalText(prompt.direction, 'Story direction', MAX_INSTRUCTION_BYTES), directionDepth: prompt.directionDepth };
}

/**
 * Turn a browser's named intent into the server's own workflow record. The
 * record is hashed and travels inside the admitted request, so a changed
 * instruction, prompt or name is a different intent under the same key.
 */
export function captureRoleplayNamedWorkflow(name, intent = {}) {
    const named = roleplayWorkflowName(name);
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)
        || Object.keys(intent).some(key => !['instruction', 'prompt'].includes(key))) {
        throw invalid('The named workflow intent is invalid.', 400);
    }
    const instruction = intent.instruction === undefined || intent.instruction === null || intent.instruction === ''
        ? '' : normalizeInstruction(intent.instruction);
    if (named.instruction === 'required' && !instruction) throw invalid('A Deep Swipe needs its own instruction.', 400);
    if (named.instruction === 'none' && instruction) throw invalid('The named workflow takes an instruction it cannot use.', 400);
    if ((named.prompt === 'guided' || named.prompt === 'story') !== (intent.prompt !== undefined)) {
        throw invalid('The named workflow takes a prompt it was not given, or one it cannot use.', 400);
    }
    const record = { version: 1, name, effect: named.effect, anchor: named.anchor, instruction,
        prompt: named.prompt === 'guided' ? normalizeGuided(intent.prompt)
            : named.prompt === 'story' ? normalizeStory(intent.prompt) : null };
    return { ...record, hash: roleplayHash(record) };
}

/** Re-check a workflow record that arrived inside an admitted request. */
export function assertRoleplayNamedWorkflow(workflow, { effect } = {}) {
    const named = workflow && typeof workflow.name === 'string' ? ROLEPLAY_WORKFLOW_NAMES[workflow.name] : null;
    if (!named || workflow.version !== 1 || named.effect !== workflow.effect || named.anchor !== workflow.anchor
        || (effect !== undefined && effect !== workflow.effect)) {
        throw invalid('The saved named workflow changed.');
    }
    const record = { version: workflow.version, name: workflow.name, effect: workflow.effect,
        anchor: workflow.anchor, instruction: workflow.instruction, prompt: workflow.prompt };
    if (workflow.hash !== roleplayHash(record)) throw invalid('The saved named workflow changed.');
    if (named.prompt === 'guided') normalizeGuided(workflow.prompt);
    else if (named.prompt === 'story') normalizeStory(workflow.prompt);
    else if (workflow.prompt !== null) throw invalid('The saved named workflow changed.');
    if (typeof workflow.instruction !== 'string' || (named.instruction === 'required' ? !workflow.instruction.trim()
        : named.instruction === 'none' && Boolean(workflow.instruction))) {
        throw invalid('The saved named workflow changed.');
    }
    return workflow;
}

/**
 * The prompt contributions one named workflow turn publishes. Group speaker
 * context keeps its own protected slot; a named workflow never carries a group
 * speaker, so the two cannot collide.
 */
export function roleplayWorkflowContributions(workflow, { speaker = null, speakerIndex = 0, history = [] } = {}) {
    const extensions = [];
    const instructions = [];
    if (speaker) {
        extensions.push({ key: `roleplay_group_speaker_${speakerIndex}`, content: speaker.contextPrompt,
            position: 0, depth: 0, role: 'system', scan: false });
    }
    if (workflow) {
        const named = ROLEPLAY_WORKFLOW_NAMES[workflow.name];
        assertRoleplayNamedWorkflow(workflow);
        if (named.prompt === 'guided') {
            extensions.push({ key: 'guided_prompt', content: workflow.prompt.text, position: 1,
                depth: workflow.prompt.depth, role: workflow.prompt.role, scan: workflow.prompt.scan });
        } else if (named.prompt === 'story') {
            extensions.push({ key: 'story_rules', content: workflow.prompt.rules, position: 1,
                depth: workflow.prompt.rulesDepth, role: 'system', scan: false });
            if (workflow.prompt.direction) {
                extensions.push({ key: 'story_direction', content: workflow.prompt.direction, position: 1,
                    depth: workflow.prompt.directionDepth, role: 'system', scan: false });
            }
        } else if (named.instruction !== 'none' && workflow.instruction) {
            instructions.push({ role: 'user', content: workflow.instruction });
        }
    }
    if (new Set(extensions.map(prompt => prompt.key)).size !== extensions.length) {
        throw invalid('The named workflow needs a unique prompt slot.');
    }
    return { extensions, history: [...history, ...instructions], tools: [] };
}

/**
 * The bounded result facts a named workflow publishes with its durable write.
 * A browser uses them to update its own bookkeeping after reading the finished
 * chat, so each one is proved from the records the server actually saved.
 */
export function roleplayWorkflowResultFacts(workflow, { before = null, after = null, messageIndex = null } = {}) {
    if (!workflow || !Array.isArray(before) || !Array.isArray(after)) return null;
    if (workflow.effect === 'append') {
        return after.length === before.length + 1 ? { appended: true } : null;
    }
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= after.length - 1) return null;
    const message = after[messageIndex + 1];
    if (!message) return null;
    if (workflow.effect === 'continue') {
        const previous = before[messageIndex + 1]?.mes;
        const current = message.mes;
        if (typeof previous !== 'string' || typeof current !== 'string' || !current.startsWith(previous)) return null;
        return { cut: previous.length, length: current.length };
    }
    if (workflow.effect === 'replace') {
        const current = message.mes;
        if (typeof current !== 'string' || current === before[messageIndex + 1]?.mes) return null;
        return { replaced: true, length: current.length };
    }
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    if (!swipes.length) return null;
    // A selected swipe is the new answer; an alternative is the extra, unselected one.
    return { index: workflow.effect === 'alternative' ? swipes.length - 1 : Number(message.swipe_id ?? 0), count: swipes.length };
}
