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
    assert.equal(reserve.companionTurns, 16);
    assert.equal(reserve.reservedBytes, 16 * (2 * 256 * 1024 + 64 * 1024 + 400 * 1024));
    const nearCapacity = MAX_WORKFLOW_CHAT_BYTES - 16 * (2 * 256 * 1024 + 64 * 1024);
    assert.throws(() => assertRoleplayWorkflowCapacity(nearCapacity, 16, 400 * 1024), {
        code: 'ROLEPLAY_WORKFLOW_CAPACITY', status: 507,
    });
    assert.throws(() => assertRoleplayWorkflowCapacity(0, 16, -1), { code: 'ROLEPLAY_WORKFLOW_CAPACITY' });
});

test('one text reply reserves its Companion notes once while retaining all sixteen tool turns', () => {
    const companionBytes = 11 * (64 * 1024 * 6 + 4096) + 8194;
    assert.throws(() => assertRoleplayWorkflowCapacity(24 * 1024, 16, companionBytes), {
        code: 'ROLEPLAY_WORKFLOW_CAPACITY', status: 507,
    });
    const reserve = assertRoleplayWorkflowCapacity(24 * 1024, 16, companionBytes, 1);
    assert.equal(reserve.maxTurns, 16);
    assert.equal(reserve.companionTurns, 1);
    assert.equal(reserve.reservedBytes, 16 * (2 * 256 * 1024 + 64 * 1024) + companionBytes);
    assert.throws(() => assertRoleplayWorkflowCapacity(MAX_WORKFLOW_CHAT_BYTES - reserve.reservedBytes + 1, 16, companionBytes, 1), {
        code: 'ROLEPLAY_WORKFLOW_CAPACITY', status: 507,
    });
    const group = assertRoleplayWorkflowCapacity(24 * 1024, 16, companionBytes, 2);
    assert.equal(group.reservedBytes, reserve.reservedBytes + companionBytes);
    for (const turns of [0, -1, 1.5, 17, NaN]) {
        assert.throws(() => assertRoleplayWorkflowCapacity(0, 16, companionBytes, turns), { code: 'ROLEPLAY_WORKFLOW_CAPACITY' });
    }
});
