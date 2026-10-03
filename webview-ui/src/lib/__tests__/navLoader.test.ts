import { describe, it, expect } from 'vitest';
import { shouldShowNavLoader, isReplayActive } from '../navLoader';

/**
 * UX-PAGE-LOADER (2026-07-21) — a transition loader between click and the next
 * layer's render, EXCLUDED during replay playback.
 */
describe('navLoader', () => {
    describe('isReplayActive', () => {
        it('is false when neither replay is active', () => {
            expect(isReplayActive(null, null)).toBe(false);
        });
        it('is true when the function-replay HUD is active', () => {
            expect(isReplayActive({ index: 0, total: 3 }, null)).toBe(true);
        });
        it('is true when the commit-timeline replay is active', () => {
            expect(isReplayActive(null, { step: null })).toBe(true);
        });
    });

    describe('shouldShowNavLoader', () => {
        it('shows the loader for a pending manual navigation', () => {
            expect(shouldShowNavLoader(true, false)).toBe(true);
        });
        it('hides the loader when nothing is pending', () => {
            expect(shouldShowNavLoader(false, false)).toBe(false);
        });
        it('NEVER shows the loader during replay, even if a nav is pending', () => {
            expect(shouldShowNavLoader(true, true)).toBe(false);
        });
    });
});
