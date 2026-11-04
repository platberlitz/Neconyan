// Neconyan: shared slot for an external policy that can veto World Info
// keyword activation per entry. Pawthfinder registers a policy when it is
// initialised and clears it on teardown; with no policy registered, keyword
// activation behaves exactly as upstream. Kept dependency-free so both the
// core scan and the extension can import it without mock churn.

let keywordActivationPolicy = null;

export function setKeywordActivationPolicy(policy) {
    keywordActivationPolicy = typeof policy === 'function' ? policy : null;
}

export function getKeywordActivationPolicy() {
    return keywordActivationPolicy;
}

export function isKeywordActivationSuppressed(entry) {
    return typeof keywordActivationPolicy === 'function' && keywordActivationPolicy(entry) === true;
}
