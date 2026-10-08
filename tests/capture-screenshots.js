#!/usr/bin/env node

/**
 * Neconyan Screenshot Capture Script (Hardened State-Machine Version)
 *
 * Automates screenshot capture for desktop and mobile viewports.
 * Uses a robust drawer state-machine to handle complex desktop/mobile overlays.
 * Uses NECONYAN_TEST_BASE_URL, or a Neconyan server on port 4433.
 */

/* global document, window */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const versionArg = args.find(arg => arg.startsWith('--version='));
const conversationCharacterArg = args.find(arg => arg.startsWith('--conversation-character='));
const desktopOnly = args.includes('--desktop-only');
const mobileOnly = args.includes('--mobile-only');

if (!versionArg) {
    console.error('Error: --version parameter is required');
    console.error('Usage: node tests/capture-screenshots.js --version=1.7.0 [--conversation-character="Bunny Guide"]');
    process.exit(1);
}

const version = versionArg.split('=')[1];
// Conversation Mode renders a real DM thread; point this at the character that
// has one so the shot is not empty chrome. Defaults to the in-chat character.
const conversationCharacter = conversationCharacterArg ? conversationCharacterArg.split('=').slice(1).join('=') : '';
const searchQuery = 'agents';
const baseURL = process.env.NECONYAN_TEST_BASE_URL || 'http://127.0.0.1:4433';
const screenshotsDir = join(__dirname, '..', 'screenshots');

// Viewport configurations
const viewports = {
    desktop: { width: 1920, height: 1080 },
    mobile: { width: 390, height: 844 },
};

async function dismissOnboardingIfPresent(page) {
    const onboardingDialog = page.locator('dialog[open]:has(.onboarding)').first();
    if (await onboardingDialog.isVisible()) {
        await onboardingDialog.locator('.popup-input').fill('Screenshot Tester');
        await onboardingDialog.locator('.popup-button-ok').click();
        await onboardingDialog.waitFor({ state: 'hidden' });
    }
    const skipTour = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skipTour.isVisible()) {
        await skipTour.click();
        await skipTour.waitFor({ state: 'hidden' });
    }
}

async function ensureOnlyOpen(page, target, tabId) {
    const panels = {
        left: '#left-nav-panel',
        customize: '#user-settings-block',
        characters: '#right-nav-panel',
    };
    // Selection can close a phone drawer between a visibility check and a click.
    await page.evaluate(() => {
        window.NeconyanShell.closeWorkspace();
        window.NeconyanShell.closeCharacters();
    });
    for (const selector of Object.values(panels)) {
        await page.locator(`${selector}.openDrawer`).waitFor({ state: 'hidden' });
    }
    if (target !== 'none') {
        const [shell, defaultTab] = { left: ['left', 'presets'], customize: ['right', 'settings'], characters: ['characters', 'characters'] }[target];
        const tab = tabId || defaultTab;
        await page.evaluate(({ shell, tab }) => window.NeconyanShell.openTab(shell, tab), { shell, tab });
        const tabAttribute = target === 'characters' ? 'data-menu-type' : 'data-sb-active-tab';
        await page.locator(`${panels[target]}.openDrawer[${tabAttribute}="${tab}"]`).waitFor();
    }
}

async function selectCharacterByName(page, name) {
    const row = page.locator('#rm_print_characters_block .character_select')
        .filter({ has: page.locator('.ch_name', { hasText: name }) })
        .first();
    await row.click();
    await page.waitForFunction(name => {
        const context = window.SillyTavern.getContext();
        return context.characters[context.characterId]?.name === name;
    }, name);
}

async function setCharacterMode(page, mode) {
    await ensureOnlyOpen(page, 'none');
    const button = page.locator(`#neconyan-workspace-rail [data-neconyan-chat-mode="${mode}"]`);
    if (!await button.isVisible()) await page.locator('#sb-hamburger').click();
    await button.click();
    await page.waitForFunction(mode => document.body.dataset.neconyanChatMode === mode, mode);
    if (await page.locator('body.neconyan-rail-drawer-open').count()) await page.locator('#sb-hamburger').click();
}

