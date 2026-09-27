import { readRoleplayAccountResetLocked, roleplayHash, roleplayLease } from '../roleplay-store.js';

export const accountResetOperationKey = value => `application:${roleplayHash([value.account.accountId, value.key])}`;
export const accountResetResult = receipt => ({ reset: true, account: receipt.result });

/** A lost job ledger after reset is reconciled from the permanent reset receipt, never by resetting again. */
export function reconcileAccountReset(value, lease) {
    if (value.kind !== 'account-reset' || value.state !== 'accepted') return false;
    const receipt = readRoleplayAccountResetLocked(lease, value.account, accountResetOperationKey(value));
    if (receipt?.phase === 'complete') {
        if (receipt.mode !== 'reset' || receipt.contentHash !== value.plan.contentHash) throw new Error('The account reset completion does not match its accepted content.');
        value.result = accountResetResult(receipt);
        value.resultHash = roleplayHash(value.result);
        value.effects.reset = { state: 'done', operationKey: accountResetOperationKey(value) };
        value.state = 'completed';
        return true;
    }
    if (!receipt && roleplayLease(lease).scope.dataEpoch !== value.account.dataEpoch) {
        value.state = 'refused';
        value.error = 'A different reset replaced this account data before this request started.';
        return true;
    }
    return false;
}
