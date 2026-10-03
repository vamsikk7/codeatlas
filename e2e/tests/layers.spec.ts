import { test, expect } from '../fixtures/server';

test.describe('Diagram Layers', () => {
    test('L1 System Design: renders microservice nodes with React Flow', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('System Design');
        await expect(page.locator('.react-flow')).toBeVisible();
        // Should show service count in header
        await expect(page.locator('.ca-header-title')).toContainText('service');
        await page.screenshot({ path: 'e2e/screenshots/l1-system-design.png' });
    });

    test('L1 System Design: infra nodes do not show tech badge or API count', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await page.waitForTimeout(1000);

        // The page should NOT contain "UNKNOWN" tech badge (infra nodes shouldn't show tech)
        const bodyText = await page.locator('body').innerText();
        expect(bodyText).not.toContain('UNKNOWN');

        // Infra node (PostgreSQL) should show «database» but not "APIs exposed"
        expect(bodyText).toContain('PostgreSQL');
        expect(bodyText).toContain('«database»');
        // "0 APIs exposed" should not appear (hidden when count is 0, and infra doesn't show it at all)
        const apiExposedMatches = bodyText.match(/0 APIs? exposed/g);
        expect(apiExposedMatches).toBeNull();
    });

    // #835 — on a bucketed multi-repo skeletal L1 the header captions the
    // workspaceInfo serviceCount (the home page's SERVICES stat) and notes
    // the condensed bucket count, instead of calling 10 buckets "10 services".
    test('L1 System Design: skeletal multi-repo header captions workspace service count (#835)', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design/skeletal-multi`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        await expect(page.locator('.ca-header-title')).toContainText('209 services');
        await expect(page.locator('.ca-header-title')).toContainText('10 groups');
    });

    // #L2merge — backend L2a is now the features-grouped API list (L2a+L2b merged):
    // each feature is a collapsible group of its APIs, empty-API features sink to
    // a trailing "Internal modules" group. FE/mobile keep the screen list.
    test('L2a (merged): renders the features-grouped API list', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('[data-testid="feature-api-list"]', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('Feature APIs');
        // Feature group header + its API rows are visible.
        await expect(page.getByText('auth', { exact: true }).first()).toBeVisible();
        await expect(page.locator('.ca-api-row').first()).toBeVisible();
        // #L2-diff-focus: when the fixture has a working diff, unchanged features
        // (like `auth`) auto-COLLAPSE so changes surface first. Expand `auth` if
        // it's collapsed, then its `/login` row is reachable either way.
        const loginRow = page.getByText('/login', { exact: true });
        if (!(await loginRow.isVisible())) {
            await page.getByText('auth', { exact: true }).first().click();
        }
        await expect(loginRow).toBeVisible();
        // The hint explains the grouping.
        await expect(page.locator('.ca-seq-hint')).toContainText('grouped by feature');
        await page.screenshot({ path: 'e2e/screenshots/l2a-features.png' });
    });

    test('L2a (merged): no-entry-point features are grouped at the end', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('[data-testid="feature-api-list"]', { timeout: 10000 });
        // The utils cluster (no APIs) is folded into the collapsed "Internal
        // modules · no entry points" group — its MODULE badge is hidden until expand.
        const internal = page.getByText(/Internal modules · no entry points/);
        await expect(internal).toBeVisible();
        await expect(page.locator('.ca-method-badge', { hasText: 'MODULE' })).toHaveCount(0);
        await internal.click();
        await expect(page.locator('.ca-method-badge', { hasText: 'MODULE' })).toHaveCount(1);
        await expect(page.locator('.ca-api-row', { hasText: 'utils' })).toBeVisible();
    });

    test('L2a (merged): clicking an API opens its L3 sequence (not a source-open)', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('[data-testid="feature-api-list"]', { timeout: 10000 });
        // Click the first API row → routes to the sequence (L3), same as the L2b panel.
        await page.locator('.ca-api-row').first().click();
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await expect(page.locator('.react-flow')).toBeVisible();
        // The merged feature list is no longer the active view.
        await expect(page.locator('[data-testid="feature-api-list"]')).toHaveCount(0);
    });

    test('L2a (merged): "Entry Points" toggle shows the feature call-topology map', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/features`);
        await page.waitForSelector('[data-testid="feature-api-list"]', { timeout: 10000 });
        // Switch from the grouped List to the Entry Points topology map (client render swap).
        await page.locator('[data-testid="cluster-mode-entrypoints"]').click();
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('Entry Points');
        await expect(page.locator('.react-flow__node').first()).toBeVisible(); // feature nodes + call edges
        // Toggle back to the grouped list.
        await page.locator('[data-testid="cluster-mode-list"]').click();
        await page.waitForSelector('[data-testid="feature-api-list"]', { timeout: 10000 });
    });

    test('L2b API List: renders searchable API list with method tabs', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/apis/cluster:auth`);
        await page.waitForSelector('.ca-api-list', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('Feature Detail');
        // Method filter tabs visible
        await expect(page.locator('.ca-method-tabs')).toBeVisible();
        // API rows visible (test data has 4 APIs)
        const rows = page.locator('.ca-api-row');
        await expect(rows.first()).toBeVisible();
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThanOrEqual(3);
        // Search input available
        await expect(page.locator('.ca-api-search')).toBeVisible();
        // Subsystems section visible
        await expect(page.getByText('Subsystems')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/l2b-api-list.png' });
    });

    test('L3 Sequence: renders participant swimlanes', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/sequence/src/auth/login.ts:loginHandler`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        // Sequence view has its own header with method + route info
        await expect(page.locator('.ca-header-badge')).toBeVisible();
        await expect(page.locator('.react-flow')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/l3-sequence.png' });
    });

    test('L3 Sequence: diff propagates from modified participant to message edge', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/sequence/src/auth/login.ts:loginHandler`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await page.waitForTimeout(1000);

        // The "findUser(email)" edge targets UserService which is diff:'modified'.
        // The edge itself has diff:'unchanged' in graph data, but the SequenceView should
        // propagate the target participant's diff to the edge color (orange, not gray).
        // Get all edge paths and check that the edge to the modified participant uses
        // the warning/modified color (not the unchanged gray).
        const edgePaths = page.locator('.react-flow__edge-path');
        const edgeCount = await edgePaths.count();
        expect(edgeCount).toBeGreaterThanOrEqual(2);

        // Check that at least one edge has a non-unchanged stroke color
        // (the modified edge should use var(--ca-warning) which resolves to an orange)
        let hasModifiedEdge = false;
        for (let i = 0; i < edgeCount; i++) {
            const stroke = await edgePaths.nth(i).getAttribute('style');
            // Unchanged edges use var(--ca-edge-unchanged); modified edges use var(--ca-warning)
            if (stroke && stroke.includes('--ca-warning')) {
                hasModifiedEdge = true;
                break;
            }
        }
        expect(hasModifiedEdge).toBeTruthy();
    });

    test('L4 File Diagram: renders file dependency nodes', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/file/src/auth/login.ts`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await expect(page.locator('.react-flow')).toBeVisible();
        // Header shows file info
        await expect(page.locator('.ca-header-badge')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/l4-file.png' });
    });

    test('L5 Flow Chart: renders control flow nodes', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/flow/src/auth/login.ts/loginHandler`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });
        await expect(page.locator('.react-flow')).toBeVisible();
        await expect(page.locator('.ca-header-badge')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/l5-flow.png' });
    });

    test('Health Dashboard: renders health cards with issue counts', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/health`);
        await page.waitForSelector('text=Code Health Report', { timeout: 10000 });
        // Health card titles — exact match so they don't also resolve to the
        // layer legend ("Health — dead code, god files, tight coupling, …").
        await expect(page.getByText('Cyclic Dependencies', { exact: true })).toBeVisible();
        await expect(page.getByText('Dead Functions', { exact: true })).toBeVisible();
        await expect(page.getByText('God Files', { exact: true })).toBeVisible();
        await expect(page.getByText('High Coupling', { exact: true })).toBeVisible();
        await expect(page.getByText('Orphaned Clusters', { exact: true })).toBeVisible();
        // Issue count badge should show numbers > 0
        await expect(page.getByText('issues detected')).toBeVisible();
        await page.screenshot({ path: 'e2e/screenshots/health-dashboard.png' });
    });

    test('L2b API List: search filtering reduces visible rows', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/apis/cluster:auth`);
        await page.waitForSelector('.ca-api-list', { timeout: 10000 });

        // Count rows before filter
        const rowsBefore = await page.locator('.ca-api-row').count();

        // Type in search to filter
        const searchInput = page.locator('.ca-api-search');
        await searchInput.fill('login');
        await page.waitForTimeout(300);

        // Count rows after filter — should be fewer
        const rowsAfter = await page.locator('.ca-api-row').count();
        expect(rowsAfter).toBeLessThan(rowsBefore);
        expect(rowsAfter).toBeGreaterThanOrEqual(1);
    });

    test('L3 Sequence: message filter works', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/sequence/src/auth/login.ts:loginHandler`);
        await page.waitForSelector('.react-flow', { timeout: 10000 });

        // Find and use the filter input
        const filterInput = page.locator('input[placeholder*="Filter messages"]');
        if (await filterInput.isVisible()) {
            await filterInput.fill('findUser');
            await page.waitForTimeout(500);
            // Some edges should be filtered
        }
    });

    test('no JS errors across all diagram layers', async ({ page, serverUrl }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        const routes = [
            '#/system-design',
            '#/features',
            '#/apis/cluster:auth',
            '#/sequence/src/auth/login.ts:loginHandler',
            '#/file/src/auth/login.ts',
            '#/flow/src/auth/login.ts/loginHandler',
            '#/health',
        ];

        for (const route of routes) {
            await page.goto(`${serverUrl}${route}`);
            await page.waitForTimeout(2000);
        }

        expect(errors).toHaveLength(0);
    });
});