// Screenshot sections configuration
const sections = [
    {
        name: 'navigate',
        description: 'Workspace Presets',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'left');
        },
    },
    {
        name: 'customize',
        description: 'User Settings drawer',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'customize');
        },
    },
    {
        name: 'agents',
        description: 'Workspace Agents tab',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'left', 'agents');
        },
    },
    {
        name: 'characters',
        description: 'Character Management drawer',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'characters');
        },
    },
    {
        name: 'in-chat',
        description: 'Active chat with Assistant',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'none');
            await page.evaluate(() => window.NeconyanShell.showHome());
            const assistant = page.locator('[data-assistant-personality="miso"]');
            await assistant.locator('[data-assistant-variant]').first().check();
            await assistant.locator('[data-assistant-open]').click();
            await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
            await setCharacterMode(page, 'roleplay');
            await page.locator('#chat .mes').first().waitFor();
        },
    },
    {
        name: 'search',
        description: 'Universal search over the open chat',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'none');
            // openGlobalSearch is the shell's own entry point; the topbar proxy icon is
            // rebuilt by a MutationObserver and goes stale mid-run.
            await page.evaluate('globalThis.NeconyanShell?.openGlobalSearch?.({ focusInput: true })');
            await page.locator('#sb-universal-search.is-open').waitFor({ timeout: 10000 });
            await page.locator('#sb-universal-search input[type="search"]').fill(searchQuery);
            await page.locator('#sb-universal-search-results.is-visible').waitFor({ timeout: 10000 });
            await page.getByRole('status').filter({ hasText: 'Searching saved content…' }).waitFor({ state: 'hidden' });
        },
        teardown: async (page) => {
            await page.keyboard.press('Escape');
            await page.locator('#sb-universal-search.is-open').waitFor({ state: 'hidden' });
        },
    },
    {
        name: 'conversation',
        description: 'Conversation Mode DM thread',
        setup: async (page) => {
            if (conversationCharacter) {
                await ensureOnlyOpen(page, 'characters');
                await selectCharacterByName(page, conversationCharacter);
            }
            await setCharacterMode(page, 'conversation');
            await ensureOnlyOpen(page, 'none');
            // Wait for real bubbles, not just the chrome, so an empty thread fails loudly
            await page.locator('.sb-conversation-message-bubble').first().waitFor({ timeout: 15000 });
        },
        teardown: async (page) => {
            await setCharacterMode(page, 'roleplay');
            await ensureOnlyOpen(page, 'none');
        },
    },
];

async function captureScreenshots(viewportType) {
    const viewport = viewports[viewportType];
    console.log(`\n📸 Capturing ${viewportType} screenshots (${viewport.width}x${viewport.height})...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewportType === 'mobile', isMobile: viewportType === 'mobile' });
    const page = await context.newPage();
    let captureFailed = false;

    // Log browser errors
    page.on('console', msg => {
        if (msg.type() === 'error') {
            console.log(`      [Browser Error] ${msg.text()}`);
        }
    });

    try {
        // Navigate to Neconyan
        console.log(`   Navigating to ${baseURL}...`);
        await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for app to initialize
        await page.locator('#preloader').waitFor({ state: 'detached', timeout: 60000 });
        await page.waitForFunction(() => typeof window.NeconyanShell?.openTab === 'function', undefined, { timeout: 60000 });
        await dismissOnboardingIfPresent(page);

        // Capture each section
        for (const section of sections) {
            const filename = `neconyan-ui-${viewportType}-${section.name}-v${version}.png`;
            const filepath = join(screenshotsDir, filename);

            console.log(`   Capturing ${section.description}...`);

            try {
                // Setup the UI for this screenshot
                await section.setup(page);

                await page.evaluate(() => document.fonts.ready);

                // Take screenshot
                await page.screenshot({
                    path: filepath,
                    fullPage: false,
                    type: 'png',
                    animations: 'disabled',
                });

                console.log(`   ✓ Saved: ${filename}`);
            } catch (error) {
                captureFailed = true;
                console.error(`   ✗ Failed to capture ${section.name}: ${error.message}`);
            }

            // Sections that change global shell state must hand a clean page to the next one
            try {
                await section.teardown?.(page);
            } catch (error) {
                captureFailed = true;
                console.error(`   ✗ Failed to reset after ${section.name}: ${error.message}`);
            }
        }
        if (captureFailed) throw new Error('One or more screenshot sections failed.');
    } catch (error) {
        console.error(`Error during ${viewportType} capture:`, error.message);
        throw error;
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🐰 Neconyan Screenshot Capture Tool');
    console.log(`   Version: ${version}`);
    console.log(`   Output: ${screenshotsDir}`);

    // Check if server is running
    try {
        const response = await fetch(baseURL);
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
    } catch (error) {
        console.error(`\n❌ Error: Neconyan server is not running on ${baseURL}`);
        console.error('   Please start the server first: bun run start');
        process.exit(1);
    }

    try {
        if (!mobileOnly) {
            await captureScreenshots('desktop');
        }

        if (!desktopOnly) {
            await captureScreenshots('mobile');
        }

        console.log('\n✅ Screenshot capture complete!');
        console.log(`   Screenshots saved to: ${screenshotsDir}`);
    } catch (error) {
        console.error('\n❌ Screenshot capture failed:', error.message);
        process.exit(1);
    }
}

main();
