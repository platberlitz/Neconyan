'use strict';

const gallery = require('./gallery.json');

const MARKER = '<!-- miso-merge-bot';
const BOT_LOGIN = 'github-actions[bot]';
const OWN_CHECK_NAMES = new Set(['🐯 Miso merge check']);
const BLOCKING_LABELS = new Set([
    '⛔ Don\'t Merge',
    '🔨 Needs Work',
    '🔬 Needs Testing',
    '⛔ Waiting For External/Upstream',
    '💥💣 Breaking Changes',
]);
const FAILED_CONCLUSIONS = {
    failure: 'failed',
    timed_out: 'timed out',
    cancelled: 'was cancelled',
    action_required: 'is waiting for someone to approve it',
    startup_failure: 'could not start',
    stale: 'went stale',
};
const MODEL_NAMES = { sunburst: 'Sunburst', flare: 'Flare' };
const CHECK_WAIT_MINUTES = 15;
const CHECK_POLL_MS = 15000;
const CHECK_QUIET_MS = 60000;

/**
 * Who can turn up in a comment. Weights are relative, so Kris appears in one comment out of ten.
 */
const CHARACTERS = {
    miso: {
        weight: 3,
        headings: { ready: '🐯 Miso says: ready to merge', blocked: '🐯 Miso says: merge blocked' },
        messages: {
            ready: [
                'Every check passed, the branch merges cleanly and nobody has asked for changes, so this pull request is ready to merge! I\'m so proud of it that the tummy is out, go on and press that button.',
                'All the checks finished happily and nobody is waiting on changes, which means this one is ready to go in. Work this tidy deserves a celebration, so here\'s the belly!',
                'Everything is green and there are no conflicts in sight, so you\'re all set to merge! I\'m showing off my tummy because this is a proper good day.',
            ],
            blocked: [
                'Not yet! I\'m keeping my tummy covered until these are sorted:',
                'Hold on a moment, this pull request can\'t be merged yet, so the belly stays hidden until these are fixed:',
                'Hmph, my tummy stays tucked away until somebody sorts these out:',
            ],
        },
    },
    taro: {
        weight: 3,
        headings: { ready: '🐈 Taro says: ready to merge', blocked: '🐈 Taro says: merge blocked' },
        messages: {
            ready: [
                'Expected a mergeable pull request, observed a mergeable pull request. Every check passed and nobody asked for changes, so you have earned a round of applause.',
                'All the checks finished green, the branch merges cleanly and there are no change requests left. I\'m clapping, which you should treat as rare and significant.',
                'Ready to merge. The checks passed, nothing conflicts and I have no notes, which is frankly a cat-astrophe for my reputation.',
            ],
            blocked: [
                'Expected a mergeable pull request, observed this instead. Fix these first:',
                'I\'m looking at you, and I\'m not impressed. This can\'t be merged until these are sorted:',
                'No. This stays unmerged until somebody deals with these:',
            ],
        },
    },
    nori: {
        weight: 3,
        headings: { ready: '🐈‍⬛ Nori says: ready to merge', blocked: '🐈‍⬛ Nori says: merge blocked' },
        messages: {
            ready: [
                'Ready to merge, obviously. Every check passed and nobody asked for changes, and I\'m taking full credit for that.',
                'Look at that, all green and no conflicts, which is clearly my influence. Go on and merge it before I start charging for the privilege.',
                'Everything passed and the branch merges cleanly, so this one is ready. I\'d say I\'m impressed, but I knew it all along, it\'s simply meow-velous.',
            ],
            blocked: [
                'Tsk, tsk. So close, and yet this can\'t be merged until these are fixed:',
                'Oh dear, oh dear. I would help, but watching is far more fun. Sort these out first:',
                'Not quite, darling. Sort these out and then we can talk:',
            ],
        },
    },
    kris: {
        weight: 1,
        headings: { ready: '💚 A wild Yukkuri Kris appeared: ready to merge', blocked: '💚 A wild Yukkuri Kris appeared: merge blocked' },
        messages: {
            ready: [
                'Take it easy! Every check passed, nothing conflicts and nobody asked for changes, so this one is ready to merge.',
                'Take it easy! Everything is green, so go ahead and merge it.',
            ],
            blocked: [
                'Can\'t take it easy yet, this can\'t be merged until these are fixed:',
                'Hmph. No taking it easy until these are sorted:',
            ],
        },
    },
};

const FOOTERS = {
    ready: 'If anything changes before it\'s merged, this comment will update itself.',
    blocked: 'This comment will update itself as soon as everything is fixed.',
};

