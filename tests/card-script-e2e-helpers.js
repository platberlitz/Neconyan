/* global document, window, localStorage */
import { expect } from '@playwright/test';

export async function openCardScriptApp(page, url = '/') {
    await page.addInitScript(() => {
        window.addEventListener('neconyan:ready', () => { window.cardScriptTestReady = true; });
        localStorage.setItem('NeconyanTutorialHidden.v1', 'true');
    });
    await page.goto(url);
    await expect.poll(async () => {
        await page.evaluate(() => {
            document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]')?.click();
            const onboarding = document.querySelector('dialog[open]:has(.onboarding)');
            if (onboarding) {
                const input = onboarding.querySelector('.popup-input');
                if (input) { input.value = 'Card script tester'; input.dispatchEvent(new Event('input', { bubbles: true })); }
                onboarding.querySelector('.popup-button-ok')?.click();
            } else document.querySelector('dialog[open] .popup-button-cancel')?.click();
        });
        return page.evaluate(() => Boolean(window.cardScriptTestReady));
    }, { timeout: 90000 }).toBe(true);
    await page.locator('#preloader').waitFor({ state: 'detached' });
}

export async function seedCardScriptMessage(page, html, { enabled = true, consent = true, clear = true } = {}) {
    return page.evaluate(async options => {
        const core = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const runtime = await import('/scripts/card-script-runtime.js');
        if (options.clear) await core.clearChat({ clearData: true });
        (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
        power_user.allow_card_scripts = options.enabled;
        power_user.encode_tags = false;
        if (options.consent) localStorage.setItem(runtime.CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true');
        else { localStorage.removeItem(runtime.CARD_SCRIPT_CONFIRMATION_STORAGE_KEY); localStorage.setItem('card_scripts_confirmed', 'true'); }
        const ctx = SillyTavern.getContext();
        const msg = { name: 'Interactive card', is_user: false, is_system: false, send_date: new Date().toISOString(), extra: {}, mes: options.html };
        const id = ctx.chat.length; ctx.chat.push(msg); ctx.addOneMessage(msg, { scroll: false });
        document.querySelector('#chat').scrollTop = document.querySelector('#chat').scrollHeight;
        return id;
    }, { html, enabled, consent, clear });
}

export const demoCardHtml = `<h3>Card scripts</h3><p id="status">Static fallback</p><p id="isolation"></p><button id="grow">Grow panel</button> <button id="shrink">Shrink panel</button><div id="panel"></div>
<script>
document.getElementById('status').textContent = 'Script ran automatically';
try { window.parent.document.body; document.getElementById('isolation').textContent = 'Parent readable'; }
catch { document.getElementById('isolation').textContent = 'Parent access blocked'; }
document.getElementById('grow').onclick = () => { document.getElementById('panel').style.height = '360px'; document.getElementById('status').textContent = 'Button worked'; };
document.getElementById('shrink').onclick = () => { document.getElementById('panel').style.height = '0px'; document.getElementById('status').textContent = 'Panel shrank'; };
</script>`;

export const fencedCardHtml = 'Surrounding prose stays readable.\n\n```html\n<!doctype html><html><body><p id="fenced-status">Fenced fallback</p><button onclick="this.textContent=\'Clicked\'">Try the card</button><script>document.getElementById("fenced-status").textContent="Full-page HTML ran automatically";</script></body></html>\n```\n\nThe rest of the message stays here.';

export function cardLocators(page, id) {
    const message = page.locator(`#chat .mes[mesid="${id}"]`);
    const outer = message.locator('iframe.card-script-sandbox-frame').first();
    return { message, outer, card: outer.contentFrame().locator('iframe.card-script-content-frame').contentFrame() };
}

export async function runCardForBrowser(page, id, { protectedBrowser = false } = {}) {
    if (!protectedBrowser) {
        const { message } = cardLocators(page, id);
        const button = message.locator('.card-script-run-anyway');
        await expect(button).toBeVisible();
        await expect(message.locator('iframe')).toHaveCount(0);
        await button.click();
    }
}
