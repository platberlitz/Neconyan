import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conversationDir = path.join(repoRoot, 'public', 'scripts', 'neconyan-conversation');
const normalizeSource = source => source.replace(/\r\n/g, '\n');

function readConversationSource(file) {
    return normalizeSource(readFileSync(path.join(conversationDir, file), 'utf8'));
}

const generationSource = readConversationSource('generation.js');
const attachmentsSource = readConversationSource('attachments.js');
const personasSource = readConversationSource('personas.js');
const chromeSource = readConversationSource('chrome.js');
const constantsSource = readConversationSource('constants.js');
const contextSource = readConversationSource('context.js');
const initSource = readConversationSource('init.js');
const mediaSource = readConversationSource('media.js');
const palsRailSource = readConversationSource('pals-rail.js');
const pickersSource = readConversationSource('pickers.js');
const promptSource = readConversationSource('prompt.js');
const promptMessagesSource = readConversationSource('prompt-messages.js');
const promptSystemSource = readConversationSource('prompt-system.js');
const sharedHelpersSource = readConversationSource('shared-helpers.js');
const renderUtilsSource = readConversationSource('render-utils.js');
const settingsStoreSource = readConversationSource('settings-store.js');
const stateSource = readConversationSource('state.js');
const threadStoreSource = readConversationSource('thread-store.js');
const timelineSource = readConversationSource('timeline-render.js');
const timelineSlashSource = readConversationSource('timeline-slash-commands.js');
const conversationTtsSource = readConversationSource('tts.js');
const extensionTtsSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'tts', 'index.js'), 'utf8'));
const pollinationsTtsSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'tts', 'pollinations.js'), 'utf8'));
const speechEndpointSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'endpoints', 'speech.js'), 'utf8'));
const speechTransportsSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'endpoints', 'speech-transports.js'), 'utf8'));
const conversationParticipantsSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'generation', 'conversation-participants.js'), 'utf8'));
const conversationJobsSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'generation', 'conversation-jobs.js'), 'utf8'));
const serverEndpointSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'endpoints', 'neconyan-conversation.js'), 'utf8'));
const conversationGenerationSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'endpoints', 'conversation-generation.js'), 'utf8'));
const serverStartupSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'server-startup.js'), 'utf8'));
const welcomeSource = normalizeSource(readFileSync(path.join(repoRoot, 'public', 'scripts', 'welcome-screen.js'), 'utf8'));

