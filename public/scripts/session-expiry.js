const INSTALLED = Symbol.for('neconyan.sessionExpiryNotifier');
const AUTH_HEADER = 'X-Neconyan-Auth';

/**
 * Observe rejected Neconyan sessions without consuming responses or interrupting requests.
 * The server marker distinguishes sign-out from provider and permission errors.
 * @param {Window} target Browser window
 * @param {function(): void} notify Show the session-expired notice
 */
export function installSessionExpiryNotifier(target, notify) {
    if (target[INSTALLED]) return;
    target[INSTALLED] = true;
    let notified = false;

    function inspect(status, url, getHeader) {
        if (notified || (status !== 401 && status !== 403)) return;
        try {
            if (new URL(url).origin !== target.location.origin || getHeader(AUTH_HEADER) !== 'required') return;
            notified = true;
            notify();
        } catch (error) {
            // A notification must never change the result of a request.
            console.warn('Could not show the session-expired notice.', error);
        }
    }

    const originalFetch = target.fetch;
    target.fetch = function (...args) {
        return originalFetch.apply(this, args).then(response => {
            inspect(response.status, response.url, name => response.headers.get(name));
            return response;
        });
    };

    const prototype = target.XMLHttpRequest.prototype;
    const originalSend = prototype.send;
    const observed = new WeakSet();
    prototype.send = function (...args) {
        if (!observed.has(this)) {
            observed.add(this);
            this.addEventListener('loadend', () => {
                inspect(this.status, this.responseURL, name => this.getResponseHeader(name));
            });
        }
        return originalSend.apply(this, args);
    };
}
