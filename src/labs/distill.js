import { createMacroEnvironment } from '../macros/index.js';
import { getCounter, getTokenizerModel } from '../mewmory/tokens.js';
import { resolveGenerationProfile } from '../generation/profiles.js';
import { runChatProfile } from '../generation/service.js';
import { createRoleplayTextCounter } from '../generation/roleplay-budget.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { captureLabBook } from './books.js';
import { captureLabChat, captureLabConnection } from './sources.js';
import { labError, withLabRecord } from './store.js';
import { messageLines, chunkLines, buildDistillPrompt, parseProposals, normalizeProposals, mergeProposals, markDuplicates }
    from '../../public/scripts/extensions/third-party/Neconyan-Lorebook-Distiller/src/core.js';

const RESPONSE_TOKENS = 1500;

export async function captureDistillPlan(base, account, input) {
    const chat = captureLabChat(base, account, input.locator);
    const target = captureLabBook(base, account, input.book, { create: input.create === true });
    const connection = await captureLabConnection(base, { profileId: input.profileId, acknowledgement: input.acknowledgement, maxTokens: RESPONSE_TOKENS }, chat.macros);
    const lines = messageLines(chat.records, { userName: chat.macros.names.user, characterName: chat.macros.names.char });
    if (!lines.length) throw labError('This saved chat has no messages to distill.', 400);
    return { target, chat, lines, ...connection, maxTokens: RESPONSE_TOKENS };
}

export async function runDistill(context, { generate = runChatProfile } = {}) {
    const plan = withLabRecord(context, ({ value }) => value.plan);
    const base = { owner: context.owner, directories: context.directories };
    let chunks = readArtifact(context.directories, context.job.id, 'distill-chunks');
    if (chunks === undefined) {
        const material = resolveGenerationProfile(context.directories, plan.binding);
        const count = material.backend === 'text' ? await createRoleplayTextCounter(base, material, { signal: context.signal })
            : (await getCounter(getTokenizerModel(material.profile?.model || 'gpt-4o'))).count;
        // Saved profiles used this conservative limit in the original Distiller.
        const budget = (plan.binding.kind === 'profile' ? Math.min(4096, plan.contextLimit) : plan.contextLimit) - plan.maxTokens - 512;
        if (budget < 1) throw labError('The selected connection context is too small for a distillation response.', 400);
        chunks = await chunkLines(plan.lines, count, budget, buildDistillPrompt);
        writeArtifact(context.directories, context.job.id, 'distill-chunks', chunks);
    }
    const collected = [];
    let failedChunks = 0;
    for (const [index, chunk] of chunks.entries()) {
        context.signal.throwIfAborted();
        await context.progress({ stage: 'Distilling saved chat', completed: index, total: chunks.length });
        const response = await generate({ context: base, jobContext: context, binding: plan.binding,
            messages: [{ role: 'user', content: buildDistillPrompt(chunk) }], maxTokens: plan.maxTokens,
            macroEnvironment: createMacroEnvironment(plan.chat.macros), userName: plan.chat.macros.names.user,
            characterName: plan.chat.macros.names.char, signal: context.signal, stepNamespace: `distill:${index}`,
            beforeDispatch: () => withLabRecord(context, () => {}) });
        try { collected.push(...parseProposals(response.text)); } catch { failedChunks++; }
    }
    const cleaned = normalizeProposals(collected);
    const proposals = markDuplicates(mergeProposals(cleaned.proposals), Object.values(plan.target.book.entries))
        .map((proposal, id) => ({ ...proposal, id }));
    await context.progress({ stage: 'Proposals saved for review', completed: chunks.length, total: chunks.length });
    return { target: plan.target, proposals, dropped: cleaned.dropped, failedChunks, chunks: chunks.length };
}
