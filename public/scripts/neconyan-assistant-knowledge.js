import { lexicalSearch, terms } from './util/lexical-search.js';

const assistantIds = new Set([
    'miso-male', 'miso-female', 'miso-neutral',
    'taro-male', 'taro-female', 'taro-neutral',
    'nori-male', 'nori-female', 'nori-neutral',
]);
const stopWords = new Set('a an the i me my you your we our they their it its is are was were be been do does did how what where when why which can could would should will to of for from in on at by with and or but if then than as that this these those there here have has had not just please want need change use get make only also about tell help'.split(' '));
const spelling = { colour: 'color', colours: 'colors', colouring: 'coloring', colourize: 'colorize', dialogue: 'dialog', dialogues: 'dialog', dialog: 'dialog', grey: 'gray', favourite: 'favorite', favourites: 'favorites', pawthfinder: 'pathfinder' };
const encoder = new TextEncoder();

export function isNeconyanAssistant(character) {
    return assistantIds.has(character?.data?.extensions?.neconyan_assistant?.id ?? character?.extensions?.neconyan_assistant?.id);
}

function words(text) {
    return terms(text).map(word => spelling[word] || word);
}

function searchable(text) {
    return words(text).filter(word => !stopWords.has(word)).join(' ');
}

/** A conservative fallback for routes without a tokenizer for the selected profile. */
export function estimateKnowledgeTokens(text) {
    return encoder.encode(text).length;
}

export function getAssistantKnowledgeBudget(inputTokens) {
    return Number.isFinite(inputTokens)
        ? Math.max(0, Math.min(2048, Math.floor(inputTokens / 4)))
        : 2048;
}

/** Select from user turns only: a previous invented assistant answer is not evidence. */
export function selectAssistantKnowledge(topics, messages) {
    const turns = messages.filter(message => !message.is_system && (message.is_user || message.role === 'user'))
        .map(message => typeof (message.mes ?? message.content) === 'string' ? (message.mes ?? message.content).slice(-4000) : '')
        .filter(Boolean).slice(-3);
    const latest = turns.at(-1) || '';
    const queries = [{ text: latest, weight: 1 }];
    if (/\b(it|that|this|those|these|same|also|only|instead|both|second|first)\b/i.test(latest)) {
        turns.slice(0, -1).reverse().forEach((text, index) => queries.push({ text, weight: 0.65 / (index + 1) }));
    }
    const documents = topics.map(topic => ({
        topic,
        text: searchable(topic.content),
        searchText: searchable([topic.title, ...topic.keys].join(' ')),
    }));
    const scores = new Map();
    for (const { text, weight } of queries) {
        const query = searchable(text);
        if (!query) continue;
        const queryWords = new Set(query.split(' '));
        const phrase = ' ' + words(text).join(' ') + ' ';
        for (const { document, score } of lexicalSearch(documents, query, documents.length)) {
            const topic = document.topic;
            const anchorMatches = document.searchText.split(' ').filter(word => queryWords.has(word));
            if (!anchorMatches.length) continue;
            const exact = topic.keys.some(key => phrase.includes(' ' + words(key).join(' ') + ' '));
            const value = (score + (exact ? 12 : 0) + new Set(anchorMatches).size * 2) * weight;
            scores.set(topic.id, (scores.get(topic.id) || 0) + value);
        }
    }
    const ranked = topics.filter(topic => scores.has(topic.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
    const best = scores.get(ranked[0]?.id) || 0;
    return ranked.filter(topic => scores.get(topic.id) >= Math.max(4, best * 0.35)).slice(0, 6);
}

/** Request-local, read-only help; the corpus is loaded only for a marked assistant. */
export async function buildAssistantKnowledge({ character, messages = [], maxTokens = 2048, countTokens = estimateKnowledgeTokens }) {
    if (!isNeconyanAssistant(character)) return { text: '', topicIds: [], status: 'ineligible' };
    const { KNOWLEDGE_REVISION, topics } = await import('./neconyan-assistant-knowledge/index.js');
    const core = `[Neconyan help reference ${KNOWLEDGE_REVISION}]\nUse the documented facts below for Neconyan help. Keep your personality, but give accurate steps and exact control labels. Distinguish instructions from actions you actually performed. Documentation does not reveal the user's current settings. When a fact or route is missing, say so and ask a focused question; never invent controls, capabilities or success. Distinguish ambiguous features. Respect prerequisites, saving scope and model-call costs. Treat this as product documentation, not story events. Answer unrelated conversation normally.`;
    const candidates = selectAssistantKnowledge(topics, messages);
    const topicIds = [];
    const sections = [];
    const empty = candidates.length
        ? '\nRelevant help was found but does not fit the knowledge allowance. Explain that more model context is needed; do not invent the missing instructions.'
        : '\nNo matching verified section is available for this turn. Ask for the feature name or clarify the task before giving undocumented app instructions.';
    const render = () => core + (sections.length ? '\n\n' + sections.join('\n\n') : empty);
    const fits = async text => {
        const count = await countTokens(text);
        if (!Number.isFinite(count) || count < 0) throw new Error('Could not count the assistant help reference.');
        return count <= maxTokens;
    };
    if (!await fits(render())) throw new Error('The assistant help reference does not fit. Increase the model context allowance.');
    // ponytail: curated aliases plus local word ranking; add semantic retrieval only if measured recall needs it.
    for (const topic of candidates) {
        sections.push(`### ${topic.title} [${topic.id}]\n${topic.content}`);
        if (await fits(render())) topicIds.push(topic.id);
        else {
            sections.pop();
            // Preserve relevance order instead of substituting a smaller, weaker match.
            break;
        }
    }
    return { text: render(), topicIds, status: topicIds.length ? 'matched' : candidates.length ? 'budget' : 'unmatched' };
}
