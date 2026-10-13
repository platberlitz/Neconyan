/* global document, localStorage, window, RTCPeerConnection */
import { expect, test, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { openCardScriptApp, seedCardScriptMessage, demoCardHtml, fencedCardHtml, cardLocators, runCardForBrowser } from './card-script-e2e-helpers.js';

const protectedBrowser = process.env.NECONYAN_CARD_SCRIPT_EXPECT_PROTECTED === '1';
test.use({ browserName: process.env.NECONYAN_CARD_SCRIPT_BROWSER === 'webkit' ? 'webkit' : 'chromium', launchOptions: process.env.NECONYAN_CARD_SCRIPT_BROWSER_PATH ? { executablePath: process.env.NECONYAN_CARD_SCRIPT_BROWSER_PATH } : {} });

test.beforeEach(async ({ page }) => { test.setTimeout(90000); await openCardScriptApp(page); });

for (const phone of [true, false]) {
    test(`runs visible interactive content under the browser policy and resizes on ${phone ? 'phone' : 'desktop'}`, async ({ page }) => {
        await page.setViewportSize(phone ? { width: 393, height: 852 } : { width: 1280, height: 900 });
        const id = await seedCardScriptMessage(page, demoCardHtml);
        await runCardForBrowser(page, id, { protectedBrowser });
        const { outer, card } = cardLocators(page, id);
        await expect(outer).toBeVisible();
        await expect(card.locator('#status')).toHaveText('Script ran automatically');
        await expect(card.locator('#isolation')).toHaveText('Parent access blocked');
        await expect(outer).toHaveAttribute('sandbox', 'allow-scripts');
        await expect(outer).toHaveAttribute('referrerpolicy', 'no-referrer');
        await expect(card.locator('body')).toHaveCSS('color', 'rgb(244, 235, 219)');
        const initial = (await outer.boundingBox()).height;
        await card.locator('#grow').click();
        await expect(card.locator('#status')).toHaveText('Button worked');
        await expect.poll(async () => (await outer.boundingBox()).height).toBeGreaterThan(initial + 300);
        const grown = (await outer.boundingBox()).height;
        await card.locator('#shrink').click();
        await expect.poll(async () => (await outer.boundingBox()).height).toBeLessThan(grown - 300);
        const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
        await expect(page.locator('.toast:has-text("Card scripts blocked")')).toHaveCount(0);
    });
}

test('full-page fences run in place, code examples and prose stay readable', async ({ page }) => {
    const entityPage = '\n\n```html\n<html><body><p id="entity"></p><script>document.getElementById("entity").textContent="&amp;";</script></body></html>\n```';
    const id = await seedCardScriptMessage(page, fencedCardHtml + '\n\n```html\n<script>window.exampleShouldNotRun=true;</script>\n```' + entityPage.replace(/\n/g, '\r\n'));
    const { message, card } = cardLocators(page, id);
    await runCardForBrowser(page, id, { protectedBrowser });
    await expect(card.locator('#fenced-status')).toHaveText('Full-page HTML ran automatically');
    await expect(message.locator('.mes_text')).toContainText('Surrounding prose stays readable.');
    await expect(message.locator('.mes_text')).toContainText('The rest of the message stays here.');
    await expect(message.locator('pre')).toHaveCount(1);
    await expect(message.locator('pre')).toContainText('window.exampleShouldNotRun');
    const secondCard = message.locator('iframe.card-script-sandbox-frame').nth(1).contentFrame().locator('iframe.card-script-content-frame').contentFrame();
    await expect(secondCard.locator('#entity')).toHaveText('&amp;');
    await card.getByRole('button', { name: 'Try the card' }).click();
    await expect(card.getByRole('button')).toHaveText('Clicked');
});

test('disabled scripts keep sanitised fallback and show setting guidance', async ({ page }) => {
    const id = await seedCardScriptMessage(page, demoCardHtml, { enabled: false });
    const { message } = cardLocators(page, id);
    await expect(message.locator('.mes_text')).toContainText('Static fallback');
    await expect(message.locator('script, iframe')).toHaveCount(0);
    await expect(page.locator('.toast').filter({ hasText: 'Enable \'Allow card scripts\' in Settings' })).toBeVisible();
});

test('fresh device consent ignores the old key, appears once and supports Stop/Restart', async ({ page }) => {
    const id = await seedCardScriptMessage(page, demoCardHtml, { consent: false });
    const { outer, card, message } = cardLocators(page, id);
    const popup = page.locator('dialog[open]').filter({ hasText: 'Allow automatic card scripts?' });
    if (!protectedBrowser) {
        await runCardForBrowser(page, id);
        await expect(popup).toHaveCount(0);
        await expect(card.locator('#status')).toHaveText('Script ran automatically');
        const second = await seedCardScriptMessage(page, demoCardHtml, { clear: false, consent: false });
        await expect(cardLocators(page, second).message.locator('.card-script-run-anyway')).toBeVisible();
        await expect(cardLocators(page, second).outer).toHaveCount(0);
        return;
    }
    await expect(popup).toBeVisible(); await expect(outer).toBeHidden();
    await expect(outer.contentFrame().locator('iframe.card-script-content-frame')).toHaveCount(0);
    await expect(popup).toContainText('run automatically in chats on this device');
    await popup.locator('.popup-button-ok').click();
    await expect(card.locator('#status')).toHaveText('Script ran automatically');
    expect(await page.evaluate(() => localStorage.getItem('card_scripts_auto_confirmed'))).toBe('true');
    await page.evaluate(async id => { (await import('/scripts/card-script-runtime.js')).destroySandbox(id); }, id);
    await expect(outer).toHaveCount(0);
    await page.evaluate(async () => { (await import('/scripts/card-script-runtime.js')).scheduleCardScriptReconcile(); });
    await expect(message.locator('.mes_text')).toContainText('Static fallback');
    await expect(message.locator('.mes_run_card_scripts')).toHaveAttribute('title', 'Restart card scripts');
    await page.evaluate(id => document.querySelector(`#chat .mes[mesid="${id}"] .mes_run_card_scripts`).click(), id);
    await expect(card.locator('#status')).toHaveText('Script ran automatically');
    await expect(popup).toHaveCount(0);
});

test('declined consent stays stopped until an explicit retry', async ({ page }) => {
    const id = await seedCardScriptMessage(page, demoCardHtml, { consent: false });
    const popup = page.locator('dialog[open]').filter({ hasText: 'Allow automatic card scripts?' });
    if (!protectedBrowser) {
        await expect(cardLocators(page, id).message.locator('.card-script-run-anyway')).toBeVisible();
        await page.evaluate(async () => { (await import('/scripts/card-script-runtime.js')).scheduleCardScriptReconcile(); });
        await expect(cardLocators(page, id).outer).toHaveCount(0);
        await expect(popup).toHaveCount(0);
        return;
    }
    await popup.locator('.popup-button-cancel').click();
    await page.evaluate(async () => { (await import('/scripts/card-script-runtime.js')).scheduleCardScriptReconcile(); });
    await expect(cardLocators(page, id).outer).toHaveCount(0); await expect(popup).toHaveCount(0);
});

test('post-render CHAT_CHANGED, edit, swipe and deletion keep only current content', async ({ page }) => {
    const id = await seedCardScriptMessage(page, demoCardHtml);
    await runCardForBrowser(page, id, { protectedBrowser });
    const { card } = cardLocators(page, id); await expect(card.locator('#status')).toHaveText('Script ran automatically');
    await page.evaluate(async () => { const ctx = SillyTavern.getContext(); await ctx.eventSource.emit(ctx.event_types.CHAT_CHANGED); });
    await expect(card.locator('#status')).toHaveText('Script ran automatically');
    await page.evaluate(async id => { const ctx = SillyTavern.getContext(); ctx.chat[id].mes = '<p>Edited plain text</p>'; await ctx.updateMessageBlock(id, ctx.chat[id]); }, id);
    await expect(cardLocators(page, id).outer).toHaveCount(0);
    await page.evaluate(async id => {
        const ctx = SillyTavern.getContext(); ctx.chat[id].swipe_id = 1; ctx.chat[id].mes = '<p id="swipe">Swipe fallback</p><script>document.getElementById("swipe").textContent="Current swipe ran";</script>';
        await ctx.updateMessageBlock(id, ctx.chat[id]); await ctx.eventSource.emit(ctx.event_types.MESSAGE_SWIPED, id);
    }, id);
    await runCardForBrowser(page, id, { protectedBrowser });
    await expect(cardLocators(page, id).card.locator('#swipe')).toHaveText('Current swipe ran');
    await page.evaluate(async id => {
        const ctx = SillyTavern.getContext(); ctx.chat.splice(id, 1); document.querySelector(`#chat .mes[mesid="${id}"]`).remove(); await ctx.eventSource.emit(ctx.event_types.MESSAGE_DELETED, id);
    }, id);
    await expect(page.locator('iframe.card-script-sandbox-frame')).toHaveCount(0);
});

test('a real swipe on one message keeps other card scripts running', async ({ page }) => {
    const first = await seedCardScriptMessage(page, demoCardHtml);
    await runCardForBrowser(page, first, { protectedBrowser });
    await expect(cardLocators(page, first).card.locator('#status')).toHaveText('Script ran automatically');
    const second = await page.evaluate(async () => {
        const ctx = SillyTavern.getContext();
        const page = text => `<p id="swipe">Swipe fallback</p><script>document.getElementById("swipe").textContent=${JSON.stringify(text)};</script>`;
        const msg = { name: 'Swipe card', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: page('First swipe ran'), swipe_id: 0, swipes: [page('First swipe ran'), page('Second swipe ran')], swipe_info: [{}, {}] };
        const id = ctx.chat.length; ctx.chat.push(msg); ctx.addOneMessage(msg, { scroll: false });
        return id;
    });
    await runCardForBrowser(page, second, { protectedBrowser });
    await expect(cardLocators(page, second).card.locator('#swipe')).toHaveText('First swipe ran');
    await page.evaluate(async () => { const core = await import('/script.js'); await core.swipe_right(null, {}); });
    await runCardForBrowser(page, second, { protectedBrowser });
    await expect(cardLocators(page, second).card.locator('#swipe')).toHaveText('Second swipe ran');
    await expect(cardLocators(page, first).card.locator('#status')).toHaveText('Script ran automatically');
    await expect(page.locator('#chat iframe.card-script-sandbox-frame')).toHaveCount(2);
});

test('streaming stays inert until the explicit final-write transition', async ({ page }) => {
    const id = await page.evaluate(async html => {
        const core = await import('/script.js'); await core.clearChat({ clearData: true });
        const { power_user } = await import('/scripts/power-user.js'); power_user.allow_card_scripts = true; power_user.encode_tags = false;
        const runtime = await import('/scripts/card-script-runtime.js'); localStorage.setItem(runtime.CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true');
        (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
        const ctx = SillyTavern.getContext(); const id = ctx.chat.length;
        runtime.setCardScriptMessageStreaming(id, true);
        const msg = { name: 'Streaming card', is_user: false, is_system: false, extra: {}, mes: html }; ctx.chat.push(msg); ctx.addOneMessage(msg);
        return id;
    }, demoCardHtml);
    await expect(cardLocators(page, id).outer).toHaveCount(0);
    await page.evaluate(async id => { const runtime = await import('/scripts/card-script-runtime.js'); runtime.setCardScriptMessageStreaming(id, false); runtime.scheduleCardScriptReconcile(id); }, id);
    await runCardForBrowser(page, id, { protectedBrowser });
    await expect(cardLocators(page, id).card.locator('#status')).toHaveText('Script ran automatically');
});

test('native scripts can replace the body and still become ready and resize', async ({ page }) => {
    const html = `<script>
    document.body.innerHTML = '<p id="dynamic">Native body renderer ran</p><div id="content" style="height:260px"></div><button id="collapse">Collapse</button>';
    document.getElementById('collapse').onclick = () => { document.getElementById('content').style.height = '0px'; };
    </script>`;
    const id = await seedCardScriptMessage(page, html);
    await runCardForBrowser(page, id, { protectedBrowser });
    const { outer, card } = cardLocators(page, id);
    await expect(card.locator('#dynamic')).toHaveText('Native body renderer ran');
    await expect.poll(async () => (await outer.boundingBox()).height).toBeGreaterThan(260);
    const grown = (await outer.boundingBox()).height;
    await card.locator('#collapse').click();
    await expect.poll(async () => (await outer.boundingBox()).height).toBeLessThan(grown - 200);
});

test('automatic consent never authorises a different unprotected message or changed revision', async ({ page }) => {
    const first = await seedCardScriptMessage(page, demoCardHtml);
    await runCardForBrowser(page, first, { protectedBrowser });
    await expect(cardLocators(page, first).card.locator('#status')).toHaveText('Script ran automatically');
    const second = await seedCardScriptMessage(page, demoCardHtml, { clear: false });
    if (!protectedBrowser) {
        await expect(cardLocators(page, second).message.locator('.card-script-run-anyway')).toBeVisible();
        await expect(cardLocators(page, second).outer).toHaveCount(0);
        await expect(page.locator('dialog[open]').filter({ hasText: 'Allow automatic card scripts?' })).toHaveCount(0);
    } else await expect(cardLocators(page, second).card.locator('#status')).toHaveText('Script ran automatically');
    await page.evaluate(async id => {
        const ctx = SillyTavern.getContext(); ctx.chat[id].mes = '<p id="changed">Changed fallback</p><script>document.getElementById("changed").textContent="Changed revision ran";</script>';
        await ctx.updateMessageBlock(id, ctx.chat[id]);
    }, first);
    await runCardForBrowser(page, first, { protectedBrowser });
    await expect(cardLocators(page, first).card.locator('#changed')).toHaveText('Changed revision ran');
});

test('unsupported override permits real WebRTC egress; the default gate does not', async ({ page }) => {
    const socket = createSocket('udp4'); let packets = 0;
    socket.on('message', () => packets++);
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    try {
        await page.evaluate(async port => {
            const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
            window.cardControlPeer = peer; peer.createDataChannel('positive-control');
            await peer.setLocalDescription(await peer.createOffer());
        }, port);
        await expect.poll(() => packets).toBeGreaterThan(0);
        await page.evaluate(() => { window.cardControlPeer.close(); });
        // Protected hostile gathering has an upstream crash; the separate diagnostic retains that failure.
        if (protectedBrowser) {
            const id = await seedCardScriptMessage(page, demoCardHtml);
            await expect(cardLocators(page, id).card.locator('#status')).toHaveText('Script ran automatically');
            expect(await page.evaluate(async id => (await import('/scripts/card-script-runtime.js')).getActiveSandbox(id).protection, id)).toBe('protected');
            return;
        }
        const before = packets;
        const id = await seedCardScriptMessage(page, `<p id="rtc">Static network fallback</p><script>const peer=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});peer.createDataChannel('card-probe');peer.createOffer().then(offer=>peer.setLocalDescription(offer));document.getElementById('rtc').textContent='ICE started';</script>`);
        const { message, outer, card } = cardLocators(page, id);
        await expect(message.locator('.card-script-run-anyway')).toBeVisible();
        await expect(outer).toHaveCount(0); expect(packets).toBe(before);
        await message.locator('.card-script-run-anyway').click();
        await expect(card.locator('#rtc')).toHaveText('ICE started');
        await expect.poll(() => packets).toBeGreaterThan(before);
    } finally { await new Promise(resolve => socket.close(resolve)); }
});

for (const browserName of ['chromium', 'webkit']) {
    test(`security policies and authenticated relay in ${browserName}`, async ({ page: chromiumPage, baseURL }) => {
        test.setTimeout(120000);
        let ownedBrowser; let page = chromiumPage;
        if (browserName === 'webkit') { ownedBrowser = await webkit.launch({ executablePath: webkit.executablePath() }); page = await ownedBrowser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true }); await openCardScriptApp(page, baseURL); }
        let received = 0;
        const probe = createServer((request, response) => { received++; response.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); response.end('Probe'); });
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${probe.address().port}/probe`;
        try {
            await page.evaluate(() => {
                document.cookie = 'card_sandbox_host_canary=not-for-cards; path=/; SameSite=Lax';
                localStorage.setItem('card_sandbox_host_canary', 'not-for-cards');
            });
            expect(await page.evaluate(() => document.cookie.includes('card_sandbox_host_canary=not-for-cards'))).toBe(true);
            const html = `<p id="status">Waiting</p><button id="attack">Attempt navigation</button><script>
            const failures = [];
            for (const read of [()=>parent.document.body,()=>top.document.body,()=>document.cookie,()=>localStorage.getItem('test')]) { try { const value=read(); failures.push(value===''?'blocked':'FAIL'); } catch { failures.push('blocked'); } }
            document.getElementById('status').textContent = failures.join(',');
            try{parent.location.href='${url}?parent-navigation';}catch{}
            fetch('${url}').catch(()=>document.body.dataset.fetch='blocked');
            const xhr=new XMLHttpRequest();xhr.open('GET','${url}?xhr');try{xhr.send();}catch{}
            for(const [tag,attr] of [['script','src'],['img','src'],['iframe','src'],['link','href']]){const n=document.createElement(tag);n[attr]='${url}?'+tag;if(tag==='link')n.rel='stylesheet';document.body.appendChild(n);}
            const style=document.createElement('style');style.textContent='@font-face{font-family:probe;src:url(${url}?font)}#status{font-family:probe;background-image:url(${url}?css)}';document.head.appendChild(style);
            const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content="default-src * 'unsafe-inline'; connect-src *; frame-src *";document.head.appendChild(meta);
            const form=document.createElement('form');form.action='${url}?form';document.body.appendChild(form);try{form.submit();}catch{}
            document.getElementById('attack').onclick=()=>{const refresh=document.createElement('meta');refresh.httpEquiv='refresh';refresh.content='0;url=${url}?refresh';document.head.appendChild(refresh);try{top.location.href='${url}?top';}catch{}window.open('${url}?popup');location.href='${url}?self';};
            triggerSlash('/echo title=Card security bridge worked');
            triggerSlash('/echo onClick=bad Unsafe');
            </script>`;
            const id = await seedCardScriptMessage(page, html);
            await runCardForBrowser(page, id, { protectedBrowser: browserName === 'webkit' ? false : protectedBrowser });
            const { outer, card } = cardLocators(page, id);
            await expect(card.locator('#status')).toHaveText('blocked,blocked,blocked,blocked');
            await expect(card.locator('body')).toHaveAttribute('data-fetch', 'blocked');
            await expect(page.locator('.toast').filter({ hasText: 'security bridge worked' })).toBeVisible();
            const attrs = await outer.contentFrame().locator('iframe.card-script-content-frame').evaluate(node => ({ sandbox: node.getAttribute('sandbox'), allow: node.getAttribute('allow'), referrer: node.getAttribute('referrerpolicy') }));
            expect(attrs.sandbox).toBe('allow-scripts'); expect(attrs.referrer).toBe('no-referrer'); expect(attrs.allow).toContain('camera \'none\'');
            const forged = await page.evaluate(async id => {
                const runtime = await import('/scripts/card-script-runtime.js'); const record = runtime.getActiveSandbox(id);
                const extra = document.createElement('iframe'); extra.srcdoc = '<p>Unrelated window</p>'; document.body.appendChild(extra);
                const result = await runtime.handleSandboxMessage({ source: extra.contentWindow, data: { type: 'neconyan-card-script:resize', version: 1, messageId: id, nonce: record.nonce, height: 4096 } }); extra.remove(); return result;
            }, id);
            expect(forged).toEqual({ ok: false, reason: 'unknown_source' });
            const authenticatedEnvelope = await page.evaluate(async id => {
                const record = (await import('/scripts/card-script-runtime.js')).getActiveSandbox(id);
                const data = { type: 'neconyan-card-script:resize', version: 1, messageId: id, nonce: record.nonce, height: 4096 };
                const attacker = document.createElement('iframe');
                attacker.id = 'forged-card-window';
                attacker.srcdoc = `<script>parent.postMessage(${JSON.stringify(data)}, '*');parent.postMessage(${JSON.stringify({ ...data, type: 'neconyan-card-script:slash', command: '/echo forged-window-command' })}, '*');</script>`;
                document.body.appendChild(attacker); return data;
            }, id);
            await card.locator('body').evaluate((_, data) => window.top.postMessage(data, '*'), authenticatedEnvelope);
            await expect(outer).not.toHaveCSS('height', '4096px');
            await expect(page.locator('.toast').filter({ hasText: 'forged-window-command' })).toHaveCount(0);
            await card.locator('#attack').click();
            await page.waitForTimeout(1200);
            expect(received).toBe(0); expect(page.url()).not.toContain('/probe'); await expect(outer).toHaveCount(1);
            await expect(page.locator('.toast').filter({ hasText: 'forged-window-command' })).toHaveCount(0);
            for (const attack of [
                `const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url=${url}?independent-refresh';document.head.appendChild(meta);`,
                `const base=document.createElement('base');base.href='${url}';document.head.appendChild(base);location.href='?base-relative';`,
            ]) {
                const next = await seedCardScriptMessage(page, `<p>Independent navigation probe</p><script>setTimeout(()=>{${attack}},300);</script>`);
                await runCardForBrowser(page, next, { protectedBrowser: browserName === 'webkit' ? false : protectedBrowser });
                await expect(cardLocators(page, next).outer).toHaveCount(1);
                await page.waitForTimeout(1200); expect(received).toBe(0);
            }
        } finally { await new Promise(resolve => probe.close(resolve)); await ownedBrowser?.close(); }
    });
}

