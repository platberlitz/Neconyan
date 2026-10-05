/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let account;
const listJobs = jest.fn();
const getJobApproval = jest.fn();
const decideJobApproval = jest.fn();
const popup = jest.fn();
const loadCreatedAgent = jest.fn();
const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });
const buildAssistantReview = jest.fn(value => value);
const buildNoteProposalReview = jest.fn(value => value);
await jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ listJobs, getJobApproval, decideJobApproval, TERMINAL: new Set(['completed', 'failed', 'cancelled']) }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: popup, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 } }));
await jest.unstable_mockModule('../public/scripts/neconyan-assistant-review.js', () => ({ buildAssistantReview, buildNoteProposalReview }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ loadCreatedAgent }));
const { reviewAssistantJobChildren } = await import('../public/scripts/neconyan-assistant-job-review.js');

const root = { id: 'root', state: 'waiting', owner: 'alice', children: ['speaker', 'foreign'] };
const speaker = { id: 'speaker', owner: 'alice', parentId: 'root', children: ['tool'] };
const child = { id: 'tool', owner: 'alice', parentId: 'speaker', type: 'media.assistant-tool', state: 'waiting', stage: 'approval', result: { approval: { id: 'approval' } } };
const approval = { id: 'approval', proposalHash: 'saved-hash', decision: null, proposal: {
    kind: 'neconyan-assistant-edit', resource: { kind: 'lorebook', id: 'Manual' }, before: 'Before', arguments: { field: 'content', value: '<img src=x>' },
} };

beforeEach(() => {
    jest.clearAllMocks();
    account = 'alice';
    globalThis.window = { dispatchEvent: jest.fn() };
    loadCreatedAgent.mockResolvedValue(undefined);
    listJobs.mockResolvedValue([speaker, child, { ...child, id: 'foreign', parentId: 'root', owner: 'bob' }]);
    getJobApproval.mockResolvedValue(approval);
    decideJobApproval.mockResolvedValue({});
    popup.mockResolvedValue(1);
});

test.each([[1, 'allow'], [0, 'deny']])('reopened descendants review the saved proposal and submit %s as %s', async (result, decision) => {
    popup.mockResolvedValue(result);
    await reviewAssistantJobChildren(root, 'alice');
    expect(getJobApproval).toHaveBeenCalledTimes(1);
    expect(getJobApproval).toHaveBeenCalledWith('tool', 'approval', { account: 'alice' });
    expect(buildAssistantReview).toHaveBeenCalledWith({ resource: 'lorebook', target: 'Manual', field: 'content', before: 'Before', after: '<img src=x>' });
    expect(decideJobApproval).toHaveBeenCalledWith('tool', { ...approval, decision }, { account: 'alice' });
});

test('a native note proposal shows its summary and diff before saving', async () => {
    const summary = { operation: 'append', label: 'Add to note: Magic system', changedRegions: ['Unresolved ideas'], affectsLiveLore: false, added: 1, removed: 0 };
    getJobApproval.mockResolvedValueOnce({ ...approval, proposal: { kind: 'neconyan-note-proposal', summary, diff: '+ New idea', arguments: {} } });
    await reviewAssistantJobChildren(root, 'alice');
    expect(buildNoteProposalReview).toHaveBeenCalledWith({ summary, diff: '+ New idea' });
    expect(buildAssistantReview).not.toHaveBeenCalled();
    expect(decideJobApproval).toHaveBeenCalledWith('tool', expect.objectContaining({ decision: 'allow' }), { account: 'alice' });
});

test('concurrent observers share one approval popup', async () => {
    let release;
    popup.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = reviewAssistantJobChildren(root, 'alice');
    const second = reviewAssistantJobChildren(root, 'alice');
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(popup).toHaveBeenCalledTimes(1);
    release(1);
    await Promise.all([first, second]);
    expect(decideJobApproval).toHaveBeenCalledTimes(1);
});

test('an account switch while the popup is open cannot approve for either account', async () => {
    popup.mockImplementationOnce(async () => { account = 'bob'; return 1; });
    await reviewAssistantJobChildren(root, 'alice');
    expect(decideJobApproval).not.toHaveBeenCalled();
    await reviewAssistantJobChildren(root, 'alice');
    expect(getJobApproval).toHaveBeenCalledTimes(1);
});

test('an already decided proposal is not offered again', async () => {
    getJobApproval.mockResolvedValueOnce({ ...approval, decision: 'deny' });
    await reviewAssistantJobChildren(root, 'alice');
    expect(popup).not.toHaveBeenCalled();
    expect(decideJobApproval).not.toHaveBeenCalled();
});

test('a completed creation is read back once after the root finishes, excluding other owners', async () => {
    const created = { ...child, state: 'completed', result: { result: { tool: 'Neconyan_Assistant_CreateAgent', result: { committed: true, id: 'new-agent' } } } };
    listJobs.mockResolvedValue([speaker, created, { ...created, id: 'foreign', parentId: 'root', owner: 'bob' }]);
    await reviewAssistantJobChildren({ ...root, state: 'completed' }, 'alice');
    await reviewAssistantJobChildren({ ...root, state: 'completed' }, 'alice');
    expect(loadCreatedAgent).toHaveBeenCalledTimes(1);
    expect(loadCreatedAgent).toHaveBeenCalledWith('new-agent', { account: 'alice', isCurrent: expect.any(Function) });
    expect(globalThis.window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'neconyan:assistant-agent-updated', detail: { id: 'new-agent' } }));
    expect(popup).not.toHaveBeenCalled();
});

test('an account change during created-agent readback cannot refresh the other account', async () => {
    listJobs.mockResolvedValue([{ ...speaker, children: ['switched'] }, { ...child, id: 'switched', state: 'completed', result: { result: {
        tool: 'Neconyan_Assistant_CreateAgent', result: { committed: true, id: 'new-agent' },
    } } }]);
    loadCreatedAgent.mockImplementationOnce(async () => { account = 'bob'; });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(loadCreatedAgent).toHaveBeenCalledTimes(1);
    expect(globalThis.window.dispatchEvent).not.toHaveBeenCalled();
});
