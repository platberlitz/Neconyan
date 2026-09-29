import { beforeEach, expect, jest, test } from '@jest/globals';

let account;
const listJobs = jest.fn();
const getJobApproval = jest.fn();
const decideJobApproval = jest.fn();
const popup = jest.fn();
const buildAssistantReview = jest.fn(value => value);
await jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ listJobs, getJobApproval, decideJobApproval }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => account }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: popup, POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 1 } }));
await jest.unstable_mockModule('../public/scripts/neconyan-assistant-review.js', () => ({ buildAssistantReview }));
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
