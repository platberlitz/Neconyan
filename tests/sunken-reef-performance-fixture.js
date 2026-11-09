/* global window, document, CanvasRenderingContext2D, MutationObserver */

// A real canvas stage with a manually advanced animation clock. This lets tests
// count work at identical frame times without depending on the runner's speed.
export async function openControlledReef(page) {
    await page.addInitScript(() => {
        let now = 1000;
        let nextId = 0;
        let frames = 0;
        let readbacks = 0;
        let motionWrites = 0;
        const pending = new Map();
        Object.defineProperty(performance, 'now', { value: () => now });
        window.requestAnimationFrame = callback => {
            pending.set(++nextId, callback);
            return nextId;
        };
        window.cancelAnimationFrame = id => pending.delete(id);
        const originalRead = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function (...args) {
            if (this.canvas.width === 1 && this.canvas.height === 1) readbacks++;
            return originalRead.apply(this, args);
        };
        const observer = new MutationObserver(records => { motionWrites += records.length; });
        observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-reef-motion'] });
        window.reefTest = {
            advance(count = 1) {
                for (let i = 0; i < count; i++) {
                    now += 1000 / 60;
                    const callbacks = [...pending.values()];
                    pending.clear();
                    for (const callback of callbacks) {
                        frames++;
                        callback(now);
                    }
                }
            },
            counts() {
                motionWrites += observer.takeRecords().length;
                return { frames, readbacks, motionWrites, pending: pending.size };
            },
        };
    });
    await page.route('**/reef-performance-fixture', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-sb-theme="sunken-reef"><head><style>
            :root { --neco-ginger:#38e8ff; --neco-accent-secondary:#ff7398;
                --reef-lagoon:#38e8ff; --reef-coral:#ff7398; --reef-pearl:#e4fbff; }
            body { margin:0; background:#061a2a; }
        </style></head><body><script type="module">
            import { mountSunkenReef } from '/scripts/neconyan-sunken-reef.js';
            mountSunkenReef();
        </script></body></html>`,
    }));
    await page.goto('/reef-performance-fixture');
    await page.waitForFunction(() => window.NeconyanSunkenReef?.snapshot().active);
}
