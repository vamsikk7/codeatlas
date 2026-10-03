/**
 * UX-67 (2026-06-09) — `PerRepoDebouncer`
 *
 * After every per-repo file save, the WorkspaceWatcher needs to re-emit
 * that sub-repo's `RepoSummary` so `cross_repo_http_edges` and friends
 * stay current. A burst of 5 saves in the same sub-repo (e.g. find/
 * replace across files) should produce ONE summary emission, not five —
 * this is the debouncer.
 *
 * Per-repo keying: simultaneous saves in service-a and service-b each
 * get their own pending timer, fire independently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerRepoDebouncer } from '../perRepoDebouncer';

describe('PerRepoDebouncer', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    describe('basic fire', () => {
        it('fires the callback once after the delay', () => {
            const fn = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-a', fn);
            expect(fn).not.toHaveBeenCalled();
            vi.advanceTimersByTime(499);
            expect(fn).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('passes the repo id to the callback', () => {
            const fn = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-x', fn);
            vi.advanceTimersByTime(500);
            expect(fn).toHaveBeenCalledWith('repo-x');
        });
    });

    describe('coalescing', () => {
        it('coalesces a burst of schedules into ONE fire', () => {
            const fn = vi.fn();
            const d = new PerRepoDebouncer(500);
            // 5 saves over 300ms
            for (let i = 0; i < 5; i++) {
                d.schedule('repo-a', fn);
                vi.advanceTimersByTime(60);
            }
            // 200ms before the debounce window closes
            expect(fn).not.toHaveBeenCalled();
            vi.advanceTimersByTime(500);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('the LATEST callback wins after coalescing', () => {
            // If the WS bridge swaps the orchestrator between saves
            // (e.g. registry refresh), the latest callback closure should
            // be the one invoked.
            const first = vi.fn();
            const second = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-a', first);
            vi.advanceTimersByTime(100);
            d.schedule('repo-a', second);
            vi.advanceTimersByTime(500);
            expect(first).not.toHaveBeenCalled();
            expect(second).toHaveBeenCalledTimes(1);
        });
    });

    describe('per-repo isolation', () => {
        it('two repo keys fire independently', () => {
            const fnA = vi.fn();
            const fnB = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-a', fnA);
            vi.advanceTimersByTime(200);
            d.schedule('repo-b', fnB);
            // repo-a fires after total 500ms
            vi.advanceTimersByTime(300);
            expect(fnA).toHaveBeenCalledTimes(1);
            expect(fnB).not.toHaveBeenCalled();
            // repo-b fires 500ms after its own schedule
            vi.advanceTimersByTime(200);
            expect(fnB).toHaveBeenCalledTimes(1);
        });
    });

    describe('cancel', () => {
        it('cancel removes a pending fire', () => {
            const fn = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-a', fn);
            vi.advanceTimersByTime(200);
            d.cancel('repo-a');
            vi.advanceTimersByTime(1000);
            expect(fn).not.toHaveBeenCalled();
        });

        it('cancelAll removes every pending', () => {
            const fnA = vi.fn();
            const fnB = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('a', fnA);
            d.schedule('b', fnB);
            d.cancelAll();
            vi.advanceTimersByTime(1000);
            expect(fnA).not.toHaveBeenCalled();
            expect(fnB).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('a throwing callback does not break the debouncer for the next schedule', () => {
            const bad = vi.fn(() => { throw new Error('boom'); });
            const good = vi.fn();
            const d = new PerRepoDebouncer(500);
            d.schedule('repo-a', bad);
            vi.advanceTimersByTime(500);
            expect(bad).toHaveBeenCalled();
            d.schedule('repo-a', good);
            vi.advanceTimersByTime(500);
            expect(good).toHaveBeenCalled();
        });
    });
});