function pickFrom(list, random) {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

function pickCharacter(state, random) {
    const names = Object.keys(gallery[state]).filter(name => CHARACTERS[name]);
    const total = names.reduce((sum, name) => sum + CHARACTERS[name].weight, 0);
    let roll = random() * total;
    for (const name of names) {
        roll -= CHARACTERS[name].weight;
        if (roll < 0) {
            return name;
        }
    }
    return names.at(-1);
}

function latestByName(checkRuns) {
    const latest = new Map();
    for (const run of checkRuns) {
        if (OWN_CHECK_NAMES.has(run.name)) {
            continue;
        }
        const previous = latest.get(run.name);
        if (!previous || Number(run.id) > Number(previous.id)) {
            latest.set(run.name, run);
        }
    }
    return [...latest.values()];
}

function latestReviewStates(reviews) {
    const states = new Map();
    for (const review of reviews) {
        const login = review.user?.login;
        if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
            continue;
        }
        states.set(login, review.state);
    }
    return states;
}

/**
 * Decides what Miso thinks of a pull request.
 * Known blockers are reported straight away; 'ready' waits until every check has finished.
 * @returns {{ state: 'ready' | 'blocked' | 'pending' | 'skip', reasons: string[] }}
 */
function evaluatePullRequest({ pr, checkRuns = [], statuses = [], reviews = [] }) {
    if (pr.state !== 'open' || pr.draft) {
        return { state: 'skip', reasons: [] };
    }

    const reasons = [];
    let pending = false;

    if (pr.mergeable === false) {
        reasons.push(`This branch has merge conflicts with \`${pr.base?.ref || 'the base branch'}\`.`);
    } else if (pr.mergeable !== true) {
        pending = true;
    }

    const runs = latestByName(checkRuns);
    if (runs.length === 0) {
        pending = true;
    }
    for (const run of runs) {
        if (run.status !== 'completed') {
            pending = true;
        } else if (FAILED_CONCLUSIONS[run.conclusion]) {
            reasons.push(`The **${run.name}** check ${FAILED_CONCLUSIONS[run.conclusion]}.`);
        }
    }

    for (const status of statuses) {
        if (status.state === 'pending') {
            pending = true;
        } else if (status.state === 'failure' || status.state === 'error') {
            reasons.push(`The **${status.context}** status ${status.state === 'error' ? 'reported an error' : 'failed'}.`);
        }
    }

    for (const [login, state] of latestReviewStates(reviews)) {
        if (state === 'CHANGES_REQUESTED') {
            reasons.push(`@${login} asked for changes.`);
        }
    }

    for (const label of pr.labels || []) {
        const name = typeof label === 'string' ? label : label.name;
        if (BLOCKING_LABELS.has(name)) {
            reasons.push(`It has the **${name}** label.`);
        }
    }

    if (reasons.length > 0) {
        return { state: 'blocked', reasons };
    }
    return { state: pending ? 'pending' : 'ready', reasons };
}

function findPicture(id) {
    for (const [state, characters] of Object.entries(gallery)) {
        for (const [character, models] of Object.entries(characters)) {
            for (const [model, pictures] of Object.entries(models)) {
                const picture = pictures.find(item => item.id === id);
                if (picture) {
                    return { ...picture, state, character, model };
                }
            }
        }
    }
    return null;
}

function pickPicture(state, random = Math.random) {
    const character = pickCharacter(state, random);
    const model = pickFrom(Object.keys(gallery[state][character]), random);
    return { ...pickFrom(gallery[state][character][model], random), state, character, model };
}

function parseMarker(body) {
    const match = String(body || '').match(/<!-- miso-merge-bot ([^>]*?) -->/);
    if (!match) {
        return null;
    }
    const fields = {};
    for (const pair of match[1].split(/\s+/)) {
        const [key, value] = pair.split('=');
        if (key && value) {
            fields[key] = value;
        }
    }
    return fields;
}

function buildComment({ state, reasons, picture, messageIndex, sha }) {
    const character = CHARACTERS[picture.character];
    const lines = [
        `${MARKER} state=${state} picture=${picture.id} message=${messageIndex} -->`,
        `### ${character.headings[state]}`,
        '',
        `<img src="${picture.url}" alt="${picture.alt}" width="320">`,
        '',
        character.messages[state][messageIndex],
    ];
    if (state === 'blocked') {
        lines.push('', ...reasons.map(reason => `- ${reason}`));
    }
    lines.push(
        '',
        FOOTERS[state],
        '',
        `<sub>Picture drawn by ${MODEL_NAMES[picture.model] || picture.model}. Checked at commit \`${String(sha).slice(0, 7)}\`.</sub>`,
    );
    return lines.join('\n');
}

/**
 * Works out the comment Miso should leave, or null when she should stay quiet.
 * A picture and message are kept while the state stays the same, so edits only change the details.
 */