test('a saved greeting runs after reopening and reloading the chat', async ({ page }) => {
    test.setTimeout(120000);
    const csrf = await (await page.request.get('/csrf-token')).json();
    const created = await page.request.post('/api/characters/create', { headers: { 'X-CSRF-Token': csrf.token }, data: { ch_name: `Script greeting ${Date.now()}`, first_mes: demoCardHtml } });
    expect(created.ok()).toBe(true); const avatar = await created.text();
    await page.evaluate(async avatar => {
        const core = await import('/script.js'); const { power_user } = await import('/scripts/power-user.js');
        power_user.allow_card_scripts = true; power_user.encode_tags = false; localStorage.setItem('card_scripts_auto_confirmed', 'true');
        await core.saveSettings(0); await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    await runCardForBrowser(page, 0, { protectedBrowser });
    await expect(cardLocators(page, 0).card.locator('#status')).toHaveText('Script ran automatically');
    await page.evaluate(async () => { await (await import('/script.js')).reloadCurrentChat(); });
    await runCardForBrowser(page, 0, { protectedBrowser });
    await expect(cardLocators(page, 0).card.locator('#status')).toHaveText('Script ran automatically');
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(window.cardScriptTestReady)), { timeout: 90000 }).toBe(true);
    await page.evaluate(async avatar => {
        const core = await import('/script.js'); await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    await runCardForBrowser(page, 0, { protectedBrowser });
    await expect(cardLocators(page, 0).card.locator('#status')).toHaveText('Script ran automatically');
    await page.evaluate(async () => { const core = await import('/script.js'); (await import('/scripts/power-user.js')).power_user.allow_card_scripts = false; await core.saveSettings(0); await core.clearChat({ clearData: true }); });
});
