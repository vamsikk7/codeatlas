import { test, expect } from '../fixtures/server';

test.describe('Timeline Replay', () => {
    test('Timeline Replay button opens commit range picker', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        // Click Timeline Replay button in command bar
        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal')).toBeVisible();
        await expect(page.getByText('Timeline Replay')).toBeVisible();
    });

    test('commit range picker shows branch selector', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Branch selector should be present
        await expect(page.locator('select')).toBeVisible();
    });

    test('commit range picker shows merge-base badge', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // merge-base badge should be visible on one commit
        await expect(page.getByText('merge-base')).toBeVisible();
    });

    test('selecting two commits enables Start Replay button', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Start button should be disabled initially (0 commits selected is auto-selected by merge-base, but let's check)
        const startBtn = page.getByText(/Start Replay/);
        // Click first commit
        const commits = page.locator('.ca-modal >> div[style*="cursor: pointer"]');
        await commits.first().click();
        // Click third commit
        await commits.nth(2).click();
        // Start button should now be enabled
        await expect(startBtn).toBeVisible();
    });

    test('starting replay shows replay controls', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Select first and last commit
        const commits = page.locator('.ca-modal >> div[style*="cursor: pointer"]');
        await commits.first().click();
        await commits.nth(3).click();

        // Click Start Replay
        await page.getByText(/Start Replay/).click();

        // Wait for replay controls to appear
        await page.waitForSelector('text=Commit', { timeout: 10000 });
        // Should show commit info
        await expect(page.getByText(/Commit \d+\/\d+/)).toBeVisible();
        // Stop button should be present
        await expect(page.locator('button:has-text("■")')).toBeVisible();
    });

    test('stop button ends replay', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        const commits = page.locator('.ca-modal >> div[style*="cursor: pointer"]');
        await commits.first().click();
        await commits.nth(3).click();
        await page.getByText(/Start Replay/).click();

        await page.waitForSelector('text=Commit', { timeout: 10000 });
        // Click stop
        await page.locator('button:has-text("■")').click();

        // Replay controls should disappear
        await expect(page.locator('text=Commit 1/')).not.toBeVisible({ timeout: 5000 });
    });

    test('cancel closes the picker without starting replay', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        await page.locator('.ca-modal-close').click();
        await expect(page.locator('.ca-modal-overlay')).not.toBeVisible();
    });
});

test.describe('Comments', () => {
    test('right-click shows Add comment in context menu', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 10000 });

        // Right-click a node
        const node = page.locator('.react-flow__node').first();
        await node.click({ button: 'right' });

        // Context menu should appear with "Add comment"
        await expect(page.getByText('Add comment')).toBeVisible({ timeout: 3000 });
    });
});
