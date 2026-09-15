// Shared by the browser and bundled server: no host, filesystem or DOM access.
import { POST_MAX_CHARS, REPLY_MAX_CHARS, reconcileInteractions } from './core.js';

const isRecord = value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const storedId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : '';
const interactionTypes = new Set(['like', 'repost', 'reply', 'vote']);

function storedTime(value) {
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(number) && Math.abs(number) <= 8_640_000_000_000_000 ? number : 0;
}

function snapshot(raw) {
    if (!isRecord(raw)) return null;
    const handle = text(own(raw, 'handle'), 20);
    return {
        key: text(own(raw, 'key'), 520),
        kind: text(own(raw, 'kind'), 20),
        handle: /^[a-z0-9_]{1,20}$/.test(handle) ? handle : '',
        name: text(own(raw, 'name'), 120),
    };
}

function imageUrl(value) {
    if (typeof value !== 'string') return null;
    if (value === '') return ''; // A pending image still owns its description.
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith('//')) return null;
    if (/^data:/i.test(url)) {
        if (/^data:image\/(?:png|jpeg|webp|gif),.+$/i.test(url)) return url;
        return /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(url) ? url : null;
    }
    if (url.length > 4000) return null;
    try {
        const parsed = new URL(url, 'https://hopper.invalid/');
        if (parsed.username || parsed.password) return null;
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            return /^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol) ? url : null;
        }
        return parsed.origin === 'https://hopper.invalid' ? url : null;
    } catch {
        return null;
    }
}

/** Bad envelopes fail closed; usable old rows are repaired without changing their source. */
export function normalizeFeed(raw) {
    if (!isRecord(raw) || !Array.isArray(own(raw, 'posts')) || !Array.isArray(own(raw, 'interactions'))) {
        throw new Error('The saved data is not a Meower timeline.');
    }
    const version = own(raw, 'version');
    if (version !== undefined && version !== 1) {
        throw new Error(typeof version === 'number' && version > 1
            ? 'The saved timeline uses a newer format.' : 'The saved timeline format is invalid.');
    }
    const epoch = own(raw, 'epoch');
    if (epoch !== undefined && (typeof epoch !== 'string' || epoch.length > 120)) {
        throw new Error('The saved timeline reset marker is invalid.');
    }

    const posts = [];
    const postIds = new Set();
    const optionIndices = new Map();
    for (const item of raw.posts) {
        const id = storedId(own(item, 'id'));
        const authorKey = text(own(item, 'authorKey'), 520).trim();
        if (!id || !authorKey || postIds.has(id)) continue;
        const poll = own(item, 'poll');
        const options = [];
        const indices = new Map();
        if (isRecord(poll) && typeof own(poll, 'question') === 'string' && Array.isArray(own(poll, 'options'))) {
            poll.options.forEach((option, index) => {
                const label = typeof option === 'string' ? option : own(option, 'text');
                if (typeof label !== 'string' || !label.trim()) return;
                indices.set(index, options.length);
                options.push({ id: text(own(option, 'id'), 120) || `option-${index}`, text: label.slice(0, 120) });
            });
        }
        const image = own(item, 'image');
        const url = imageUrl(own(image, 'url'));
        posts.push({
            id,
            authorKey,
            body: text(own(item, 'body'), POST_MAX_CHARS),
            createdAt: storedTime(own(item, 'createdAt')),
            image: url !== null ? {
                url,
                prompt: text(own(image, 'prompt'), 2000),
                ...(Number.isSafeInteger(own(image, 'width')) && image.width > 0
                    && Number.isSafeInteger(own(image, 'height')) && image.height > 0
                    ? { width: image.width, height: image.height } : {}),
            } : null,
            poll: options.length >= 2 ? { question: poll.question.slice(0, 200), options } : null,
            authorSnapshot: snapshot(own(item, 'authorSnapshot')),
        });
        postIds.add(id);
        optionIndices.set(id, indices);
    }

    const interactions = [];
    const ids = new Set();
    for (const item of raw.interactions) {
        const id = storedId(own(item, 'id'));
        const postId = storedId(own(item, 'postId'));
        const actorKey = text(own(item, 'actorKey'), 520).trim();
        const type = own(item, 'type');
        if (!id || ids.has(id) || !postIds.has(postId) || !actorKey || !interactionTypes.has(type)) continue;
        const parent = own(item, 'parentInteractionId');
        if (parent != null && !storedId(parent) && type !== 'reply') continue;
        const index = own(item, 'pollOptionIndex');
        interactions.push({
            id,
            postId,
            type,
            actorKey,
            content: text(own(item, 'content'), REPLY_MAX_CHARS) || null,
            parentInteractionId: storedId(parent) || null,
            pollOptionIndex: Number.isInteger(index) && index >= 0
                ? (type === 'vote' ? optionIndices.get(postId).get(index) ?? null : index) : null,
            createdAt: storedTime(own(item, 'createdAt')),
            actorSnapshot: snapshot(own(item, 'actorSnapshot')),
        });
        ids.add(id);
    }
    return { version: 1, posts, interactions: reconcileInteractions(posts, interactions), ...(epoch !== undefined ? { epoch } : {}) };
}

