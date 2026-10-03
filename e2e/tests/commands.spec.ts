import { test, expect } from '../fixtures/server';
import { pickScopeIfPresent } from './helpers/scopePicker';

test.describe('Commands & Interactions', () => {
    test('theme toggle switches between dark and light', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        // Initially dark (no data-theme or empty)
        const initial = await page.locator('html').getAttribute('data-theme');
        expect(!initial || initial === '').toBeTruthy();

        // Click Light Mode card
        await page.getByText('Light Mode').click();
        await page.waitForFunction(() =>
            document.documentElement.dataset.theme === 'light',
            {}, { timeout: 5000 },
        );
        expect(await page.locator('html').getAttribute('data-theme')).toBe('light');

        // Toggle back to dark
        await page.getByText('Dark Mode').click();
        await page.waitForFunction(() =>
            document.documentElement.dataset.theme !== 'light',
            {}, { timeout: 5000 },
        );
    });

    test('Compare Commits opens commit picker modal', async ({ page, serverUrl }) => {
        // (9.1.49) The 'Compare Commits' HOME card was removed — the flow is
        // now reached from the in-diagram nav-bar (.ca-git-diff-btn) /
        // CommandBar, both of which dispatch the identical `requestGitDiff`
        // message → showCommitPicker. Open a diagram, then click the nav-bar
        // Compare Commits button.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-nav-bar', { timeout: 10000 });

        await page.locator('.ca-git-diff-btn').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal')).toBeVisible();
        // Commit picker should show commit list
        await expect(page.locator('.ca-modal-list-item').first()).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/modal-commit-picker.png' });

        // Close with X button
        await page.locator('.ca-modal-close').first().click();
        await expect(page.locator('.ca-modal-overlay')).not.toBeVisible();
    });

    test('Branch Diff opens branch picker modal', async ({ page, serverUrl }) => {
        // (9.1.49) The 'Branch Diff' HOME card was removed — the flow is now
        // reached from the in-diagram CommandBar toolbar, whose "Branch Diff"
        // button dispatches the identical `requestBranchDiff` message →
        // showBranchPicker. Open a diagram, then click the CommandBar button.
        // The CommandBar dispatches directly (no repo scope-picker step).
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[aria-label="Branch Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal')).toBeVisible();
        await expect(page.locator('.ca-modal-header h3')).toContainText('Branch Diff');
        // Should show branch items
        await expect(page.locator('.ca-modal-list-item').first()).toBeVisible();
    });

    test('CommandBar is visible on diagram views', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });
        await expect(page.locator('.ca-command-bar')).toBeVisible();
        // Should have multiple toolbar buttons
        const btnCount = await page.locator('.ca-command-bar-btn').count();
        expect(btnCount).toBeGreaterThanOrEqual(8);
    });

    test('Compare Commits button in nav bar opens commit picker', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-nav-bar', { timeout: 10000 });

        await page.locator('.ca-git-diff-btn').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal')).toBeVisible();
    });

    test('"/" key focuses API list search input', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/apis/cluster:auth`);
        await page.waitForSelector('.ca-api-list', { timeout: 10000 });

        // Press "/" key
        await page.keyboard.press('/');
        const searchInput = page.locator('.ca-api-search');
        await expect(searchInput).toBeFocused();
    });

    test('toast notification appears on Re-sync', async ({ page, serverUrl }) => {
        // Toast only renders on diagram views, not home — navigate to a diagram first
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Click Re-sync button in command bar (🔄)
        const syncBtn = page.locator('.ca-command-bar-btn[aria-label="Re-sync"]');
        await syncBtn.click();
        await page.waitForSelector('.ca-home-toast', { timeout: 5000 });
        await expect(page.locator('.ca-home-toast')).toBeVisible();
        await expect(page.locator('.ca-home-toast')).toContainText('Re-sync complete');
    });

    test('explorer sidebar toggles open and closed', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Open explorer via command bar button (☰ is first button)
        const toggleBtn = page.locator('.ca-command-bar-btn[aria-label="Explorer"]');
        await toggleBtn.click();
        await expect(page.locator('.ca-explorer-sidebar')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/explorer-sidebar.png' });

        // Close explorer
        await page.locator('.ca-explorer-close').click();
        await expect(page.locator('.ca-explorer-sidebar')).not.toBeVisible();
    });

    test('search picker opens and shows items', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        await page.getByText('Search').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal-header h3')).toContainText('Search');
        // Search items from test data (4 items)
        const items = page.locator('.ca-modal-list-item');
        await expect(items.first()).toBeVisible();
        const count = await items.count();
        expect(count).toBeGreaterThanOrEqual(3);
        await page.screenshot({ path: 'e2e/screenshots/modal-search-picker.png' });
    });

    test('Health Report opens from home page Tools section', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        // Health Report should be in the Tools section, not Diagrams
        const toolsSection = page.locator('.ca-section-label').filter({ hasText: /tools/i });
        await expect(toolsSection).toBeVisible();

        // Click Health Report card
        await page.getByText('Health Report').click();
        // Should navigate to health dashboard
        await page.waitForSelector('text=Code Health Report', { timeout: 10000 });
        await expect(page.getByText('Code Health Report')).toBeVisible();
        await expect(page.getByText('Cyclic Dependencies')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/health-from-home.png' });
    });

    test('PR Diff opens PR picker with list of open PRs', async ({ page, serverUrl }) => {
        // (9.1.49) 'PR Diff' HOME card removed — reached from the in-diagram
        // CommandBar toolbar (identical `runCommand codeatlas.openPrDiff` →
        // showPrPicker). Open a diagram, then click the CommandBar button.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await expect(page.locator('.ca-modal-header h3')).toContainText('PR Diff');
        // Should show PR list items with numbers and titles
        const items = page.locator('.ca-modal-list-item');
        await expect(items.first()).toBeVisible();
        const count = await items.count();
        expect(count).toBe(3);
        // First PR should show #142
        await expect(items.first()).toContainText('#142');
        await expect(items.first()).toContainText('fix: login validation');
        await expect(items.first()).toContainText('alice');
        await page.screenshot({ path: 'e2e/screenshots/modal-pr-picker.png' });
    });

    test('PR picker search filters PR list', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Type to filter
        const searchInput = page.locator('.ca-modal-search');
        await searchInput.fill('payment');
        // Only the payments PR should remain
        const items = page.locator('.ca-modal-list-item');
        await expect(items).toHaveCount(1);
        await expect(items.first()).toContainText('payment');
    });

    test('PR picker manual mode toggle works', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Click "Enter PR number manually"
        await page.getByText('Enter PR number manually').click();
        // Should show the number input
        await expect(page.locator('.ca-modal-input')).toBeVisible();
        // "Back to list" should be visible
        await expect(page.getByText('Back to list')).toBeVisible();
    });

    test('PR selection shows progress then diff badge with PR number', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });

        // Click first PR (#142)
        await page.locator('.ca-modal-list-item').first().click();

        // Should navigate away from home and eventually show diff badge
        await page.waitForSelector('.ca-git-diff-badge', { timeout: 10000 });
        const badge = page.locator('.ca-git-diff-badge');
        await expect(badge).toContainText('PR #142');
        // Reset button should also be visible
        await expect(page.locator('.ca-git-diff-clear')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/pr-diff-badge.png' });
    });

    test('PR diff reset clears the diff badge', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Trigger PR selection
        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.locator('.ca-modal-list-item').first().click();
        await page.waitForSelector('.ca-git-diff-badge', { timeout: 10000 });

        // Click reset
        await page.locator('.ca-git-diff-clear').click();
        // Badge should disappear, Compare Commits button should reappear
        await expect(page.locator('.ca-git-diff-badge')).not.toBeVisible();
        await expect(page.locator('.ca-git-diff-btn')).toBeVisible();
    });

    test('Replay button appears on diff badge and clicking it shows replay controls', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Trigger PR diff to get a diff badge
        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.locator('.ca-modal-list-item').first().click();
        await page.waitForSelector('.ca-git-diff-badge', { timeout: 10000 });

        // Replay button should be visible next to the badge
        const replayBtn = page.locator('.ca-git-diff-replay');
        await expect(replayBtn).toBeVisible();
        await expect(replayBtn).toContainText('Replay');

        // Click replay — should show replay controls
        await replayBtn.click();
        await page.waitForSelector('[title="Previous step"]', { timeout: 5000 });
        await expect(page.locator('[title="Next step"]')).toBeVisible();
        await expect(page.locator('[title="Stop replay"]')).toBeVisible();
    });

    test('Replay controls show step counter and commit info', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Trigger PR diff then replay
        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.locator('.ca-modal-list-item').first().click();
        await page.waitForSelector('.ca-git-diff-badge', { timeout: 10000 });
        await page.locator('.ca-git-diff-replay').click();

        // Wait for step info to appear
        await page.waitForFunction(
            () => document.body.textContent?.includes('Step'),
            {}, { timeout: 8000 },
        );

        // Step counter and layer info should be visible
        const bodyText = await page.locator('body').textContent();
        expect(bodyText).toContain('Step');
        expect(bodyText).toMatch(/L[1-5]/); // layer indicator
    });

    test('Replay stop clears replay controls', async ({ page, serverUrl }) => {
        // (9.1.49) PR Diff reached from the in-diagram CommandBar toolbar.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });

        // Trigger PR diff then replay
        await page.locator('.ca-command-bar-btn[aria-label="PR Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.locator('.ca-modal-list-item').first().click();
        await page.waitForSelector('.ca-git-diff-badge', { timeout: 10000 });

        // Wait for replay button to be stable, then click
        const replayBtn = page.locator('.ca-git-diff-replay');
        await expect(replayBtn).toBeVisible({ timeout: 3000 });
        await replayBtn.click();
        await page.waitForSelector('[title="Stop replay"]', { timeout: 8000 });

        // Click stop
        await page.locator('[title="Stop replay"]').click();

        // Replay controls should disappear
        await expect(page.locator('[title="Stop replay"]')).not.toBeVisible({ timeout: 3000 });
    });

    test('HomePage has Replay Working Changes card', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        await expect(page.getByText('Replay Working Changes')).toBeVisible();
    });

    test('HomePage has Replay PR and Replay Branch cards', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        await expect(page.getByText('Replay PR')).toBeVisible();
        await expect(page.getByText('Replay Branch')).toBeVisible();
    });

    test('Replay Working Changes shows replay controls', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        // Wait for "Connected to CodeAtlas server" status — until the WS
        // bridge is up, postMessage payloads are dropped and the click below
        // has no effect. The status string was renamed from "Connected to
        // VS Code" during the browser-first shift (ADR-031..033).
        await expect(page.getByText('Connected to CodeAtlas server')).toBeVisible({ timeout: 10000 });

        // The home → replayWorkingDiff path is occasionally racy: if the WS
        // briefly drops between connection-up and the click landing, the
        // postMessage is dropped before the bridge sees it. Retry the click
        // up to 3× until the replay controls appear, falling back through
        // Playwright's `expect.toPass` retry budget.
        await expect(async () => {
            // Re-click in case the previous click was lost.
            const btn = page.getByText('Replay Working Changes');
            await btn.click({ timeout: 5000 });
            // UX-63 repo scope step (#828) — short timeout inside the retry loop.
            await pickScopeIfPresent(page, 2000);
            // Stop replay button = entered replay mode.
            await expect(page.locator('[title="Stop replay"]')).toBeVisible({ timeout: 6000 });
        }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] });

        await expect(page.locator('[title="Previous step"]')).toBeVisible();
        await expect(page.locator('[title="Next step"]')).toBeVisible();
    });
});
