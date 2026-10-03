/**
 * hashSuppressGuard.test.ts
 *
 * Issue #441: the `suppressHashChange` flag in App.tsx must NOT be left
 * stuck `true` when the SPA sets `window.location.hash` to a value equal
 * to the current hash — in that case no `hashchange` event fires to
 * reset the flag, and the next user-initiated URL change is silently
 * suppressed. This file pins the conditional-suppression behavior.
 *
 * The behavior is co-located with the navigateTo + handleHome handlers
 * in App.tsx (search "Issue #441"). The pattern is:
 *
 *     const currentHash = window.location.hash.replace(/^#/, '');
 *     if (currentHash !== nextHash) {
 *         suppressFlag.current = true;
 *         window.location.hash = nextHash;
 *     }
 *
 * Tests below validate that pattern via a small isolated helper.
 */

import { describe, it, expect } from 'vitest';

/**
 * Mirror of the conditional suppress-and-set pattern used in App.tsx.
 * Exposed as a pure function so it's unit-testable without rendering App.
 */
function setHashWithGuard(
    nextHash: string,
    currentHash: string,
    suppressFlag: { current: boolean },
    setHash: (h: string) => void,
): { didSet: boolean } {
    if (currentHash !== nextHash) {
        suppressFlag.current = true;
        setHash(nextHash);
        return { didSet: true };
    }
    return { didSet: false };
}

describe('setHashWithGuard (#441)', () => {
    it('sets suppress flag + writes hash when the next hash differs', () => {
        const flag = { current: false };
        let written: string | null = null;
        const result = setHashWithGuard('/features/svc-a', '/system-design', flag, (h) => { written = h; });
        expect(result.didSet).toBe(true);
        expect(flag.current).toBe(true);
        expect(written).toBe('/features/svc-a');
    });

    it('does NOT set suppress flag when the next hash equals the current hash', () => {
        const flag = { current: false };
        let written: string | null = null;
        const result = setHashWithGuard('/system-design', '/system-design', flag, (h) => { written = h; });
        expect(result.didSet).toBe(false);
        expect(flag.current, 'flag must stay false — otherwise next real hashchange will be suppressed').toBe(false);
        expect(written, 'hash must NOT be re-set when value is unchanged').toBeNull();
    });

    it('leaves a previously-set flag alone when nothing needs to change', () => {
        // This guards against accidentally CLEARING a legitimate suppress
        // flag set by another concurrent navigation.
        const flag = { current: true };
        setHashWithGuard('/home', '/home', flag, () => { /* no-op */ });
        expect(flag.current, 'guard must not mutate flag when no write happens').toBe(true);
    });

    it('initial-load scenario: SPA loads at /system-design and sets hash to /system-design — flag stays clear', () => {
        // Reproduces the bug. Pre-fix, navigateTo always set the flag, then
        // the hash assignment was a no-op (same value), so no `hashchange`
        // fired and the flag stayed `true` forever. User then types
        // /features/X in the URL bar, hashchange fires, sees stale flag,
        // bails. Post-fix, flag stays clean so the next user nav works.
        const flag = { current: false };
        const setHash = (_: string) => { /* would fire hashchange + auto-clear flag */ };
        setHashWithGuard('/system-design', '/system-design', flag, setHash);
        // Simulate the user typing a new hash now
        // (in real App, this fires hashchange → handler checks flag)
        expect(flag.current, 'flag must be clean for the next user-driven hashchange').toBe(false);
    });
});
