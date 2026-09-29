import { eventSource, event_types, getCurrentChatId, substituteParams } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { getDataBankAttachments } from '../../chats.js';
import { getStringHash } from '../../utils.js';
import { getAssistantIconSrc } from '../../neconyan-assistant-art.js';
import { accountStorage } from '../../util/AccountStorage.js';
import { t } from '../../i18n.js';
import { mountSavedVectorWork, runVectorWork } from './native.js';

const GUIDE_KEY = 'neconyanVectorsGuideStep';
function renderSearchResults(results, result) {
    // Retrieved passages and source names are user content, not interface captions.
    results.setAttribute('data-i18n-ignore', '');
    const matches = Object.entries(result).flatMap(([id, value]) => Array.isArray(value?.metadata) ? value.metadata.map((metadata, index) => ({
        ...metadata, label: value.label || id, score: value.scores[index],
    })) : []).sort((a, b) => b.score - a.score);
    results.replaceChildren();
    for (const match of matches) {
        const item = document.createElement('li');
        const heading = document.createElement('strong');
        heading.textContent = t`Score ${match.score.toFixed(3)} · ${match.label}`;
        const position = document.createElement('small'); position.textContent = t`Source position: ${match.index}`;
        const text = document.createElement('p'); text.textContent = match.text;
        item.append(heading, position, text); results.append(item);
    }
    return matches.length;
}

const steps = () => [
    { tab: 'connection', title: t`First paws: what are we finding?`, body: t`Meowlcome~! Vectorization finds text by meaning, even when the words differ. It can bring an old promise, a passage from a file or a lorebook entry into your next reply.\nIt does not make your model remember everything. Mewmory and Conversation summaries are separate features. We'll choose what to search, then check what comes back.` },
    { tab: 'connection', title: t`Give the search its own model`, body: t`The embedding provider turns text into numbers for searching. Local (Transformers) runs on your Neconyan server; its first use may download a model. Hosted providers use the keys in Connections. WebLLM needs this page open.\nChoose an embedding model, not a chat model. Your existing provider and model choices stay yours. When you change either, index your sources for the new choice.` },
    { tab: 'chats', title: t`Keep the recent conversation together`, body: t`Turn on chat retrieval to recall older messages. Recent messages kept in place protects the newest part of your chat. Older messages to retrieve sets how many earlier messages can return.\nIndex chat catches up with the current conversation. If you change chunk size or summaries, use Rebuild chat. The old index stays usable until the replacement is ready. Your original messages stay saved, promise~!` },
    { tab: 'files', title: t`A small passage can be enough`, body: t`Add text through the Data Bank or attach a file to a message, then enable file retrieval. Large files are split into chunks: smaller pieces that can be searched separately.\nStart with the existing chunk sizes. If a fact gets cut in half, try some overlap and rebuild. Retrieve only the passages you need; every extra passage uses room in the model's prompt. Translation is optional and uses a separate connection.` },
    { tab: 'world', title: t`Let related lore join in`, body: t`Lorebook retrieval looks through the books active for your chat. It can match an entry by meaning without a keyword appearing.\nBy default, only entries marked for vector matching participate. Search all enabled entries broadens that to the whole active book, but disabled entries stay out. The lorebook's own insertion rules and budgets still apply.` },
    { tab: 'search', title: t`Let's check one familiar detail`, body: t`Index a source first, choose it here, then type a detail you know it contains. Search index shows the saved chunks and their similarity scores. It makes an embedding query, but does not send a chat reply.\nNo results? Check the source, provider and model, then lower the score for this search. Too much unrelated text? Raise it a little. A score is not a confidence percentage, and different models need different thresholds. These test controls do not change reply settings.` },
    { tab: 'work', title: t`You're ready to try it in a reply`, body: t`Once your search returns useful text, enable the source you want and send a message. Check the prompt template includes the text placeholder, then choose where it belongs.\nSaved work lets you revisit indexing and searches after leaving the page. A failed rebuild keeps the previous index. Clearing an index keeps its source text, but enabled retrieval can build it again.\nYou did it! Come back to this guide whenever you like. I'll be right here, getting excited about the useful bits with you~!` },
];