describe('conversation mode scoped connection profile', () => {
    test('removes the global profile switch wrapper and slash-command helpers', () => {
        expect(personasSource).not.toContain('withConversationConnectionProfile');
        expect(personasSource).not.toContain('applyConnectionProfileByName');
        expect(personasSource).not.toContain('queueConversationProfileSwitch');
        expect(personasSource).not.toContain('quoteSlashArg');
        // The old path ran the `/profile` slash command to flip the global profile.
        expect(personasSource).not.toContain('getSelectedConnectionProfileName');
        expect(personasSource).not.toContain('/profile ');
    });

    test('drops the now-unused selected-profile name reader and switch queue', () => {
        expect(chromeSource).not.toContain('getSelectedConnectionProfileName');
        expect(stateSource).not.toContain('conversationProfileSwitchQueue');
    });

    test('retires the page-owned raw generation helper and route caller', () => {
        expect(generationSource).not.toContain('generateConversationRaw');
        expect(generationSource).not.toContain('binding/generate');
        expect(generationSource).not.toContain('/profile ');
        expect(generationSource).not.toContain('generateRaw(');
    });

    test('replaces every generation call site with the scoped helper', () => {
        const consumers = ['generation.js', 'interface.js', 'schedule.js', 'timeline-render.js'];
        for (const file of consumers) {
            const source = readConversationSource(file);
            expect(source).toMatch(/submitConversationRewrite|captureConversationTextBinding|generateCharacterSchedule|requestConversationSelfie/);
            expect(source).not.toContain('withConversationConnectionProfile');
        }
        expect(readConversationSource('interface.js')).toContain('submitConversationRewrite(\'polish\'');
        expect(timelineSource).toContain('submitConversationRewrite(\'regenerate\'');
        expect(promptSource).toContain('captureConversationTextBinding');
        expect(promptSource).toContain('requestConversationBinding(\'summary/submit\'');
        expect(promptSource).not.toContain('generateConversationRaw');
    });

    test('keeps Conversation DM selection decoupled from roleplay chats and groups', () => {
        expect(chromeSource).not.toContain('selectCharacterById');
        expect(chromeSource).not.toContain('openGroupById');
        expect(pickersSource).not.toContain('/api/groups/create');
        expect(initSource).not.toContain('syncConversationWorkspaceToRoleplaySelection');
        expect(initSource).not.toContain('isAvatarInConversationGroup');
    });

    test('routes explicitly prefixed group replies to the named participant', () => {
        expect(readConversationSource('reply-delivery.js')).toContain('getSpeakerPrefixMatch');
        expect(conversationJobsSource).toContain('deliverConversationReply');
        expect(conversationJobsSource).toContain('partner_avatar: author.avatar');
        expect(generationSource).not.toContain('deliverConversationReply');
    });

    test('adds context-aware implicit references for group DMs', () => {
        expect(promptSource).toContain('composeConversationPromptMessages');
        expect(promptMessagesSource).toContain('buildConversationGroupReferenceContext');
        expect(promptMessagesSource).toContain('conversation-group-reference-context');
        expect(sharedHelpersSource).toContain('last non-user speaker before it');
        expect(sharedHelpersSource).toContain('do not assume every you means');
        expect(conversationParticipantsSource).toContain('buildConversationPromptMessages(current.branch.messages, directive, character.name, {');
        expect(conversationParticipantsSource).toContain('isBroadGroupAddress');
        expect(conversationParticipantsSource).toContain('chooseGroupReplyCandidates');
    });

    test('adds device date time and timezone context to Conversation prompts', () => {
        expect(promptSource).toContain('getConversationLocalTimeContext');
        expect(promptSource).toContain('Current device time context');
        expect(promptSource).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
        expect(promptSource).toContain('weekday: \'long\'');
        expect(promptSource).toContain('computer/phone time');
        expect(promptSource).toContain('getCurrentActivityFromSchedule(schedule, avatar, now, { personaId })');
    });

    test('adds compact editable Grounded Dialogue Rules as an optional global prompt block', () => {
        expect(constantsSource).toContain('DEFAULT_GROUNDED_DIALOGUE_RULES');
        expect(constantsSource).toContain('grounded_dialogue_rules_enabled: false');
        expect(constantsSource).toContain('{ id: \'sb_conv_grounded_dialogue_rules_enabled\', key: \'grounded_dialogue_rules_enabled\', prop: \'checked\' }');
        expect(constantsSource).toContain('{ id: \'sb_conv_grounded_dialogue_rules\', key: \'grounded_dialogue_rules\', prop: \'value\' }');
        expect(constantsSource).toContain('grounded_dialogue_rules_enabled');
        expect(constantsSource).toContain('grounded_dialogue_rules');
        expect(timelineSource).toContain('data-sb-conversation-action="edit-grounded-dialogue-rules"');
        expect(timelineSource).toContain('<textarea id="sb_conv_grounded_dialogue_rules" hidden></textarea>');
        expect(chromeSource).toContain('openGroundedDialogueRulesEditor');
        expect(chromeSource).toContain('case \'edit-grounded-dialogue-rules\':');
        expect(chromeSource).toContain('DEFAULT_GROUNDED_DIALOGUE_RULES');
        expect(promptSystemSource).toContain('getGroundedDialogueRulesPrompt(settings)');
        expect(promptSource).toContain('composeConversationSystemPrompt');
        expect(conversationGenerationSource).toContain('composeConversationSystemPrompt');
        // Server endpoint now imports from conversation-generation.js which imports from shared-helpers.js
        expect(serverEndpointSource).toContain('from \'./conversation-generation.js\'');
        // normalizeConversationSettings is now in conversation-generation.js
        expect(conversationGenerationSource).toContain('normalized.grounded_dialogue_rules_enabled = Boolean(normalized.grounded_dialogue_rules_enabled)');
    });

    test('keeps saved Conversation-owned group DMs visible without messages', () => {
        expect(settingsStoreSource).toContain('const hasConversationGroups');
        expect(settingsStoreSource).toContain('getConversationGroups().forEach');
        expect(settingsStoreSource).toContain('!group.is_conversation_group');
        expect(palsRailSource).toContain('getConversationGroups({ personaId }).forEach');
        expect(palsRailSource).toContain('isEmptyThread && !group?.is_conversation_group');
        expect(settingsStoreSource.indexOf('getConversationGroups().forEach')).toBeGreaterThanOrEqual(0);
        expect(palsRailSource.indexOf('getConversationGroups({ personaId }).forEach')).toBeGreaterThanOrEqual(0);
        expect(settingsStoreSource.indexOf('getConversationGroups().forEach')).toBeLessThan(settingsStoreSource.indexOf('Object.entries(getConversationStore().characters || {}).forEach'));
        expect(palsRailSource.indexOf('getConversationGroups({ personaId }).forEach')).toBeLessThan(palsRailSource.indexOf('Object.entries(getConversationStore().characters || {}).forEach'));
        expect(contextSource).toContain('group.updatedAt = Date.now();');
        expect(timelineSource).toContain('group.updatedAt = Date.now();');
    });

    test('defaults group DM cross-talk settings on without global solo overrides hiding them', () => {
        const groupSettingsIndex = settingsStoreSource.indexOf('if (groupId) {');
        expect(groupSettingsIndex).toBeGreaterThanOrEqual(0);
        expect(settingsStoreSource.indexOf('globalSettings', groupSettingsIndex)).toBeLessThan(settingsStoreSource.indexOf('GROUP_CONVERSATION_FORCED_SETTINGS', groupSettingsIndex));
        expect(settingsStoreSource.indexOf('GROUP_CONVERSATION_FORCED_SETTINGS', groupSettingsIndex)).toBeLessThan(settingsStoreSource.indexOf('getGroupConversationSettings(groupId)', groupSettingsIndex));
    });

    test('scopes Conversation storage by active persona to prevent bleedthrough', () => {
        expect(contextSource).toContain('PERSONA_CONVERSATION_STORE_PREFIX');
        expect(contextSource).toContain('getConversationPersonaId');
        expect(contextSource).toContain('scopeConversationStorageKey');
        expect(contextSource).toContain('isConversationThreadKeyForPersona');
        expect(contextSource).toContain('migrateLegacyConversationStoreToPersona');
        expect(contextSource).toContain('personaId: getConversationPersonaId(personaId)');
        expect(settingsStoreSource).toContain('isConversationThreadKeyForPersona(storeKey)');
        expect(palsRailSource).toContain('isConversationThreadKeyForPersona(storeKey, personaId)');
        expect(initSource).toContain('event_types.PERSONA_CHANGED');
    });

    test('uses reply metadata instead of copying quoted text into the composer', () => {
        expect(stateSource).toContain('conversationReplyTarget');
        expect(timelineSource).toContain('renderConversationComposerReplyPreview');
        expect(timelineSource).toContain('conversationReplyTarget = {');
        expect(timelineSource).toContain('!String(reference.messageId || \'\').trim()');
        expect(timelineSource).not.toContain('reference?.text || reference?.attachmentSummary || \'Message\'');
        expect(timelineSource).not.toContain('quoteBlock');
        expect(timelineSource).not.toContain('> **${speakerName}');
        expect(attachmentsSource).toContain('conversation_reply_to');
    });

    test('does not inline reply references in the Conversation prompt transcript', () => {
        expect(promptSource).not.toContain('formatConversationReplyReference');
        expect(promptSource).not.toContain('(replying to');
        expect(serverEndpointSource).not.toContain('formatConversationReplyReference');
    });

    test('lets generated character replies use message reply metadata', () => {
        expect(threadStoreSource).toContain('export function buildConversationMessageReplyReference');
        expect(timelineSource).toContain('buildConversationMessageReplyReference(context.message)');
        expect(conversationParticipantsSource).toContain('replyReference: automation ? null : buildConversationMessageReplyReference(');
        expect(conversationJobsSource).toContain('conversation_reply_to: snapshot.replyReference');
        expect(readConversationSource('reply-delivery.js')).toContain('const attachReplyReference = !referenced.has(speakerAvatar)');
        expect(readConversationSource('reply-delivery.js')).toContain('referenced.add(speakerAvatar)');
        expect(generationSource).not.toContain('getGeneratedReplyReference');
    });

    test('adds Quick Image Gen actions for actual selfie commands', () => {
        expect(timelineSource).toContain('getConversationSelfieCommandRequests');
        expect(timelineSource).toContain('conversation_commands?.selfieRequests');
        expect(timelineSource).toContain('SELFIE_COMMAND_RE');
        expect(timelineSource).toContain('sb-conversation-selfie-action');
        expect(timelineSource).toContain('requestConversationSelfie({');
        expect(timelineSource).toContain('sourceMessageId: String(context.message.id');
        expect(timelineSlashSource).toContain('requestConversationSelfie({ avatar, branchId: capturedBranchId');
        expect(renderUtilsSource).toContain('compactConversationCommandsFingerprint');
        expect(chromeSource).toContain('generate-selfie-command');
        expect(generationSource).toContain('requestConversationBinding(\'selfie/submit\'');
        expect(generationSource).not.toContain('generateConversationImage');
        expect(mediaSource).not.toContain('generateConversationImage');
        expect(mediaSource).not.toContain('getExtensionCapability(\'quick-image-gen\')');
        expect(mediaSource).not.toContain('../extensions/quick-image-gen/index.js');
    });

    test('suppresses the welcome recent-chat surface while Conversation Mode opens', () => {
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(true)');
        expect(welcomeSource).toContain('element.style.visibility = \'hidden\'');
        expect(welcomeSource).toContain('clearConversationWelcomeOpeningSuppressionAfterRender');
        expect(welcomeSource).toContain('requestAnimationFrame(() => requestAnimationFrame(clearSuppression))');
        expect(welcomeSource).toContain('setConversationWelcomeOpeningSuppressed(false)');
    });

    test('exposes Conversation REST discovery on one API base path', () => {
        expect(serverStartupSource).toContain('app.use(\'/api/neconyan-conversation\', neconyanConversationRouter)');
        expect(serverStartupSource).not.toContain('/api/neconyan/conversation');
        expect(serverStartupSource).not.toContain('sillybunny');
    });

    test('connects Conversation messages to the existing TTS extension', () => {
        expect(extensionTtsSource).toContain('export async function narrateTtsMessage');
        expect(extensionTtsSource).toContain('async function ensureTtsProviderLoaded');
        expect(extensionTtsSource).toContain('await ensureTtsProviderLoaded()');
        expect(extensionTtsSource.indexOf('await ensureTtsProviderLoaded()')).toBeLessThan(extensionTtsSource.indexOf('await initVoiceMap(Boolean(unrestrictedVoiceMap), [speaker])'));
        expect(extensionTtsSource).toContain('await initVoiceMap(Boolean(unrestrictedVoiceMap), [speaker])');
        expect(extensionTtsSource).toContain('await wrapper.update()');
        expect(extensionTtsSource).toContain('await processTtsQueue()');
        expect(extensionTtsSource).toContain('setTimeout(() => void wrapper.update(), 0)');
        expect(extensionTtsSource).toContain('processAndQueueTtsMessage({ ...message, name: speaker }, messageId, { manual: isManual, isStillVisible })');
        expect(conversationTtsSource).toContain('getExtensionCapability(\'tts\')');
        expect(conversationTtsSource).not.toContain('../extensions/tts/index.js');
        expect(conversationTtsSource).toContain('narrateTtsMessage(ttsMessage');
        expect(threadStoreSource).toContain('void narrateConversationMessage(message, { isStillVisible })');
        expect(timelineSource).toContain('action: \'speak-message\'');
        expect(timelineSource).toContain('speakConversationMessage');
        expect(chromeSource).toContain('case \'speak-message\':');
    });

    test('sends Pollinations TTS text as literal speech input', () => {
        expect(pollinationsTtsSource).toContain('text: chunk');
        expect(pollinationsTtsSource).not.toContain('Say exactly this and nothing else');
        expect(speechTransportsSource).toContain('https://gen.pollinations.ai/v1/audio/speech');
        expect(speechTransportsSource).toContain('model === \'openai-audio\' ? \'openai/tts-1\' : model');
        expect(speechTransportsSource).toContain('input: text');
        expect(speechEndpointSource).not.toContain('modalities: [\'text\', \'audio\']');
    });

    test('advances TTS queue immediately after segment generation completes', () => {
        const extensionTtsLines = extensionTtsSource.split('\n');
        const completeTtsJobIndex = extensionTtsLines.findIndex(line => line.includes('function completeTtsJob()'));
        expect(completeTtsJobIndex).toBeGreaterThanOrEqual(0);

        // Find the closing brace of completeTtsJob function
        let braceCount = 0;
        let endIndex = completeTtsJobIndex;
        for (let i = completeTtsJobIndex; i < extensionTtsLines.length; i++) {
            const line = extensionTtsLines[i];
            braceCount += (line.match(/{/g) || []).length;
            braceCount -= (line.match(/}/g) || []).length;
            if (braceCount === 0 && i > completeTtsJobIndex) {
                endIndex = i;
                break;
            }
        }

        const completeTtsJobBody = extensionTtsLines.slice(completeTtsJobIndex, endIndex + 1).join('\n');
        expect(completeTtsJobBody).toContain('ttsJobQueue.length > 0');
        expect(completeTtsJobBody).toContain('scheduleTtsQueueWakeup()');

        // The wakeup helper must schedule a macrotask; a microtask can run before
        // SimpleMutex releases and be swallowed.
        const wakeupIndex = extensionTtsLines.findIndex(line => line.includes('function scheduleTtsQueueWakeup()'));
        expect(wakeupIndex).toBeGreaterThanOrEqual(0);
        const wakeupBody = extensionTtsLines.slice(wakeupIndex, wakeupIndex + 6).join('\n');
        expect(wakeupBody).toContain('setTimeout(() => void wrapper.update(), 0)');
        expect(extensionTtsSource).not.toContain('queueMicrotask(() => void wrapper.update())');
    });

    test('waits around five seconds for rapid follow-up messages before replying', () => {
        const serverJobsSource = normalizeSource(readFileSync(path.join(repoRoot, 'src', 'generation', 'conversation-jobs.js'), 'utf8'));
        expect(serverJobsSource).toContain('COALESCE_WINDOW_MS = 5000');
        expect(serverJobsSource).toContain('deadline: Date.now() + COALESCE_WINDOW_MS');
        expect(attachmentsSource).not.toContain('SEND_QUEUE_COALESCE_MS');
    });
});
