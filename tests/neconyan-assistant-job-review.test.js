/* global globalThis */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

let account;
const listJobs = jest.fn();
const getJob = jest.fn();
const getJobApproval = jest.fn();
const decideJobApproval = jest.fn();
const reviewAndSaveBrowserMacro = jest.fn();
const popup = jest.fn();
const loadCreatedAgent = jest.fn();
const toastr = { error: jest.fn() };
const originalWindow = globalThis.window;
const originalToastr = globalThis.toastr;
afterEach(() => { globalThis.window = originalWindow; globalThis.toastr = originalToastr; });
const buildAssistantReview = jest.fn(value => value);
const buildNoteProposalReview = jest.fn(value => value);
await jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ listJobs, getJob, getJobApproval, decideJobApproval, TERMINAL: new Set(['completed', 'failed', 'cancelled']) }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: popup, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 } }));
await jest.unstable_mockModule('../public/scripts/neconyan-assistant-review.js', () => ({ buildAssistantReview, buildNoteProposalReview }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({ loadCreatedAgent }));
await jest.unstable_mockModule('../public/scripts/neconyan-assistant-macros.js', () => ({ reviewAndSaveBrowserMacro }));
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
    globalThis.toastr = toastr;
    loadCreatedAgent.mockResolvedValue(undefined);
    listJobs.mockResolvedValue([speaker, child, { ...child, id: 'foreign', parentId: 'root', owner: 'bob' }]);
    getJob.mockResolvedValue({ ...child, state: 'waiting', stage: 'approval', result: { approval: { id: 'approval' } } });
    getJobApproval.mockResolvedValue(approval);
    decideJobApproval.mockResolvedValue({});
    reviewAndSaveBrowserMacro.mockResolvedValue({ status: 'success', committed: true, name: 'SceneMood', scope: 'browser' });
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

test('a browser macro approval calls the shared helper before allowing the saved job', async () => {
    const job = { ...child, id: 'browser-tool', result: { approval: { id: 'browser-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [job.id] }, job]);
    getJob.mockResolvedValue({ ...job, state: 'waiting', stage: 'approval' });
    const browserApproval = { ...approval, id: 'browser-approval', proposal: {
        kind: 'neconyan-browser-macro', tool: 'Neconyan_Assistant_SaveBrowserMacro', resource: { kind: 'browser-macro', id: 'SceneMood' },
        arguments: { name: 'SceneMood', template: 'Mood: {{mood}}', userConfirmed: true },
    } };
    getJobApproval.mockResolvedValue(browserApproval);
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(reviewAndSaveBrowserMacro).toHaveBeenCalledWith({ name: 'SceneMood', template: 'Mood: {{mood}}' },
        { account: 'alice', isCurrent: expect.any(Function), proposalId: 'alice/browser-tool/browser-approval' });
    expect(buildAssistantReview).not.toHaveBeenCalled();
    expect(decideJobApproval).toHaveBeenCalledWith('browser-tool', { ...browserApproval, decision: 'allow' }, { account: 'alice' });
    getJobApproval.mockResolvedValueOnce({ ...browserApproval, decision: 'deny' });
    await expect(reviewAndSaveBrowserMacro.mock.calls[0][1].isCurrent()).resolves.toBe(false);
});

test('a declined browser macro review denies the job, and a storage error leaves it pending', async () => {
    const declined = { ...child, id: 'browser-cancel', result: { approval: { id: 'browser-cancel-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [declined.id] }, declined]);
    getJob.mockResolvedValue({ ...declined, state: 'waiting', stage: 'approval' });
    const declinedApproval = { ...approval, id: 'browser-cancel-approval', proposal: {
        kind: 'neconyan-browser-macro', tool: 'Neconyan_Assistant_SaveBrowserMacro', resource: { kind: 'browser-macro', id: 'SceneMood' },
        arguments: { name: 'SceneMood', template: 'Mood: {{mood}}', userConfirmed: true },
    } };
    getJobApproval.mockResolvedValue(declinedApproval);
    reviewAndSaveBrowserMacro.mockResolvedValueOnce({ status: 'cancelled', committed: false, declined: true, message: 'Nothing was saved.' });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(decideJobApproval).toHaveBeenCalledWith('browser-cancel', { ...declinedApproval, decision: 'deny' }, { account: 'alice' });

    const failedJob = { ...child, id: 'browser-error', result: { approval: { id: 'browser-error-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [failedJob.id] }, failedJob]);
    getJob.mockResolvedValue({ ...failedJob, state: 'waiting', stage: 'approval' });
    getJobApproval.mockResolvedValue({ ...approval, id: 'browser-error-approval', proposal: {
        kind: 'neconyan-browser-macro', tool: 'Neconyan_Assistant_SaveBrowserMacro', resource: { kind: 'browser-macro', id: 'SceneMood' },
        arguments: { name: 'SceneMood', template: 'Mood: {{mood}}', userConfirmed: true },
    } });
    reviewAndSaveBrowserMacro.mockResolvedValueOnce({ status: 'error', committed: false, message: 'The browser storage is full.' });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(decideJobApproval).toHaveBeenCalledTimes(1);
    expect(toastr.error).toHaveBeenCalledWith('The browser storage is full. The approval is still pending.', 'Browser macro not saved');
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(reviewAndSaveBrowserMacro).toHaveBeenCalledTimes(2);
});

test('a stale browser macro review leaves the approval pending and an uncommitted success cannot allow it', async () => {
    const stale = { ...child, id: 'browser-stale-review', result: { approval: { id: 'browser-stale-review-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [stale.id] }, stale]);
    getJob.mockResolvedValue({ ...stale, state: 'waiting', stage: 'approval' });
    const staleApproval = { ...approval, id: 'browser-stale-review-approval', proposal: {
        kind: 'neconyan-browser-macro', arguments: { name: 'SceneMood', template: 'Mood: {{mood}}', userConfirmed: true },
    } };
    getJobApproval.mockResolvedValue(staleApproval);
    reviewAndSaveBrowserMacro.mockResolvedValueOnce({ status: 'cancelled', committed: false, declined: false, message: 'The account or request changed.' });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(decideJobApproval).not.toHaveBeenCalled();
    expect(toastr.error).not.toHaveBeenCalled();

    const uncommitted = { ...child, id: 'browser-uncommitted', result: { approval: { id: 'browser-uncommitted-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [uncommitted.id] }, uncommitted]);
    getJob.mockResolvedValue({ ...uncommitted, state: 'waiting', stage: 'approval' });
    getJobApproval.mockResolvedValue({ ...staleApproval, id: 'browser-uncommitted-approval' });
    reviewAndSaveBrowserMacro.mockResolvedValueOnce({ status: 'success', committed: false, name: 'SceneMood', scope: 'browser' });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(decideJobApproval).not.toHaveBeenCalled();
    expect(toastr.error).toHaveBeenCalledWith('The browser did not confirm that the macro was saved. The approval is still pending.', 'Browser macro not saved');
});

test('a browser macro cannot be written after its job was cancelled or its account changed', async () => {
    const job = { ...child, id: 'browser-stale', result: { approval: { id: 'browser-stale-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [job.id] }, job]);
    getJob.mockResolvedValue({ ...job, state: 'cancelled', stage: 'approval' });
    const staleApproval = { ...approval, id: 'browser-stale-approval', proposal: {
        kind: 'neconyan-browser-macro', arguments: { name: 'SceneMood', template: 'Mood: {{mood}}', userConfirmed: true },
    } };
    getJobApproval.mockResolvedValue(staleApproval);
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(reviewAndSaveBrowserMacro).not.toHaveBeenCalled();
    expect(decideJobApproval).not.toHaveBeenCalled();

    const switched = { ...job, id: 'browser-switched', result: { approval: { id: 'browser-switched-approval' } } };
    listJobs.mockResolvedValue([{ ...speaker, children: [switched.id] }, switched]);
    getJob.mockResolvedValue({ ...switched, state: 'waiting', stage: 'approval' });
    getJobApproval.mockResolvedValue({ ...staleApproval, id: 'browser-switched-approval' });
    reviewAndSaveBrowserMacro.mockImplementationOnce(async () => {
        account = 'bob';
        return { status: 'success', committed: true, name: 'SceneMood', scope: 'browser' };
    });
    await reviewAssistantJobChildren({ ...root, children: ['speaker'] }, 'alice');
    expect(decideJobApproval).not.toHaveBeenCalled();
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
