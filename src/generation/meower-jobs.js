import { hash } from '../mewmory/core.js';
import { acceptJob, getJob, listJobs, releaseJob, validateOwner } from '../jobs/store.js';
import { createProviderScope, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { withRoleplayAccount } from '../roleplay-store.js';
import { createMacroEnvironment } from '../macros/index.js';
import { runChatProfile } from './service.js';
import { generateQuickImageGenJobImage } from './quick-image-gen-job.js';
import { saveQuickImageToUserImages } from './quick-image-gen.js';
import { accountsForPlan, captureMeowerPlan, checkMeowerReceipts, meowerError, meowerInput, meowerMacros, receiptKey, RECEIPT_LIMIT } from './meower-plan.js';
import { readMeowerStore, mutateMeowerStore } from '../../public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js';
import { buildCorrectionMessage, buildProfileMessages, buildRefreshMessages, KIND_AMBIENT, KIND_CHARACTER, KIND_PERSONA,
    materializeRefresh, MAX_NEW_STRANGERS_PER_REFRESH, MAX_POLLS_PER_REFRESH, normalizeSession,
    parseProfileResponse, parseRefreshResponse, reconcileInteractions } from '../../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

const rows = ['posts', 'interactions', 'follows', 'strangers', 'trends', 'warnings'];
const emptyResult = () => Object.fromEntries(rows.map(key => [key, []]));
const keyFor = context => receiptKey(context.owner, context.job.submissionKey);

function receiptFor(context, receipts) {
    checkMeowerReceipts(receipts);
    const receipt = receipts[keyFor(context)];
    if (!receipt || receipt.jobId !== context.job.id || receipt.planHash !== context.job.config?.planHash) throw meowerError('The permanent Meower acceptance receipt is missing or changed.');
    return receipt;
}

function validSource(store, plan) {
    return Boolean(store.settings.sessions[plan.input.sessionId] && store.feeds[plan.input.sessionId]?.epoch === plan.epoch);
}

async function source(context, plan) {
    withRoleplayAccount({ owner: context.owner, directories: context.directories }, plan.account, () => {});
    const current = await readMeowerStore(context.directories, context.owner);
    receiptFor(context, current.receipts);
    if (!validSource(current.store, plan)) throw meowerError('The Meower timeline was deleted or reset. Generated work was kept out of the replacement.');
    return current.store;
}

/** Paused acceptance contains the complete plan, so a crash before its artifact is recoverable. */
export async function finalizeMeowerSubmission(context) {
    const { job, owner, directories } = context;
    if (!['meower.refresh', 'meower.profile'].includes(job.type) || job.state !== 'waiting' || job.stage !== 'preparing') return;
    const plan = job.intent?.plan;
    if (!plan || hash(plan) !== job.config?.planHash) throw meowerError('The accepted Meower plan needs recovery.');
    await mutateMeowerStore(directories, owner, (store, receipts) => {
        const key = keyFor(context);
        if (receipts[key]) { receiptFor(context, receipts); return { unchanged: true }; }
        checkMeowerReceipts(receipts, RECEIPT_LIMIT);
        // This is the acceptance crash window, before any provider can run.
        if (!store.settings.sessions[plan.input.sessionId]) throw meowerError('That timeline session no longer exists.');
        const feed = store.feeds[plan.input.sessionId];
        if (feed.epoch && feed.epoch !== plan.epoch) throw meowerError('The Meower timeline changed during acceptance.');
        feed.epoch = plan.epoch;
        receipts[key] = { version: 1, jobId: job.id, requestHash: job.intent.requestHash, planHash: job.config.planHash, units: {}, closed: false };
    });
    writeArtifact(directories, job.id, 'plan', plan);
    releaseJob(directories, job.id);
}

export async function acceptMeowerJob(request, body = {}, kind = 'refresh') {
    const owner = validateOwner(request.user?.profile?.handle);
    const directories = request.user.directories;
    if (request.get?.('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== owner) throw meowerError('The signed-in account changed. Reload Meower before continuing.');
    const input = meowerInput(body, kind);
    const requestHash = hash(input);
    const key = receiptKey(owner, body.submissionKey);
    let accepted;
    await mutateMeowerStore(directories, owner, async (store, receipts) => {
        checkMeowerReceipts(receipts);
        const prior = receipts[key];
        const existing = prior ? getJob(directories, prior.jobId) : listJobs(directories, { owner, includeDismissed: true }).find(job => job.submissionKey === body.submissionKey);
        if (prior || existing) {
            if ((prior?.requestHash ?? existing.intent?.requestHash) !== requestHash || existing && existing.type !== `meower.${kind}`) throw meowerError('This submission key already belongs to another operation.');
            if (!existing) throw meowerError('This Meower operation was already accepted. Its job has expired; it will not be repeated.');
            accepted = { created: false, job: existing };
            return { unchanged: true };
        }
        checkMeowerReceipts(receipts, RECEIPT_LIMIT);
        const plan = await captureMeowerPlan({ owner, directories }, store, input);
        const planHash = hash(plan);
        accepted = acceptJob(directories, { owner, type: `meower.${kind}`, submissionKey: body.submissionKey,
            intent: { requestHash, plan }, target: { kind: 'meower', id: input.sessionId }, config: { planHash },
            credentialRef: plan.binding, mutating: true, paused: true, label: kind === 'refresh' ? 'Meower refresh' : 'Meower profiles' });
        receipts[key] = { version: 1, jobId: accepted.job.id, requestHash, planHash, units: {}, closed: false };
    });
    noteOwner(owner);
    await finalizeMeowerSubmission({ owner, directories, job: accepted.job });
    return { ...accepted, job: getJob(directories, accepted.job.id) };
}

function cached(context, name, produce) {
    const saved = readArtifact(context.directories, context.job.id, name);
    if (saved !== undefined) return saved;
    const value = produce();
    writeArtifact(context.directories, context.job.id, name, value);
    return value;
}

async function generateText(context, plan, messages, step, dependencies) {
    await source(context, plan);
    const macros = meowerMacros(plan);
    return (await dependencies.generate({ context: { owner: context.owner, directories: context.directories }, binding: plan.binding,
        messages, maxTokens: plan.settings.maxTokens, jobContext: context, signal: context.signal, stepNamespace: `meower:${step}`,
        macroEnvironment: createMacroEnvironment(macros), userName: macros.names.user, characterName: macros.names.char,
        overridePayload: plan.overridePayload,
        rawOptions: plan.binding.kind === 'profile' ? { includePreset: false, ...(plan.binding.backend === 'text' ? { includeInstruct: false } : {}) } : {},
        beforeDispatch: () => source(context, plan) })).text;
}

async function profiles(context, plan, keys, unit, dependencies) {
    const current = await source(context, plan);
    const existing = (await readMeowerStore(context.directories, context.owner)).receipts[keyFor(context)].units[unit];
    if (existing) return existing;
    const input = cached(context, `${unit}:input`, () => {
        const accounts = accountsForPlan(plan, current.settings.profiles, current.settings.sessions[plan.input.sessionId].strangers);
        const targets = accounts.filter(account => keys.includes(account.key));
        const others = accounts.filter(account => !keys.includes(account.key));
        const avoid = plan.input.kind === 'profile' && plan.input.mode !== 'persona' ? accounts.map(account => account.handle) : others.map(account => account.handle);
        return { targets, others, avoid, messages: buildProfileMessages(targets, { avoid }) };
    });
    let generated = readArtifact(context.directories, context.job.id, `${unit}:materialized`);
    if (generated === undefined) {
        const raw = await generateText(context, plan, input.messages, unit, dependencies);
        try { generated = parseProfileResponse(raw, input.targets, input.others, input.avoid); } catch { generated = {}; }
        writeArtifact(context.directories, context.job.id, `${unit}:materialized`, generated);
    }
    context.signal.throwIfAborted();
    const committed = await mutateMeowerStore(context.directories, context.owner, (store, receipts) => {
        withRoleplayAccount({ owner: context.owner, directories: context.directories }, plan.account, () => {});
        const receipt = receiptFor(context, receipts);
        if (receipt.units[unit]) return { unchanged: true, unit: receipt.units[unit] };
        if (!validSource(store, plan)) throw meowerError('The Meower timeline was deleted or reset. Your changes were kept.');
        let result;
        if (plan.input.mode === 'persona') {
            const session = store.settings.sessions[plan.input.sessionId];
            if (hash([session.personaId, session.personaProfile, session.scenarioNoteIds]) !== hash([plan.session.personaId, plan.session.personaProfile, plan.session.scenarioNoteIds])) throw meowerError('The persona or its profile changed while generation was running. Your edits were kept.');
            result = { profile: generated[keys[0]] || null, written: 0 };
        } else {
            const saved = {};
            for (const [key, profile] of Object.entries(generated)) {
                if (hash(store.settings.profiles[key] ?? null) === hash(plan.settings.profiles[key] ?? null)) {
                    store.settings.profiles[key] = profile;
                    saved[key] = profile;
                }
            }
            result = { profiles: saved, written: Object.keys(saved).length, conflicts: Object.keys(generated).length - Object.keys(saved).length };
        }
        receipt.units[unit] = result;
        checkMeowerReceipts(receipts);
        return { unit: result };
    });
    return committed.result?.unit ?? committed.unit;
}

function turnSettings(settings, turn) {
    if (!turn) return settings;
    return { ...settings, quotas: { posts: 0, replies: 0, reposts: 0, likes: 0, [{ post: 'posts', reply: 'replies', repost: 'reposts', like: 'likes' }[turn.kind]]: 1 },
        images: { ...settings.images, perRefresh: turn.kind === 'post' ? turn.imageLimit : 0 } };
}

function scopeTurn(parsed, turn) {
    if (!turn) return parsed;
    if (turn.kind === 'post') return { ...parsed, posts: parsed.posts.slice(0, 1), interactions: [], follows: [],
        strangers: parsed.strangers.slice(0, turn.strangers), trends: turn.trends ? parsed.trends : [] };
    const types = turn.kind === 'like' ? ['like', 'vote'] : [turn.kind];
    return { ...parsed, posts: [], interactions: parsed.interactions.filter(item => types.includes(item.type)).slice(0, 1), follows: [], strangers: [], trends: [] };
}

async function generatedBatch(context, plan, unit, input, dependencies) {
    for (let attempt = 0, reason = ''; attempt < 2; attempt++) {
        const messages = attempt ? [...input.messages, { role: 'user', content: buildCorrectionMessage(reason, input.active.map(account => account.handle)) }] : input.messages;
        const raw = await generateText(context, plan, messages, `${unit}:${attempt}`, dependencies);
        try { return parseRefreshResponse(raw); } catch (error) {
            reason = error.message;
            if (attempt === 1) {
                if (!input.turn) throw meowerError('The model returned no usable activity after its correction attempt.', 422);
                return { ...emptyResult(), warnings: ['The model returned no usable activity.'] };
            }
        }
    }
}

async function renderImage(context, plan, post) {
    const effectId = `meower:${post.id}`;
    const image = await generateQuickImageGenJobImage(context, { effectId, prompt: post.image.prompt,
        settingsFingerprint: plan.imageFingerprint, expectedAccount: plan.account });
    try {
        return await saveQuickImageToUserImages(context.directories, { base64: image.base64, format: image.format,
            filename: `meower-${hash([context.job.id, post.id])}`, owner: context.owner, account: plan.account });
    } catch (error) {
        error.recoverable = true;
        throw error;
    }
}

async function activity(context, plan, unit, input, dependencies) {
    let materialized = readArtifact(context.directories, context.job.id, `${unit}:materialized`);
    if (materialized === undefined) {
        const parsed = await generatedBatch(context, plan, unit, input, dependencies);
        let counter = 0;
        materialized = materializeRefresh(scopeTurn(parsed, input.turn), { accounts: input.accounts, allowedActorKeys: input.active.map(account => account.key),
            allowedPostAuthorKeys: input.turn?.kind === 'post' ? (input.turn.author ? [input.turn.author.key] : input.active.filter(account => account.kind === KIND_AMBIENT).map(account => account.key)) : input.active.map(account => account.key),
            allowNewStrangerPosts: !input.turn || input.turn.kind === 'post' && !input.turn.author,
            settings: input.settings, posts: input.feed.posts, interactions: input.feed.interactions,
            newId: () => hash([context.job.id, unit, counter++]), now: input.now, strangerLimit: input.strangers,
            strangerPostLimit: input.strangerPostLimit, pollLimit: input.turn?.pollLimit ?? MAX_POLLS_PER_REFRESH,
            imageLimit: input.turn?.imageLimit ?? plan.settings.images.perRefresh, requiredTopic: plan.input.topic, allowTrends: !plan.input.topic && (!input.turn || input.turn.trends) });
        materialized.warnings.push(...(parsed.warnings || []));
        writeArtifact(context.directories, context.job.id, `${unit}:materialized`, materialized);
    }
    let ready = readArtifact(context.directories, context.job.id, `${unit}:ready`);
    if (ready === undefined) {
        ready = structuredClone(materialized);
        for (const post of ready.posts.filter(post => post.image?.prompt)) {
            await source(context, plan);
            const name = `${unit}:image:${post.id}`;
            let image = readArtifact(context.directories, context.job.id, name);
            if (image === undefined) {
                try { image = { url: await dependencies.image(context, plan, post) }; } catch (error) {
                    context.signal.throwIfAborted();
                    // A provider step still marked uncertain is never converted to text-only success.
                    if (getJob(context.directories, context.job.id)?.recoverability === 'unknown-outcome'
                        || error.recoverable || error.code || error.status === 409 || error.status === 423) throw error;
                    image = { url: null, warning: `image: ${error.message || 'could not be drawn'}, posted as text` };
                }
                writeArtifact(context.directories, context.job.id, name, image);
            }
            post.image = image.url ? { url: image.url, prompt: post.image.prompt } : null;
            if (image.warning) ready.warnings.push(image.warning);
        }
        writeArtifact(context.directories, context.job.id, `${unit}:ready`, ready);
    }
    return ready;
}

/** Feed rows, session bookkeeping and the no-replay receipt have one atomic commit. */
export async function commitMeowerActivity(context, plan, unit, result) {
    context.signal.throwIfAborted();
    const committed = await mutateMeowerStore(context.directories, context.owner, (store, receipts) => {
        withRoleplayAccount({ owner: context.owner, directories: context.directories }, plan.account, () => {});
        const receipt = receiptFor(context, receipts);
        if (receipt.units[unit]) return { unchanged: true, unit: receipt.units[unit] };
        if (!validSource(store, plan)) throw meowerError('The Meower timeline was deleted or reset. Your changes were kept.');
        const feed = store.feeds[plan.input.sessionId];
        const posts = [...feed.posts, ...result.posts.filter(post => !feed.posts.some(saved => saved.id === post.id))];
        const interactions = reconcileInteractions(posts, [...feed.interactions, ...result.interactions.filter(item => !feed.interactions.some(saved => saved.id === item.id))]);
        const ids = new Set(interactions.map(item => item.id));
        const applied = { ...result, interactions: result.interactions.filter(item => ids.has(item.id)) };
        if (applied.interactions.length !== result.interactions.length) applied.warnings = [...result.warnings, 'reactions: skipped activity whose target changed while the refresh was running'];
        Object.assign(feed, { posts, interactions });
        const session = store.settings.sessions[plan.input.sessionId];
        const follows = structuredClone(session.follows);
        for (const { actorKey, targetKey } of result.follows) follows[actorKey] = [...new Set([...(follows[actorKey] || []), targetKey])];
        store.settings.sessions[plan.input.sessionId] = normalizeSession({ ...session, follows, lastRefreshAt: Date.now(),
            strangers: [...session.strangers, ...result.strangers], ...(result.trends.length ? { trends: result.trends } : {}) }, session.id);
        const summary = { posts: applied.posts.map(post => post.id), interactions: applied.interactions.map(item => item.id),
            strangers: applied.strangers.map(stranger => stranger.id), warnings: applied.warnings };
        // Retain the materialised result before the commit; recovery filters it through this receipt.
        receipt.units[unit] = summary;
        checkMeowerReceipts(receipts);
        return { unit: summary };
    });
    return committed.result?.unit ?? committed.unit;
}

function refreshTurns(plan, accounts) {
    if (!plan.settings.incremental) return [[null]];
    const cast = accounts.filter(account => plan.activeKeys.includes(account.key) && account.kind === KIND_CHARACTER);
    const count = cast.length ? plan.settings.quotas.posts : Math.min(plan.settings.quotas.posts, 1);
    const posts = Array.from({ length: count }, (_, offset) => ({ kind: 'post', index: offset + 1, total: count,
        author: cast.length ? cast[offset % cast.length] : null, strangers: !offset && plan.session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        pollLimit: !offset ? MAX_POLLS_PER_REFRESH : 0, trends: !offset && !plan.input.topic,
        imageLimit: plan.settings.images.enabled && offset < plan.settings.images.perRefresh ? 1 : 0 }));
    const counts = { reply: plan.settings.quotas.replies, repost: plan.settings.quotas.reposts, like: plan.settings.quotas.likes };
    const interactions = [];
    for (let offset = 0; offset < Math.max(...Object.values(counts)); offset++) {
        for (const [kind, total] of Object.entries(counts)) if (offset < total) interactions.push({ kind, index: offset + 1, total, strangers: 0, pollLimit: 0, trends: false, imageLimit: 0 });
    }
    const waves = [];
    for (const [turns, width] of [[posts, cast.length ? plan.settings.concurrency : 1], [interactions, plan.settings.concurrency]]) {
        for (let index = 0; index < turns.length; index += width) waves.push(turns.slice(index, index + width));
    }
    return waves;
}

export function createMeowerJobHandler({ generate = runChatProfile, image = renderImage } = {}) {
    return async context => {
        const plan = readArtifact(context.directories, context.job.id, 'plan');
        if (!plan || hash(plan) !== context.job.config?.planHash) throw meowerError('The saved Meower plan needs recovery.');
        const current = await readMeowerStore(context.directories, context.owner);
        const receipt = receiptFor(context, current.receipts);
        if (receipt.closed) return readArtifact(context.directories, context.job.id, 'result') ?? receipt.result;
        await source(context, plan);
        const dependencies = { generate, image };
        let result;
        if (plan.input.kind === 'profile') {
            await context.progress({ stage: 'Writing profiles' });
            result = await profiles(context, plan, plan.profileKeys, 'profiles', dependencies);
            if (result.conflicts && !result.written) throw meowerError('The profiles changed while generation was running. Your edits were kept.');
        } else {
            const missing = plan.accounts.filter(account => plan.activeKeys.includes(account.key) && account.kind === KIND_CHARACTER && !account.hasProfile).map(account => account.key);
            const profileResult = missing.length ? await profiles(context, plan, missing, 'profiles', dependencies) : { written: 0 };
            const afterProfiles = await source(context, plan);
            const waves = cached(context, 'waves', () => refreshTurns(plan, accountsForPlan(plan, afterProfiles.settings.profiles)));
            result = { ...emptyResult(), profilesWritten: profileResult.written };
            const activeKeys = new Set(plan.activeKeys);
            const scope = { ...context, providerScope: createProviderScope(context) };
            for (const [index, turns] of waves.entries()) {
                const store = await source(context, plan);
                const session = store.settings.sessions[plan.input.sessionId];
                const accounts = accountsForPlan(plan, store.settings.profiles, session.strangers);
                await context.progress({ stage: 'Writing Meower activity', completed: index, total: waves.length });
                const inputs = cached(context, `wave:${index}:input`, () => turns.map(turn => {
                    const active = accounts.filter(account => activeKeys.has(account.key));
                    const settings = turnSettings(plan.settings, turn);
                    const strangers = turn?.strangers ?? (session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0);
                    const feed = store.feeds[plan.input.sessionId];
                    const now = Date.now();
                    return { accounts, active, settings, feed, now, turn, strangers,
                        strangerPostLimit: Math.max(0, 1 - result.posts.filter(post => post.authorSnapshot?.kind === KIND_AMBIENT).length),
                        messages: buildRefreshMessages({ accounts, active, persona: accounts.find(account => account.kind === KIND_PERSONA), session,
                            posts: feed.posts, interactions: feed.interactions, settings, now, localTime: plan.input.localTime,
                            strangers, turn, trends: !plan.input.topic && (!turn || turn.trends), topic: plan.input.topic,
                            scene: settings.scene.enabled ? plan.input.scene : null, pollLimit: turn?.pollLimit ?? MAX_POLLS_PER_REFRESH }) };
                }));
                const outcomes = await Promise.allSettled(inputs.map(async (input, offset) => {
                    const unit = `wave:${index}:${offset}`;
                    const saved = (await readMeowerStore(context.directories, context.owner)).receipts[keyFor(context)].units[unit];
                    if (!saved) await activity(scope, plan, unit, input, dependencies);
                    return unit;
                }));
                // Commit successful siblings even if another request has an unknown outcome.
                for (const outcome of outcomes.filter(outcome => outcome.status === 'fulfilled')) {
                    const unit = outcome.value;
                    const ready = readArtifact(context.directories, context.job.id, `${unit}:ready`);
                    if (!ready) throw meowerError('The saved Meower activity needs recovery.');
                    const applied = await commitMeowerActivity(context, plan, unit, ready);
                    for (const key of rows) {
                        const values = key === 'warnings' ? applied.warnings : ['posts', 'interactions', 'strangers'].includes(key)
                            ? ready[key].filter(item => applied[key].includes(item.id)) : ready[key];
                        result[key].push(...values);
                    }
                    for (const stranger of ready.strangers) activeKeys.add(`${KIND_AMBIENT}:${stranger.id}`);
                }
                const failed = outcomes.find(outcome => outcome.status === 'rejected');
                if (failed) throw failed.reason;
                await context.progress({ stage: 'Meower activity saved', completed: index + 1, total: waves.length });
            }
        }
        writeArtifact(context.directories, context.job.id, 'result', result);
        await mutateMeowerStore(context.directories, context.owner, (_store, receipts) => {
            const receipt = receiptFor(context, receipts);
            receipt.closed = true;
            receipt.result = plan.input.kind === 'profile' ? result : { posts: result.posts.length, interactions: result.interactions.length, profilesWritten: result.profilesWritten };
            checkMeowerReceipts(receipts);
        });
        return plan.input.kind === 'profile' ? result : { posts: result.posts.length, interactions: result.interactions.length, profilesWritten: result.profilesWritten };
    };
}

registerHandler('meower.refresh', createMeowerJobHandler());
registerHandler('meower.profile', createMeowerJobHandler());
