import { normaliseBrowserMacroDraft } from './neconyan-assistant-macro-schema.js';
import { areVariablesReadOnly } from './variable-read-only.js';

const failed = (status, message) => ({ status, committed: false, message });
const cancelled = (declined, message) => ({ ...failed('cancelled', message), declined });
const saved = name => ({ status: 'success', committed: true, name, scope: 'browser' });
const fields = def => def ? ({ name: def.name, template: def.template, description: def.description ?? '', args: def.args ?? [], enabled: def.enabled !== false }) : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const named = (defs, name) => defs.find(def => def.name.toLowerCase() === name.toLowerCase());

/** Serialise reviews so two approved drafts cannot overwrite each other. */
export function createBrowserMacroAuthoring(loadRuntime) {
    let queue = Promise.resolve();
    return function reviewAndSave(input, { account, isCurrent = () => true, proposalId } = {}) {
        // Capture account before entering the queue, not when a previous popup closes.
        let runtimePromise;
        try {
            runtimePromise = Promise.resolve(loadRuntime({ account })).then(runtime => ({ runtime }), error => ({ error }));
        } catch (error) {
            runtimePromise = Promise.resolve({ error });
        }
        const operation = queue.then(async () => {
            try {
                const loaded = await runtimePromise;
                if (loaded.error) throw loaded.error;
                const { runtime } = loaded;
                const draft = normaliseBrowserMacroDraft(input);
                if (proposalId !== undefined && (typeof proposalId !== 'string' || !proposalId || proposalId.length > 512)) return failed('error', 'The macro proposal identifier is invalid.');
                const current = async () => await isCurrent() && runtime.account === runtime.getAccount() && (account === undefined || account === runtime.account);
                if (!await current()) return cancelled(false, 'The account or request changed. Nothing was saved.');
                runtime.assertAvailable();
                const defs = runtime.getDefs();
                const existing = named(defs, draft.name);
                const next = runtime.createDef({ ...draft, ...(existing ? { id: existing.id, enabled: existing.enabled } : {}) });
                if (proposalId && existing?.authoringProposalId === proposalId) {
                    return same(fields(existing), fields(next)) ? saved(existing.name) : failed('conflict', 'This macro changed after the proposal was saved. Nothing was overwritten.');
                }
                if (existing ? draft.expectedTemplate !== existing.template : draft.expectedTemplate !== undefined) {
                    return failed('conflict', existing
                        ? 'This browser already has that macro. Share its current template and include it as expectedTemplate before editing it.'
                        : 'The macro to edit no longer exists in this browser.');
                }
                const problems = runtime.validate(next, defs);
                if (problems.length) return failed('error', problems.join(' '));
                const snapshot = JSON.stringify(existing ?? null);
                const preview = runtime.preview(next);
                const approved = await runtime.confirm({ before: fields(existing), after: fields(next), preview, shadowed: runtime.isShadowed(next.name) });
                if (!await current()) return cancelled(false, 'The account or request changed. Nothing was saved.');
                if (!approved) return cancelled(true, 'Nothing was saved.');
                runtime.assertAvailable();
                // Another tab or the editor may have changed this name during review.
                const fresh = runtime.getDefs();
                const now = named(fresh, draft.name);
                if (JSON.stringify(now ?? null) !== snapshot) return failed('conflict', 'This macro changed while you were reviewing it. Nothing was overwritten.');
                const freshProblems = runtime.validate(next, fresh);
                if (freshProblems.length) return failed('conflict', freshProblems.join(' '));
                const persisted = { ...next, ...(proposalId ? { authoringProposalId: proposalId } : {}) };
                runtime.saveDefs([...fresh.filter(def => def.id !== next.id), persisted]);
                try {
                    runtime.sync();
                } catch {
                    return { ...saved(next.name), message: 'Saved in this browser. Reload to refresh macro registrations.' };
                }
                return saved(next.name);
            } catch (error) {
                return failed('error', error?.message || 'The browser macro could not be saved.');
            }
        });
        queue = operation.catch(() => {});
        return operation;
    };
}

