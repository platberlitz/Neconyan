import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRoleplayWorkflowCapacity, MAX_WORKFLOW_CHAT_BYTES } from '../src/generation/roleplay-workflow-capacity.js';

test('a complete sixteen-turn chat reserves every bounded candidate before admission', () => {
    const accepted = assertRoleplayWorkflowCapacity(5 * 1024 * 1024);
    assert.equal(accepted.maxTurns, 16);
    assert.equal(accepted.limitBytes, MAX_WORKFLOW_CHAT_BYTES);
    assert.ok(accepted.reservedBytes > 8 * 1024 * 1024);
    assert.throws(() => assertRoleplayWorkflowCapacity(MAX_WORKFLOW_CHAT_BYTES - accepted.reservedBytes + 1), {
        code: 'ROLEPLAY_WORKFLOW_CAPACITY', status: 507,
    });
    assert.throws(() => assertRoleplayWorkflowCapacity(0, 17), { code: 'ROLEPLAY_WORKFLOW_CAPACITY' });
});

test('bounded Companion results for every paid turn are reserved before accepting a chat', () => {
    const reserve = assertRoleplayWorkflowCapacity(2 * 1024 * 1024, 16, 400 * 1024);
    assert.equal(reserve.companionBytes, 400 * 1024);
    assert.equal(reserve.reservedBytes, 16 * (2 * 256 * 1024 + 64 * 1024 + 400 * 1024));
    const nearCapacity = MAX_WORKFLOW_CHAT_BYTES - 16 * (2 * 256 * 1024 + 64 * 1024);
    assert.throws(() => assertRoleplayWorkflowCapacity(nearCapacity, 16, 400 * 1024), {
        code: 'ROLEPLAY_WORKFLOW_CAPACITY', status: 507,
    });
    assert.throws(() => assertRoleplayWorkflowCapacity(0, 16, -1), { code: 'ROLEPLAY_WORKFLOW_CAPACITY' });
});
