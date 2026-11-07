/* global document, window */
import { expect } from '@playwright/test';
import { MODEL, test } from './neconyan-conversation-durable-fixture.js';

test.describe.configure({ mode: 'default' });
test.setTimeout(240000);

const PANEL = '#neconyan-conversation-games';
const GAMES_BUTTON = '.sb-conversation-quick-actions [data-sb-conversation-action="games"]';
const STARTED = 'Started a game of Connect Four with Durable Nova.';
const PUZZLE = 'Started a Picross puzzle.';

/**
 * The pal is asked to move through the saved connection, so the fixture answers with a legal
 * column. Connect Four reads a bare digit as a one-based column, which is what the board shows.
 */
function palReply(body) {
    const text = JSON.stringify(body.messages || body.prompt || '');
    if (text.includes('playing Connect Four')) {
        return '4';
    }
    if (text.includes('playing Chess')) {
        return 'e7e5';
    }
    return 'Unexpected fixture request.';
}

function palCalls(app) {
    return app.provider.calls.filter(call => JSON.stringify(call.messages ?? call.prompt ?? '').includes('playing Connect Four'));
}

async function oocNotes(account) {
    const branch = await account.branch();
    return (branch?.messages || [])
        .filter(message => message.extra?.conversation_mode_ooc)
        .map(message => String(message.mes || '').trim());
}

async function savedRecord(account) {
    const branch = await account.branch();
    return branch?.games || null;
}

async function openPanel(page) {
    const button = page.locator(GAMES_BUTTON);
    if (!await button.isVisible()) {
        await page.locator('#sb_conversation_toggle_tools').click();
    }
    await button.click();
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    return panel;
}