function same(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => same(value, b[index]));
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function conflict(path) {
    throw new Error(`${path.join('.')} changed on another device. Your local changes have been kept.`);
}

function mergeValue(base, local, remote, path) {
    if (path.length === 2 && path[0] === 'settings' && ['activeSessionId', 'activeSessionByPersona'].includes(path[1])) {
        return structuredClone(local);
    }
    if (same(local, remote)) return structuredClone(local);
    if (same(local, base)) return structuredClone(remote);
    if (same(remote, base)) return structuredClone(local);

    const field = path.at(-1);
    const stringSet = path[0] === 'settings'
        && (['invited', 'scenarioNoteIds', 'noteIds', 'follows'].includes(field) || path.at(-2) === 'follows');
    if (stringSet && [base, local, remote].every(value => value === undefined
        || (Array.isArray(value) && value.every(item => typeof item === 'string')))) {
        const before = new Set(base);
        const mine = new Set(local);
        const theirs = new Set(remote);
        const merged = [...new Set([...(remote ?? []), ...(local ?? [])])]
            .filter(value => !before.has(value) || (mine.has(value) && theirs.has(value)));
        return path.at(-2) === 'follows' && !merged.length ? undefined : merged;
    }

    // These are observations, not editable settings: concurrent readers keep the latest time.
    if (path[0] === 'settings' && ['lastRefreshAt', 'timelineSeenAt', 'notificationsSeenAt'].includes(field)
        && [local, remote].every(value => Number.isFinite(value) && value >= (base ?? 0))) {
        return Math.max(local, remote);
    }

    if (isRecord(local) && isRecord(remote) && (base === undefined || isRecord(base))) {
        const keys = new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base ?? {})]);
        return Object.fromEntries([...keys].flatMap(key => {
            const value = mergeValue(own(base, key), own(local, key), own(remote, key), [...path, key]);
            return value === undefined ? [] : [[key, value]];
        }));
    }

    const rows = (path[0] === 'feeds' && path.length === 3 && ['posts', 'interactions'].includes(field))
        || (path[0] === 'settings' && field === 'strangers');
    if (rows && Array.isArray(local) && Array.isArray(remote) && (base === undefined || Array.isArray(base))) {
        const maps = [base ?? [], local, remote].map(items => {
            const map = new Map();
            for (const item of items) {
                const id = own(item, 'id');
                if (typeof id !== 'string' || !id || (map.has(id) && !same(map.get(id), item))) conflict(path);
                map.set(id, item);
            }
            return map;
        });
        const ids = new Set([...maps[2].keys(), ...maps[1].keys(), ...maps[0].keys()]);
        return [...ids].flatMap(id => {
            const item = mergeValue(maps[0].get(id), maps[1].get(id), maps[2].get(id), [...path, id]);
            return item === undefined ? [] : [item];
        });
    }
    conflict(path);
}

/**
 * Three-way merge, with remote.revision as the next save's base revision. Missing fields
 * mean deletion only when they existed in base. Selection stays local; no input is mutated.
 */
