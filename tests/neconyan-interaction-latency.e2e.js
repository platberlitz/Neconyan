/* global window, document, MutationObserver, requestAnimationFrame */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { acceptJob } from '../src/jobs/store.js';

for (const phone of [false, true]) {
    test(`saved job changes reach ${phone ? 'phone' : 'desktop'} controls without a polling wait`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        await account.context.addInitScript(() => {
            window.__latency = { longTasks: [] };
            new PerformanceObserver(list => window.__latency.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
        });
        const page = await account.open({ workspace: false });
        const startup = await page.evaluate(() => ({ ready: performance.now(), navigation: performance.getEntriesByType('navigation')[0].toJSON(), ...window.__latency }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        const warm = await page.evaluate(() => ({ ready: performance.now(), ...window.__latency }));
        const directories = { root: path.join(app.directory, 'data/default-user') };
        const ids = [0, 1].map(index => acceptJob(directories, {
            owner: 'default-user', type: 'latency-fixture', paused: true,
            intent: { index }, submissionKey: `latency-${index}`,
        }).job.id);
        let streams = 0;
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/jobs/events') streams++; });
        const streamReady = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs/events');
        await page.evaluate(async ids => {
            const { observeJob } = await import('/scripts/jobs.js');
            window.__jobLatency = { snapshots: {}, completed: {}, started: null };
            for (const id of ids) observeJob(id, {
                intervalMs: 60000,
                onSnapshot: job => { window.__jobLatency.snapshots[id] = job.state; },
                onDone: () => { window.__jobLatency.completed[id] = performance.now() - window.__jobLatency.started; },
            });
        }, ids);
        expect((await streamReady).headers()['content-type']).toContain('text/event-stream');
        await expect.poll(() => page.evaluate(() => Object.keys(window.__jobLatency.snapshots).length)).toBe(2);
        await page.evaluate(async ids => {
            const { cancelJob } = await import('/scripts/jobs.js');
            window.__jobLatency.started = performance.now();
            await Promise.all(ids.map(id => cancelJob(id)));
        }, ids);
        await expect.poll(() => page.evaluate(() => Object.keys(window.__jobLatency.completed).length), { timeout: 2000 }).toBe(2);
        const jobs = await page.evaluate(() => window.__jobLatency);
        expect(Object.values(jobs.snapshots)).toEqual(['cancelled', 'cancelled']);
        expect(Math.max(...Object.values(jobs.completed))).toBeLessThan(1000);
        expect(streams).toBe(1);

        const profiler = process.env.NECONYAN_PROFILE_UI === '1' ? await account.context.newCDPSession(page) : null;
        if (profiler) {
            await profiler.send('Profiler.enable');
            await profiler.send('Profiler.start');
        }
        const navigation = await page.evaluate(async () => {
            const start = performance.now();
            window.NeconyanShell.openTab('left', 'agents');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return performance.now() - start;
        });
        await expect(page.locator('#ica--settings')).toBeVisible();
        if (phone) {
            const bounds = await page.locator('#left-nav-panel').boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(-1);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(394);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(853);
        }
        if (profiler) {
            const { profile } = await profiler.send('Profiler.stop');
            const output = info.outputPath('agents-open.cpuprofile');
            await writeFile(output, JSON.stringify(profile));
            await info.attach('agents-open-profile', { path: output, contentType: 'application/json' });
            await profiler.detach();
        }
        const firstCard = page.locator('#ica--agentList .ica--agent-card').first();
        const settingsButton = firstCard.getByRole('button', { name: 'Quick settings', exact: true });
        await settingsButton.evaluate(button => button.addEventListener('click', () => {
            window.__settingsClick = performance.now();
            window.__settingsFirstPaint = null;
            const observer = new MutationObserver(() => {
                if (!document.querySelector('dialog[open] .ica--quick-settings')) return;
                observer.disconnect();
                requestAnimationFrame(() => requestAnimationFrame(() => { window.__settingsFirstPaint = performance.now() - window.__settingsClick; }));
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
        }, { capture: true, once: true }));
        await settingsButton.click();
        const dialog = page.getByRole('dialog', { name: 'Quick settings', exact: true });
        await expect(dialog).toBeVisible();
        await page.waitForFunction(() => window.__settingsFirstPaint !== null);
        const settings = await dialog.evaluate(root => ({ milliseconds: performance.now() - window.__settingsClick, paintMilliseconds: window.__settingsFirstPaint, width: root.clientWidth, scrollWidth: root.scrollWidth }));
        expect(settings.scrollWidth).toBeLessThanOrEqual(settings.width + 1);
        await page.keyboard.press('Escape');
        await page.evaluate(async () => {
            const shell = window.NeconyanShell;
            shell.closeWorkspace();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            shell.openTab('left', 'agents');
            shell.closeWorkspace();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await expect(page.locator('#left-nav-panel')).not.toHaveClass(/openDrawer/);
        const measurements = { phone, startup, warm, jobs, navigation, settings };
        await info.attach('interaction-latency', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
        console.log('Interaction latency', JSON.stringify({ phone, startup: startup.ready, warm: warm.ready, completed: jobs.completed, navigation, settings }));

        const controls = await page.evaluate(async () => {
            const keyboard = await import('/scripts/keyboard.js');
            const { localizeControls } = await import('/scripts/ui-localization.js');
            const { addLocaleData, getCurrentLocale } = await import('/scripts/i18n.js');
            const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const host = document.createElement('div');
            host.className = 'latency-scope scroll-reset-container';
            host.innerHTML = '<div class="latency-control" tabindex="4">Keyboard action</div>';
            const control = host.firstElementChild;
            let resetListeners = 0;
            const listen = host.addEventListener.bind(host);
            host.addEventListener = (type, ...args) => {
                if (type === 'focusout') resetListeners++;
                return listen(type, ...args);
            };
            keyboard.registerInteractableType('.latency-scope .latency-control');
            document.body.append(host);
            await settle();
            const initial = control.getAttribute('tabindex');
            host.classList.add('disabled');
            await settle();
            const disabled = control.getAttribute('tabindex');
            host.classList.add('not_focusable');
            await settle();
            host.classList.remove('disabled', 'not_focusable');
            await settle();
            const restored = control.getAttribute('tabindex');
            const query = document.body.querySelectorAll;
            let wholePageKeyboardScans = 0;
            document.body.querySelectorAll = function (selector) {
                if (selector.includes('.custom_interactable')) wholePageKeyboardScans++;
                return query.call(this, selector);
            };
            document.body.classList.add('latency-unrelated-state');
            await settle();
            document.body.classList.remove('latency-unrelated-state');
            await settle();
            document.body.querySelectorAll = query;
            let emptyLocaleScans = 0;
            localizeControls({ querySelectorAll: () => { emptyLocaleScans++; return []; } }, {});
            addLocaleData(getCurrentLocale(), { 'Latency button': 'Bouton de test' });
            host.insertAdjacentHTML('beforeend', '<button>Latency button</button><div class="mes_text"><button>Latency button</button></div>');
            await settle();
            const translated = host.querySelector(':scope > button').textContent;
            const userText = host.querySelector('.mes_text button').textContent;
            host.remove();
            return { initial, disabled, restored, resetListeners, wholePageKeyboardScans, emptyLocaleScans, translated, userText };
        });
        expect(controls).toEqual({ initial: '4', disabled: null, restored: '4', resetListeners: 1,
            wholePageKeyboardScans: 0, emptyLocaleScans: 0, translated: 'Bouton de test', userText: 'Latency button' });
    });
}