export function mountVectorWorkspace(settings) {
    const root = document.querySelector('#vectors_container .vectors-workspace');
    const find = selector => root.querySelector(selector);
    const tabs = [...root.querySelectorAll('[data-vectors-tab]')];
    const openTab = (name, focus = false) => {
        for (const tab of tabs) {
            const active = tab.dataset.vectorsTab === name;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            find(`#${tab.getAttribute('aria-controls')}`).hidden = !active;
            if (active && focus) tab.focus();
        }
    };
    for (const [index, tab] of tabs.entries()) {
        tab.addEventListener('click', () => openTab(tab.dataset.vectorsTab));
        tab.addEventListener('keydown', event => {
            const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            openTab(tabs[next].dataset.vectorsTab, true);
        });
    }

    const image = find('[data-vectors-miso]');
    const portrait = () => { image.src = getAssistantIconSrc('miso'); };
    portrait();
    image.addEventListener('error', () => { image.hidden = true; });
    image.addEventListener('load', () => { image.hidden = false; });
    window.addEventListener('neconyan:assistant-gender-changed', portrait);
    const guide = steps();
    let step = Math.max(0, Math.min(guide.length - 1, Math.trunc(Number(accountStorage.getItem(GUIDE_KEY))) || 0));
    const start = find('[data-vectors-guide-start]');
    const showStep = () => {
        const current = guide[step];
        find('[data-vectors-guide-body]').hidden = false;
        find('[data-vectors-guide-intro]').hidden = true;
        start.hidden = true;
        find('[data-vectors-guide-progress]').textContent = t`Step ${step + 1} of ${guide.length}`;
        const title = find('[data-vectors-guide-title]');
        title.textContent = current.title;
        find('[data-vectors-guide-copy]').replaceChildren(...current.body.split('\n').map(text => {
            const paragraph = document.createElement('p'); paragraph.textContent = text; return paragraph;
        }));
        find('[data-vectors-guide-back]').disabled = step === 0;
        find('[data-vectors-guide-next]').textContent = step === guide.length - 1 ? t`Finish` : t`Next`;
        openTab(current.tab);
        accountStorage.setItem(GUIDE_KEY, String(step));
        title.focus({ preventScroll: true });
    };
    const closeGuide = () => {
        find('[data-vectors-guide-body]').hidden = true;
        find('[data-vectors-guide-intro]').hidden = false;
        start.hidden = false;
        start.textContent = step ? t`Continue with Miso` : t`Learn with Miso`;
        start.focus({ preventScroll: true });
    };
    start.textContent = step ? t`Continue with Miso` : t`Learn with Miso`;
    start.addEventListener('click', showStep);
    find('[data-vectors-guide-back]').addEventListener('click', () => { step = Math.max(0, step - 1); showStep(); });
    find('[data-vectors-guide-next]').addEventListener('click', () => {
        if (step < guide.length - 1) { step++; showStep(); } else {
            step = 0; accountStorage.setItem(GUIDE_KEY, '0'); closeGuide(); start.textContent = t`Replay Miso's guide`;
        }
    });
    find('[data-vectors-guide-close]').addEventListener('click', closeGuide);

    // Capture invalid edits before the existing settings listeners can persist them.
    root.addEventListener('input', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'number') return;
        const valid = input.validity.valid && input.value !== '';
        input.setAttribute('aria-invalid', String(!valid));
        if (!valid) event.stopImmediatePropagation();
    }, true);
    const validate = () => {
        const invalid = [...root.querySelectorAll('input[type="number"]')].find(input => !input.checkValidity());
        if (!invalid) return true;
        openTab(invalid.closest('[role="tabpanel"]').id.replace('vectors-panel-', ''));
        invalid.reportValidity();
        return false;
    };
    const updateState = () => {
        const enabled = [settings.enabled_chats && t`chats`, settings.enabled_files && t`files`, settings.enabled_world_info && t`lorebooks`].filter(Boolean);
        find('[data-vectors-state]').textContent = enabled.length ? t`Used in replies: ${enabled.join(', ')}.` : t`Retrieval is off. You can still index sources and try a search.`;
    };
    root.addEventListener('input', updateState);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        find('#vectors_chat_stats').textContent = '';
        find('#vectors_search_results').replaceChildren();
        find('#vectors_search_status').textContent = t`Index your sources first, then try a detail you know is there.`;
    });
    const savedResults = document.createElement('ol');
    savedResults.className = 'vectors-results';
    savedResults.setAttribute('aria-label', t`Saved search results`);
    mountSavedVectorWork(find('#vectors_saved_work'), { onResult: result => renderSearchResults(savedResults, result) });
    find('#vectors_saved_work').append(savedResults);
    updateState();

    let controller;
    const status = find('#vectors_action_status');
    const stop = find('#vectors_stop');
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    const work = async (action, input = {}, present) => {
        if (controller || !validate()) return;
        controller = new AbortController();
        stop.hidden = false;
        status.textContent = t`Preparing saved work…`;
        root.setAttribute('aria-busy', 'true');
        try {
            const result = await runVectorWork(action, input, { signal: controller.signal, onProgress: progress => {
                status.textContent = [progress.stage, progress.total ? `${progress.completed ?? 0} / ${progress.total}` : ''].filter(Boolean).join(' · ');
            } });
            status.textContent = action === 'purge' ? t`Indexes cleared. Source text kept.`
                : Array.isArray(result.collections) ? t`${result.collections.length} collections ready, ${result.collections.reduce((sum, item) => sum + item.count, 0)} indexed chunks.` : t`Finished.`;
            present?.(result);
        } catch (error) {
            status.textContent = error.cancelled || controller.signal.aborted ? t`Vector work stopped. Check Saved work for its final state.` : error.message;
            if (action === 'query') find('#vectors_search_status').textContent = status.textContent;
        } finally { controller = null; stop.hidden = true; root.removeAttribute('aria-busy'); }
    };
    const indexChat = rebuild => {
        if (!getCurrentChatId()) { status.textContent = t`Open a saved chat first.`; return; }
        void work('sync-chat', { rebuild });
    };
    find('#vectors_vectorize_all').addEventListener('click', () => indexChat(false));
    find('#vectors_files_vectorize_all').addEventListener('click', () => void work('sync-files'));
    root.querySelectorAll('[data-vectors-index]').forEach(button => button.addEventListener('click', () => void work(button.dataset.vectorsIndex)));
    root.querySelectorAll('[data-vectors-rebuild]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.vectorsRebuild === 'sync-chat') indexChat(true);
        else void work(button.dataset.vectorsRebuild, { rebuild: true });
    }));
    find('#vectors_purge').addEventListener('click', () => {
        const chat = getCurrentChatId();
        if (!chat) { status.textContent = t`Open a saved chat first.`; return; }
        void work('purge', { collectionIds: [chat] });
    });
    find('#vectors_files_purge').addEventListener('click', () => {
        const files = [...getDataBankAttachments(false), ...getContext().chat.flatMap(row => row.extra?.files || [])];
        void work('purge', { collectionIds: [...new Set(files.map(file => `file_${getStringHash(file.url)}`))] });
    });
    find('#vectors_view_stats').addEventListener('click', () => {
        const chat = getCurrentChatId();
        if (!chat) { status.textContent = t`Open a saved chat first.`; return; }
        void work('list', { collectionIds: [chat], details: true }, result => {
            if (getCurrentChatId() !== chat) return;
            const saved = result[chat];
            const rows = getContext().chat;
            const eligible = rows.filter(row => row.mes?.trim() && (!row.is_system || settings.keep_hidden));
            const covered = eligible.filter(row => saved.hashes.includes(getStringHash(substituteParams(row.mes)))).length;
            find('#vectors_chat_stats').textContent = t`${covered} of ${eligible.length} eligible messages indexed; ${saved.chunks} searchable chunks.`;
        });
    });
    find('#vectors_search_threshold').value = String(settings.score_threshold);
    find('#vectors_search').addEventListener('click', () => {
        const query = find('#vectors_search_query').value.trim();
        const hint = find('#vectors_search_status');
        if (!query) { hint.textContent = t`Enter a detail or question to search for.`; find('#vectors_search_query').focus(); return; }
        if (controller || !validate()) return;
        const results = find('#vectors_search_results');
        results.replaceChildren();
        hint.textContent = t`Searching the saved index…`;
        void work('query', { queryScope: find('#vectors_search_scope').value, query,
            topK: Number(find('#vectors_search_count').value), threshold: Number(find('#vectors_search_threshold').value) }, result => {
            const count = renderSearchResults(results, result);
            hint.textContent = count ? t`${count} matching chunks. These are search results, not a generated answer.`
                : t`No matches. Index this source with the selected provider and model, or try a lower minimum score.`;
        });
    });
    return { updateState };
}
