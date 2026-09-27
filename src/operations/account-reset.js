import { prepareRoleplayResetContent, resetRoleplayAccount, readRoleplayAccountReset } from '../roleplay-store.js';
import { captureUserResetContent } from '../endpoints/content-manager.js';
import { acceptApplicationOperation, registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';
import { accountResetOperationKey, accountResetResult } from './account-reset-proof.js';

const authorisedRequests = new WeakSet();

/** The existing password and reset-code route is the only admission authority. */
export async function acceptAccountReset(request, key) {
    authorisedRequests.add(request);
    try { return await acceptApplicationOperation(request, { key, kind: 'account-reset' }); } finally { authorisedRequests.delete(request); }
}

export function captureAccountReset(base, account, _input, { content = captureUserResetContent(base.directories) } = {}) {
    return { account, contentHash: prepareRoleplayResetContent(base, account, content) };
}

export function runAccountReset(context, plan, { afterAccountReset = () => {} } = {}) {
    const value = withOperation(context, ({ value, save }) => {
        context.signal.throwIfAborted();
        const operationKey = accountResetOperationKey(value);
        value.effects.reset = { state: 'prepared', operationKey };
        save();
        return value;
    });
    const base = { owner: context.owner, directories: context.directories };
    const operationKey = accountResetOperationKey(value);
    resetRoleplayAccount(base, plan.account, 'reset', { operationKey, contentHash: plan.contentHash });
    afterAccountReset();
    const receipt = readRoleplayAccountReset(base, plan.account, operationKey);
    if (receipt?.phase !== 'complete') throw operationError('The reset completion needs recovery.');
    withOperation(context, ({ value, save }) => { value.effects.reset.state = 'done'; save(); });
    return accountResetResult(receipt);
}

registerOperation('account-reset', { label: 'Reset account data', resultInRecord: true,
    authorize(request) { if (!authorisedRequests.has(request)) throw operationError('Use the confirmed account reset control.', 403); },
    capture: captureAccountReset, run: runAccountReset, target: () => ({ kind: 'account', id: 'reset' }) });