function planComment({ evaluation, existingBody, sha, random = Math.random }) {
    if (evaluation.state !== 'ready' && evaluation.state !== 'blocked') {
        return null;
    }
    const previous = parseMarker(existingBody);
    let picture = null;
    let messageIndex = null;
    if (previous && previous.state === evaluation.state) {
        const kept = findPicture(previous.picture);
        const keptIndex = Number(previous.message);
        if (kept && kept.state === evaluation.state && CHARACTERS[kept.character]) {
            picture = kept;
            if (Number.isInteger(keptIndex) && CHARACTERS[kept.character].messages[evaluation.state][keptIndex]) {
                messageIndex = keptIndex;
            }
        }
    }
    picture ||= pickPicture(evaluation.state, random);
    const messages = CHARACTERS[picture.character].messages[evaluation.state];
    messageIndex ??= Math.min(messages.length - 1, Math.floor(random() * messages.length));
    const body = buildComment({ state: evaluation.state, reasons: evaluation.reasons, picture, messageIndex, sha });
    return body === existingBody ? null : body;
}

/**
 * Waits until every check on a commit has finished, because a pull request can
 * arrive before GitHub has registered its checks or finished running them.
 * An empty list is only believed after a quiet period, and the whole run shares
 * one deadline. Times are injected so tests never wait for real.
 */
async function waitForFinishedChecks({ github, owner, repo, sha, sleep, core, now = Date.now, deadline = now() + CHECK_WAIT_MINUTES * 60000 }) {
    const started = now();
    for (;;) {
        const runs = latestByName(await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 }));
        if (runs.length > 0 && runs.every(run => run.status === 'completed')) {
            return;
        }
        if (runs.length === 0 && now() - started >= CHECK_QUIET_MS) {
            return;
        }
        if (now() >= deadline) {
            core.warning(`Checks on ${String(sha).slice(0, 7)} were still running after ${CHECK_WAIT_MINUTES} minutes, so this check reports what it knows.`);
            return;
        }
        await sleep(CHECK_POLL_MS);
    }
}

async function getPullRequest({ github, owner, repo, number, sleep }) {
    let pr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        pr = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
        if (pr.mergeable !== null || pr.state !== 'open' || pr.draft) {
            return pr;
        }
        await sleep(3000);
    }
    return pr;
}

async function processPullRequest({ github, core, owner, repo, number, random, sleep, settleChecks = false, now = Date.now, deadline }) {
    let pr = await getPullRequest({ github, owner, repo, number, sleep });
    if (pr.state !== 'open' || pr.draft) {
        core.info(`#${number}: skipped (${pr.draft ? 'draft' : pr.state}).`);
        return 'skip';
    }

    if (settleChecks) {
        await waitForFinishedChecks({ github, owner, repo, sha: pr.head.sha, sleep, core, now, deadline });
        pr = await getPullRequest({ github, owner, repo, number, sleep });
        if (pr.state !== 'open' || pr.draft) {
            core.info(`#${number}: skipped (${pr.draft ? 'draft' : pr.state}).`);
            return 'skip';
        }
    }

    const sha = pr.head.sha;
    const [checkRuns, combined, reviews, comments] = await Promise.all([
        github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 }),
        github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 }),
        github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 }),
        github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    ]);

    const evaluation = evaluatePullRequest({ pr, checkRuns, statuses: combined.data.statuses || [], reviews });
    const existing = comments.find(comment => comment.user?.login === BOT_LOGIN && String(comment.body || '').includes(MARKER));
    const body = planComment({ evaluation, existingBody: existing?.body, sha, random });
    core.info(`#${number}: ${evaluation.state}${evaluation.reasons.length ? ` (${evaluation.reasons.join(' ')})` : ''}.`);

    if (!body) {
        return evaluation.state;
    }
    if (existing) {
        await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
        core.info(`#${number}: updated comment ${existing.id}.`);
    } else {
        await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
        core.info(`#${number}: posted a new comment.`);
    }
    return evaluation.state;
}

async function run({ github, context, core, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), settleChecks = false, now = Date.now }) {
    const { owner, repo } = context.repo;
    const deadline = now() + CHECK_WAIT_MINUTES * 60000;
    const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
    const results = {};
    for (const pull of pulls) {
        try {
            results[pull.number] = await processPullRequest({ github, core, owner, repo, number: pull.number, random, sleep, settleChecks, now, deadline });
        } catch (error) {
            results[pull.number] = 'error';
            core.warning(`#${pull.number}: ${error.message}`);
        }
    }
    return results;
}

module.exports = {
    BLOCKING_LABELS,
    CHARACTERS,
    MARKER,
    evaluatePullRequest,
    parseMarker,
    pickPicture,
    planComment,
    processPullRequest,
    run,
    waitForFinishedChecks,
};
