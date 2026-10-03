/**
 * baselineRef.test.ts (#534 — AI Review findings carry no commit / baseline reference)
 *
 * Verifies the two strategies of `computeBaselineRef`:
 *  - git workspace → 7-char short SHA via injected probe
 *  - non-git workspace → deterministic 8-char hash of (path@hash) lines
 *
 * Both shapes carry a `capturedAt` ISO timestamp.
 */

import { describe, it, expect } from 'vitest';
import { computeBaselineRef } from '../baselineRef';

function fakeStore(files: Record<string, { hash: string }>): any {
    return { getWorking: () => ({ files }) };
}

describe('computeBaselineRef', () => {
    it('returns git short SHA when the probe finds one', () => {
        const ref = computeBaselineRef({
            workspaceRoot: '/tmp/anything',
            snapshotStore: fakeStore({}),
            gitShaProbe: () => 'abc1234',
        });
        expect(ref.kind).toBe('git');
        expect(ref.ref).toBe('abc1234');
        expect(ref.capturedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('falls back to snapshot hash when git probe returns null', () => {
        const ref = computeBaselineRef({
            workspaceRoot: '/tmp/nogit',
            snapshotStore: fakeStore({
                'src/a.ts': { hash: 'aaa' },
                'src/b.ts': { hash: 'bbb' },
            }),
            gitShaProbe: () => null,
        });
        expect(ref.kind).toBe('snapshot');
        expect(ref.ref).toMatch(/^[0-9a-f]{8}$/);
    });

    it('snapshot hash is deterministic for identical file sets', () => {
        const probe = () => null;
        const refA = computeBaselineRef({
            workspaceRoot: '/tmp/x',
            snapshotStore: fakeStore({ 'a.ts': { hash: '1' }, 'b.ts': { hash: '2' } }),
            gitShaProbe: probe,
        });
        const refB = computeBaselineRef({
            workspaceRoot: '/tmp/x',
            // Same content, different insertion order — must produce same hash.
            snapshotStore: fakeStore({ 'b.ts': { hash: '2' }, 'a.ts': { hash: '1' } }),
            gitShaProbe: probe,
        });
        expect(refA.ref).toBe(refB.ref);
    });

    it('snapshot hash differs when any file hash changes', () => {
        const probe = () => null;
        const refA = computeBaselineRef({
            workspaceRoot: '/tmp/x',
            snapshotStore: fakeStore({ 'a.ts': { hash: 'OLD' } }),
            gitShaProbe: probe,
        });
        const refB = computeBaselineRef({
            workspaceRoot: '/tmp/x',
            snapshotStore: fakeStore({ 'a.ts': { hash: 'NEW' } }),
            gitShaProbe: probe,
        });
        expect(refA.ref).not.toBe(refB.ref);
    });

    it('returns a snapshot ref even when store throws', () => {
        const ref = computeBaselineRef({
            workspaceRoot: '/tmp/whatever',
            snapshotStore: { getWorking: () => { throw new Error('boom'); } } as any,
            gitShaProbe: () => null,
        });
        expect(ref.kind).toBe('snapshot');
        expect(ref.ref).toMatch(/^[0-9a-f]{8}$/);
    });
});