test('desktop Connect Four plays against the pal seat and comes back after a reload', async ({ app }) => {
    const account = await app.account({ phone: false });
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await expect(panel.locator('.neco-games-card')).toHaveCount(4);

    await panel.locator('.neco-games-card[data-game="connect-four"]').click();
    await expect(panel.locator('.neco-games-setup')).toBeVisible();
    await panel.locator('.neco-games-choice', { hasText: 'Your pal' }).click();
    await expect(panel.locator('.neco-games-choice', { hasText: 'Your pal' })).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.neco-games-start').click();

    // The pal opens, because the setup asked it to drop first.
    await expect(panel.locator('[data-column="3"] .neco-games-cf-cell[data-row="5"][data-seat="y"]')).toHaveCount(1, { timeout: 60000 });
    await expect(panel.locator('[data-column="3"] .neco-games-cf-cell[data-row="5"] .neco-games-cf-disc')).toHaveText('X');
    await expect(panel.locator('.neco-games-status')).toHaveAttribute('data-turn', 'you');
    await expect(panel.locator('.neco-games-status')).toContainText('Your turn to drop');
    expect(palCalls(app)).toHaveLength(1);
    expect(palCalls(app)[0].model).toBe(MODEL);

    await panel.locator('.neco-games-cf-column[data-column="0"]').click();
    await expect(panel.locator('[data-column="0"] .neco-games-cf-cell[data-row="5"][data-seat="r"]')).toHaveCount(1);
    await expect(panel.locator('[data-column="3"] .neco-games-cf-cell[data-seat="y"]')).toHaveCount(2, { timeout: 60000 });
    expect(palCalls(app)).toHaveLength(2);

    await expect.poll(async () => (await savedRecord(account))?.state.history).toEqual([3, 0, 3]);
    const record = await savedRecord(account);
    expect(record.state.history).toEqual([3, 0, 3]);
    expect(record.options.first).toBe('pal');
    expect(record.difficulty).toBe('normal');

    await expect.poll(() => oocNotes(account).then(notes => notes.join('\n'))).toContain(STARTED);

    // Close while a reply is pending. Reopening must resume that pal turn, not lock the board.
    app.provider.mode.hold = palCalls(app)[0].model;
    await panel.locator('.neco-games-cf-column[data-column="1"]').click();
    await expect.poll(() => palCalls(app).length).toBe(3);
    await expect.poll(async () => (await savedRecord(account))?.state.history).toEqual([3, 0, 3, 1]);
    await page.close();
    await app.release();
    const reopened = await account.open();
    const again = await openPanel(reopened);
    await expect(again.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(3, { timeout: 60000 });
    await expect(again.locator('.neco-games-cf-cell[data-seat="r"]')).toHaveCount(2);
    await expect(again.locator('.neco-games-status')).toHaveAttribute('data-turn', 'you');

    // Leaving the board and coming back keeps the game in progress.
    await again.locator('.neco-games-back').click();
    await expect(again.locator('.neco-games-resume')).toBeVisible();
    await expect(again.locator('.neco-games-resume')).toContainText('Connect Four in progress');
    await again.locator('.neco-games-resume button', { hasText: 'Back to the board' }).click();
    await expect(again.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(3);

    // A solo puzzle replaces the versus game on this branch, and never asks the model anything.
    const before = palCalls(app).length;
    await again.locator('.neco-games-back').click();
    await again.locator('.neco-games-card[data-game="picross"]').click();
    await again.locator('.neco-games-choice', { hasText: 'Small (5 by 5)' }).click();
    await again.locator('.neco-games-start').click();
    await expect(again.locator('.neco-games-picross-grid')).toBeVisible();
    await expect(again.locator('.neco-games-picross-cell')).toHaveCount(25);
    await expect(again.locator('.neco-games-hint')).toBeVisible();

    await again.locator('.neco-games-picross-cell[data-cell="0"]').click();
    await expect(again.locator('.neco-games-picross-cell[data-cell="0"]')).toHaveAttribute('data-value', '1');
    await expect(again.locator('.neco-games-status')).toContainText('rows and');
    await expect.poll(async () => (await savedRecord(account))?.state.cells?.[0]).toBe(1);
    const puzzle = (await savedRecord(account)).state;
    const hintIndex = puzzle.answer.findIndex((value, index) => value && puzzle.cells[index] !== 1);
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    await again.locator('.neco-games-hint').click();
    await expect(again.locator('.neco-games-note')).toContainText(`Hint: Painted row ${Math.floor(hintIndex / puzzle.cols) + 1}, column ${hintIndex % puzzle.cols + 1}.`);

    await expect.poll(async () => (await savedRecord(account))?.id).toBe('picross');
    await expect.poll(() => oocNotes(account).then(notes => notes.join('\n'))).toContain(PUZZLE);
    expect(palCalls(app)).toHaveLength(before);
    expect(await oocNotes(account)).toEqual([STARTED, PUZZLE]);
});

test('desktop Chess plays a pawn for you and answers with the pal seat', async ({ app }) => {
    const account = await app.account({ phone: false });
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await panel.locator('.neco-games-card[data-game="chess"]').click();
    await panel.locator('.neco-games-start').click();
    await expect(panel.locator('.neco-games-chess-board')).toBeVisible();
    await expect(panel.locator('.neco-games-chess-square')).toHaveCount(64);

    // Your pieces are hollow, the pal's are solid, so the two sides read apart.
    await expect(panel.locator('.neco-games-chess-square[data-square="e2"] .neco-games-chess-glyph')).toHaveText('♙');
    await expect(panel.locator('.neco-games-chess-square[data-square="e7"] .neco-games-chess-glyph')).toHaveText('♟');
    await expect(panel.locator('.neco-games-status')).toContainText('Your move');

    await panel.locator('.neco-games-chess-square[data-square="e2"]').click();
    await panel.locator('.neco-games-chess-square[data-square="e4"]').click();
    await expect(panel.locator('.neco-games-chess-square[data-square="e4"] .neco-games-chess-glyph')).toHaveCount(1);
    await expect(panel.locator('.neco-games-chess-square[data-square="e2"] .neco-games-chess-glyph')).toHaveCount(0);

    // The fixture answers e7e5, which puts a second pawn on the board.
    await expect(panel.locator('.neco-games-chess-square[data-square="e5"] .neco-games-chess-glyph')).toHaveCount(1, { timeout: 60000 });
    await expect(panel.locator('.neco-games-status')).toHaveAttribute('data-turn', 'you');

    await expect.poll(async () => (await savedRecord(account))?.state.history?.length).toBe(2);
    const record = await savedRecord(account);
    expect(record.state.history.map(entry => entry.san).slice(0, 2)).toEqual(['e4', 'e5']);
    expect(record.options.first).toBe('you');
});

test('phone games cover the chat and a small puzzle fits the screen', async ({ app }) => {
    const account = await app.account({ phone: true });
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await expect(panel).toHaveCSS('position', 'fixed');
    const box = await panel.boundingBox();
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(393);

    await panel.locator('.neco-games-card[data-game="picross"]').click();
    // A phone starts on the smallest board, so the field simply fits.
    await expect(panel.locator('.neco-games-choice', { hasText: 'Small (5 by 5)' })).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.neco-games-start').click();
    await expect(panel.locator('.neco-games-picross-grid')).toBeVisible();

    const layout = await panel.evaluate(element => {
        const grid = element.querySelector('.neco-games-picross-grid');
        const cell = element.querySelector('.neco-games-picross-cell');
        const clue = element.querySelector('.neco-games-picross-row-clues');
        return {
            panelWidth: element.getBoundingClientRect().width,
            scrollWidth: element.scrollWidth,
            documentScroll: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            gridWidth: grid.getBoundingClientRect().width,
            cellWidth: cell.getBoundingClientRect().width,
            cellHeight: cell.getBoundingClientRect().height,
            clueWidth: clue.getBoundingClientRect().width,
        };
    });
    expect(layout.documentScroll).toBeLessThanOrEqual(layout.viewport);
    expect(layout.panelWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.panelWidth + 1);
    expect(layout.gridWidth + layout.clueWidth).toBeLessThanOrEqual(layout.panelWidth);

    await panel.locator('.neco-games-picross-cell[data-cell="6"]').tap();
    await expect(panel.locator('.neco-games-picross-cell[data-cell="6"]')).toHaveAttribute('data-value', '1');
    await expect.poll(async () => (await savedRecord(account))?.id).toBe('picross');

    // Measure controls on the active board, not the hidden setup screen.
    for (const selector of ['.neco-games-picross-tool', '.neco-games-again', '.neco-games-end']) {
        const target = panel.locator(selector).first();
        await expect(target).toBeVisible();
        const targetBox = await target.boundingBox();
        expect(targetBox.height, selector).toBeGreaterThanOrEqual(44);
    }
});

test('phone Connect Four drops discs and the board never scrolls sideways', async ({ app }) => {
    const account = await app.account({ phone: true });
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await panel.locator('.neco-games-card[data-game="connect-four"]').click();
    await panel.locator('.neco-games-start').click();

    await panel.locator('.neco-games-cf-column[data-column="6"]').tap();
    await expect(panel.locator('.neco-games-cf-cell[data-seat="r"]')).toHaveCount(1);
    await expect(panel.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(1, { timeout: 60000 });

    const layout = await panel.evaluate(element => ({
        scrollWidth: element.scrollWidth,
        width: element.getBoundingClientRect().width,
        documentScroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        columnWidth: element.querySelector('.neco-games-cf-column').getBoundingClientRect().width,
    }));
    expect(layout.documentScroll).toBeLessThanOrEqual(layout.viewport);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.columnWidth).toBeGreaterThanOrEqual(44);
});

test('switching branches keeps each board separate and ignores a late pal reply', async ({ app }) => {
    const account = await app.account();
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await panel.locator('.neco-games-card[data-game="connect-four"]').click();
    await panel.locator('.neco-games-start').click();
    await panel.locator('.neco-games-cf-column[data-column="0"]').click();
    await expect(panel.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(1, { timeout: 60000 });
    app.provider.mode.hold = palCalls(app)[0].model;
    await panel.locator('.neco-games-cf-column[data-column="1"]').click();
    await expect.poll(() => palCalls(app).length).toBe(2);
    await expect.poll(async () => (await account.branch('main'))?.games?.state.history).toEqual([0, 3, 1]);

    const branchId = await page.evaluate(async avatar => {
        const { createConversationBranchForAvatar } = await import('/scripts/neconyan-conversation/context.js');
        const { openConversationWorkspaceForAvatar } = await import('/scripts/neconyan-conversation/chrome.js');
        const branch = createConversationBranchForAvatar(avatar, 'Separate game');
        openConversationWorkspaceForAvatar(avatar, { branchId: branch.id, showToast: false });
        return branch.id;
    }, account.avatar);
    await expect(panel.locator('.neco-games-card[data-game="minesweeper"]')).toBeVisible();
    await panel.locator('.neco-games-card[data-game="minesweeper"]').click();
    await panel.locator('.neco-games-start').click();
    await expect.poll(async () => (await account.branch(branchId))?.games?.id).toBe('minesweeper');
    await app.release();
    await expect.poll(() => palCalls(app).every(call => call.completedAt !== null)).toBe(true);
    await expect(panel.locator('.neco-games-mines-grid')).toBeVisible();
    expect((await account.branch('main')).games.state.history).toEqual([0, 3, 1]);
    expect((await account.branch(branchId)).games.id).toBe('minesweeper');

    await page.evaluate(async avatar => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/neconyan-conversation/chrome.js');
        openConversationWorkspaceForAvatar(avatar, { branchId: 'main', showToast: false });
    }, account.avatar);
    await expect(panel.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(2, { timeout: 60000 });
    await expect.poll(async () => (await account.branch('main'))?.games?.state.history).toEqual([0, 3, 1, 3]);
    expect((await account.branch(branchId)).games.id).toBe('minesweeper');
});

test('a refreshed game deletion cancels a pending pal turn and a reset branch can save again', async ({ app }) => {
    const account = await app.account();
    app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: palReply(body) } }] });
    const page = await account.open();
    const panel = await openPanel(page);
    await panel.locator('.neco-games-card[data-game="connect-four"]').click();
    await panel.locator('.neco-games-start').click();
    await panel.locator('.neco-games-cf-column[data-column="0"]').click();
    await expect(panel.locator('.neco-games-cf-cell[data-seat="y"]')).toHaveCount(1, { timeout: 60000 });
    app.provider.mode.hold = palCalls(app)[0].model;
    await panel.locator('.neco-games-cf-column[data-column="1"]').click();
    await expect.poll(() => palCalls(app).length).toBe(2);
    await expect.poll(async () => (await account.branch('main'))?.games?.state.history).toEqual([0, 3, 1]);

    await account.changeStore(store => { delete store.characters[account.threadKey].branches.main.games; });
    await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).refreshConversationStore());
    await expect(panel.locator('.neco-games-card[data-game="minesweeper"]')).toBeVisible();
    await app.release();
    await expect.poll(() => palCalls(app).every(call => call.completedAt !== null)).toBe(true);
    expect((await account.branch('main')).games).toBeUndefined();

    await account.changeStore(store => { store.characters[account.threadKey].branches.main.lifetimeSeed = 'reset-empty-game-branch'; });
    await page.evaluate(async () => (await import('/scripts/neconyan-conversation/store-sync.js')).refreshConversationStore());
    await panel.locator('.neco-games-card[data-game="minesweeper"]').click();
    await panel.locator('.neco-games-start').click();
    await expect.poll(async () => (await account.branch('main'))?.games?.id).toBe('minesweeper');
});
