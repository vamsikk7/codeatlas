/**
 * bundleSwitch.test.ts
 *
 * Issue #776: SPA-side helper that reloads the page when a fresh VSIX
 * has been installed (bundle build number changes) but the browser tab
 * stays open. Without this, the first paint of L2a / L2b / L3 / etc.
 * renders cached graph state from the prior bundle until the WS push
 * arrives — confusingly looks like a regression during live verify.
 *
 * Mirrors the shape of `maybeReloadOnWorkspaceSwitch` (#431) so the two
 * stay symmetric and easy to reason about.
 */

import { describe, it, expect, vi } from 'vitest';
import { maybeReloadOnBundleSwitch } from '../App';

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = v; },
    };
}

describe('maybeReloadOnBundleSwitch (#776)', () => {
    it('does NOT reload on first arrival (cold start records the bundle)', () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const reloaded = maybeReloadOnBundleSwitch('7.0.0.11', storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(storage.data['codeatlas:bundleBuild']).toBe('7.0.0.11');
    });

    it('does NOT reload when same bundle pushes a fresh workspaceInfo', () => {
        const storage = makeStorage({ 'codeatlas:bundleBuild': '7.0.0.11' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnBundleSwitch('7.0.0.11', storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });

    it('triggers reload when bundle build changes (fresh VSIX install)', () => {
        const storage = makeStorage({ 'codeatlas:bundleBuild': '7.0.0.10' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnBundleSwitch('7.0.0.11', storage, reload);
        expect(reloaded).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.data['codeatlas:bundleBuild']).toBe('7.0.0.11');
    });

    it('does nothing when the incoming bundle id is empty', () => {
        const storage = makeStorage({ 'codeatlas:bundleBuild': '7.0.0.11' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnBundleSwitch('', storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(storage.data['codeatlas:bundleBuild']).toBe('7.0.0.11');
    });

    it('treats undefined incoming bundle id as no-op', () => {
        const storage = makeStorage({ 'codeatlas:bundleBuild': '7.0.0.11' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnBundleSwitch(undefined as unknown as string, storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });
});
