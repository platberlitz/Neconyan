/* eslint-env browser */
/** Shared browser harness for the release chat-reveal check and the manual pre-fix diagnostic. */
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

export const OBSERVE_MS = 4000;
// The Home entrance can dip for one frame while its 360 ms fade starts; every
// reproduced chat blank held opacity 0 for 173 ms or longer. This tolerance is
// Home-only; the other cases require no hidden sample at all.
export const HOME_ENTRANCE_TOLERANCE_MS = 50;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const screenshotsDir = path.join(repoRoot, 'screenshots');
// Set ROLEPLAY_REVEAL_VIDEOS_DIR to record a verification run without replacing captured evidence.
export const videosDir = process.env.ROLEPLAY_REVEAL_VIDEOS_DIR
    ? path.resolve(process.env.ROLEPLAY_REVEAL_VIDEOS_DIR)
    : path.join(screenshotsDir, 'videos');

export async function createCharacter(account, name, firstMes) {
    const response = await account.context.request.post('/api/characters/create', {
        headers: account.headers,
        data: { ch_name: name, description: 'Disposable reveal fixture character.', first_mes: firstMes },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.text();
}

export async function openReadyPage(account, { ios = false } = {}) {
    await account.context.addInitScript(() => {
        window.__revealTestReady = false;
        window.addEventListener('neconyan:ready', () => { window.__revealTestReady = true; }, { once: true });
    });
    if (ios) await installIPhoneSafari(account.context);
    const page = await account.open({ workspace: false, timeout: 30000, readyTimeout: 90000 });
    await expect.poll(() => page.evaluate(() => window.__revealTestReady === true), { timeout: 90000 }).toBe(true);
    if (ios) await applyIOSOnlyCss(page);
    await page.evaluate(() => {
        try {
            const storage = window.SillyTavern?.getContext?.().accountStorage;
            storage?.setItem('NeconyanTutorialStatus.v1', 'skipped');
            storage?.setItem('NeconyanTutorialHidden.v1', 'true');
        } catch { /* The tour remains dismissible below. */ }
    });
    await dismissTourAndToasts(page);
    return page;
}

export async function dismissTourAndToasts(page) {
    await page.addStyleTag({ content: '#toast-container .toast:not(.toast-error) { display: none !important; }' });
    for (let attempt = 0; attempt < 30; attempt++) {
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        if (await skip.isVisible().catch(() => false)) {
            await skip.click({ timeout: 2000 }).catch(() => {});
            break;
        }
        await delay(100);
    }
    await page.evaluate(() => {
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    });
}

export async function expectNoErrorToasts(page) {
    await expect(page.locator('#toast-container .toast-error')).toHaveCount(0);
}

export async function selectCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const id = core.characters.findIndex(character => character?.avatar === avatar);
        if (id < 0) throw new Error('Disposable reveal character is missing.');
        if (await core.selectCharacterById(id, { switchMenu: false }) === false) {
            throw new Error('Disposable reveal character did not open.');
        }
    }, avatar);
}

export async function openHome(page) {
    await page.evaluate(async () => {
        const welcome = await import('/scripts/welcome-screen.js');
        await welcome.openWelcomeScreen({ force: true });
    });
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('neconyan-home-visible')), { timeout: 30000 }).toBe(true);
}

export async function openGroup(page, groupId) {
    await page.evaluate(async id => {
        const groups = await import('/scripts/group-chats.js');
        await groups.openGroupById(id);
    }, groupId);
    await expect(page.locator('#send_textarea')).toBeVisible({ timeout: 30000 });
}

export async function createGroup(account, secondAvatar) {
    const probe = await account.context.request.post('/api/chats/get', {
        headers: account.headers,
        data: { avatar_url: account.avatar, file_name: 'Reveal group probe', allow_create: true },
    });
    expect(probe.ok(), await probe.text()).toBe(true);
    const stamp = JSON.parse(probe.headers()['x-neconyan-roleplay']).account;
    const group = await account.post('/api/groups/create', {
        name: 'Reveal group',
        members: [account.avatar, secondAvatar],
        activation_strategy: 1,
        roleplay: { account: stamp, operationKey: randomUUID() },
    });
    return { group, stamp };
}

