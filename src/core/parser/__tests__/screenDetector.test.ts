/**
 * screenDetector.test.ts — v2 phase 3 PR-A scaffolding tests.
 *
 * What this test suite covers:
 *   1. **Category gating** — `detectScreens` short-circuits on backend
 *      services and returns an empty record (zero entries) for them.
 *      This is the load-bearing invariant: dropping the gate would
 *      run framework detectors against every backend file, polluting
 *      L2a with false-positive screens on Express / Django / Spring
 *      services that happen to ship JSX/TSX templates or sample apps.
 *   2. **Unknown / monorepo-parent gating** — also early-returns
 *      (matches the spec §3 gating language: "only frontend or mobile
 *      services produce screens").
 *   3. **No-services workspace** — empty `services` argument →
 *      empty result.
 *   4. **PR-A stubbed dispatcher** — frontend/mobile services do not
 *      yet produce any screens. This pin lets PR-B+ swap real
 *      detectors in without surprising any caller; today's empty
 *      record is the contract.
 *
 * Per-framework positive tests land in later PRs as each detector
 * goes live (PR-B Next.js, PR-C Nuxt/Remix/SvelteKit/Expo, etc.).
 */

import { describe, it, expect } from 'vitest';
import { detectScreens } from '../screenDetector';
import type { Snapshot, ServiceRecord } from '../../graph/graphTypes';

function makeService(overrides: Partial<ServiceRecord> & { id: string; name: string }): ServiceRecord {
    return {
        rootPath: '',
        technology: 'unknown',
        category: 'backend',
        exposedApiCount: 0,
        consumedUrls: [],
        consumedServices: [],
        diff: 'unchanged',
        ...overrides,
    };
}

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

describe('detectScreens — PR-A scaffolding contract', () => {
    it('returns empty record for an empty workspace (no services)', () => {
        const result = detectScreens(emptySnapshot(), {});
        expect(result).toEqual({});
    });

    it('returns empty record for a pure-backend workspace (category gate)', () => {
        const services = {
            'service:api': makeService({ id: 'service:api', name: 'api', technology: 'express', category: 'backend' }),
            'service:worker': makeService({ id: 'service:worker', name: 'worker', technology: 'unknown', category: 'backend' }),
        };
        const result = detectScreens(emptySnapshot(), services);
        expect(result).toEqual({});
    });

    it('returns empty record for an unknown-category service (safe default)', () => {
        const services = {
            'service:mystery': makeService({ id: 'service:mystery', name: 'mystery', technology: 'unknown', category: 'unknown' }),
        };
        const result = detectScreens(emptySnapshot(), services);
        expect(result).toEqual({});
    });

    it('returns empty record for a monorepo-parent service', () => {
        const services = {
            'service:root': makeService({ id: 'service:root', name: 'root', technology: 'unknown', category: 'monorepo-parent' }),
        };
        const result = detectScreens(emptySnapshot(), services);
        expect(result).toEqual({});
    });

    it('returns empty record for a frontend service with no recognised framework files', () => {
        // Frontend service with content but no Next.js page.tsx files
        // and no other supported FE conventions → still empty until
        // PR-C+ detectors land.
        const snapshot = mkSnapshot(['apps/web/src/utils.ts']);
        const services = {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'nextjs', category: 'frontend' }),
        };
        const result = detectScreens(snapshot, services);
        expect(result).toEqual({});
    });

    it('returns empty record for a mobile service with no recognised framework files (PR-D will fill this)', () => {
        const services = {
            'service:mobile': makeService({ id: 'service:mobile', name: 'mobile', technology: 'react-native', category: 'mobile' }),
        };
        const result = detectScreens(emptySnapshot(), services);
        expect(result).toEqual({});
    });
});

// Helper: build a Snapshot from a list of file paths. Files have empty
// content because the Next.js + Pages detectors are pure-path-based —
// no source-content parsing is required.
function mkSnapshot(filePaths: string[]): Snapshot {
    const files: Snapshot['files'] = {};
    for (const fp of filePaths) {
        files[fp] = { path: fp, hash: 'h', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } };
    }
    return { files, apiIndex: {}, graphs: {} };
}

