/**
 * @abstract
 * @implements {EventTarget}
 */
export class AbstractEventTarget {
    constructor() {
        this.listeners = {};
    }

    addEventListener(type, callback, _options) {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    dispatchEvent(event) {
        if (!this.listeners[event.type] || this.listeners[event.type].length === 0) {
            return true;
        }
        // A listener may remove itself while handling an abort. Iterate a snapshot
        // so the next listener still receives it, and defer newly added listeners.
        [...this.listeners[event.type]].forEach(listener => {
            if (this.listeners[event.type].includes(listener)) listener(event);
        });
        return true;
    }

    removeEventListener(type, callback, _options) {
        if (!this.listeners[type]) {
            return;
        }
        const index = this.listeners[type].indexOf(callback);
        if (index !== -1) {
            this.listeners[type].splice(index, 1);
        }
    }
}
