import { test, expect } from '../fixtures/server';

/**
 * First-install regression guard.
 *
 * On a fresh workspace, System Design used to auto-enter the "Baseline →
 * Working" git-diff mode on load (`surfaceLiveWorkingDiff`, which existed only
 * to surface the now-removed in-diagram AI Review button). That dropped the
 * user straight into the diff view, whose toolbar (Replay / ✕ Reset) blocked
 * the normal diagram cascade until they manually hit Reset — a broken
 * first-run experience.
 *
 * First open must be INTERACTIVE:
 *   - the opt-in "Compare Commits" control is shown, NOT the git-diff
 *     sub-toolbar (Replay / ✕ Reset);
 *   - there is NO in-diagram AI Review UI (toggle, overlay, per-node markers,
 *     or an "Ask AI" command) — AI review lives only on the home Code Review card.
 */
test.describe('First install — System Design opens interactive (no forced diff mode)', () => {
    test('does NOT auto-enter Baseline→Working git-diff mode', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });
        await expect(page.locator('.ca-header-badge')).toContainText('System Design');

        // The blocking git-diff sub-toolbar must be absent on first open…
        await expect(page.locator('.ca-git-diff-clear')).toHaveCount(0);   // no ✕ Reset
        await expect(page.locator('.ca-git-diff-replay')).toHaveCount(0);  // no diff-mode Replay
        // …and the opt-in entry point (Compare Commits) is what's shown instead.
        await expect(page.locator('.ca-git-diff-btn')).toBeVisible();
    });

    test('has NO in-diagram AI Review controls (moved to the home Code Review card)', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.ca-header-badge', { timeout: 10000 });

        await expect(page.locator('.ca-ai-review-btn')).toHaveCount(0);              // no diagram toggle
        await expect(page.locator('.ca-ai-review-status')).toHaveCount(0);           // no diagram overlay
        await expect(page.locator('[data-testid="ai-review-marker"]')).toHaveCount(0); // no per-node markers
        await expect(page.getByRole('button', { name: /^Ask AI/ })).toHaveCount(0);   // no Ask AI command
    });
});