describe('detectScreens — Next.js App Router (PR-B)', () => {
    function frontendWebService(rootPath = 'apps/web'): Record<string, ServiceRecord> {
        return {
            'service:web': makeService({
                id: 'service:web', name: 'web', rootPath,
                technology: 'nextjs', category: 'frontend',
            }),
        };
    }

    it('app/page.tsx → screen at /', () => {
        const snapshot = mkSnapshot(['apps/web/app/page.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen).toBeDefined();
        expect(screen.framework).toBe('nextjs-app');
        expect(screen.routePath).toBe('/');
        expect(screen.serviceId).toBe('service:web');
        expect(screen.filePath).toBe('apps/web/app/page.tsx');
        expect(screen.anchor.filePath).toBe('apps/web/app/page.tsx');
    });

    it('app/dashboard/page.tsx → screen at /dashboard', () => {
        const snapshot = mkSnapshot(['apps/web/app/dashboard/page.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/dashboard');
        expect(screen.framework).toBe('nextjs-app');
    });

    it('app/users/[id]/page.tsx → screen at /users/[id]', () => {
        const snapshot = mkSnapshot(['apps/web/app/users/[id]/page.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/users/[id]');
    });

    it('src/app/dashboard/page.tsx (src-prefix layout) → screen at /dashboard', () => {
        const snapshot = mkSnapshot(['apps/web/src/app/dashboard/page.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/dashboard');
    });

    it('multiple App Router pages → multiple screens in one service', () => {
        const snapshot = mkSnapshot([
            'apps/web/app/page.tsx',
            'apps/web/app/dashboard/page.tsx',
            'apps/web/app/profile/page.tsx',
        ]);
        const result = detectScreens(snapshot, frontendWebService());
        const routePaths = Object.values(result).map((s) => s.routePath).sort();
        expect(routePaths).toEqual(['/', '/dashboard', '/profile']);
    });

    it('app/.tsx files that are NOT named page.tsx are ignored (layout/loading/error/template)', () => {
        const snapshot = mkSnapshot([
            'apps/web/app/dashboard/layout.tsx',
            'apps/web/app/dashboard/loading.tsx',
            'apps/web/app/dashboard/error.tsx',
            'apps/web/app/dashboard/template.tsx',
            'apps/web/app/dashboard/not-found.tsx',
        ]);
        const result = detectScreens(snapshot, frontendWebService());
        expect(result).toEqual({});
    });

    it('app/api/.../route.ts is NOT a screen (it is a route handler)', () => {
        const snapshot = mkSnapshot(['apps/web/app/api/users/route.ts']);
        const result = detectScreens(snapshot, frontendWebService());
        expect(result).toEqual({});
    });
});

describe('detectScreens — Next.js Pages Router (PR-B)', () => {
    function frontendWebService(rootPath = 'apps/web'): Record<string, ServiceRecord> {
        return {
            'service:web': makeService({
                id: 'service:web', name: 'web', rootPath,
                technology: 'nextjs', category: 'frontend',
            }),
        };
    }

    it('pages/index.tsx → screen at /', () => {
        const snapshot = mkSnapshot(['apps/web/pages/index.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.framework).toBe('nextjs-pages');
        expect(screen.routePath).toBe('/');
    });

    it('pages/dashboard.tsx → screen at /dashboard', () => {
        const snapshot = mkSnapshot(['apps/web/pages/dashboard.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/dashboard');
    });

    it('pages/users/[id].tsx → screen at /users/[id]', () => {
        const snapshot = mkSnapshot(['apps/web/pages/users/[id].tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/users/[id]');
    });

    it('src/pages/profile.tsx (src-prefix layout) → screen at /profile', () => {
        const snapshot = mkSnapshot(['apps/web/src/pages/profile.tsx']);
        const result = detectScreens(snapshot, frontendWebService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/profile');
    });

    it('pages/_app.tsx, _document.tsx, _error.tsx are NOT screens (Next conventions)', () => {
        const snapshot = mkSnapshot([
            'apps/web/pages/_app.tsx',
            'apps/web/pages/_document.tsx',
            'apps/web/pages/_error.tsx',
        ]);
        const result = detectScreens(snapshot, frontendWebService());
        expect(result).toEqual({});
    });

    it('pages/api/users.ts is NOT a screen (it is an API route)', () => {
        const snapshot = mkSnapshot(['apps/web/pages/api/users.ts']);
        const result = detectScreens(snapshot, frontendWebService());
        expect(result).toEqual({});
    });

    it('App + Pages mixed: app/page.tsx and pages/about.tsx both emit screens', () => {
        const snapshot = mkSnapshot([
            'apps/web/app/page.tsx',
            'apps/web/pages/about.tsx',
        ]);
        const result = detectScreens(snapshot, frontendWebService());
        const frameworks = Object.values(result).map((s) => s.framework).sort();
        expect(frameworks).toEqual(['nextjs-app', 'nextjs-pages']);
    });
});

describe('detectScreens — Nuxt 3 (PR-C)', () => {
    function nuxtService(): Record<string, ServiceRecord> {
        return {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'unknown', category: 'frontend' }),
        };
    }

    it('pages/index.vue → screen at /', () => {
        const snapshot = mkSnapshot(['apps/web/pages/index.vue']);
        const result = detectScreens(snapshot, nuxtService());
        const screen = Object.values(result)[0];
        expect(screen.framework).toBe('nuxt');
        expect(screen.routePath).toBe('/');
    });

    it('pages/dashboard.vue → screen at /dashboard', () => {
        const snapshot = mkSnapshot(['apps/web/pages/dashboard.vue']);
        const result = detectScreens(snapshot, nuxtService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/dashboard');
    });

    it('pages/users/[id].vue → screen at /users/[id]', () => {
        const snapshot = mkSnapshot(['apps/web/pages/users/[id].vue']);
        const result = detectScreens(snapshot, nuxtService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/users/[id]');
    });

    it('pages/_app.vue and pages/_layout.vue are NOT screens', () => {
        const snapshot = mkSnapshot([
            'apps/web/pages/_app.vue',
            'apps/web/pages/_layout.vue',
        ]);
        const result = detectScreens(snapshot, nuxtService());
        expect(result).toEqual({});
    });

    it('pages/index.tsx (Next.js — not Vue) is NOT picked up as a Nuxt screen', () => {
        const snapshot = mkSnapshot(['apps/web/pages/index.tsx']);
        const result = detectScreens(snapshot, nuxtService());
        // Picked up by Next.js Pages detector, not Nuxt.
        expect(Object.values(result).some((s) => s.framework === 'nuxt')).toBe(false);
    });
});

describe('detectScreens — Remix (PR-C)', () => {
    function remixService(): Record<string, ServiceRecord> {
        return {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'unknown', category: 'frontend' }),
        };
    }

    it('app/routes/_index.tsx → screen at /_index', () => {
        const snapshot = mkSnapshot(['apps/web/app/routes/_index.tsx']);
        const result = detectScreens(snapshot, remixService());
        const screen = Object.values(result)[0];
        expect(screen.framework).toBe('remix');
        expect(screen.routePath).toBe('/_index');
    });

    it('app/routes/articles.$id.tsx → screen at /articles.$id', () => {
        const snapshot = mkSnapshot(['apps/web/app/routes/articles.$id.tsx']);
        const result = detectScreens(snapshot, remixService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/articles.$id');
    });

    it('app/routes/__layout.tsx is NOT a screen (route-level layout)', () => {
        const snapshot = mkSnapshot(['apps/web/app/routes/__layout.tsx']);
        const result = detectScreens(snapshot, remixService());
        expect(result).toEqual({});
    });

    it('routes/products.tsx (no app/ prefix) → screen at /products', () => {
        const snapshot = mkSnapshot(['apps/web/routes/products.tsx']);
        const result = detectScreens(snapshot, remixService());
        const screen = Object.values(result)[0];
        expect(screen.framework).toBe('remix');
        expect(screen.routePath).toBe('/products');
    });
});

describe('detectScreens — SvelteKit (PR-C)', () => {
    function svelteService(): Record<string, ServiceRecord> {
        return {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'unknown', category: 'frontend' }),
        };
    }

    it('src/routes/+page.svelte → screen at /', () => {
        const snapshot = mkSnapshot(['apps/web/src/routes/+page.svelte']);
        const result = detectScreens(snapshot, svelteService());
        const screen = Object.values(result)[0];
        expect(screen.framework).toBe('sveltekit');
        expect(screen.routePath).toBe('/');
    });

    it('src/routes/dashboard/+page.svelte → screen at /dashboard', () => {
        const snapshot = mkSnapshot(['apps/web/src/routes/dashboard/+page.svelte']);
        const result = detectScreens(snapshot, svelteService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/dashboard');
    });

    it('src/routes/users/[id]/+page.svelte → screen at /users/[id]', () => {
        const snapshot = mkSnapshot(['apps/web/src/routes/users/[id]/+page.svelte']);
        const result = detectScreens(snapshot, svelteService());
        const screen = Object.values(result)[0];
        expect(screen.routePath).toBe('/users/[id]');
    });

    it('src/routes/+layout.svelte and +server.ts are NOT screens', () => {
        const snapshot = mkSnapshot([
            'apps/web/src/routes/+layout.svelte',
            'apps/web/src/routes/api/+server.ts',
            'apps/web/src/routes/+error.svelte',
        ]);
        const result = detectScreens(snapshot, svelteService());
        expect(result).toEqual({});
    });
});

describe('detectScreens — Expo Router (PR-C)', () => {
    function expoService(): Record<string, ServiceRecord> {
        return {
            // technology=react-native triggers the Expo Router detection gate
            'service:mobile': makeService({ id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile', technology: 'react-native', category: 'mobile' }),
        };
    }

    it('app/index.tsx → screen at /', () => {
        const snapshot = mkSnapshot([
            'apps/mobile/app/index.tsx',
            'apps/mobile/app/_layout.tsx',  // signature file for Expo detection gate
        ]);
        const result = detectScreens(snapshot, expoService());
        const indexScreen = Object.values(result).find((s) => s.framework === 'expo-router');
        expect(indexScreen).toBeDefined();
        expect(indexScreen!.routePath).toBe('/');
    });

    it('app/dashboard.tsx → screen at /dashboard', () => {
        const snapshot = mkSnapshot([
            'apps/mobile/app/dashboard.tsx',
            'apps/mobile/app/_layout.tsx',
        ]);
        const result = detectScreens(snapshot, expoService());
        const screen = Object.values(result).find((s) => s.framework === 'expo-router' && s.routePath === '/dashboard');
        expect(screen).toBeDefined();
    });

    it('app/(tabs)/home.tsx → screen at /home (group route segments stripped)', () => {
        const snapshot = mkSnapshot([
            'apps/mobile/app/(tabs)/home.tsx',
            'apps/mobile/app/_layout.tsx',
        ]);
        const result = detectScreens(snapshot, expoService());
        const home = Object.values(result).find((s) => s.routePath === '/home');
        expect(home).toBeDefined();
        expect(home!.framework).toBe('expo-router');
    });

    it('app/_layout.tsx and app/+not-found.tsx are NOT screens', () => {
        const snapshot = mkSnapshot([
            'apps/mobile/app/_layout.tsx',
            'apps/mobile/app/+not-found.tsx',
        ]);
        const result = detectScreens(snapshot, expoService());
        expect(Object.values(result).every((s) => s.framework !== 'expo-router')).toBe(true);
    });

    it('Expo Router detection is gated — without _layout.tsx signature, app/foo.tsx does not become an Expo screen', () => {
        // No _layout.tsx signature and tech is not react-native ⇒ skip
        // Expo detection. Without this gate, ALL frontend services
        // with `app/foo.tsx` files would emit Expo screens.
        const snapshot = mkSnapshot(['apps/web/app/dashboard.tsx']);
        const nonExpoFrontend: Record<string, ServiceRecord> = {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'nextjs', category: 'frontend' }),
        };
        const result = detectScreens(snapshot, nonExpoFrontend);
        expect(Object.values(result).some((s) => s.framework === 'expo-router')).toBe(false);
    });

    it('Mixed Next.js + Expo Router in same monorepo: Next.js wins for page.tsx, Expo for app/foo.tsx', () => {
        // Two different services, each with its own layout. The
        // file-convention detection keeps them separated.
        const snapshot = mkSnapshot([
            'apps/web/app/dashboard/page.tsx',     // Next.js App Router screen
            'apps/mobile/app/dashboard.tsx',        // Expo Router screen
            'apps/mobile/app/_layout.tsx',
        ]);
        const services: Record<string, ServiceRecord> = {
            'service:web': makeService({ id: 'service:web', name: 'web', rootPath: 'apps/web', technology: 'nextjs', category: 'frontend' }),
            'service:mobile': makeService({ id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile', technology: 'react-native', category: 'mobile' }),
        };
        const result = detectScreens(snapshot, services);
        const next = Object.values(result).find((s) => s.framework === 'nextjs-app');
        const expo = Object.values(result).find((s) => s.framework === 'expo-router');
        expect(next).toBeDefined();
        expect(expo).toBeDefined();
        expect(next!.serviceId).toBe('service:web');
        expect(expo!.serviceId).toBe('service:mobile');
    });
});

// Helper for content-based detectors (PR-D / PR-E). Builds a snapshot
// where each file has actual source content (not just an empty stub).
function mkSnapshotWithContent(files: Record<string, string>): Snapshot {
    const fileMap: Snapshot['files'] = {};
    for (const [fp, content] of Object.entries(files)) {
        fileMap[fp] = { path: fp, hash: 'h', mtime: 0, content, symbols: { functions: [], variables: [], imports: [] } };
    }
    return { files: fileMap, apiIndex: {}, graphs: {} };
}

describe('detectScreens — Android (PR-D)', () => {
    function androidService(rootPath = 'apps/android'): Record<string, ServiceRecord> {
        return {
            'service:mobile': makeService({
                id: 'service:mobile', name: 'mobile', rootPath,
                technology: 'android', category: 'mobile',
            }),
        };
    }

    it('Kotlin class extending AppCompatActivity → android-activity screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/android/app/src/main/java/com/foo/MainActivity.kt':
                'package com.foo\nclass MainActivity : AppCompatActivity() {\n  override fun onCreate(...) {}\n}',
        });
        const result = detectScreens(snapshot, androidService());
        const screen = Object.values(result).find((s) => s.framework === 'android-activity');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('MainActivity');
    });

    it('Java class extending Fragment → android-fragment screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/android/app/src/main/java/com/foo/HomeFragment.java':
                'package com.foo;\npublic class HomeFragment : Fragment {\n  public void onCreateView(...) {}\n}',
        });
        const result = detectScreens(snapshot, androidService());
        const screen = Object.values(result).find((s) => s.framework === 'android-fragment');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('HomeFragment');
    });

    it('composable("dashboard") inside NavHost → android-compose screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/android/app/src/main/kotlin/Nav.kt':
                'NavHost(navController = navController) {\n  composable("dashboard") { DashboardScreen() }\n  composable("profile") { ProfileScreen() }\n}',
        });
        const result = detectScreens(snapshot, androidService());
        const composeScreens = Object.values(result).filter((s) => s.framework === 'android-compose');
        expect(composeScreens.length).toBe(2);
        expect(composeScreens.map((s) => s.routePath).sort()).toEqual(['dashboard', 'profile']);
    });

    it('non-Kotlin/Java file in mobile service → no Android screens (language gate)', () => {
        const snapshot = mkSnapshotWithContent({
            // .swift file in a mobile service that happens to have an
            // "Activity" subclass-style string. Must not match Android.
            'apps/android/swift-shim.swift': 'class MyActivity : AppCompatActivity {}',
        });
        const result = detectScreens(snapshot, androidService());
        expect(Object.values(result).filter((s) => s.framework === 'android-activity')).toEqual([]);
    });
});

describe('detectScreens — iOS (PR-D)', () => {
    function iosService(): Record<string, ServiceRecord> {
        return {
            'service:mobile': makeService({ id: 'service:mobile', name: 'mobile', rootPath: 'apps/ios', technology: 'ios', category: 'mobile' }),
        };
    }

    it('Swift class subclassing UIViewController → ios-uikit screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/ios/Sources/HomeViewController.swift':
                'import UIKit\nclass HomeViewController: UIViewController {\n  override func viewDidLoad() {}\n}',
        });
        const result = detectScreens(snapshot, iosService());
        const screen = Object.values(result).find((s) => s.framework === 'ios-uikit');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('HomeViewController');
    });

    it('Swift struct conforming to View → ios-swiftui screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/ios/Sources/HomeView.swift':
                'import SwiftUI\nstruct HomeView: View {\n  var body: some View { Text("hi") }\n}',
        });
        const result = detectScreens(snapshot, iosService());
        const screen = Object.values(result).find((s) => s.framework === 'ios-swiftui');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('HomeView');
    });

    it('multiple SwiftUI views in one file → multiple screens', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/ios/Sources/Screens.swift':
                'struct LoginView: View { var body: some View { Text("login") } }\nstruct SignupView: View { var body: some View { Text("signup") } }',
        });
        const result = detectScreens(snapshot, iosService());
        const swiftui = Object.values(result).filter((s) => s.framework === 'ios-swiftui');
        expect(swiftui.length).toBe(2);
        expect(swiftui.map((s) => s.routePath).sort()).toEqual(['LoginView', 'SignupView']);
    });
});

