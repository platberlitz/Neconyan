import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';

const invalid = message => { throw roleplayError('ROLEPLAY_WORKFLOW_INVALID', message, 409); };
const MAX_SPEAKERS = 64;

function draw(random) {
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) invalid('The saved group speaker draw is invalid.');
    return value;
}

function shuffle(items, random) {
    const list = [...items];
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(draw(random) * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function mentions(name, text) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu').test(text);
}

function contextPrompt(name, targetName = '') {
    const targetText = targetName ? ` The immediate call or message is directed at ${name} by ${targetName}; ${name} should answer ${targetName}.` : '';
    return `[Group context: write only as ${name}. Pay attention to who addressed whom in the recent chat. If the user calls for ${name}, answer the user. If another character calls for ${name}, answer that character. Characters may also talk to each other naturally when the context calls for it.${targetText}]`;
}

/** Freeze the exact enabled member order and model selection before paying for any speaker. */
export function captureRoleplayGroupSpeakers(base, account, source, { effect, forcedAvatars, selectedSpeakerAvatar,
    random = Math.random, generationId = Date.now() } = {}) {
    if (!source.locator?.group || !source.groupId || !['append', 'continue', 'swipe', 'replace'].includes(effect)
        || !Number.isSafeInteger(generationId) || generationId < 0) invalid('The accepted group turn is invalid.');
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source, { effect });
        const group = readRoleplayEntityLocked(lease, 'group', source.groupId).data;
        if (!Array.isArray(group.members) || !Array.isArray(group.disabled_members ?? [])
            || new Set(group.members).size !== group.members.length || group.members.length > MAX_SPEAKERS) {
            invalid('The saved group has no bounded unique speaker list.');
        }
        const enabled = group.members.filter(avatar => !group.disabled_members?.includes(avatar));
        if (!enabled.length) invalid('The group has no enabled saved speakers.');
        const cards = new Map(enabled.map(avatar => {
            const card = readRoleplayEntityLocked(lease, 'character', avatar).data;
            const name = card.data?.name ?? card.name;
            if (typeof name !== 'string' || !name.trim()) invalid('An enabled group member has no saved name.');
            return [avatar, { name, card }];
        }));
        const last = saved.records.at(-1);
        const freshUser = last?.is_user === true && effect === 'append';
        const text = typeof last?.mes === 'string' ? last.mes : '';
        const wholeGroup = freshUser && /(^|[^\p{L}\p{N}_])(?:everyone|everybody|you\s+all|y['’]?all|all)([^\p{L}\p{N}_]|$)/iu.test(text);
        let selected;
        if (forcedAvatars !== undefined) {
            if (!Array.isArray(forcedAvatars) || !forcedAvatars.length || forcedAvatars.length > MAX_SPEAKERS
                || forcedAvatars.some(avatar => !enabled.includes(avatar)) || new Set(forcedAvatars).size !== forcedAvatars.length) {
                invalid('The forced group speakers are not distinct enabled members.');
            }
            selected = [...forcedAvatars];
        } else if (effect !== 'append') {
            const record = saved.records[(effect === 'replace' ? source.range?.start : source.message?.index) + 1];
            const avatar = record?.original_avatar || enabled.find(member => cards.get(member).name === record?.name);
            if (!avatar || !enabled.includes(avatar) || selectedSpeakerAvatar && selectedSpeakerAvatar !== avatar) {
                invalid('The selected group message no longer belongs to an enabled speaker.');
            }
            selected = [avatar];
        } else if (wholeGroup) selected = [...enabled];
        else {
            const addressed = enabled.find(avatar => mentions(cards.get(avatar).name, text));
            if (addressed) selected = [addressed];
            else if (selectedSpeakerAvatar !== undefined) {
                if (!enabled.includes(selectedSpeakerAvatar)) invalid('The selected group speaker is disabled or missing.');
                selected = [selectedSpeakerAvatar];
            } else {
                const strategy = Number(group.activation_strategy ?? 0);
                if (strategy === 1) selected = [enabled[0]];
                else if (strategy === 3) {
                    const spoken = [];
                    for (const message of saved.records.slice(1).reverse()) {
                        if (message.is_user) break;
                        if (!message.is_system && enabled.includes(message.original_avatar)) spoken.push(message.original_avatar);
                    }
                    const available = enabled.filter(avatar => !spoken.includes(avatar));
                    const lastAvatar = enabled.includes(last?.original_avatar) ? last.original_avatar : '';
                    const pool = available.length ? available : enabled.length > 1 && lastAvatar
                        ? enabled.filter(avatar => avatar !== lastAvatar) : enabled;
                    selected = [pool[Math.floor(draw(random) * pool.length)]];
                } else if (strategy === 2 && !freshUser) selected = [shuffle(enabled, random)[0]];
                else if (strategy === 0) {
                    const banned = !freshUser && !group.allow_self_responses && !last?.is_user ? last?.name : null;
                    const mentioned = enabled.filter(avatar => cards.get(avatar).name !== banned
                        && cards.get(avatar).name.split(/\W+/u).some(word => word && text.toLowerCase().includes(word.toLowerCase())));
                    const shuffled = shuffle(enabled, random);
                    const chatty = shuffled.filter(avatar => cards.get(avatar).name !== banned
                        && Number(cards.get(avatar).card.data?.extensions?.talkativeness
                            ?? cards.get(avatar).card.talkativeness ?? 0.5) >= draw(random));
                    const pool = [...new Set([...mentioned, ...chatty])];
                    selected = [pool[0] ?? shuffled.find(avatar => cards.get(avatar).name !== banned) ?? shuffled[0]];
                } else invalid('Manual group selection needs an explicit saved speaker.');
            }
        }
        if (effect !== 'append' && selected.length !== 1) invalid('An anchored group edit needs its original speaker.');
        if (effect !== 'append') {
            const record = saved.records[(effect === 'replace' ? source.range?.start : source.message?.index) + 1];
            const original = record?.original_avatar || enabled.find(member => cards.get(member).name === record?.name);
            if (original !== selected[0]) invalid('A group edit cannot change the saved message speaker.');
        }
        const targetName = selected.length === 1 && mentions(cards.get(selected[0]).name, text)
            ? last?.is_user ? 'the user' : last?.name || 'another character' : '';
        const speakers = selected.map(avatar => {
            const name = cards.get(avatar).name;
            const modelOverride = group.member_models?.[avatar] ?? '';
            if (typeof modelOverride !== 'string' || modelOverride.length > 256) invalid('A saved group model override is invalid.');
            return { avatar, name, modelOverride: modelOverride.trim(), contextPrompt: contextPrompt(name, targetName) };
        });
        const value = { version: 1, groupId: source.groupId, sourceHash: roleplayHash(source),
            generationId, speakers, strategy: Number(group.activation_strategy ?? 0) };
        return { ...value, hash: roleplayHash(value) };
    });
}
