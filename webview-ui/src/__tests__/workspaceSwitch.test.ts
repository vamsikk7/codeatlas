/**
 * workspaceSwitch.test.ts
 *
 * Unit tests for `maybeReloadOnWorkspaceSwitch` — the SPA-side helper that
 * reloads the page when the extension switches to a different workspace
 * while the browser tab stays open (Issue #431).
 */

import { describe, it, expect, vi } from 'vitest';
import { maybeReloadOnWorkspaceSwitch } from '../App';

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = v; },
    };
}

describe('maybeReloadOnWorkspaceSwitch (#431)', () => {
    it('does NOT reload on the first workspaceInfo arrival (cold start)', () => {
        const storage = makeStorage();
        const reload = vi.fn();
        const reloaded = maybeReloadOnWorkspaceSwitch('/path/to/repo-A', storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        // Storage should now remember the root for next time.
        expect(storage.data['codeatlas:workspaceRoot']).toBe('/path/to/repo-A');
    });

    it('does NOT reload when the same workspace pushes a fresh workspaceInfo (re-init / file save)', () => {
        const storage = makeStorage({ 'codeatlas:workspaceRoot': '/path/to/repo-A' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnWorkspaceSwitch('/path/to/repo-A', storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });

    it('triggers reload when workspaceInfo arrives with a different workspaceRoot', () => {
        const storage = makeStorage({ 'codeatlas:workspaceRoot': '/path/to/repo-A' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnWorkspaceSwitch('/path/to/repo-B', storage, reload);
        expect(reloaded).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        // Storage updated so the post-reload SPA records the new root.
        expect(storage.data['codeatlas:workspaceRoot']).toBe('/path/to/repo-B');
    });

    it('does nothing when the incoming workspaceRoot is undefined (older server / missing field)', () => {
        const storage = makeStorage({ 'codeatlas:workspaceRoot': '/path/to/repo-A' });
        const reload = vi.fn();
        const reloaded = maybeReloadOnWorkspaceSwitch(undefined, storage, reload);
        expect(reloaded).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        // Storage left unchanged.
        expect(storage.data['codeatlas:workspaceRoot']).toBe('/path/to/repo-A');
    });
});