describe('detectScreens — Flutter (PR-D)', () => {
    function flutterService(): Record<string, ServiceRecord> {
        return {
            'service:mobile': makeService({ id: 'service:mobile', name: 'mobile', rootPath: 'apps/flutter', technology: 'unknown', category: 'mobile' }),
        };
    }

    it('Dart GoRoute(path: "/home", ...) → flutter-goroute screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/flutter/lib/router.dart':
                "import 'package:go_router/go_router.dart';\nfinal router = GoRouter(routes: [\n  GoRoute(path: '/home', builder: (ctx, st) => HomeScreen()),\n]);",
        });
        const result = detectScreens(snapshot, flutterService());
        const screen = Object.values(result).find((s) => s.framework === 'flutter-goroute');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('/home');
    });

    it('multiple GoRoute declarations → multiple screens', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/flutter/lib/router.dart':
                "GoRoute(path: '/', builder: ...),\nGoRoute(path: '/profile', builder: ...),\nGoRoute(path: '/settings', builder: ...)",
        });
        const result = detectScreens(snapshot, flutterService());
        const screens = Object.values(result).filter((s) => s.framework === 'flutter-goroute');
        expect(screens.map((s) => s.routePath).sort()).toEqual(['/', '/profile', '/settings']);
    });

    it('MaterialPageRoute(builder: (ctx) => HomeScreen()) → flutter-material-page-route screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/flutter/lib/nav.dart':
                'Navigator.push(context, MaterialPageRoute(builder: (context) => HomeScreen()));',
        });
        const result = detectScreens(snapshot, flutterService());
        const screen = Object.values(result).find((s) => s.framework === 'flutter-material-page-route');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('HomeScreen');
    });

    it('MaterialPageRoute builders for Container/Scaffold/etc. are filtered (noise reduction)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/flutter/lib/nav.dart':
                'Navigator.push(context, MaterialPageRoute(builder: (context) => Container()));',
        });
        const result = detectScreens(snapshot, flutterService());
        expect(Object.values(result).filter((s) => s.framework === 'flutter-material-page-route')).toEqual([]);
    });

    it('non-Dart file in mobile service → no Flutter screens (language gate)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/flutter/random.txt': "GoRoute(path: '/legit')",
        });
        const result = detectScreens(snapshot, flutterService());
        expect(Object.values(result)).toEqual([]);
    });
});

