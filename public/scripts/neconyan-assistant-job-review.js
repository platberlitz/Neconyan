import { getJob, getJobApproval, decideJobApproval, listJobs, TERMINAL } from './jobs.js';
import { getCurrentUserHandle } from './user.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { buildAssistantReview, buildNoteProposalReview } from './neconyan-assistant-review.js';

const pending = new Map();
const refreshed = new Set();
const browserMacroFailures = new Set();
let queue = Promise.resolve();

const BROWSER_MACRO_FIELDS = Object.freeze(['name', 'template', 'description', 'args', 'expectedTemplate']);
function browserMacroDraft(argumentsValue) {
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return argumentsValue;
    return Object.fromEntries(BROWSER_MACRO_FIELDS
        .filter(field => Object.hasOwn(argumentsValue, field))
        .map(field => [field, argumentsValue[field]]));
}

function rememberBrowserMacroFailure(key) {
    browserMacroFailures.add(key);
    if (browserMacroFailures.size > 256) browserMacroFailures.delete(browserMacroFailures.values().next().value);
}

function surfaceBrowserMacroFailure(message) {
    try {
        globalThis.toastr?.error?.(message, 'Browser macro not saved');
    } catch { /* A missing notification surface must not retry the popup. */ }
}

async function isWaitingApproval(job, account, approvalId) {
    const body = await getJob(job.id, { account });
    const current = body?.job ?? body;
    return Boolean(current && current.owner === account && current.state === 'waiting'
        && current.stage === 'approval' && current.result?.approval?.id === approvalId
        && !current.cancellation?.requested);
}

async function decideWaiting(job, account, approvalId, decision) {
    if (account !== getCurrentUserHandle() || !await isWaitingApproval(job, account, approvalId)) return false;
    const current = await getJobApproval(job.id, approvalId, { account });
    if (account !== getCurrentUserHandle() || current.decision !== null) return false;
    await decideJobApproval(job.id, { ...current, decision }, { account });
    return true;
}

/**
 * The browser host writes the macro and then reports success. Only that exact
 * success allows the durable job; a conflict or storage error leaves the
 * approval pending and is not retried automatically on every poll.
 */
async function reviewBrowserMacro(job, account, initialApproval) {
    const key = `${account}:${job.id}:${initialApproval.id}`;
    if (browserMacroFailures.has(key) || initialApproval.decision !== null) return;
    if (account !== getCurrentUserHandle() || !await isWaitingApproval(job, account, initialApproval.id)) return;
    const approval = await getJobApproval(job.id, initialApproval.id, { account });
    if (account !== getCurrentUserHandle() || approval.decision !== null) return;
    let host;
    try {
        host = await import('./neconyan-assistant-macros.js');
    } catch {
        rememberBrowserMacroFailure(key);
        surfaceBrowserMacroFailure('The browser macro library is unavailable. The macro was not saved; the approval is still pending.');
        return;
    }
    if (typeof host.reviewAndSaveBrowserMacro !== 'function') {
        rememberBrowserMacroFailure(key);
        surfaceBrowserMacroFailure('The browser macro library is unavailable. The macro was not saved; the approval is still pending.');
        return;
    }
    let result;
    try {
        result = await host.reviewAndSaveBrowserMacro(browserMacroDraft(approval.proposal?.arguments ?? {}), {
            account,
            // Check the saved approval again at the helper's pre-commit point,
            // after its review popup, so a cancelled or decided job cannot write.
            isCurrent: async () => {
                if (account !== getCurrentUserHandle()) return false;
                const current = await getJobApproval(job.id, approval.id, { account });
                return current.decision === null && await isWaitingApproval(job, account, approval.id);
            },
            proposalId: `${account}/${job.id}/${approval.id}`,
        });
    } catch (error) {
        if (account !== getCurrentUserHandle()) return;
        rememberBrowserMacroFailure(key);
        surfaceBrowserMacroFailure(`${error instanceof Error ? error.message : String(error)} The approval is still pending.`);
        return;
    }
    if (account !== getCurrentUserHandle()) return;
    if (result?.status === 'cancelled') {
        // A stale account or request is not the user declining this macro. Only
        // an explicit current decline may deny the durable approval.
        if (result.declined === true) await decideWaiting(job, account, approval.id, 'deny');
        return;
    }
    if (result?.status !== 'success' || result.committed !== true) {
        rememberBrowserMacroFailure(key);
        const reason = result?.message || (result?.status === 'success'
            ? 'The browser did not confirm that the macro was saved.'
            : result?.status === 'conflict'
                ? 'The macro library changed before the macro could be saved.'
                : 'The browser macro library could not save the macro.');
        surfaceBrowserMacroFailure(`${reason} The approval is still pending.`);
        return;
    }
    await decideWaiting(job, account, approval.id, 'allow');
}

async function review(job, account) {
    if (account !== getCurrentUserHandle()) return;
    const approval = await getJobApproval(job.id, job.result.approval.id, { account });
    const kind = approval.proposal?.kind;
    if (account !== getCurrentUserHandle() || approval.decision !== null
        || !['neconyan-assistant-edit', 'neconyan-note-proposal', 'neconyan-browser-macro'].includes(kind)) return;
    if (kind === 'neconyan-browser-macro') return reviewBrowserMacro(job, account, approval);
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
