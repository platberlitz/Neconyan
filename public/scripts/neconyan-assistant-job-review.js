import { getJobApproval, decideJobApproval, listJobs } from './jobs.js';
import { getCurrentUserHandle } from './user.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { buildAssistantReview, buildNoteProposalReview } from './neconyan-assistant-review.js';

const pending = new Map();
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
            field: args.field || 'Character and optional generated avatar', before: proposal.before,
            after: Object.hasOwn(args, 'value') ? args.value : args });
    const result = await callGenericPopup(node, POPUP_TYPE.CONFIRM, '', { wide: true, large: true });
    if (account !== getCurrentUserHandle()) return;
    await decideJobApproval(job.id, { ...approval, decision: result === POPUP_RESULT.AFFIRMATIVE ? 'allow' : 'deny' }, { account });
}

/** Discover only owned descendants; reopening the page can resume a pending review. */
export async function reviewAssistantJobChildren(root, account) {
    if (root?.state !== 'waiting' || !root.children?.length || account !== getCurrentUserHandle()) return;
    const jobs = new Map((await listJobs({ account })).map(job => [job.id, job]));
    const visit = [root];
    const seen = new Set();
    for (const job of visit) {
        if (seen.has(job.id) || account !== getCurrentUserHandle()) continue;
        seen.add(job.id);
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
