/**
 * Autosave for the shared Mewmory configuration.
 *
 * The queue keeps one request in flight. Typing is debounced by the caller, while committed controls
 * can ask for an immediate save. Responses are merged over edits made while the request was running,
 * so a slow reply never rolls the draft back. Configuration is global, so this module deliberately
 * knows nothing about the active chat or about the Mewmory panel.
 */

const DEFAULT_DEBOUNCE_MS = 650;

export function cloneSettings(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function settingsEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((value, index) => settingsEqual(value, right[index]));
    }
    if (!isObject(left) || !isObject(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!settingsEqual(left[key], right[key])) return false;
    return true;
}

function settingsWithoutRevision(config) {
    if (!isObject(config)) return config;
    const settings = { ...config };
    delete settings.revision;
    return settings;
}

/**
 * Applies the difference between base and source to target. Values that source did not change keep
 * the target's (normally the server's) value; arrays are replaced as a whole.
 */
export function applySettingsChanges(target, base, source) {
    if (settingsEqual(base, source)) return target;
    if (isObject(base) && isObject(source)) {
        const result = isObject(target) ? target : {};
        for (const key of Object.keys(source)) {
            result[key] = applySettingsChanges(result[key], base[key], source[key]);
        }
        for (const key of Object.keys(base)) {
            if (!Object.hasOwn(source, key)) delete result[key];
        }
        return result;
    }
    return cloneSettings(source);
}

/**
 * Clears only the secret actions that the completed request actually acknowledged. A key or a
 * clear-key tick typed while the request was in flight is newer input and stays in the draft.
 */
export function acknowledgeSecretActions(saved, sent, current) {
    if (!isObject(saved?.roles) || !isObject(sent?.roles) || !isObject(current?.roles)) return saved;
    for (const [name, sentRole] of Object.entries(sent.roles)) {
        const currentRole = current.roles[name];
        const savedRole = saved.roles[name];
        if (!isObject(currentRole) || !isObject(savedRole)) continue;
        if (typeof sentRole.apiKey === 'string' && sentRole.apiKey && currentRole.apiKey === sentRole.apiKey) {
            delete savedRole.apiKey;
        }
        if (sentRole.clearKey === true && currentRole.clearKey === true) delete savedRole.clearKey;
    }
    return saved;
}

function errorMessage(error) {
    return String(error?.message || 'Mewmory settings could not be saved. Check your connection and try again.');
}

export class MewmoryConfigAutosave {
    constructor(options = {}) {
        this.options = {};
        this.base = null;
        this.saving = false;
        this.error = '';
        this.invalid = '';
        this.timer = null;
        this.running = null;
        this.mergeBaseline = null;
        this.lastSavedAt = 0;
        this.remoteChange = false;
        this.account = null;
        this.accountError = '';
        this.controller = null;
        this.epoch = 0;
        this.configure(options);
    }

    configure(options = {}) {
        this.options = { ...this.options, ...options };
        if (Number.isFinite(options.debounceMs)) this.debounceMs = options.debounceMs;
        else if (!Number.isFinite(this.debounceMs)) this.debounceMs = DEFAULT_DEBOUNCE_MS;
        return this;
    }

    accountErrorText(message) {
        return message || 'The signed-in account changed. Reload the page before saving Mewmory settings.';
    }

    /**
     * Binds an initial account, or returns false after locking the queue when the live account
     * or a server response belongs to somebody else.
     */
    ensureAccount(configAccount = null) {
        const live = this.options.getAccount?.() || null;
        const incoming = live || configAccount || null;
        if (!this.account) this.account = incoming;
        if (live && this.account && live !== this.account) {
            this.lockAccount(this.accountErrorText());
            return false;
        }
        if (configAccount && this.account && configAccount !== this.account) {
            this.lockAccount(this.accountErrorText());
            return false;
        }
        if (!this.account && incoming) this.account = incoming;
        return !this.accountError;
    }

    lockAccount(message) {
        this.accountError = this.accountErrorText(message);
        this.cancelWork();
        this.base = null;
        this.mergeBaseline = null;
        this.error = '';
        this.invalid = '';
        this.remoteChange = false;
        this.options.writeDraft?.(null);
        this.emit();
        this.options.onAccountMismatch?.(this.accountError);
    }

    /** Explicit account change: cancel everything and drop the old account's draft. */
    changeAccount(account) {
        const next = account || null;
        if (next === this.account && !this.accountError) return;
        const previous = this.account;
        this.cancelWork();
        this.account = next;
        this.base = null;
        this.mergeBaseline = null;
        this.error = '';
        this.invalid = '';
        this.remoteChange = false;
        this.accountError = '';
        this.options.writeDraft?.(null);
        this.emit();
        this.options.onAccountChange?.(next, previous);
    }