describe('detectScreens — native gate (PR-D): backend service with mobile-style code is ignored', () => {
    it('backend service with a Swift file is gated out (category check)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/api/Sources/HomeView.swift': 'struct HomeView: View { var body: some View { Text("x") } }',
        });
        const services: Record<string, ServiceRecord> = {
            'service:api': makeService({
                id: 'service:api', name: 'api', rootPath: 'apps/api',
                technology: 'express', category: 'backend',
            }),
        };
        const result = detectScreens(snapshot, services);
        expect(result).toEqual({});
    });

    it('frontend (non-mobile) service with .swift file is ignored (native detectors are mobile-gated)', () => {
        // category=frontend triggers the Next.js / Nuxt / etc. paths,
        // but the Android / iOS / Flutter detectors run only when
        // category === 'mobile' — so a Swift file in a Next.js service
        // doesn't accidentally emit ios-uikit screens.
        const snapshot = mkSnapshotWithContent({
            'apps/web/HomeView.swift': 'struct HomeView: View { var body: some View { Text("x") } }',
        });
        const services: Record<string, ServiceRecord> = {
            'service:web': makeService({
                id: 'service:web', name: 'web', rootPath: 'apps/web',
                technology: 'nextjs', category: 'frontend',
            }),
        };
        const result = detectScreens(snapshot, services);
        expect(Object.values(result).filter((s) => s.framework === 'ios-swiftui')).toEqual([]);
    });
});

