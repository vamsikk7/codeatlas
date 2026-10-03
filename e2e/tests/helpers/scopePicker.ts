/**
 * helpers/scopePicker.ts — #828 (2026-06-10).
 *
 * UX-50/UX-63: home-page cards open a repo/service ScopePicker first when
 * the workspace has ≥2 scopes. The e2e mock fixture advertises TWO
 * services (backend / frontend), so every diff/replay/L1 card click now
 * goes through the picker before the underlying flow (PR picker, branch
 * picker, replay, direct navigation) proceeds.
 *
 * `pickScopeIfPresent` clicks the first scope item when the picker
 * appears and waits for it to close, so specs written for the pre-UX-63
 * single-step flow can opt into the new step with one line. Returns true
 * when a picker was dismissed, false when none appeared (single-scope
 * direct dispatch).
 */
import type { Page } from '@playwright/test';

export async function pickScopeIfPresent(page: Page, timeout = 4000): Promise<boolean> {
    const picker = page.locator('[data-testid="ca-scope-picker"]');
    try {
        await picker.waitFor({ state: 'visible', timeout });
    } catch {
        return false;
    }
    await picker.locator('[data-testid="ca-scope-picker-item"]').first().click();
    await picker.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => { /* already gone */ });
    return true;
}