    abandonAccount() {
        const previous = this.account;
        this.cancelWork();
        this.account = null;
        this.base = null;
        this.mergeBaseline = null;
        this.error = '';
        this.invalid = '';
        this.remoteChange = false;
        this.accountError = '';
        this.options.writeDraft?.(null);
        this.emit();
        this.options.onAccountChange?.(null, previous);
    }

    cancelWork() {
        this.clearTimer();
        this.epoch++;
        this.controller?.abort();
        this.controller = null;
        this.saving = false;
        this.running = null;
    }

    state() {
        const draft = this.options.readDraft?.();
        return {
            pending: this.hasPendingChanges(),
            saving: this.saving,
            error: this.accountError || this.error,
            invalid: this.invalid,
            revision: Number(this.base?.revision ?? draft?.revision ?? 0),
            lastSavedAt: this.lastSavedAt,
            remoteChange: this.remoteChange,
            account: this.account,
            accountChanged: Boolean(this.accountError),
        };
    }

    hasPendingChanges() {
        const draft = this.options.readDraft?.();
        if (!draft) return false;
        if (!this.base) return true;
        return !settingsEqual(settingsWithoutRevision(this.base), settingsWithoutRevision(draft));
    }

    /** Adopts a configuration fetched by the panel. Local edits win over a newer remote copy. */
    sync(config, account = null) {
        if (!isObject(config) || this.accountError) return;
        if (!this.ensureAccount(account || config.account || null)) return;
        const revision = Number.isSafeInteger(config.revision) ? config.revision : 0;
        if (!this.base) {
            this.base = cloneSettings(config);
            if (!this.options.readDraft?.()) this.options.writeDraft?.(cloneSettings(config));
            this.emit();
            return;
        }
        if (this.saving) return;
        const baseRevision = Number.isSafeInteger(this.base.revision) ? this.base.revision : 0;
        if (revision < baseRevision) return;
        const draft = this.options.readDraft?.();
        if (!draft) {
            this.base = cloneSettings(config);
            this.options.writeDraft?.(cloneSettings(config));
            this.emit();
            return;
        }
        if (!this.hasPendingChanges()) {
            const changed = !settingsEqual(settingsWithoutRevision(draft), settingsWithoutRevision(config))
                || draft.revision !== config.revision;
            this.base = cloneSettings(config);
            if (changed) this.options.writeDraft?.(cloneSettings(config));
            this.error = '';
            this.invalid = '';
            this.remoteChange = false;
            this.emit();
            return;
        }
        if (revision > baseRevision) {
            const merged = applySettingsChanges(cloneSettings(config), this.base, draft);
            merged.revision = revision;
            this.base = cloneSettings(config);
            this.remoteChange = true;
            this.options.writeDraft?.(merged);
            this.emit();
        }
    }