describe('detectScreens — React SPA via react-router (PR-E)', () => {
    function spaService(): Record<string, ServiceRecord> {
        return {
            'service:spa': makeService({
                id: 'service:spa', name: 'spa', rootPath: 'apps/spa',
                technology: 'unknown', category: 'frontend',
            }),
        };
    }

    it('JSX <Route path="/home" element={<Home />} /> → react-spa screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/spa/src/App.tsx':
                "import { Route, Routes } from 'react-router-dom';\nfunction App() { return <Routes><Route path=\"/home\" element={<Home />} /></Routes>; }",
        });
        const result = detectScreens(snapshot, spaService());
        const screen = Object.values(result).find((s) => s.framework === 'react-spa');
        expect(screen).toBeDefined();
        expect(screen!.routePath).toBe('/home');
    });

    it('multiple <Route> declarations → multiple screens', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/spa/src/App.tsx':
                "import { Route, Routes } from 'react-router-dom';\n<Routes>\n  <Route path=\"/\" element={<Home />} />\n  <Route path=\"/about\" element={<About />} />\n  <Route path=\"/users/:id\" element={<User />} />\n</Routes>",
        });
        const result = detectScreens(snapshot, spaService());
        const routes = Object.values(result).filter((s) => s.framework === 'react-spa').map((s) => s.routePath).sort();
        expect(routes).toEqual(['/', '/about', '/users/:id']);
    });

    it('object-config createBrowserRouter([{ path: "/dash", element: <Dash /> }]) → react-spa screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/spa/src/router.ts':
                "import { createBrowserRouter } from 'react-router-dom';\nconst router = createBrowserRouter([\n  { path: '/dash', element: <Dash /> },\n]);",
        });
        const result = detectScreens(snapshot, spaService());
        const dash = Object.values(result).find((s) => s.framework === 'react-spa' && s.routePath === '/dash');
        expect(dash).toBeDefined();
    });

    it('catch-all <Route path="*" /> is NOT a screen (sentinel)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/spa/src/App.tsx':
                "import { Route } from 'react-router-dom';\n<Route path=\"*\" element={<NotFound />} />",
        });
        const result = detectScreens(snapshot, spaService());
        expect(Object.values(result).filter((s) => s.framework === 'react-spa')).toEqual([]);
    });

    it('<Route> in a file with NO react-router import is NOT detected (disambiguator gate)', () => {
        // A custom component happens to be named Route — without the
        // import gate this would over-emit screens for unrelated
        // libraries.
        const snapshot = mkSnapshotWithContent({
            'apps/spa/src/CustomRoute.tsx':
                "function CustomRoute({ path }: { path: string }) { return null; }\n<Route path=\"/fake\" />",
        });
        const result = detectScreens(snapshot, spaService());
        expect(Object.values(result).filter((s) => s.framework === 'react-spa')).toEqual([]);
    });

    it('react-native service does NOT emit react-spa screens (mobile services use RN nav instead)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/mobile/src/App.tsx':
                "import { Route } from 'react-router-dom';\n<Route path=\"/home\" element={<Home />} />",
        });
        const services: Record<string, ServiceRecord> = {
            'service:mobile': makeService({
                id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile',
                technology: 'react-native', category: 'mobile',
            }),
        };
        const result = detectScreens(snapshot, services);
        expect(Object.values(result).filter((s) => s.framework === 'react-spa')).toEqual([]);
    });
});

