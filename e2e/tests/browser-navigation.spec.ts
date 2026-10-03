/**
 * browser-navigation.spec.ts — navigation invariants for the standalone
 * browser surface.
 *
 * 2026-05-30: rewritten to use the `fixtures/server` harness (mirrors
 * home.spec.ts / commands.spec.ts). The previous version bypassed the
 * fixture and pointed at a hardcoded `localhost:7742`, which made the
 * suite depend on a live VS Code session — the tests failed with
 * ERR_CONNECTION_REFUSED whenever the extension wasn't running. Assertions
 * also drifted from the mock handler (the API List card now sends
 * `codeatlas.openApiExplorer` and the mock routes it to the first
 * cluster's api-list; Feature Areas breadcrumb is "Feature Areas", not
 * "Feature Clusters").
 */
import { test, expect } from '../fixtures/server';
import { pickScopeIfPresent } from './helpers/scopePicker';

test.describe('CodeAtlas Browser Navigation', () => {
    test.beforeEach(async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-card-grid', { state: 'visible', timeout: 15000 });
    });

    test('API List card opens an api-list view', async ({ page }) => {
        await page.locator('.ca-card', { hasText: 'API List' }).click();

        // UX-50 (2026-06-06) — API List now opens the cluster scope
        // picker first. The mock features list has 3 clusters, so the
        // picker shows. Pick the first one (auth) and assert it routes
        // to `#/apis/cluster:auth`.
        const picker = page.locator('[data-testid="ca-scope-picker"]');
        await expect(picker).toBeVisible();
        await picker.locator('[data-testid="ca-scope-picker-item"]').first().click();

        await expect(page).toHaveURL(/#\/apis\//);
        await expect(page.locator('.ca-header-badge', { hasText: 'Feature Detail' })).toBeVisible();
    });

    test('Explorer Sidebar does not overlap Command Bar', async ({ page }) => {
        await page.locator('.ca-card', { hasText: 'System Design' }).click();
        await pickScopeIfPresent(page); // UX-50/63 scope step (#828)

        const explorerBtn = page.locator('.ca-command-bar-btn', { hasText: '☰' });
        await explorerBtn.click();

        const sidebar = page.locator('.ca-explorer-sidebar');
        await expect(sidebar).toBeVisible();
        await expect(explorerBtn).toBeVisible();
        await expect(explorerBtn).toBeEnabled();

        await explorerBtn.click();
        await expect(sidebar).not.toBeVisible();
    });

    test('Breadcrumb backtracking does not infinitely append', async ({ page }) => {
        // System Design → drills into a sequence (via the explorer sidebar)
        // → click back to System Design breadcrumb → assert the stack
        // truncates rather than appending a 3rd entry.
        await page.locator('.ca-card', { hasText: 'System Design' }).click();
        await pickScopeIfPresent(page); // UX-50/63 scope step (#828)
        await expect(page.locator('.ca-breadcrumb-item').last()).toContainText('System Design');

        await page.locator('.ca-command-bar-btn', { hasText: '☰' }).click();
        // The APIs section starts collapsed; click to expand. Then pick an
        // item *inside that section's listbox* — `.ca-explorer-item` alone
        // would also match the Services / Feature Areas items above.
        const apisSection = page.locator('.ca-explorer-section', { has: page.locator('.ca-explorer-section-header', { hasText: 'APIs' }) });
        await apisSection.locator('.ca-explorer-section-header').click();
        const firstApiItem = apisSection.locator('.ca-explorer-item').first();
        if (!(await firstApiItem.isVisible())) test.skip();

        await firstApiItem.click();
        await expect(page.locator('.ca-breadcrumb-item')).toHaveCount(2);

        // Click the first breadcrumb to navigate back to System Design.
        await page.locator('.ca-breadcrumb-item').first().click();
        await expect(page.locator('.ca-breadcrumb-item')).toHaveCount(1);
        await expect(page.locator('.ca-breadcrumb-item').last()).toContainText('System Design');
    });

    test('Home button clears breadcrumb stack', async ({ page }) => {
        await page.locator('.ca-card', { hasText: 'System Design' }).click();
        await pickScopeIfPresent(page); // UX-50/63 scope step (#828)
        await expect(page.locator('.ca-breadcrumb-item').first()).toBeVisible();

        await page.locator('button[title="Home"]').click();
        await expect(page.locator('.ca-card-grid').first()).toBeVisible();

        // Navigate to a *different* layer via its stable route. (9.1.49) The
        // 'Feature Areas' HOME card was removed — Feature Areas (L2) is now
        // reached by drilling from L1 / navigating to the layer's route
        // (#/features → the mock returns label 'Feature Areas'). A fresh
        // navigation after the Home reset must produce a SINGLE breadcrumb,
        // which is exactly what this test guards.
        await page.goto(`${page.url().split('#')[0]}#/features`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });

        await expect(page.locator('.ca-breadcrumb-item')).toHaveCount(1);
        await expect(page.locator('.ca-breadcrumb-item')).toContainText('Feature Areas');
    });
});
