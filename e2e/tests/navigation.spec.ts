import { test, expect } from '../fixtures/server';
import { pickScopeIfPresent } from './helpers/scopePicker';

test.describe('Navigation', () => {
    test('hash routing: #/system-design loads L1 view', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('System Design');
        expect(page.url()).toContain('#/system-design');
    });

    test('breadcrumbs appear and update on navigation', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-nav-bar', { timeout: 10000 });
        // At least one breadcrumb item should be visible
        await expect(page.locator('.ca-breadcrumb-item').first()).toBeVisible();

        // Navigate to another layer — breadcrumb should update
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        const crumbs = await page.locator('.ca-breadcrumb-item').allTextContents();
        expect(crumbs.length).toBeGreaterThanOrEqual(1);
    });

    test('back button navigates to previous view', async ({ page, serverUrl }) => {
        // Start on system design
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('System Design');

        // Navigate within the SPA using the command bar L2 button (Feature Areas)
        const featureBtn = page.locator('.ca-command-bar-btn[aria-label="Feature Areas (L2)"]');
        await featureBtn.click();
        // #L2merge — backend L2a header badge is now "Feature APIs" (merged view).
        await expect(page.locator('.ca-header-badge')).toContainText('Feature APIs', { timeout: 10000 });

        // Click back button — should return to System Design
        const backBtn = page.locator('.ca-back-btn[aria-label="Go back"]');
        await expect(backBtn).toBeVisible();
        await backBtn.click();
        await expect(page.locator('.ca-header-badge')).toContainText('System Design', { timeout: 10000 });
    });

    test('home button returns to home page', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-nav-bar', { timeout: 10000 });

        // Click home button (⌂)
        await page.locator('.ca-back-btn[aria-label="Home"]').click();
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        await expect(page.locator('.ca-home')).toBeVisible();
    });

    test('hash updates when navigating between views', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        expect(page.url()).toContain('system-design');

        // Navigate to features
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        expect(page.url()).toContain('features');
    });

    test('clicking home page card navigates to diagram view', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        // Click "System Design" card — opens the repo/service scope picker
        // first (UX-50/63: the mock fixture has 2 services; #828).
        await page.getByText('System Design').first().click();
        await pickScopeIfPresent(page);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        // Should no longer show home page
        await expect(page.locator('.ca-home')).not.toBeVisible();
        await expect(page.locator('.ca-header-badge')).toBeVisible();
    });
});
