/**
 * mobileScreenReclassifier.test.ts — TICKET-MOBILE-1.
 */
import { describe, it, expect } from 'vitest';
import { collectComposableNavTargets, reclassifyMobileScreens } from '../mobileScreenReclassifier';
import type { ApiRecord } from '../../graph/graphTypes';

function screen(name: string, composable = true): ApiRecord {
    return {
        apiId: `SCREEN:/${name}::x.kt::${name}`, method: 'SCREEN', route: `/${name}`,
        handlerName: name, filePath: 'x.kt', ...(composable ? { meta: { composable: true } } : {}),
    } as ApiRecord;
}
function index(...recs: ApiRecord[]) { return Object.fromEntries(recs.map(r => [r.apiId, r])); }

describe('collectComposableNavTargets', () => {
    it('extracts destination composables from NavHost lambdas (string + typed routes)', () => {
        const src = `
            NavHost(navController, startDestination = "home") {
                composable("home") { HomeScreen(navController) }
                composable("feed") { val vm = viewModel(); Feed(vm) }
                composable<ProfileRoute> { Profile() }
            }`;
        const t = collectComposableNavTargets([src]);
        expect(t.has('HomeScreen')).toBe(true);
        expect(t.has('Feed')).toBe(true);      // does NOT end in Screen — nav-target catches it
        expect(t.has('Profile')).toBe(true);
        expect(t.has('viewModel'), 'lowercase calls are not targets').toBe(false);
    });
});

describe('reclassifyMobileScreens', () => {
    it('keeps navigable composables, drops UI components', () => {
        const before = index(
            screen('HomeScreen'),     // *Screen → keep
            screen('Feed'),           // nav-target → keep
            screen('Profile'),        // nav-target → keep
            screen('PostCard'),       // component → drop
            screen('BoxScope'),       // receiver shim → drop
            screen('JumpToBottom'),   // component → drop
        );
        const nav = new Set(['Feed', 'Profile']);
        const after = reclassifyMobileScreens(before, nav);
        const names = Object.values(after).map(r => r.handlerName).sort();
        expect(names).toEqual(['Feed', 'HomeScreen', 'Profile']);
    });

    it('NEVER drops class-based Activity/Fragment screens (no meta.composable)', () => {
        const before = index(
            screen('MainActivity', false),         // class-based → always keep
            screen('ConversationFragment', false), // class-based → always keep
            screen('PostCard'),                    // composable component → drop
        );
        const after = reclassifyMobileScreens(before, new Set());
        const names = Object.values(after).map(r => r.handlerName).sort();
        expect(names).toEqual(['ConversationFragment', 'MainActivity']);
    });

    it('is count-preserving (referentially unchanged) when nothing is dropped', () => {
        const before = index(screen('HomeScreen'), screen('DetailScreen'));
        const after = reclassifyMobileScreens(before, new Set());
        expect(after).toBe(before);
    });

    it('leaves non-SCREEN records untouched', () => {
        const api = { apiId: 'GET:/x::a.ts::h', method: 'GET', route: '/x', handlerName: 'h', filePath: 'a.ts' } as ApiRecord;
        const before = index(api, screen('PostCard'));
        const after = reclassifyMobileScreens(before, new Set());
        expect(Object.values(after).some(r => r.method === 'GET')).toBe(true);
        expect(Object.values(after).some(r => r.handlerName === 'PostCard')).toBe(false);
    });
});
