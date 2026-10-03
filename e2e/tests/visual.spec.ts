import { test, expect } from '../fixtures/server';

const LAYERS = [
    { hash: '#/home', name: 'home', waitFor: '.ca-home' },
    { hash: '#/system-design', name: 'system-design', waitFor: '.ca-header-badge' },
    { hash: '#/features', name: 'features', waitFor: '.ca-header-badge' },
    { hash: '#/apis/cluster:auth', name: 'api-list', waitFor: '.ca-api-list' },
    { hash: '#/sequence/src/auth/login.ts:loginHandler', name: 'sequence', waitFor: '.react-flow' },
    { hash: '#/file/src/auth/login.ts', name: 'file', waitFor: '.react-flow' },
    { hash: '#/flow/src/auth/login.ts/loginHandler', name: 'flow', waitFor: '.react-flow' },
    { hash: '#/health', name: 'health', waitFor: 'text=Code Health Report' },
];

test.describe('Visual Screenshots — Dark Theme', () => {
    for (const layer of LAYERS) {
        test(`screenshot: ${layer.name} (dark)`, async ({ page, serverUrl }) => {
            await page.goto(`${serverUrl}${layer.hash}`);
            if (layer.waitFor.startsWith('text=')) {
                await page.waitForSelector(`:has-text("${layer.waitFor.slice(5)}")`, { timeout: 10000 });
            } else {
                await page.waitForSelector(layer.waitFor, { timeout: 10000 });
            }
            // Wait for React Flow animations to settle
            await page.waitForTimeout(1500);

            // Verify page is not blank
            const bodyText = await page.locator('body').innerText();
            expect(bodyText.length).toBeGreaterThan(10);

            await page.screenshot({
                path: `e2e/screenshots/${layer.name}-dark.png`,
                fullPage: true,
            });
        });
    }
});

test.describe('Visual Screenshots — Light Theme', () => {
    for (const layer of LAYERS) {
        test(`screenshot: ${layer.name} (light)`, async ({ page, serverUrl }) => {
            await page.goto(`${serverUrl}${layer.hash}`);
            if (layer.waitFor.startsWith('text=')) {
                await page.waitForSelector(`:has-text("${layer.waitFor.slice(5)}")`, { timeout: 10000 });
            } else {
                await page.waitForSelector(layer.waitFor, { timeout: 10000 });
            }

            // Switch to light theme
            if (layer.name === 'home') {
                // Home page: click the Light Mode card
                await page.getByText('Light Mode').click();
            } else {
                // Diagram views: use the command bar theme toggle button
                // The theme button shows ☀ for "switch to light" and ☾ for "switch to dark"
                const themeBtn = page.locator('.ca-command-bar-btn').filter({ hasText: '☀' });
                if (await themeBtn.isVisible()) {
                    await themeBtn.click();
                } else {
                    // Fallback: try any theme button
                    const altBtn = page.locator('.ca-command-bar-btn').filter({ hasText: '☾' });
                    if (await altBtn.isVisible()) {
                        await altBtn.click();
                    }
                }
            }

            // Wait for theme to apply
            await page.waitForFunction(
                () => document.documentElement.dataset.theme === 'light',
                {}, { timeout: 5000 },
            ).catch(() => {
                // Theme may not change if toggle fails — still take screenshot
            });
            await page.waitForTimeout(1000);

            // Verify page is not blank
            const bodyText = await page.locator('body').innerText();
            expect(bodyText.length).toBeGreaterThan(10);

            await page.screenshot({
                path: `e2e/screenshots/${layer.name}-light.png`,
                fullPage: true,
            });
        });
    }
});

test.describe('Visual Screenshots — Modals & Overlays', () => {
    test('screenshot: commit picker modal', async ({ page, serverUrl }) => {
        // (9.1.49) 'Compare Commits' HOME card removed — the commit picker is
        // now opened from the in-diagram nav-bar (.ca-git-diff-btn), which
        // dispatches the identical `requestGitDiff` message.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-nav-bar', { timeout: 10000 });
        await page.locator('.ca-git-diff-btn').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: 'e2e/screenshots/modal-commit-picker-full.png' });
    });

    test('screenshot: branch picker modal', async ({ page, serverUrl }) => {
        // (9.1.49) 'Branch Diff' HOME card removed — the branch picker is now
        // opened from the in-diagram CommandBar toolbar's "Branch Diff" button,
        // which dispatches the identical `requestBranchDiff` message.
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });
        await page.locator('.ca-command-bar-btn[aria-label="Branch Diff"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: 'e2e/screenshots/modal-branch-picker.png' });
    });

    test('screenshot: search picker modal', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        await page.getByText('Search').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: 'e2e/screenshots/modal-search-picker-full.png' });
    });

    test('screenshot: explorer sidebar open', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-command-bar', { timeout: 10000 });
        await page.locator('.ca-command-bar-btn[aria-label="Explorer"]').click();
        await page.waitForSelector('.ca-explorer-sidebar', { timeout: 5000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: 'e2e/screenshots/explorer-sidebar-full.png' });
    });
});