export function mergeStore(base, local, remote, { discardableInteractions = {} } = {}) {
    for (const store of [base, local, remote]) {
        if (!isRecord(store) || store.format !== 1 || !Number.isSafeInteger(store.revision) || store.revision < 0
            || !isRecord(store.settings) || !isRecord(store.settings.sessions) || !isRecord(store.feeds)) {
            throw new Error('The Meower store format is invalid or newer than this version.');
        }
        const sessionIds = Object.keys(store.settings.sessions);
        if (sessionIds.length !== Object.keys(store.feeds).length || sessionIds.some(id => !Object.hasOwn(store.feeds, id))) {
            throw new Error('The Meower timelines and their saved feeds do not match.');
        }
        for (const feed of Object.values(store.feeds)) {
            if (!isRecord(feed) || feed.version !== 1 || !Array.isArray(feed.posts) || !Array.isArray(feed.interactions)
                || (own(feed, 'epoch') !== undefined && (typeof feed.epoch !== 'string' || feed.epoch.length > 120))) {
                throw new Error('The saved timeline format is invalid or newer than this version.');
            }
        }
        if (own(store, 'account') !== undefined && own(remote, 'account') !== undefined && store.account !== remote.account) {
            throw new Error('The signed-in account changed. This draft belongs to the previous account.');
        }
    }

    let localFeeds = local.feeds;
    for (const id of Object.keys(base.settings.sessions)) {
        const before = own(base.feeds, id);
        const mine = own(local.feeds, id);
        const theirs = own(remote.feeds, id);
        const beforeSession = own(base.settings.sessions, id);
        const mySession = own(local.settings.sessions, id);
        const theirSession = own(remote.settings.sessions, id);
        if (!mine || !theirs) {
            const survivor = mine ?? theirs;
            if (survivor && (!same(survivor, before) || !same(mySession ?? theirSession, beforeSession))) {
                conflict(['settings', 'sessions', id]);
            }
            continue;
        }
        const myReset = !same(own(mine, 'epoch'), own(before, 'epoch'));
        const theirReset = !same(own(theirs, 'epoch'), own(before, 'epoch'));
        if (!myReset && !theirReset) continue;
        if (myReset && theirReset) {
            const withoutEpoch = feed => Object.fromEntries(Object.entries(feed).filter(([key]) => key !== 'epoch'));
            if (!same(withoutEpoch(mine), withoutEpoch(theirs)) || !same(mySession, theirSession)
                || (!same(mine.epoch, theirs.epoch) && (mine.posts.length || mine.interactions.length))) {
                conflict(['feeds', id, 'reset']);
            }
            localFeeds = { ...localFeeds, [id]: { ...mine, epoch: theirs.epoch } };
        } else if (!same(myReset ? theirs : mine, before) || !same(myReset ? theirSession : mySession, beforeSession)) {
            conflict(['feeds', id, 'reset']);
        }
    }

    const settings = mergeValue(base.settings, local.settings, remote.settings, ['settings']);
    for (const key of ['activeSessionId', 'activeSessionByPersona']) {
        if (Object.hasOwn(local.settings, key)) settings[key] = structuredClone(local.settings[key]);
        else delete settings[key];
    }
    const feeds = mergeValue(base.feeds, localFeeds, remote.feeds, ['feeds']);
    for (const [id, feed] of Object.entries(feeds)) {
        const before = own(base.feeds, id);
        const beforePosts = new Set(before?.posts.map(post => post.id));
        const beforeRows = new Map(before?.interactions.map(item => [item.id, item]));
        const posts = new Set(feed.posts.map(post => post.id));
        const rows = new Map(feed.interactions.map(item => [item.id, item]));
        const discardable = new Set(own(discardableInteractions, id));
        feed.interactions = feed.interactions.filter(item => {
            const answerable = item.type === 'reply' || (item.type === 'repost' && item.content?.trim());
            const targetDeleted = (beforePosts.has(item.postId) && !posts.has(item.postId))
                || (beforeRows.has(item.parentInteractionId) && !rows.has(item.parentInteractionId));
            if (answerable && targetDeleted && !same(beforeRows.get(item.id), item)) {
                // Only the generating caller can discard its own newly generated rows.
                // Human replies and quotes are otherwise retained as explicit conflicts.
                if (!beforeRows.has(item.id) && discardable.has(item.id)) return false;
                conflict(['feeds', id, 'interactions', item.id, 'deleted-target']);
            }
            return true;
        });
        const reactions = new Map();
        for (const item of feed.interactions) {
            if (item.type === 'reply') continue;
            const key = JSON.stringify([item.postId, item.actorKey, item.type, item.parentInteractionId ?? null]);
            const previous = reactions.get(key);
            if (previous && ((item.type === 'vote' && previous.pollOptionIndex !== item.pollOptionIndex)
                || (item.type === 'repost' && (previous.content ?? null) !== (item.content ?? null)))) {
                conflict(['feeds', id, 'interactions', item.postId, item.actorKey, item.type]);
            }
            reactions.set(key, item);
        }
        feed.interactions = reconcileInteractions(feed.posts, feed.interactions);
    }
    return {
        format: 1,
        revision: remote.revision,
        settings,
        feeds,
        ...(own(remote, 'account') !== undefined ? { account: remote.account } : {}),
    };
}