export async function seedGroupChat(account, group, stamp) {
    const headers = { ...account.headers, 'X-Neconyan-Account': 'default-user' };
    const read = await account.context.request.post('/api/chats/group/get', {
        headers,
        data: { id: group.chat_id, allow_create: true, roleplay: { account: stamp } },
    });
    expect(read.ok(), await read.text()).toBe(true);
    const evidence = JSON.parse(read.headers()['x-neconyan-roleplay']);
    const save = await account.context.request.post('/api/chats/group/save', {
        headers,
        data: {
            id: group.chat_id,
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'Durable Nova', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Synthetic group greeting.' },
            ],
            roleplay: {
                account: evidence.account,
                operationKey: randomUUID(),
                ...(evidence.source ? { source: evidence.source } : { vacancy: evidence.vacancy }),
            },
        },
    });
    expect(save.ok(), await save.text()).toBe(true);
}

export async function waitForReadable(page, timeout = 30000) {
    await expect.poll(() => page.evaluate(() => {
        const chat = document.querySelector('#chat');
        if (!chat) return false;
        const chatStyle = getComputedStyle(chat);
        if (chatStyle.display === 'none' || chatStyle.visibility === 'hidden') return false;
        const chatOpacity = Number.parseFloat(chatStyle.opacity);
        if (!(chatOpacity >= 0.9)) return false;
        const chatRect = chat.getBoundingClientRect();
        for (const message of chat.querySelectorAll('.mes[mesid]')) {
            const text = message.querySelector('.mes_text');
            if (!text || !text.textContent.trim()) continue;
            const rect = text.getBoundingClientRect();
            const left = Math.max(0, chatRect.left, rect.left);
            const right = Math.min(innerWidth, chatRect.right, rect.right);
            const top = Math.max(0, chatRect.top, rect.top);
            const bottom = Math.min(innerHeight, chatRect.bottom, rect.bottom);
            if (right <= left || bottom <= top) continue;
            const textOpacity = Number.parseFloat(getComputedStyle(text).opacity);
            if (!(chatOpacity * textOpacity >= 0.9)) continue;
            for (const [x, y] of [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
                const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
                if (hit && (hit === text || text.contains(hit))) return true;
            }
        }
        return false;
    }), { timeout }).toBe(true);
}

export async function startRevealProbe(page, { observeMs = OBSERVE_MS, timeoutMs = 30000 } = {}) {
    await page.evaluate(({ observeMs: observeWindowMs, timeoutMs: firstReadableTimeoutMs }) => {
        const chat = document.querySelector('#chat');
        const beforeNodes = new Set(chat?.querySelectorAll('.mes[mesid]') ?? []);
        const probe = { done: false, result: null, live: null };
        window.__revealProbe = probe;
        const started = performance.now();
        probe.startedAt = started;
        let firstReadableAt = null;
        let firstReadablePageAt = null;
        let firstReadable = null;
        let knownAnimations = null;
        const samples = [];
        const hiddenIntervals = [];
        const opacityResets = [];
        const transparentAnimations = [];
        let previous = null;
        let openInterval = null;
        const opacityCache = new Map();
        const clearOpacityCache = () => opacityCache.clear();
        const opacityOf = element => {
            if (!opacityCache.has(element)) {
                const value = Number.parseFloat(getComputedStyle(element).opacity);
                opacityCache.set(element, Number.isFinite(value) ? value : 1);
            }
            return opacityCache.get(element);
        };
        const effectiveOpacity = element => {
            let value = 1;
            for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
                value *= opacityOf(node);
                if (value < 0.9) return value;
            }
            return value;
        };
        const readArea = () => {
            const area = document.querySelector('#chat');
            if (!area) return null;
            const style = getComputedStyle(area);
            const rect = area.getBoundingClientRect();
            return {
                area,
                opacity: effectiveOpacity(area),
                display: style.display,
                visibility: style.visibility,
                rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            };
        };
        const readableMessage = area => {
            if (!area || area.display === 'none' || area.visibility === 'hidden' || area.opacity < 0.9) return null;
            for (const message of area.area.querySelectorAll('.mes[mesid]')) {
                if (beforeNodes.has(message)) continue;
                const text = message.querySelector('.mes_text');
                if (!text || !text.textContent.trim()) continue;
                const rect = text.getBoundingClientRect();
                const left = Math.max(0, area.rect.left, rect.left);
                const right = Math.min(innerWidth, area.rect.right, rect.right);
                const top = Math.max(0, area.rect.top, rect.top);
                const bottom = Math.min(innerHeight, area.rect.bottom, rect.bottom);
                if (right <= left || bottom <= top) continue;
                if (effectiveOpacity(text) < 0.9) continue;
                for (const [x, y] of [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
                    const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
                    if (hit && (hit === text || text.contains(hit))) {
                        return {
                            mesid: Number(message.getAttribute('mesid')),
                            textLength: text.textContent.trim().length,
                            rect: { left, right, top, bottom, width: right - left, height: bottom - top },
                        };
                    }
                }
            }
            return null;
        };
        const animationState = area => area.area.getAnimations().map(animation => {
            let firstOpacity = null;
            try { firstOpacity = animation.effect.getKeyframes()[0]?.opacity ?? null; } catch { /* Keyframes unavailable. */ }
            return {
                animation,
                playState: animation.playState,
                currentTime: animation.currentTime,
                startTime: animation.startTime,
                duration: animation.effect.getTiming().duration,
                firstOpacity,
            };
        });
        const finish = failure => {
            probe.done = true;
            probe.result = {
                failure,
                startedAt: probe.startedAt,
                firstReadableAt,
                firstReadablePageAt,
                firstReadable,
                samples,
                hiddenIntervals,
                opacityResets,
                transparentAnimations,
                sampleCount: samples.length,
            };
        };
        const tick = () => {
            const now = performance.now();
            clearOpacityCache();
            const area = readArea();
            const readable = readableMessage(area);
            if (!firstReadableAt && readable) {
                firstReadableAt = now;
                firstReadablePageAt = now;
                firstReadable = readable;
                knownAnimations = new Set(area.area.getAnimations());
            }
            if (firstReadableAt) {
                const at = now - firstReadableAt;
                const animations = area ? animationState(area) : [];
                for (const animation of animations) {
                    if (knownAnimations.has(animation.animation)) continue;
                    knownAnimations.add(animation.animation);
                    if (firstReadableAt !== null && (animation.firstOpacity === 0 || animation.firstOpacity === '0')) {
                        transparentAnimations.push({
                            at: Math.round(at),
                            playState: animation.playState,
                            currentTime: animation.currentTime,
                            startTime: animation.startTime,
                            duration: animation.duration,
                        });
                    }
                }
                const chatHidden = !area || area.opacity < 0.9 || area.display === 'none' || area.visibility === 'hidden';
                const state = {
                    at: Math.round(at),
                    chatHidden,
                    opacity: area ? Math.round(area.opacity * 1000) / 1000 : null,
                    readable: Boolean(readable),
                    mesid: readable?.mesid ?? null,
                    textLength: readable?.textLength ?? 0,
                    animations: animations.map(({ animation, ...rest }) => rest),
                };
                if (chatHidden && !openInterval) openInterval = { start: state.at, end: state.at };
                else if (chatHidden && openInterval) openInterval.end = state.at;
                else if (!chatHidden && openInterval) {
                    hiddenIntervals.push(openInterval);
                    openInterval = null;
                }
                if (previous && !previous.chatHidden && chatHidden) {
                    opacityResets.push({
                        at: state.at,
                        previousOpacity: previous.opacity,
                        opacity: state.opacity,
                        animations: state.animations,
                    });
                }
                samples.push(state);
                probe.live = state;
                previous = state;
                if (at >= observeWindowMs) {
                    if (openInterval) hiddenIntervals.push(openInterval);
                    finish(null);
                    return;
                }
            }
            if (!firstReadableAt && now - started >= firstReadableTimeoutMs) {
                finish('first-readable-timeout');
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, { observeMs, timeoutMs });
}

export async function settleProbe(page, timeout = 45000) {
    await expect.poll(() => page.evaluate(() => window.__revealProbe?.done === true), { timeout }).toBe(true);
    return page.evaluate(() => window.__revealProbe.result);
}

export async function captureChat(page, name) {
    mkdirSync(screenshotsDir, { recursive: true });
    const file = path.join(screenshotsDir, `roleplay-reveal-${name}.png`);
    const box = await page.locator('#chat').boundingBox().catch(() => null);
    await page.screenshot({ path: file, ...(box ? { clip: box } : {}) });
    return file;
}

export async function captureWhenHidden(page, name) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const hidden = await page.evaluate(() => window.__revealProbe?.live?.chatHidden === true);
        if (hidden) return captureChat(page, name);
        await delay(40);
    }
    return null;
}

export function expectNoRevealReset(result) {
    expect(result.failure).toBeNull();
    expect(result.firstReadable).not.toBeNull();
    expect(result.sampleCount).toBeGreaterThan(5);
    expect(result.hiddenIntervals).toEqual([]);
    expect(result.opacityResets).toEqual([]);
    expect(result.transparentAnimations).toEqual([]);
}

export function expectHomeEntryReveal(result) {
    expect(result.failure).toBeNull();
    expect(result.firstReadable).not.toBeNull();
    expect(result.sampleCount).toBeGreaterThan(5);
    const visibleHidden = result.hiddenIntervals.filter(interval => interval.end - interval.start >= HOME_ENTRANCE_TOLERANCE_MS);
    const inTransient = at => result.hiddenIntervals.some(interval => at >= interval.start && at <= interval.end
        && interval.end - interval.start < HOME_ENTRANCE_TOLERANCE_MS);
    const visibleResets = result.opacityResets.filter(reset => !inTransient(reset.at));
    const visibleTransparent = result.transparentAnimations.filter(animation => !inTransient(animation.at));
    expect(visibleHidden).toEqual([]);
    expect(visibleResets).toEqual([]);
    expect(visibleTransparent).toEqual([]);
}

export async function seedTwoChats(page, firstAvatar, secondAvatar) {
    await selectCharacter(page, firstAvatar);
    await waitForReadable(page);
    await selectCharacter(page, secondAvatar);
    await waitForReadable(page);
    await selectCharacter(page, firstAvatar);
    await waitForReadable(page);
}

export const VIEWPORTS = [
    { label: 'phone', phone: true, width: 393, height: 852 },
    { label: 'desktop', phone: false, width: 1280, height: 900 },
];

export async function runSoloSwitch(app, { browserName, viewport, baseline = false, baselineSources = null, mediaDir = videosDir, namePrefix = '' } = {}) {
    mkdirSync(mediaDir, { recursive: true });
    const name = `${namePrefix}${browserName}-${baseline ? 'baseline' : 'candidate'}-${viewport.label}-switch`;
    const account = await app.account({
        phone: viewport.phone,
        contextOptions: {
            reducedMotion: 'no-preference',
            recordVideo: { dir: mediaDir, size: { width: viewport.width, height: viewport.height } },
        },
    });
    if (baselineSources) {
        const { scriptPatched, tabsPatched, motionPatched } = baselineSources;
        await account.context.route('**/script.js*', route => route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: scriptPatched,
        }));
        await account.context.route('**/scripts/neconyan-tabs.js*', route => route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: tabsPatched,
        }));
        await account.context.route('**/scripts/ui-motion.js*', route => route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: motionPatched,
        }));
    }
    const secondAvatar = await createCharacter(account, `Reveal ${baseline ? 'Baseline' : 'Second'} ${viewport.label}`, 'Fixture greeting.');
    const page = await openReadyPage(account);
    await seedTwoChats(page, account.avatar, secondAvatar);
    await dismissTourAndToasts(page);

    await startRevealProbe(page);
    await selectCharacter(page, secondAvatar);
    const hiddenCapture = await captureWhenHidden(page, `${name}-hidden`);
    const result = await settleProbe(page);
    await captureChat(page, `${name}-after`);

    await expectNoErrorToasts(page);
    const video = page.video();
    await page.close();
    const recordedPath = video ? await video.path() : null;
    let videoPath = null;
    if (recordedPath) {
        videoPath = path.join(mediaDir, `${name}.webm`);
        copyFileSync(recordedPath, videoPath);
    }
    const markerPath = path.join(mediaDir, `${name}.json`);
    writeFileSync(markerPath, JSON.stringify({
        name,
        browser: browserName,
        viewport: viewport.label,
        baseline,
        videoPath,
        probeStartedAt: result.startedAt,
        firstReadablePageAt: result.firstReadablePageAt,
        firstReadableAt: result.firstReadableAt,
        hiddenIntervals: result.hiddenIntervals,
        opacityResets: result.opacityResets,
        transparentAnimations: result.transparentAnimations,
        samples: result.samples,
    }, null, 2));
    console.log(JSON.stringify({ videoPath, markerPath, hiddenCapture, baseline, viewport: viewport.label, browser: browserName }));
    return { result, hiddenCapture, videoPath, markerPath };
}
