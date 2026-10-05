import { getJobApproval, decideJobApproval, listJobs, TERMINAL } from './jobs.js';
import { getCurrentUserHandle } from './user.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { buildAssistantReview, buildNoteProposalReview } from './neconyan-assistant-review.js';

const pending = new Map();
const refreshed = new Set();
let queue = Promise.resolve();

async function review(job, account) {
    if (account !== getCurrentUserHandle()) return;
    const approval = await getJobApproval(job.id, job.result.approval.id, { account });
    const kind = approval.proposal?.kind;
    if (account !== getCurrentUserHandle() || approval.decision !== null || !['neconyan-assistant-edit', 'neconyan-note-proposal'].includes(kind)) return;
    const proposal = approval.proposal;
    const args = proposal.arguments;
    const node = kind === 'neconyan-note-proposal'
        ? buildNoteProposalReview({ summary: proposal.summary, diff: proposal.diff })
        : buildAssistantReview({ resource: proposal.resource.kind, target: proposal.resource.id,
            field: args.field || (args.agent ? 'new agent (switched off)' : 'Character and optional generated avatar'), before: proposal.before,
            after: Object.hasOwn(args, 'value') ? args.value : args });
    const result = await callGenericPopup(node, POPUP_TYPE.CONFIRM, '', { wide: true, large: true });
    if (account !== getCurrentUserHandle()) return;
    await decideJobApproval(job.id, { ...approval, decision: result === POPUP_RESULT.AFFIRMATIVE ? 'allow' : 'deny' }, { account });
}

/** Discover only owned descendants; reopening the page can resume a pending review. */
export async function reviewAssistantJobChildren(root, account) {
    if ((root?.state !== 'waiting' && !TERMINAL.has(root?.state)) || !root.children?.length || account !== getCurrentUserHandle()) return;
    const jobs = new Map((await listJobs({ account })).map(job => [job.id, job]));
    const visit = [root];
    const seen = new Set();
    for (const job of visit) {
        if (seen.has(job.id) || account !== getCurrentUserHandle()) continue;
        seen.add(job.id);
        const completed = job.result?.result;
        if (job.type === 'media.assistant-tool' && job.state === 'completed'
            && completed?.tool === 'Neconyan_Assistant_CreateAgent' && completed.result?.committed) {
            const key = `${account}:${job.id}`;
            if (!refreshed.has(key)) {
                const { loadCreatedAgent } = await import('./extensions/in-chat-agents/agent-store.js');
                await loadCreatedAgent(completed.result.id, { account, isCurrent: () => account === getCurrentUserHandle() });
                if (account !== getCurrentUserHandle()) return;
                refreshed.add(key);
                if (refreshed.size > 256) refreshed.delete(refreshed.values().next().value);
                window.dispatchEvent(new CustomEvent('neconyan:assistant-agent-updated', { detail: { id: completed.result.id } }));
            }
        }
        if (job.type === 'media.assistant-tool' && job.state === 'waiting' && job.stage === 'approval' && job.result?.approval?.id) {
            const key = `${account}:${job.id}:${job.result.approval.id}`;
            if (!pending.has(key)) {
                const task = queue.catch(() => {}).then(() => review(job, account));
                queue = task;
                pending.set(key, task);
                void task.finally(() => pending.delete(key)).catch(() => {});
            }
            await pending.get(key);
        }
        for (const id of job.children ?? []) {
            const child = jobs.get(id);
            if (child?.parentId === job.id && child.owner === account) visit.push(child);
        }
    }
}