describe('detectScreens — React Native manual navigation (PR-E)', () => {
    function rnService(): Record<string, ServiceRecord> {
        return {
            'service:mobile': makeService({
                id: 'service:mobile', name: 'mobile', rootPath: 'apps/mobile',
                technology: 'react-native', category: 'mobile',
            }),
        };
    }

    it('<Stack.Screen name="Home" component={Home} /> → react-native-nav screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/mobile/src/Navigator.tsx':
                "import { createNativeStackNavigator } from '@react-navigation/native-stack';\nconst Stack = createNativeStackNavigator();\nfunction Nav() { return <Stack.Navigator><Stack.Screen name=\"Home\" component={Home} /></Stack.Navigator>; }",
        });
        const result = detectScreens(snapshot, rnService());
        const home = Object.values(result).find((s) => s.framework === 'react-native-nav');
        expect(home).toBeDefined();
        expect(home!.routePath).toBe('Home');
    });

    it('<Tab.Screen name="Profile" component={Profile} /> → react-native-nav screen', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/mobile/src/Tabs.tsx':
                "import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';\nconst Tab = createBottomTabNavigator();\n<Tab.Navigator>\n  <Tab.Screen name=\"Profile\" component={Profile} />\n  <Tab.Screen name=\"Settings\" component={Settings} />\n</Tab.Navigator>",
        });
        const result = detectScreens(snapshot, rnService());
        const screens = Object.values(result).filter((s) => s.framework === 'react-native-nav').map((s) => s.routePath).sort();
        expect(screens).toEqual(['Profile', 'Settings']);
    });

    it('<Drawer.Screen ... /> declarations → react-native-nav screens', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/mobile/src/Drawer.tsx':
                "import { createDrawerNavigator } from '@react-navigation/drawer';\nconst Drawer = createDrawerNavigator();\n<Drawer.Screen name=\"About\" component={About} />",
        });
        const result = detectScreens(snapshot, rnService());
        const about = Object.values(result).find((s) => s.routePath === 'About');
        expect(about).toBeDefined();
        expect(about!.framework).toBe('react-native-nav');
    });

    it('files without @react-navigation/* import are NOT scanned (disambiguator gate)', () => {
        const snapshot = mkSnapshotWithContent({
            'apps/mobile/src/Random.tsx':
                "function CustomStack() { return null; }\n<Stack.Screen name=\"Fake\" />",
        });
        const result = detectScreens(snapshot, rnService());
        expect(Object.values(result).filter((s) => s.framework === 'react-native-nav')).toEqual([]);
    });
});

describe('detectScreens — backend service with page.tsx files (category gate, PR-B sanity)', () => {
    // A backend service that incidentally ships a sample Next.js demo
    // app under its rootPath should NOT produce screens — the category
    // gate must hold even when the file convention matches.
    it('backend service with apps/api/app/page.tsx is gated out', () => {
        const snapshot = mkSnapshot(['apps/api/app/page.tsx']);
        const services = {
            'service:api': makeService({
                id: 'service:api', name: 'api', rootPath: 'apps/api',
                technology: 'express', category: 'backend',
            }),
        };
        const result = detectScreens(snapshot, services);
        expect(result).toEqual({});
    });
});
