import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, roleplayChatPath } from './roleplay-source.js';

export const MAX_WORKFLOW_CHAT_BYTES = 64 * 1024 * 1024;
const MAX_TURNS = 16;
const MAX_REPLY_BYTES = 256 * 1024;
const PER_TURN_RESERVE = 2 * MAX_REPLY_BYTES + 64 * 1024;

const fail = () => roleplayError('ROLEPLAY_WORKFLOW_CAPACITY',
    'This complete workflow cannot fit inside its protected chat capacity.', 507);

/** Reserve all bounded turns, their saved metadata and every selected Companion note before admission. */
export function assertRoleplayWorkflowCapacity(size, turns = MAX_TURNS, companionBytes = 0) {
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(turns) || turns < 1 || turns > MAX_TURNS
        || !Number.isSafeInteger(companionBytes) || companionBytes < 0
        || size + turns * (PER_TURN_RESERVE + companionBytes) > MAX_WORKFLOW_CHAT_BYTES) throw fail();
    return { version: 1, sourceBytes: size, maxTurns: turns, companionBytes,
        reservedBytes: turns * (PER_TURN_RESERVE + companionBytes), limitBytes: MAX_WORKFLOW_CHAT_BYTES };
}

export function captureRoleplayWorkflowCapacity(base, account, source, { maxTurns = MAX_TURNS, companionBytes = 0 } = {}) {
    return withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, source);
        const { scope } = roleplayLease(lease);
        const file = readRoleplayFile(roleplayChatPath(scope, source.locator), MAX_WORKFLOW_CHAT_BYTES);
        if (!file || file.rawHash !== source.rawHash) throw fail();
        const saved = { ...assertRoleplayWorkflowCapacity(file.bytes.length, maxTurns, companionBytes), sourceHash: roleplayHash(source),
            accountId: account.accountId, dataEpoch: account.dataEpoch };
        return { ...saved, hash: roleplayHash(saved) };
    });
}
