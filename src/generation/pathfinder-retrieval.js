import { createHash } from 'node:crypto';
import { readTreeLayout, getEntryPlacement } from '../../public/scripts/extensions/in-chat-agents/pathfinder/layout-data.js';
import { isEntryEligible } from '../../public/scripts/extensions/in-chat-agents/pathfinder/lorebook-policy.js';
import { getCounter } from '../mewmory/tokens.js';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { createMacroEnvironment } from '../macros/index.js';
import { getChatProfileContextLimit } from './profiles.js';
import { runChatProfile } from './service.js';
import { pathfinderPipeline, readPathfinderAgent } from './world-info-pathfinder.js';
import { assertRoleplayWorldInfoCurrent, readBoundPathfinderBooks } from './world-info.js';

const invalid = message => { throw roleplayError('ROLEPLAY_INVALID', message, 409); };
const recovery = message => { throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', message, 503); };
const NODE_SYSTEM = 'You are a lorebook retrieval assistant. Analyze the conversation and identify which waypoints are relevant. Respond with waypoint/node IDs (the "id: node_..." values), one per line.';

function category(entry) {
    const name = String(entry.comment || entry.key?.[0] || `Entry ${entry.uid}`).trim();
    if (/^\[Tracker\]/i.test(name)) return 'Trackers';
    if (/^\[Summary\]/i.test(name)) return 'Summaries';
    if (/^(character|npc|creature|faction)/i.test(name)) return 'Characters';
    if (/^(location|place|area|room|building|city|town|dungeon)/i.test(name)) return 'Locations';
    if (/^(rule|mechanic|system|magic|combat|skill)/i.test(name)) return 'World Rules';
    return 'Uncategorized';
}

export function pathfinderTreeForBook(bookName, book, bookHash) {
    const runtimeId = localId => `node_${createHash('sha256').update(JSON.stringify([bookName, bookHash, localId])).digest('hex').slice(0, 20)}`;
    const nodes = new Map();
    const categories = new Map();
    const restore = saved => {
        const node = { id: runtimeId(saved.id), localId: saved.id, name: saved.name, entries: [], children: [] };
        nodes.set(saved.id, node);
        if (saved.generatedCategory) categories.set(saved.generatedCategory, node);
        node.children = saved.children.map(restore);
        return node;
    };
    const saved = readTreeLayout(book);
    const root = saved ? restore(saved) : { id: runtimeId('root'), localId: 'root', name: 'Root', entries: [], children: [] };
    nodes.set(saved?.id ?? 'root', root);
    const seen = new Set();
    for (const [key, entry] of Object.entries(book.entries)) {
        if (!isEntryEligible(entry)) continue;
        const uid = entry.uid ?? (Number.isSafeInteger(Number(key)) ? Number(key) : key);
        if (seen.has(String(uid))) continue;
        seen.add(String(uid));
        let node = nodes.get(getEntryPlacement(entry));
        if (!node) {
            const name = category(entry);
            node = categories.get(name);
            if (!node) {
                let localId = `category_${name.replaceAll(' ', '_')}`;
                while (nodes.has(localId)) localId += '_';
                node = { id: runtimeId(localId), localId, name, entries: [], children: [] };
                nodes.set(localId, node);
                categories.set(name, node);
                root.children.push(node);
            }
        }
        node.entries.push(uid);
    }
    return root;
}

function guide(tree) {
    const lines = [];
    const walk = (node, depth = 0) => {
        let line = `${'  '.repeat(depth)}${node.name}`;
        if (node.entries.length) line += ` (${node.entries.length} entries)`;
        if (node.children.length) line += ` [${node.children.length} sub-waypoints]`;
        if ((depth || node.entries.length) && node.id) line += ` [id: ${node.id}]`;
        lines.push(line);
        for (const child of node.children) walk(child, depth + 1);
    };
    walk(tree);
    return lines.join('\n');
}

function namesInTree(tree) {
    return new Set([...(tree.entries ?? []), ...tree.children.flatMap(child => [...namesInTree(child)])].map(String));
}

function entriesForBooks(names, books, hashes) {
    const entries = [];
    const trees = new Map();
    for (const name of names) {
        const book = books[name];
        const tree = pathfinderTreeForBook(name, book, hashes[name]);
        trees.set(name, tree);
        const uids = namesInTree(tree);
        for (const [key, entry] of Object.entries(book.entries)) {
            const uid = entry.uid ?? (Number.isSafeInteger(Number(key)) ? Number(key) : key);
            if (!isEntryEligible(entry) || !uids.has(String(uid))) continue;
            if (entry.content !== undefined && typeof entry.content !== 'string') invalid('A Pathfinder lorebook entry must contain text.');
            const title = String(entry.comment || entry.key?.[0] || `Entry ${uid}`);
            entries.push({ bookName: name, uid, name: title, content: entry.content || '',
                label: `${JSON.stringify([name, uid])} ${title}` });
        }
    }
    return { entries, trees };
}

function formatContext(entries) {
    return entries.length ? `<pathfinder_context>\n${entries.map(entry => `[${entry.name}]\n${entry.content}`).join('\n\n')}\n</pathfinder_context>` : '';
}

function mappedPrompt(stage, settings, entries, history, current, outputs) {
    const byName = new Map(entries.map(entry => [entry.label, entry]));
    const inputs = {};
    for (const [key, mapping] of Object.entries(stage.inputMapping)) {
        if (mapping === 'source:chat_history') inputs[key] = history;
        else if (mapping === 'source:entry_names') inputs[key] = [...byName.keys()].map(name => `- ${name}`).join('\n');
        else if (mapping === 'prev:candidate_entries') {
            const limit = Math.max(1, Math.min(50, Math.floor(Number(settings.maxCandidates) || 20)));
            const length = Number(settings.truncateLength ?? 500);
            if (settings.entryContentMode === 'truncated' && (!Number.isSafeInteger(length) || length < 0)) {
                invalid('The saved Pathfinder entry length is invalid.');
            }
            inputs[key] = current.slice(0, limit).map(name => {
                const entry = byName.get(name);
                if (!entry) return '';
                let content = entry.content;
                if (settings.entryContentMode === 'truncated' && content.length > length) content = content.slice(0, length) + '...';
                return `### ${name}\n${content}`;
            }).filter(Boolean).join('\n\n');
        } else if (mapping.startsWith('prev:')) inputs[key] = outputs.get(mapping.slice(5))?.join('\n') ?? '';
        else if (mapping.startsWith('settings:')) inputs[key] = String(settings[mapping.slice(9)] ?? '');
        else inputs[key] = mapping;
    }
    return inputs;
}

function selectedNames(text, format, entries) {
    const byName = new Map(entries.map(entry => [entry.label, entry]));
    const resolve = name => {
        if (typeof name !== 'string') return null;
        const trimmed = name.trim();
        if (byName.has(trimmed)) return trimmed;
        const normalized = trimmed.replace(/\s+/g, ' ').toLowerCase();
        const matches = entries.filter(entry => entry.label.replace(/\s+/g, ' ').toLowerCase() === normalized
            || entry.name.replace(/\s+/g, ' ').toLowerCase() === normalized);
        return matches.length === 1 ? matches[0].label : null;
    };
    const trimmed = text.trim();
    if (format === 'json_object' || format === 'json_array') {
        const source = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
        let json;
        try { json = JSON.parse(source); } catch {
            if (source.startsWith('{') || source.startsWith('[') || trimmed.startsWith('```')) {
                invalid('The Pathfinder retrieval result has invalid JSON.');
            }
        }
        if (json !== undefined) {
            const candidates = Array.isArray(json) ? json : json?.candidates ?? json?.selected;
            if (!Array.isArray(candidates) || candidates.some(name => typeof name !== 'string')) {
                invalid('The Pathfinder retrieval result has no valid entry list.');
            }
            return [...new Set(candidates.map(resolve).filter(Boolean))];
        }
    }
    const selected = trimmed.split('\n').map(line => resolve(line.replace(/^[-*]\s*/, ''))).filter(Boolean);
    if (!selected.length) invalid('The Pathfinder retrieval result contains no valid entries.');
    return [...new Set(selected)];
}

async function paidStage(context, { base, snapshot, identity, stageId, binding, messages, requestedTokens,
    temperature, generate, count, macroSnapshot, assertBeforeDispatch }) {
    const { directories, job } = context;
    const contextLimit = getChatProfileContextLimit(directories, binding) ?? 8192;
    const inputTokens = await count(messages.map(message => message.content).join('\n\n'));
    const maxTokens = Math.min(64000, Math.floor(Number(requestedTokens) || 2048), contextLimit - inputTokens - 64);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) invalid('The Pathfinder request exceeds its saved connection context limit.');
    const input = { identity, binding, messages, maxTokens, temperature: Number.isFinite(temperature) ? temperature : null };
    const artifact = `pathfinder:${stageId}:input`;
    const saved = readArtifact(directories, job.id, artifact);
    if (saved !== undefined && roleplayHash(saved) !== roleplayHash(input)) recovery('The saved Pathfinder stage has different inputs.');
    if (saved === undefined) writeArtifact(directories, job.id, artifact, input);
    if (unresolvedProviderStep(directories, job.id)) {
        recovery('The previous Pathfinder provider outcome is unknown. It cannot be repeated automatically.');
    }
    const named = binding.kind === 'profile';
    // The sidecar must not advance the main prompt's saved variable or random-macro state.
    const macroEnvironment = createMacroEnvironment(macroSnapshot, {}, { readOnly: true });
    const response = await generate({ context: base, jobContext: context, binding, messages, maxTokens,
        signal: context.signal, macroEnvironment, userName: snapshot.speakerNames.user,
        characterName: snapshot.speakerNames.character, stream: false,
        rawOptions: { ...(binding.backend === 'text' && named ? {} : { cacheScope: 'auxiliary' }),
            ...(!named && Number.isFinite(temperature) ? { temperature } : {}) },
        overridePayload: named && Number.isFinite(temperature) ? { temperature } : {},
        beforeDispatch: () => { assertBeforeDispatch(); assertRoleplayWorldInfoCurrent(base, snapshot); },
        onProviderStep: step => {
            if (getJob(directories, job.id)?.resume === step && readArtifact(directories, job.id, step) === undefined) {
                recovery('The previous Pathfinder provider outcome is unknown. It cannot be repeated automatically.');
            }
        },
    });
    if (typeof response?.text !== 'string' || Buffer.byteLength(response.text) > 1024 * 1024) {
        invalid('The saved Pathfinder provider result has no usable text.');
    }
    return response.text;
}

