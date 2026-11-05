/**
 * Delays a redraw until the user pauses typing.
 * The returned function keeps the last arguments, and cancel() drops a pending call.
 * @template {(...args: any[]) => void} T
 * @param {T} callback
 * @param {number} delay
 * @returns {T & { cancel: () => void }}
 */
export function debounce(callback, delay = 200) {
    let timer = 0;
    const debounced = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => callback(...args), delay);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
}
