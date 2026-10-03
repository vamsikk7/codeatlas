/**
 * Tests for hash-URL parsing (#444-B): accept both `/` and `:` as the
 * file→function separator in `#/flow/...` so users pasting a graph-id-shaped
 * hash get to L5 instead of falling back to home.
 */
import { describe, it, expect } from 'vitest';
import { parseHash, isHomeHashRoute } from '../App';

describe('parseHash — flow route separator forgiveness (#444-B)', () => {
    it('accepts canonical `/` separator', () => {
        const r = parseHash('#/flow/src/app/articles/Create.cs/Create.Handle');
        expect(r).toEqual({ route: 'flow', param: 'src/app/articles/Create.cs', param2: 'Create.Handle' });
    });

    it('accepts `:` separator (graph-id shape)', () => {
        const r = parseHash('#/flow/src/app/articles/Create.cs:Create.Handle');
        expect(r).toEqual({ route: 'flow', param: 'src/app/articles/Create.cs', param2: 'Create.Handle' });
    });

    it('accepts `:` separator with dotted function name', () => {
        const r = parseHash('#/flow/lib/screen.dart:MyApp.build');
        expect(r).toEqual({ route: 'flow', param: 'lib/screen.dart', param2: 'MyApp.build' });
    });

    it('accepts `/` separator with no nested path', () => {
        const r = parseHash('#/flow/file.ts/handler');
        expect(r).toEqual({ route: 'flow', param: 'file.ts', param2: 'handler' });
    });

    it('home hash returns null', () => {
        expect(parseHash('#')).toBeNull();
        expect(parseHash('#/')).toBeNull();
        expect(parseHash('#/home')).toBeNull();
    });

    it('file route still parses', () => {
        const r = parseHash('#/file/src/app/articles/Create.cs');
        expect(r).toEqual({ route: 'file', param: 'src/app/articles/Create.cs' });
    });

    it('sequence route still parses', () => {
        const r = parseHash('#/sequence/Create');
        expect(r).toEqual({ route: 'sequence', param: 'Create' });
    });
});

// HOME-2 (2026-06-07): the suppressHashChange flag (used to silence the
// app-initiated hash sync to the WS panel) was swallowing the user's
// explicit `#/home` hashchange too — so navigating to `#/home` via the URL
// bar / deep link / location.href didn't reset `showHome=true` and the user
// stayed on whatever graph was last rendered. The fix routes home detection
// through `isHomeHashRoute` and explicitly bypasses the suppress flag in
// the App's onHashChange handler when this returns true.
describe('isHomeHashRoute — HOME-2', () => {
    it('detects empty hash as home', () => {
        expect(isHomeHashRoute('')).toBe(true);
    });
    it('detects "#" as home', () => {
        expect(isHomeHashRoute('#')).toBe(true);
    });
    it('detects "#/" as home', () => {
        expect(isHomeHashRoute('#/')).toBe(true);
    });
    it('detects "#/home" as home', () => {
        expect(isHomeHashRoute('#/home')).toBe(true);
    });
    it('rejects any other route hash', () => {
        expect(isHomeHashRoute('#/system-design')).toBe(false);
        expect(isHomeHashRoute('#/file/src/x.ts')).toBe(false);
        expect(isHomeHashRoute('#/apis/cluster:auth')).toBe(false);
        expect(isHomeHashRoute('#/api-testing')).toBe(false);
        expect(isHomeHashRoute('#/homer-simpson')).toBe(false);
    });
});

// Bug B (2026-06-04) — `#/domains` plural typo silently hangs the SPA on
// "Connecting…" because `parseHash` returns null for the plural form, so
// no `requestRoute` ever fires. Add a tolerant alias mapping the plural
// hash back to the singular `domain` route used everywhere internally.
describe('parseHash — Bug B: tolerant plural alias for domain', () => {
    it('plural `#/domains` resolves to the `domain` route (alias)', () => {
        expect(parseHash('#/domains')).toEqual({ route: 'domain' });
    });

    it('singular `#/domain` continues to resolve (regression guard)', () => {
        expect(parseHash('#/domain')).toEqual({ route: 'domain' });
    });
});

