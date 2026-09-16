/* global window, document, getComputedStyle */
import { expect, test } from '@playwright/test';

const username = process.env.NECONYAN_AUTH_TEST_USERNAME;
const password = process.env.NECONYAN_AUTH_TEST_PASSWORD;
test.describe.configure({ mode: 'serial' });

for (const title of ['phone sign-in', 'desktop sign-in']) {
    const phone = title.startsWith('phone');
    test.describe(`${title}`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
        test('password, passkey, rejected verification, remembered expiry and logout', async ({ page, context }, testInfo) => {
            test.skip(!username || !password, 'Set NECONYAN_AUTH_TEST_USERNAME and NECONYAN_AUTH_TEST_PASSWORD for an isolated authenticated preview at localhost or HTTPS.');
            test.setTimeout(180000);
            const cdp = await context.newCDPSession(page);
            await cdp.send('WebAuthn.enable');
            const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
                options: { protocol: 'ctap2', ctap2Version: 'ctap2_0', transport: 'internal', automaticPresenceSimulation: true, isUserVerified: true, hasResidentKey: true, hasUserVerification: true },
            });
            const openSettings = async () => {
                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
                await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
                await expect(page.locator('#passkey_controls')).toBeVisible();
            };
            const signIn = async () => {
                await page.locator('#workspaceUsername').fill(username);
                await page.locator('#workspacePassword').fill(password);
                await page.locator('#workspaceLoginButton').click();
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
            };
            await page.goto('/');
            await expect(page).toHaveURL(/\/login/);
            await expect(page.locator('#workspaceLoginBlock')).toBeVisible();
            await expect(page.locator('#rememberDevice')).not.toBeChecked();
            await expect(page.locator('#userSelectBlock')).toBeHidden();
            await page.evaluate(() => document.fonts.ready);
            const loginGeometry = await page.evaluate(() => ({
                overflow: document.documentElement.scrollWidth > window.innerWidth,
                inputFont: getComputedStyle(document.querySelector('#workspaceUsername')).fontFamily,
                headingFont: getComputedStyle(document.querySelector('h1')).fontFamily,
                controls: [...document.querySelectorAll('#workspaceLoginForm input:not([type=checkbox]), #workspaceLoginButton, #passkeyLoginButton, .remember-option')].map(el => ({ height: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right })),
            }));
            expect(loginGeometry.overflow).toBe(false);
            expect(loginGeometry.inputFont).toContain('Nunito');
            expect(loginGeometry.headingFont).toContain('Fredoka One');
            for (const control of loginGeometry.controls) {
                expect(control.height).toBeGreaterThanOrEqual(44);
                expect(control.right).toBeLessThanOrEqual(phone ? 393 : 1280);
            }
            await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true });
            await page.locator('#workspaceUsername').fill(username);
            await page.locator('#workspacePassword').fill('incorrect-test-password');
            await page.locator('#workspaceLoginButton').click();
            await expect(page.locator('#errorMessage')).toContainText('did not match');
            await signIn();
            const temporaryCookies = await context.cookies();
            expect(temporaryCookies.filter(cookie => cookie.name.startsWith('session-')).every(cookie => cookie.expires === -1)).toBe(true);
            await openSettings();
            const label = `Test ${phone ? 'phone' : 'desktop'} ${Date.now()}`;
            await page.locator('#passkeyLabel').fill(label);
            await page.locator('#passkeyPassword').fill(password);
            await page.locator('#passkeyAddButton').click();
            const row = page.locator('.passkey-row', { hasText: label });
            await expect(row).toHaveCount(1, { timeout: 30000 });
            const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
            expect(credentials.some(credential => credential.isResidentCredential)).toBe(true);
            await page.locator('#passkey_controls').scrollIntoViewIfNeeded();
            const settingsGeometry = await page.locator('#passkey_controls').evaluate(el => ({
                overflow: el.scrollWidth > el.clientWidth + 1,
                controls: [...el.querySelectorAll('input, button')].map(control => control.getBoundingClientRect().height),
            }));
            expect(settingsGeometry.overflow).toBe(false);
            for (const height of settingsGeometry.controls) expect(height).toBeGreaterThanOrEqual(44);
            const removeGeometry = await row.locator('.passkey-remove').evaluate(button => {
                const text = document.createRange();
                text.selectNodeContents(button);
                return { lines: text.getClientRects().length, textWidth: text.getBoundingClientRect().width, width: button.clientWidth, height: button.clientHeight };
            });
            expect(removeGeometry.lines).toBe(1);
            expect(removeGeometry.width).toBeGreaterThan(removeGeometry.textWidth);
            expect(removeGeometry.width).toBeGreaterThan(removeGeometry.height);
            await page.screenshot({ path: testInfo.outputPath('passkey-settings.png') });
            await page.locator('#logout_button').click();
            await expect(page).toHaveURL(/\/login/);
            const oldCookie = temporaryCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
            expect((await context.request.get('/version', { headers: { Cookie: oldCookie } })).status()).toBe(401);
            await page.goto('/');
            await expect(page).toHaveURL(/\/login/);

            // A real assertion with a damaged signature must fail, not create a session.
            await page.route('**/api/auth/passkeys/login', async route => {
                const payload = route.request().postDataJSON();
                payload.response.response.signature = 'AA';
                await route.continue({ postData: JSON.stringify(payload) });
            }, { times: 1 });
            await page.locator('#passkeyLoginButton').click();
            await expect(page.locator('#errorMessage')).toContainText(/did not verify|could not be verified/);
            expect((await (await context.request.get('/api/auth/status')).json()).browserSession).toBe(false);

            // Even if a client weakens the browser options, the server requires device verification.
            await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
            await page.route('**/api/auth/passkeys/login-options', async route => {
                const response = await route.fetch();
                const payload = await response.json();
                payload.options.userVerification = 'discouraged';
                await route.fulfill({ response, json: payload });
            }, { times: 1 });
            const rejectedVerification = page.waitForResponse(response => response.url().endsWith('/api/auth/passkeys/login'));
            await page.locator('#passkeyLoginButton').click();
            expect((await rejectedVerification).status()).toBe(400);
            await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });

            await page.locator('#rememberDevice').check();
            await page.locator('#passkeyLoginButton').click();
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
            const cookies = (await context.cookies()).filter(cookie => cookie.name.startsWith('session-'));
            expect(cookies.length).toBeGreaterThan(0);
            for (const cookie of cookies) expect(Math.abs(cookie.expires - Date.now() / 1000 - 30 * 86400)).toBeLessThan(120);
            await openSettings();
            await page.locator('#passkeyPassword').fill(password);
            await row.locator('.passkey-remove').click();
            await expect(row).toHaveCount(0);
            await page.locator('#logout_button').click();
            await expect(page).toHaveURL(/\/login/);
            await page.locator('#passkeyLoginButton').click();
            await expect(page.locator('#errorMessage')).toContainText(/not enrolled|No passkey/);
            await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
        });
    });
}
