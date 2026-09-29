import { isNeconyanAssistant } from '../../public/scripts/neconyan-assistant-knowledge.js';
import { isConversationGroupSpeakerEligible } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { getJob } from '../jobs/store.js';
import { readArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { readRoleplayEntityLocked } from './roleplay-source.js';
import { assertConversationEffectSource } from './conversation-effects.js';

const invalid = message => roleplayError('CONVERSATION_ASSISTANT_SOURCE_CHANGED', message, 409);
const assistantId = character => character?.data?.extensions?.neconyan_assistant?.id ?? character?.extensions?.neconyan_assistant?.id;
const descriptor = ({ data: _data, changed: _changed, ...value }) => value;

/** A Conversation branch is the source. No Roleplay chat is needed or created. */
export function captureConversationAssistantSource(context, snapshot) {
    const base = { owner: context.owner, directories: context.directories };
    const account = snapshot.assistantTools?.account;
    if (!account) throw invalid('The accepted assistant account is unavailable.');
    return withRoleplayAccount(base, account, lease => {
        const character = readRoleplayEntityLocked(lease, 'character', snapshot.speaker.avatar);
        if (character.changed) saveRoleplayAccount(lease);
        const source = { kind: 'conversation-assistant', ...account, instanceId: context.job.id,
            intentHash: roleplayHash(context.job.intent), snapshotHash: roleplayHash(snapshot),
            avatar: snapshot.speaker.avatar, assistantId: snapshot.assistantTools.id,
            dependencies: [descriptor(character)] };
        assertConversationAssistantSourceLocked(lease, source);
        return source;
    });
}

/** Reuse the account lock and saved branch checkpoint for every assistant tool effect. */
export function assertConversationAssistantSourceLocked(lease, source, { ownCharacterEdit = false } = {}) {
    const { scope } = roleplayLease(lease);
    if (source?.kind !== 'conversation-assistant' || source.accountId !== scope.accountId || source.dataEpoch !== scope.dataEpoch) {
        throw invalid('The Conversation assistant belongs to a different account.');
    }
    const job = getJob(scope.directories, source.instanceId);
    if (!job || job.owner !== scope.owner || !['conversation.participant', 'conversation.reply'].includes(job.type)
        || !['running', 'queued', 'waiting'].includes(job.state) || roleplayHash(job.intent) !== source.intentHash) {
        throw invalid('The accepted Conversation assistant reply is no longer active.');
    }
    const snapshot = readArtifact(scope.directories, job.id, 'request');
    if (!snapshot || roleplayHash(snapshot) !== source.snapshotHash || snapshot.speaker.avatar !== source.avatar
        || snapshot.assistantTools?.id !== source.assistantId
        || roleplayHash(snapshot.assistantTools.account) !== roleplayHash({ accountId: scope.accountId, dataEpoch: scope.dataEpoch })) {
        throw invalid('The accepted Conversation assistant changed.');
    }
    const current = assertConversationEffectSource({ job, directories: scope.directories, owner: scope.owner }, snapshot.target, 'assistant-tools');
    if (snapshot.target.groupId && !isConversationGroupSpeakerEligible(current.group, source.avatar)) {
        throw invalid('The Conversation assistant is no longer available in this group.');
    }
    if (source.dependencies?.length !== 1 || source.dependencies[0].locator?.avatar !== source.avatar) {
        throw invalid('The Conversation assistant character binding is invalid.');
    }
    // An approved self-edit validates the replacement card against its physical
    // write receipt in assistant-character-actions instead of the original card.
    if (!ownCharacterEdit) {
        const character = readRoleplayEntityLocked(lease, 'character', source.avatar);
        if (character.changed || roleplayHash(descriptor(character)) !== roleplayHash(source.dependencies[0])
            || !isNeconyanAssistant(character.data) || assistantId(character.data) !== source.assistantId) {
            throw invalid('The Conversation assistant card changed before its tool could finish.');
        }
    }
    return current;
}