// Issue #779: hash-route gating for the ApiTestingView early-return.
// `showApiTesting` state was never reset on navigation, so the view
// "won" the render even after the user navigated to `#/map` or any
// other route. The fix adds `parseHash(hash)?.route === 'api-testing'`
// as a gate. These tests lock in the contract.
describe('parseHash — #779 ApiTesting gate semantics', () => {
    it('returns route="api-testing" only for the canonical hash', () => {
        expect(parseHash('#/api-testing')?.route).toBe('api-testing');
    });

    it('returns route="map" for `#/map` (not api-testing)', () => {
        expect(parseHash('#/map')?.route).toBe('map');
        expect(parseHash('#/map')?.route).not.toBe('api-testing');
    });

    it('returns route="system-design" for `#/system-design` (not api-testing)', () => {
        expect(parseHash('#/system-design')?.route).toBe('system-design');
        expect(parseHash('#/system-design')?.route).not.toBe('api-testing');
    });

    it('returns route="features" for `#/features` (not api-testing)', () => {
        expect(parseHash('#/features')?.route).toBe('features');
        expect(parseHash('#/features')?.route).not.toBe('api-testing');
    });

    it('returns null (home) for `#/`', () => {
        // App.tsx checks `parseHash(hash)?.route === 'api-testing'` so
        // a null parse (home) safely fails the equality check.
        expect(parseHash('#/')).toBeNull();
    });
});

// UX-63 (2026-06-09) — per-repo diff / replay deep-links so refresh /
// share-link / back-forward all preserve the sub-repo scope the user
// picked. Each route accepts both the bare workspace form and a
// `<route>/<repoId>` form. Workspace form keeps the legacy single-repo
// behaviour; per-repo form drives the multi-repo branch in the
// corresponding message handler.
describe('parseHash — per-repo diff / replay routes (UX-63)', () => {
    it('UX-63a: `#/replay-working` is workspace-scoped', () => {
        expect(parseHash('#/replay-working')).toEqual({ route: 'replay-working' });
    });
    it('UX-63a: `#/replay-working/<repoId>` carries repoId', () => {
        expect(parseHash('#/replay-working/auth-svc')).toEqual({ route: 'replay-working', param: 'auth-svc' });
    });
    it('UX-63b: `#/compare-commits` is workspace-scoped', () => {
        expect(parseHash('#/compare-commits')).toEqual({ route: 'compare-commits' });
    });
    it('UX-63b: `#/compare-commits/<repoId>` carries repoId', () => {
        expect(parseHash('#/compare-commits/payments-svc')).toEqual({ route: 'compare-commits', param: 'payments-svc' });
    });
    it('UX-63c: `#/branch-diff/<repoId>` carries repoId', () => {
        expect(parseHash('#/branch-diff/orders')).toEqual({ route: 'branch-diff', param: 'orders' });
    });
    it('UX-63d: `#/pr-diff/<repoId>` carries repoId', () => {
        expect(parseHash('#/pr-diff/web-app')).toEqual({ route: 'pr-diff', param: 'web-app' });
    });
    it('UX-63d: `#/replay-pr/<repoId>` carries repoId', () => {
        expect(parseHash('#/replay-pr/api-gw')).toEqual({ route: 'replay-pr', param: 'api-gw' });
    });
    it('UX-63e: `#/replay-branch/<repoId>` carries repoId', () => {
        expect(parseHash('#/replay-branch/notifications')).toEqual({ route: 'replay-branch', param: 'notifications' });
    });
    it('UX-63f: `#/timeline-replay/<repoId>` carries repoId', () => {
        expect(parseHash('#/timeline-replay/billing')).toEqual({ route: 'timeline-replay', param: 'billing' });
    });
    it('preserves hyphenated multi-segment repoIds', () => {
        expect(parseHash('#/replay-working/aws-node-http-api-mongodb')).toEqual({
            route: 'replay-working',
            param: 'aws-node-http-api-mongodb',
        });
    });
    it('keeps bare workspace forms passing the home gate', () => {
        // None of these are home routes, so isHomeHashRoute is false.
        expect(isHomeHashRoute('#/replay-working')).toBe(false);
        expect(isHomeHashRoute('#/compare-commits')).toBe(false);
    });
});

// ADR-034 Phase H Pass 3 (#793) — per-repo tour deep-links.
describe('parseHash — tour routes', () => {
    it('plain `#/tour` resolves to the workspace meta-tour (no param)', () => {
        expect(parseHash('#/tour')).toEqual({ route: 'tour' });
    });

    it('`#/tour/<repoId>` carries the repoId as param', () => {
        expect(parseHash('#/tour/auth-svc')).toEqual({ route: 'tour', param: 'auth-svc' });
    });

    it('`#/tour/<repoId-with-hyphens>` preserves hyphens in repoId', () => {
        expect(parseHash('#/tour/my-cool-service-v2')).toEqual({
            route: 'tour',
            param: 'my-cool-service-v2',
        });
    });
});