/** Each accepted sidecar stage saves exact model input and result; an uncertain result cannot repeat on recovery. */
export async function runBoundPathfinderRetrieval(context, { base, snapshot, records, preparedHistory, worldInfo,
    contributions, mainBinding, macroSnapshot, assertBeforeDispatch, generate = runChatProfile } = {}) {
    if (!snapshot?.pathfinder) return null;
    const { directories, job } = context;
    const identity = roleplayHash({ snapshot, history: preparedHistory.hash, contributors: contributions,
        activated: worldInfo.activated, mainBinding });
    const completed = readArtifact(directories, job.id, 'roleplay-pathfinder');
    if (completed !== undefined) {
        const { hash, ...result } = completed ?? {};
        if (result.identity !== identity || hash !== roleplayHash(result)
            || result.prompt && (result.prompt.key !== (result.mode === 'pipeline' ? 'pathfinder_pipeline_retrieval' : 'pathfinder_sidecar_retrieval')
                || result.prompt.position !== 0 || result.prompt.depth !== 4 || result.prompt.role !== 'system'
                || result.prompt.scan !== false || typeof result.prompt.content !== 'string')) {
            recovery('The saved Pathfinder retrieval needs recovery.');
        }
        return completed;
    }
    context.signal.throwIfAborted();
    const books = readBoundPathfinderBooks(base, snapshot);
    const agent = withRoleplayAccount(base, snapshot.account, () => readPathfinderAgent(directories, {
        id: snapshot.pathfinder.agentId, revision: snapshot.pathfinder.revision, physical: snapshot.pathfinder.physical,
    }));
    const settings = agent.settings ?? {};
    const { entries, trees } = entriesForBooks(snapshot.pathfinder.books, books, snapshot.bookHashes);
    const history = records.slice(1).map((record, index) => ({
        name: record.name, is_user: record.is_user, mes: preparedHistory.content[index],
    })).slice(-10);
    const chatHistory = history.map(message => `${message.is_user ? 'User' : message.name || 'Assistant'}: ${message.mes}`).join('\n\n');
    const { count } = await getCounter(snapshot.tokenizer);
    const stageMacros = { ...macroSnapshot, variables: preparedHistory.macroState.variables,
        extra: { ...macroSnapshot.extra, chatMetadata: preparedHistory.macroState.chatMetadata,
            bannedWords: preparedHistory.macroState.bannedWords } };
    let selection = [];
    const stageResults = [];
    const mode = settings.pipelineEnabled ? 'pipeline' : 'sidecar';
    if (entries.length && history.length) {
        if (settings.pipelineEnabled) {
            const { pipeline, prompts } = pathfinderPipeline(settings);
            const outputs = new Map();
            const maxCandidates = Math.max(1, Math.min(50, Math.floor(Number(settings.maxCandidates) || 20)));
            for (const [index, stage] of pipeline.stages.entries()) {
                context.signal.throwIfAborted();
                if (stage.optional && stage.skipCondition && settings[stage.skipCondition]) {
                    stageResults.push({ index, promptId: stage.promptId, skipped: true });
                    continue;
                }
                const prompt = prompts[stage.promptId];
                const profile = prompt.connectionProfile || settings.connectionProfile;
                const binding = profile ? { kind: 'profile', ...snapshot.pathfinder.bindings[profile] } : mainBinding;
                if (!binding?.fingerprint) invalid('The selected Pathfinder connection was not captured at admission.');
                const inputs = mappedPrompt(stage, settings, entries, chatHistory, selection, outputs);
                const messages = [{ role: 'system', content: prompt.systemPrompt }, { role: 'user', content: Object.entries(inputs)
                    .reduce((text, [key, value]) => text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value), prompt.userPromptTemplate) }];
                const text = await paidStage(context, { base, snapshot, identity, stageId: `${index}`,
                    binding, messages, requestedTokens: prompt.settings?.maxTokens ?? 64000,
                    temperature: prompt.settings?.temperature, generate, count, macroSnapshot: stageMacros, assertBeforeDispatch });
                const filtering = Object.values(stage.inputMapping).includes('prev:candidate_entries')
                    && !Object.values(stage.inputMapping).includes('source:entry_names');
                try {
                    const offered = filtering ? entries.filter(entry => selection.includes(entry.label)) : entries;
                    selection = selectedNames(text, prompt.outputFormat, offered).slice(0, maxCandidates);
                    outputs.set(stage.outputKey, selection);
                    stageResults.push({ index, promptId: stage.promptId, selected: selection });
                } catch (error) {
                    if (!stage.optional) throw error;
                    stageResults.push({ index, promptId: stage.promptId, failed: true });
                }
            }
            selection = selection.map(name => entries.find(entry => entry.label === name));
        } else {
            const contextText = snapshot.pathfinder.books.map(name => `\n### ${name}\n${guide(trees.get(name))}\n`).join('');
            const prompt = `Given the current conversation context, which of these lorebook waypoints contain information relevant to what's happening right now? List the waypoint/node IDs (the "id: node_..." values) you'd retrieve.\n\n${chatHistory}\n\n${contextText}`;
            const profile = settings.connectionProfile;
            const binding = profile ? { kind: 'profile', ...snapshot.pathfinder.bindings[profile] } : mainBinding;
            if (!binding?.fingerprint) invalid('The selected Pathfinder connection was not captured at admission.');
            const text = await paidStage(context, { base, snapshot, identity, stageId: 'legacy', binding,
                messages: [{ role: 'system', content: NODE_SYSTEM }, { role: 'user', content: prompt }],
                requestedTokens: 2048, generate, count, macroSnapshot: stageMacros, assertBeforeDispatch });
            const ids = new Set(text.split('\n').map(line => line.match(/node_[a-z0-9]+/i)?.[0]).filter(Boolean));
            const matches = new Set();
            const visit = node => {
                if (ids.has(node.id)) for (const uid of node.entries) matches.add(String(uid));
                for (const child of node.children) visit(child);
            };
            for (const [name, tree] of trees) {
                matches.clear();
                visit(tree);
                selection.push(...entries.filter(entry => entry.bookName === name && matches.has(String(entry.uid))));
            }
            stageResults.push({ index: 0, promptId: 'legacy-sidecar', ids: [...ids] });
        }
    }
    const activated = new Set(worldInfo.activated.map(entry => JSON.stringify([entry.world, String(entry.uid)])));
    const selected = selection.filter(entry => settings.dedupeNaturalActivation === false
        || !activated.has(JSON.stringify([entry.bookName, String(entry.uid)])));
    const reserved = [snapshot.global.characterDescription, snapshot.global.characterPersonality,
        snapshot.global.personaDescription, snapshot.global.scenario, ...preparedHistory.promptChat.slice(0, 10),
        ...contributions.extensions.map(entry => entry.content), ...worldInfo.activeLore.map(entry => entry.content)].join('\n\n');
    const budget = Math.max(0, Math.min(Math.floor(snapshot.maxContext / 4), snapshot.maxContext - await count(reserved) - 128));
    const fitted = [];
    for (const entry of selected) {
        if (await count(formatContext([...fitted, entry])) <= budget) fitted.push(entry);
    }
    const content = formatContext(fitted);
    const result = { identity, mode, stageResults, selected: fitted.map(({ bookName, uid }) => [bookName, uid]),
        ...(content ? { prompt: { key: mode === 'pipeline' ? 'pathfinder_pipeline_retrieval' : 'pathfinder_sidecar_retrieval',
            content, position: 0, depth: 4, role: 'system', scan: false } } : {}) };
    const completedResult = { ...result, hash: roleplayHash(result) };
    writeArtifact(directories, job.id, 'roleplay-pathfinder', completedResult);
    return completedResult;
}
