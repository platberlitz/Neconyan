import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, roleplayChatPath } from './roleplay-source.js';

export const MAX_WORKFLOW_CHAT_BYTES = 64 * 1024 * 1024;
const MAX_TURNS = 16;
const MAX_REPLY_BYTES = 256 * 1024;
const PER_TURN_RESERVE = 2 * MAX_REPLY_BYTES + 64 * 1024;

const fail = () => roleplayError('ROLEPLAY_WORKFLOW_CAPACITY',
    'This complete workflow cannot fit inside its protected chat capacity.', 507);

/** Reserve all bounded model turns and Companion notes for the turns that can produce text. */
export function assertRoleplayWorkflowCapacity(size, turns = MAX_TURNS, companionBytes = 0, companionTurns = turns) {
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(turns) || turns < 1 || turns > MAX_TURNS
        || !Number.isSafeInteger(companionBytes) || companionBytes < 0
        || !Number.isSafeInteger(companionTurns) || companionTurns < 1 || companionTurns > turns
        || size + turns * PER_TURN_RESERVE + companionTurns * companionBytes > MAX_WORKFLOW_CHAT_BYTES) throw fail();
    return { version: 1, sourceBytes: size, maxTurns: turns, companionBytes, companionTurns,
        reservedBytes: turns * PER_TURN_RESERVE + companionTurns * companionBytes, limitBytes: MAX_WORKFLOW_CHAT_BYTES };
}

export function captureRoleplayWorkflowCapacity(base, account, source, { maxTurns = MAX_TURNS, companionBytes = 0, companionTurns = maxTurns } = {}) {
    return withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, source);
        const { scope } = roleplayLease(lease);
        const file = readRoleplayFile(roleplayChatPath(scope, source.locator), MAX_WORKFLOW_CHAT_BYTES);
        if (!file || file.rawHash !== source.rawHash) throw fail();
        const saved = { ...assertRoleplayWorkflowCapacity(file.bytes.length, maxTurns, companionBytes, companionTurns), sourceHash: roleplayHash(source),
            accountId: account.accountId, dataEpoch: account.dataEpoch };
        return { ...saved, hash: roleplayHash(saved) };
    });
}