    schedule({ immediate = false } = {}) {
        if (!this.options.readDraft) return;
        if (this.accountError) {
            this.emit();
            return;
        }
        if (!this.ensureAccount()) return;
        this.clearTimer();
        const draft = this.options.readDraft();
        if (!draft) return;
        const invalid = this.options.validate?.(draft) || '';
        this.invalid = invalid;
        this.error = '';
        this.emit();
        if (invalid || !this.hasPendingChanges()) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
        }, immediate ? 0 : this.debounceMs);
    }

    async flush() {
        if (this.accountError) return this.result();
        if (!this.ensureAccount()) return this.result();
        this.clearTimer();
        if (this.running) await this.running;
        if (this.accountError) return this.result();
        if (!this.ensureAccount()) return this.result();
        const draft = this.options.readDraft?.();
        if (draft) {
            this.invalid = this.options.validate?.(draft) || '';
            if (this.invalid) this.error = '';
        }
        if (draft && this.hasPendingChanges() && !this.invalid) await this.run();
        return this.result();
    }

    retry() {
        return this.flush();
    }

    /** Throws away local edits, or lets an in-flight save land before adopting its result. */
    discard() {
        if (this.accountError) return;
        this.clearTimer();
        if (!this.base) return;
        const restored = cloneSettings(this.base);
        if (this.saving) this.mergeBaseline = cloneSettings(restored);
        this.options.writeDraft?.(restored);
        this.error = '';
        this.invalid = '';
        this.remoteChange = false;
        this.emit();
    }

    run() {
        if (this.running) return this.running;
        if (this.accountError) return Promise.resolve(this.state());
        if (!this.ensureAccount()) return Promise.resolve(this.state());
        if (!this.options.readDraft || !this.options.save) return Promise.resolve(this.state());
        const epoch = this.epoch;
        const running = this.drain().catch(error => {
            if (epoch !== this.epoch) return this.state();
            this.saving = false;
            this.error = errorMessage(error);
            this.emit();
            return this.state();
        }).finally(() => {
            if (this.running === running) this.running = null;
        });
        this.running = running;
        return running;
    }

    async drain() {
        let conflicts = 0;
        const epoch = this.epoch;
        for (;;) {
            if (this.accountError || epoch !== this.epoch || !this.ensureAccount()) break;
            const draft = this.options.readDraft?.();
            if (!draft) break;
            const invalid = this.options.validate?.(draft) || '';
            if (invalid) {
                this.invalid = invalid;
                this.error = '';
                this.saving = false;
                this.emit();
                break;
            }
            this.invalid = '';
            if (!this.hasPendingChanges()) {
                this.saving = false;
                this.emit();
                break;
            }
            const snapshot = cloneSettings(draft);
            this.mergeBaseline = cloneSettings(snapshot);
            this.saving = true;
            this.error = '';
            this.emit();
            const controller = new AbortController();
            this.controller = controller;
            let saved;
            try {
                saved = await this.options.save(cloneSettings(snapshot), { account: this.account, signal: controller.signal });
            } catch (error) {
                if (this.controller === controller) this.controller = null;
                if (epoch !== this.epoch || error?.name === 'AbortError') break;
                if (error?.code === 'MEWMORY_ACCOUNT_CHANGED') {
                    this.lockAccount(error.message);
                    break;
                }
                if (error?.status === 409 && this.options.load && conflicts < 1) {
                    conflicts++;
                    this.saving = false;
                    this.emit();
                    let latest;
                    const loadController = new AbortController();
                    this.controller = loadController;
                    try {
                        latest = await this.options.load({ account: this.account, signal: loadController.signal });
                    } catch (loadError) {
                        if (epoch !== this.epoch || loadError?.name === 'AbortError') break;
                        if (loadError?.code === 'MEWMORY_ACCOUNT_CHANGED') {
                            this.lockAccount(loadError.message);
                            break;
                        }
                        this.error = errorMessage(loadError);
                        this.emit();
                        break;
                    } finally {
                        if (this.controller === loadController) this.controller = null;
                    }
                    if (epoch !== this.epoch) break;
                    if (!isObject(latest)) {
                        this.error = errorMessage(error);
                        this.emit();
                        break;
                    }
                    if (!this.ensureAccount(latest.account || null)) break;
                    this.rebaseOn(latest);
                    continue;
                }
                this.saving = false;
                this.error = errorMessage(error);
                this.emit();
                break;
            }
            if (this.controller === controller) this.controller = null;
            if (epoch !== this.epoch || this.accountError || !this.ensureAccount()) break;
            if (!isObject(saved)) {
                this.saving = false;
                this.error = 'Mewmory returned an empty configuration. Try again.';
                this.emit();
                break;
            }
            this.saving = false;
            this.error = '';
            this.invalid = '';
            const current = this.options.readDraft?.() || snapshot;
            const baseline = this.mergeBaseline || snapshot;
            const merged = applySettingsChanges(cloneSettings(saved), baseline, current);
            merged.revision = saved.revision;
            acknowledgeSecretActions(merged, snapshot, current);
            this.base = cloneSettings(saved);
            this.mergeBaseline = null;
            this.remoteChange = false;
            this.options.writeDraft?.(merged);
            this.lastSavedAt = Date.now();
            conflicts = 0;
            this.options.onSaved?.(saved, merged);
            this.emit();
        }
        return this.state();
    }

    rebaseOn(latest) {
        if (!isObject(latest) || !this.ensureAccount(latest.account || null)) return;
        const draft = this.options.readDraft?.();
        const merged = applySettingsChanges(cloneSettings(latest), this.base || {}, draft || latest);
        merged.revision = latest.revision;
        this.base = cloneSettings(latest);
        this.mergeBaseline = null;
        this.remoteChange = true;
        this.options.writeDraft?.(merged);
        this.emit();
    }

    result() {
        const state = this.state();
        return {
            ok: !state.pending && !state.error && !state.invalid && !state.accountChanged,
            pending: state.pending,
            invalid: Boolean(state.invalid),
            error: state.error || state.invalid,
            revision: state.revision,
            accountChanged: state.accountChanged,
        };
    }

    clearTimer() {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }

    emit() {
        this.options.onState?.(this.state());
    }
}

export function createMewmoryConfigAutosave(options = {}) {
    return new MewmoryConfigAutosave(options);
}

/** Shared queue registered by the Mewmory panel and flushed by manual hiding in index.js. */
export const mewmoryConfigAutosave = createMewmoryConfigAutosave();

/**
 * Saves any valid pending Mewmory edit, waits for an in-flight save, and retries once if needed.
 * Safe to call when the panel was never opened or when nothing changed.
 *
 * @returns {Promise<{ ok: boolean, pending: boolean, invalid: boolean, error: string, revision: number, accountChanged: boolean }>}
 * ok is true when no draft remains unsaved. invalid is true for an incomplete number field, which
 * retrying cannot fix. accountChanged is true when the signed-in account changed and a reload is
 * required. error carries the last save, validation or account message.
 */
export function flushMewmoryConfigAutosave() {
    return mewmoryConfigAutosave.flush();
}
