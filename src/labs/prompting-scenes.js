import { sceneTurnEntries, CAVEAT_EXISTING_CHAT } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/scenes.js';
import { readArtifact, writeArtifact, isDefiniteProviderRefusal } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { runChatProfile } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { capturePromptingContext, promptingMaterial } from './prompting-context.js';
import { promptingTokenCounter } from './prompting-suites.js';
import { computeLab } from './compute.js';
import { labError, withLabRecord } from './store.js';
import { promptingMemoryPreparation } from './prompting-memory.js';

export function capturePromptingScene(base, account, input) {
    if (!Array.isArray(input.presets) || !input.presets.length || input.presets.length > 4
        || !Array.isArray(input.turns) || input.turns.length > 4 || input.turns.some(turn => typeof turn !== 'string')
        || !['scripted', 'continue'].includes(input.mode ?? 'scripted')) throw labError('Choose up to four presets and scene turns.', 400);
    if (typeof input.connectionProfileId !== 'string' || !input.connectionProfileId) throw labError('Choose a saved connection for this scene.', 400);
    const maxTokens = input.maxTokens ?? 300;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw labError('The scene reply limit is invalid.', 400);
    const fullTurns = sceneTurnEntries(input);
    if (!fullTurns.length) throw labError('Write the first scene turn.', 400);
    const start = Math.max(Math.floor(Number(input.startAt)) || 1, 1);
    const found = fullTurns.findIndex(turn => turn.index >= start);
    const turns = fullTurns.slice(found < 0 ? Math.max(0, fullTurns.length - 1) : found);
    if (!Array.isArray(input.history ?? []) || (input.history ?? []).some(entry => !entry || !['assistant', 'user'].includes(entry.role) || typeof entry.text !== 'string')) {
        throw labError('The resumed scene history is invalid.', 400);
    }
    const opening = String(input.greeting ?? '');
    const history = [...(opening.trim() ? [{ role: 'assistant', text: opening }] : []), ...(input.history ?? []).filter(entry => entry.text.trim())];
    const columns = input.presets.map(preset => {
        if (!preset || typeof preset.apiId !== 'string' || typeof preset.name !== 'string' || !preset.name) throw labError('The scene preset is invalid.', 400);
        return { preset, context: capturePromptingContext(base, account, { characterAvatar: input.characterAvatar,
            personaKey: input.personaKey, connectionProfileId: input.connectionProfileId, presets: [preset] }, { maxTokens }) };
    });
    const display = { presets: input.presets, characterAvatar: input.characterAvatar, personaKey: input.personaKey ?? '',
        characterName: columns[0].context.environment.characterName, connectionName: columns[0].context.environment.profileName,
        connectionModel: columns[0].context.environment.model,
        connectionProfileId: input.connectionProfileId, greeting: opening, mode: input.mode ?? 'scripted',
        turns: input.turns, exchanges: Number(input.exchanges) || fullTurns.length, maxTokens, startAt: start, history: input.history ?? [] };
    return { columns, turns, fullTurns, history, opening, maxTokens, expectedRequests: columns.length * turns.length, display };
}

export async function runPromptingScene(context, plan, { generate = runChatProfile } = {}) {
    const columns = [];
    let completedRequests = 0;
    const partial = () => withLabRecord(context, ({ value, save }) => {
        value.partial = { columns, script: plan.turns.map(turn => turn.text), opening: plan.opening,
            completedRequests, expectedRequests: plan.expectedRequests, incomplete: true };
        save();
    });
    for (const [columnIndex, saved] of plan.columns.entries()) {
        const column = { preset: saved.preset, label: saved.preset.name, turns: [], error: '', done: false,
            caveats: saved.context.records.length > 1 ? [CAVEAT_EXISTING_CHAT] : [] };
        columns.push(column);
        const scene = structuredClone(plan.history);
        for (const turn of plan.turns) {
            context.signal.throwIfAborted();
            const step = `scene:${columnIndex}:${turn.index}`;
            let record = readArtifact(context.directories, context.job.id, step);
            if (record === undefined) {
                let capture = readArtifact(context.directories, context.job.id, `${step}:capture`);
                if (capture === undefined) {
                    const material = promptingMaterial(context.directories, saved.context);
                    const tokenCount = await promptingTokenCounter(context, saved.context, material);
                    capture = await computeLab('prompting.capture', { context: saved.context, material, scene,
                        userMessage: turn.text }, context.signal,
                    { tokenCount, prepareMemory: promptingMemoryPreparation(context, saved.context, tokenCount.tokenizer) });
                    writeArtifact(context.directories, context.job.id, `${step}:capture`, capture);
                }
                record = { index: turn.index, userText: turn.text, text: '', error: null, promptTokens: capture.tokenTable.total,
                    durationMs: 0, waiting: true };
                column.turns.push(record);
                partial();
                await context.progress({ stage: `${saved.preset.name}: turn ${turn.index}`, completed: completedRequests, total: plan.expectedRequests });
                const started = Date.now();
                try {
                    const reply = await generate({ context: { owner: context.owner, directories: context.directories }, jobContext: context,
                        binding: saved.context.binding, messages: capture.messages ?? [{ role: 'user', content: capture.combinedPrompt }],
                        maxTokens: plan.maxTokens, signal: context.signal, stepNamespace: step,
                        macroEnvironment: createMacroEnvironment(saved.context.macros), userName: saved.context.macros.names.user,
                        characterName: saved.context.macros.names.char, rawOptions: { includePreset: true, includeInstruct: !capture.combinedPrompt },
                        beforeDispatch: () => withLabRecord(context, () => {}) });
                    record.text = typeof reply === 'string' ? reply : String(reply?.text ?? '');
                    record.error = record.text.trim() ? null : 'The model returned an empty reply.';
                } catch (error) {
                    context.signal.throwIfAborted();
                    if (getJob(context.directories, context.job.id)?.recoverability === 'unknown-outcome' || !isDefiniteProviderRefusal(error.status)) throw error;
                    record.error = error.message;
                }
                record.durationMs = Date.now() - started;
                record.waiting = false;
                writeArtifact(context.directories, context.job.id, step, record);
            } else column.turns.push(record);
            completedRequests++;
            partial();
            if (record.error) break;
            scene.push({ role: 'user', text: turn.text }, { role: 'assistant', text: record.text });
        }
        column.done = true;
        partial();
    }
    await context.progress({ stage: 'Scene comparison saved', completed: completedRequests, total: plan.expectedRequests });
    return { columns, script: plan.turns.map(turn => turn.text), opening: plan.opening, restoreProblems: [], aborted: false,
        completedRequests, expectedRequests: plan.expectedRequests, incomplete: completedRequests < plan.expectedRequests };
}