async function browserRuntime({ account: requestedAccount } = {}) {
    const context = () => globalThis.SillyTavern?.getContext();
    const ctx = context();
    if (!ctx) throw new Error('Open Neconyan in a browser to save this macro.');
    const account = requestedAccount ?? ctx.currentUserHandle;
    const [store, registrar, gate, sandboxModule, chatState, readOnly, review] = await Promise.all([
        import('./extensions/third-party/MacroEnhanced/src/custom/store.js'),
        import('./extensions/third-party/MacroEnhanced/src/custom/registrar.js'),
        import('./extensions/third-party/MacroEnhanced/src/engine-gate.js'),
        import('./extensions/third-party/MacroEnhanced/src/workbench/sandbox.js'),
        import('./extensions/third-party/MacroEnhanced/src/chat-state.js'),
        import('./variable-read-only.js'),
        import('./neconyan-assistant-review.js'),
    ]);
    return {
        account,
        getAccount: () => context()?.currentUserHandle,
        assertAvailable() {
            if (!account) throw new Error('Sign in before saving a browser macro.');
            if (readOnly.areVariablesReadOnly()) throw new Error('Macros cannot be saved during a read-only preview.');
            const problem = store.getBrowserStoreProblem({ account });
            if (problem) throw new Error(problem);
            const registered = context()?.macros?.registry?.getMacro('me-listpick');
            if (!gate.isEngineAvailable() || registered?.source?.name !== 'MacroEnhanced') throw new Error('Enable Macro Enhanced and the experimental macro setting in User Settings first.');
        },
        getDefs: () => store.getBrowserDefs({ account }),
        saveDefs: defs => store.saveBrowserDefs(defs, { account }),
        createDef: store.createDef,
        validate: (def, siblings) => store.validateDef(def, { siblings, registry: context().macros.registry, customNames: store.getAllCustomNames() }),
        sync: registrar.syncRegistrations,
        isShadowed: name => [...store.getCharacterDefs(), ...store.getChatDefs()].some(def => def.enabled !== false && def.name.toLowerCase() === name.toLowerCase()),
        preview(def) {
            const ctx = context();
            const sandbox = sandboxModule.createSandbox({
                getLocalStore: () => ctx.chatMetadata?.variables ?? {},
                getGlobalStore: () => ctx.extensionSettings?.variables?.global ?? {},
                getChatState: () => chatState.peekChatState(),
            });
            const bindings = {};
            def.args.forEach((arg, index) => {
                const value = arg.optional ? arg.defaultValue : `[${arg.name}]`;
                bindings[arg.name.toLowerCase()] = value;
                bindings[`arg${index + 1}`] = value;
            });
            return readOnly.withReadOnlyVariables(() => sandbox.run((content, dynamicMacros) => {
                const env = ctx.macros.envBuilder.buildFromRawEnv({ content, replaceCharacterCard: true, dynamicMacros: { ...dynamicMacros, ...bindings }, postProcessFn: text => text });
                sandboxModule.applySandboxEnvironment(env, sandbox);
                return ctx.macros.engine.evaluate(content, env);
            }, def.template));
        },
        async confirm({ before, after, preview, shadowed }) {
            const content = review.buildAssistantReview({ resource: 'browser macro', target: after.name, field: 'Definition', before: before ?? '(new macro)', after });
            const note = document.createElement('p');
            note.textContent = 'Saved for this account in this browser only. Export it from My macros to move it elsewhere. It is not synced or included in account backups. Server-built prompts cannot expand browser macros.';
            const heading = document.createElement('strong');
            heading.textContent = 'Isolated preview';
            const explanation = document.createElement('p');
            explanation.textContent = 'Required arguments use [name] examples; optional arguments use their defaults. Preview variable changes are discarded.';
            const output = document.createElement('pre');
            output.textContent = String(preview ?? '');
            output.style.whiteSpace = 'pre-wrap';
            output.style.overflowWrap = 'anywhere';
            content.append(note, heading, explanation, output);
            if (shadowed) {
                const warning = document.createElement('p');
                warning.textContent = 'A character or chat macro with this name takes priority in the current chat.';
                content.append(warning);
            }
            return Boolean(await context().Popup.show.confirm('Save browser macro?', content));
        },
    };
}

const authorBrowserMacro = createBrowserMacroAuthoring(browserRuntime);

export function reviewAndSaveBrowserMacro(input, options) {
    if (areVariablesReadOnly()) return Promise.resolve(failed('error', 'Macros cannot be saved during a read-only preview.'));
    return authorBrowserMacro(input, options);
}
