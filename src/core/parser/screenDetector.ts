/**
 * screenDetector.ts — Per-framework screen enumeration for FE/mobile services.
 *
 * v2 phase 3 (#484 — L2a screen enumeration (flat list, per-framework detectors)) per `docs/v2-frontend-mobile-layer-spec.md` §3 (L2a).
 * Frontend / mobile services replace today's Louvain clustering with a
 * flat list of screens at L2a. This module owns the detection logic;
 * the L2a renderer in `webview-ui/src/components/FeatureView.tsx` reads
 * the resulting `ScreenRecord[]` and presents it to the user.
 *
 * Detection strategy: file-convention-based + content-regex per
 * framework. Each framework gets its own self-contained detector
 * function called from the central `detectScreens()` dispatcher.
 * Service category gates the dispatch — backend services produce zero
 * screens and the cost of running the detector against them is one
 * `category === 'backend'` early-return per service.
 *
 * Per-framework detectors are added incrementally across PR-B through
 * PR-E of v2 phase 3:
 *
 *   - PR-B: Next.js App Router + Pages Router
 *   - PR-C: Nuxt + Remix + SvelteKit + Expo Router
 *   - PR-D: Android Activity / Fragment / Compose + iOS UIKit /
 *           SwiftUI + Flutter GoRouter / Navigator
 *   - PR-E: React SPA (react-router) + React Native manual nav
 *           (Stack.Screen / Tab.Screen / Drawer.Screen declarations)
 *
 * PR-A (this PR) lands the types, storage, scaffolding, and the empty
 * dispatcher. Per-framework detectors are stubs that return [];
 * `detectScreens()` returns an empty `Record<string, ScreenRecord>`.
 */

import type { Snapshot, ScreenRecord, ServiceRecord, ScreenFramework, Anchor, FileRecord } from '../graph/graphTypes';
import { inferRouteFromFilePath } from './frameworkDetector';
import { detectLanguage } from './treeSitterParser';

/**
 * Optional content fallback for files whose `FileRecord.content` has
 * been lazy-dropped post-save. Matches the same shape used by
 * `serviceDetector.ts`.
 */
export type ContentProvider = (filePath: string) => string | undefined;

/**
 * Detect every user-visible screen across the workspace's FE/mobile
 * services. Returns an empty record when no services qualify or no
 * framework matches the source files.
 *
 * The result is keyed by `screenId` and intended to be written
 * directly to `snapshot.screens` via `store.updateWorkingScreens()`.
 */
export function detectScreens(
    snapshot: Snapshot,
    services: Record<string, ServiceRecord>,
    getContent?: ContentProvider,
): Record<string, ScreenRecord> {
    const screens: Record<string, ScreenRecord> = {};
    for (const service of Object.values(services)) {
        if (service.category !== 'frontend' && service.category !== 'mobile') continue;
        // Filter files to those owned by this service. rootPath === ''
        // is the workspace-wide catch-all (orphan-guard `main` service).
        const serviceFiles = Object.keys(snapshot.files).filter((fp) =>
            service.rootPath === '' ||
            fp.startsWith(service.rootPath + '/') ||
            fp === service.rootPath,
        );
        // Per-framework detectors. Each one appends its screen records
        // to `screens` via the shared `emit` helper so id collisions
        // are de-duplicated at the dispatcher level (a single file
        // can't be a screen for two frameworks at once).
        detectNextJsScreens(service, serviceFiles, screens);
        detectNuxtScreens(service, serviceFiles, screens);
        detectRemixScreens(service, serviceFiles, screens);
        detectSvelteKitScreens(service, serviceFiles, screens);
        detectExpoRouterScreens(service, serviceFiles, screens);
        // PR-D native + Flutter — content-based detection.
        if (service.category === 'mobile') {
            detectAndroidScreens(service, serviceFiles, snapshot, screens, getContent);
            detectIosScreens(service, serviceFiles, snapshot, screens, getContent);
            detectFlutterScreens(service, serviceFiles, snapshot, screens, getContent);
        }
        // PR-E React SPA (react-router) + React Native manual nav.
        // Both FE and mobile categories can use these patterns:
        //   - React SPA's react-router `<Route path="..." />` appears
        //     in `category: 'frontend'` (e.g. a Vite SPA).
        //   - React Native's `<Stack.Screen name="..." />` / `<Tab.Screen ... />`
        //     appears in `category: 'mobile'` services that don't use
        //     Expo Router (manual React Navigation setup).
        detectReactSpaScreens(service, serviceFiles, snapshot, screens, getContent);
        detectReactNativeNavScreens(service, serviceFiles, snapshot, screens, getContent);
    }
    return screens;
}

/**
 * Emit one `ScreenRecord` into the dispatcher's result map.
 *
 * Id form: `screen:<serviceId>:<routePath>` — stable across cascade
 * rebuilds so the L2a panel can preserve scroll position / selection
 * when a single screen changes. Duplicate emits for the same id
 * (e.g. two detectors matching the same file) silently keep the
 * FIRST hit — per spec §3 the per-framework detectors are mutually
 * exclusive by file convention.
 */
function emitScreen(
    screens: Record<string, ScreenRecord>,
    record: Omit<ScreenRecord, 'screenId'> & { screenId?: string },
): void {
    const screenId = record.screenId ?? `screen:${record.serviceId}:${record.routePath}`;
    if (screens[screenId]) return;
    screens[screenId] = { ...record, screenId };
}

/**
 * Anchor pointing at the start of `filePath` — Next.js screens are
 * declared by file existence, not by a specific symbol within the
 * file, so column 0 line 1 is the correct landing point.
 */
function fileAnchor(filePath: string): Anchor {
    return { filePath, lineStart: 1, lineEnd: 1 };
}

// ── Next.js App Router + Pages Router ──────────────────────────────
// Each `app/.../page.{tsx,jsx,js}` is one screen (App Router).
// Each `pages/*.{tsx,jsx,js}` excluding `_app`, `_document`, `_error`,
// `api/*` is one screen (Pages Router). routePath comes from
// `inferRouteFromFilePath` so the L2a label matches what end users
// actually type into a browser address bar.

const NEXTJS_APP_ROUTER_RE = /\/(?:app|src\/app)\/(?:[^/]+\/)*page\.(?:tsx|jsx|js|ts)$/;
const NEXTJS_PAGES_RE = /\/(?:pages|src\/pages)\/(?!api\/)(?!_app)(?!_document)(?!_error)(?!_)[^/]*\.(?:tsx|jsx|js|ts)$|\/(?:pages|src\/pages)\/(?!api\/)(?:[^/]+\/)*(?!_app)(?!_document)(?!_error)(?!_)[^/]+\.(?:tsx|jsx|js|ts)$/;

function isNextAppRouterPage(filePath: string): boolean {
    // Match `app/.../page.{ext}` or `src/app/.../page.{ext}`. The
    // leading `/` in the regex ensures we don't false-match a literal
    // `page.tsx` at workspace root that has no `app/` parent.
    return /(?:^|\/)(?:src\/)?app\/(?:[^/]+\/)*page\.(?:tsx|jsx|js|ts)$/.test(filePath);
}

function isNextPagesPage(filePath: string): boolean {
    // Match `pages/<anything>.{ext}` or `pages/<dir>/<anything>.{ext}`,
    // excluding api routes and the special `_app` / `_document` /
    // `_error` files (Pages Router convention).
    const m = /(?:^|\/)(?:src\/)?pages\/(.+)\.(?:tsx|jsx|js|ts)$/.exec(filePath);
    if (!m) return false;
    const inner = m[1];
    if (inner.startsWith('api/') || inner === 'api') return false;
    const base = inner.split('/').pop() ?? '';
    if (base === '_app' || base === '_document' || base === '_error') return false;
    if (base.startsWith('_')) return false;
    return true;
}

function detectNextJsScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    screens: Record<string, ScreenRecord>,
): void {
    for (const fp of serviceFiles) {
        if (isNextAppRouterPage(fp)) {
            // `inferRouteFromFilePath` strips `/route.ts` (the App
            // Router endpoint convention) but NOT `/page.tsx` (the
            // App Router screen convention). Strip `/page.X` first so
            // the helper sees `app/dashboard/` and returns `/dashboard`.
            const stripped = fp.replace(/\/page\.(?:tsx|jsx|ts|js)$/, '/_page_.ts');
            const routePath = (inferRouteFromFilePath(stripped, ['app/', 'src/app/']) ?? '/')
                .replace(/\/_page_$/, '') || '/';
            emitScreen(screens, {
                serviceId: service.id,
                routePath,
                framework: 'nextjs-app',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
            continue;
        }
        if (isNextPagesPage(fp)) {
            const routePath = inferRouteFromFilePath(fp, ['pages/', 'src/pages/']) ?? '/';
            emitScreen(screens, {
                serviceId: service.id,
                routePath,
                framework: 'nextjs-pages',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// ── Nuxt 3 ─────────────────────────────────────────────────────────
// Each `pages/*.vue` is one screen (Nuxt 3 file-system router).
// `pages/_app.vue` / `pages/_error.vue` / `pages/_layout.vue` are NOT
// screens (Nuxt 2 conventions kept here for safety) — gated like Next
// Pages's `_*` exclusion.

function isNuxtPage(filePath: string): boolean {
    const m = /(?:^|\/)pages\/(.+)\.vue$/.exec(filePath);
    if (!m) return false;
    const inner = m[1];
    const base = inner.split('/').pop() ?? '';
    if (base.startsWith('_')) return false;
    return true;
}

function detectNuxtScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    screens: Record<string, ScreenRecord>,
): void {
    for (const fp of serviceFiles) {
        if (!isNuxtPage(fp)) continue;
        const routePath = inferRouteFromFilePath(fp, ['pages/']) ?? '/';
        emitScreen(screens, {
            serviceId: service.id,
            routePath,
            framework: 'nuxt',
            filePath: fp,
            anchor: fileAnchor(fp),
        });
    }
}

// ── Remix ──────────────────────────────────────────────────────────
// Each `app/routes/*.{tsx,jsx,ts,js}` is one screen. Route file naming
// conventions: dotted segments (`articles.$id.tsx` for `/articles/:id`),
// `_index.tsx` (the segment's root), `__layout.tsx` (route-level layout
// — NOT a screen).
//
// First-pass detection: derive routePath from the file path with
// `inferRouteFromFilePath(fp, ['app/routes/', 'routes/'])`. The helper
// strips the extension; nothing else is normalised — `_index` stays as
// `/_index` and `articles.$id` stays as `/articles.$id`. Cleaner
// route-template normalisation can come later (#484-route-norm).

function isRemixRoute(filePath: string): boolean {
    const m = /(?:^|\/)(?:app\/routes|routes)\/(.+)\.(?:tsx|jsx|ts|js)$/.exec(filePath);
    if (!m) return false;
    const inner = m[1];
    const base = inner.split('/').pop() ?? '';
    // `__layout.tsx` / `__layout.<segment>.tsx` are route-level layouts.
    if (base.startsWith('__')) return false;
    // SvelteKit conventions live under `src/routes/` and use `+`-prefixed
    // file names. Skip them so they don't double-match as Remix routes.
    if (base.startsWith('+')) return false;
    return true;
}

function detectRemixScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    screens: Record<string, ScreenRecord>,
): void {
    for (const fp of serviceFiles) {
        if (!isRemixRoute(fp)) continue;
        const routePath = inferRouteFromFilePath(fp, ['app/routes/', 'routes/']) ?? '/';
        emitScreen(screens, {
            serviceId: service.id,
            routePath,
            framework: 'remix',
            filePath: fp,
            anchor: fileAnchor(fp),
        });
    }
}

// ── SvelteKit ──────────────────────────────────────────────────────
// Each `+page.svelte` under `src/routes/` (or `routes/`) is one screen.
// `+layout.svelte`, `+error.svelte`, `+server.ts` are NOT screens.

function isSvelteKitPage(filePath: string): boolean {
    return /(?:^|\/)(?:src\/)?routes\/(?:[^/]+\/)*\+page\.svelte$/.test(filePath);
}

function detectSvelteKitScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    screens: Record<string, ScreenRecord>,
): void {
    for (const fp of serviceFiles) {
        if (!isSvelteKitPage(fp)) continue;
        // `inferRouteFromFilePath` only strips `/+page.<ext>` when
        // there's a preceding `/`. For top-level `+page.svelte` it
        // returns `/+page`. Pre-substitute `/+page.svelte` with a
        // sentinel so the helper sees a directory and emits `/`.
        const stripped = fp.replace(/\/\+page\.svelte$/, '/_skpage_.svelte');
        const routePath = (inferRouteFromFilePath(stripped, ['src/routes/', 'routes/']) ?? '/')
            .replace(/\/_skpage_$/, '') || '/';
        emitScreen(screens, {
            serviceId: service.id,
            routePath,
            framework: 'sveltekit',
            filePath: fp,
            anchor: fileAnchor(fp),
        });
    }
}

// ── Expo Router ────────────────────────────────────────────────────
// Each `app/*.{tsx,jsx,ts,js}` is one screen, with these exceptions:
//   - `_layout.<ext>` — route-level layout, NOT a screen
//   - `_error.<ext>` — error boundary, NOT a screen
//   - `+not-found.<ext>` — fallback, NOT a screen
//   - `index.<ext>` — root screen, route `/`
//
// IMPORTANT: distinguishes from Next.js App Router by file naming.
// Expo Router files are NAMED after the route (`dashboard.tsx`,
// `profile.tsx`) whereas Next.js uses `page.tsx` inside a directory.
// `app/dashboard/page.tsx` is Next; `app/dashboard.tsx` is Expo.
// Group routes wrapped in parens (`(tabs)`, `(auth)`) get stripped.

function isExpoRouterScreen(filePath: string): boolean {
    const m = /(?:^|\/)app\/(.+)\.(?:tsx|jsx|ts|js)$/.exec(filePath);
    if (!m) return false;
    const inner = m[1];
    const base = inner.split('/').pop() ?? '';
    if (base === 'page' || base === 'route' || base === 'layout') return false;     // Next.js conventions
    if (base.startsWith('_layout') || base.startsWith('_error')) return false;
    if (base.startsWith('+not-found')) return false;
    if (base.startsWith('_')) return false;
    // Exclude api routes embedded in Expo's app/ dir (e.g. app/api/foo.ts
    // is sometimes used for Next-style API handlers).
    if (inner.startsWith('api/')) return false;
    return true;
}

function expoRoutePath(filePath: string): string {
    const m = /(?:^|\/)app\/(.+)\.(?:tsx|jsx|ts|js)$/.exec(filePath);
    if (!m) return '/';
    let inner = m[1];
    // Strip group route segments — `(tabs)/home.tsx` → `home`, the
    // Expo Router convention for organising files without affecting URLs.
    inner = inner.split('/').filter((seg) => !/^\([^)]+\)$/.test(seg)).join('/');
    if (inner === 'index') return '/';
    if (inner.endsWith('/index')) inner = inner.slice(0, -'/index'.length);
    return '/' + inner;
}

function detectExpoRouterScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    screens: Record<string, ScreenRecord>,
): void {
    // Heuristic: only run Expo detection if the service is React Native
    // or if at least one file in the service references `expo-router`.
    // This prevents Expo from over-firing on Next.js App Router files
    // (where `app/foo.tsx` shouldn't be a screen — only `app/foo/page.tsx`
    // is). Tech-tag check is the cheap path; a content-grep fallback
    // would be needed when tech is misclassified, but for first pass
    // tech-based gating is good enough.
    if (service.technology !== 'react-native' &&
        !serviceFiles.some((fp) => /(?:^|\/)app\/_layout\.(?:tsx|jsx|ts|js)$/.test(fp))) {
        // `_layout.tsx` at app/ root is the Expo Router signature — Next.js
        // App Router uses `layout.tsx` (no underscore). Presence of
        // `_layout.tsx` is a strong "this is an Expo Router service" hint.
        return;
    }
    for (const fp of serviceFiles) {
        if (!isExpoRouterScreen(fp)) continue;
        // Skip files that look like Next App Router pages — those land
        // via `detectNextJsScreens` instead.
        if (isNextAppRouterPage(fp)) continue;
        const routePath = expoRoutePath(fp);
        emitScreen(screens, {
            serviceId: service.id,
            routePath,
            framework: 'expo-router',
            filePath: fp,
            anchor: fileAnchor(fp),
        });
    }
}

// ── Helpers for content-based detectors (PR-D / PR-E) ──────────────

function readContent(rec: FileRecord | undefined, fp: string, getContent?: ContentProvider): string {
    if (rec && typeof rec.content === 'string' && rec.content.length > 0) return rec.content;
    return getContent?.(fp) ?? '';
}

// ── Android screens (PR-D) ─────────────────────────────────────────
// - Activity:   `class Foo : (AppCompatActivity|Activity|...)` in .kt/.java
// - Fragment:   `class Foo : (Fragment|DialogFragment|...)` in .kt/.java
// - Composable: `composable("route") { ... }` inside a NavHost block
//
// Activity / Fragment route paths are the class FQN (Android nav doesn't
// use URL paths). Composable route paths are the literal route string.
//
// AndroidManifest.xml `<activity>` declarations are an additional source
// of truth, but they're already scanned for entry-point detection by
// `mobileDetector.ts`. Re-scanning here would duplicate work; instead
// we rely on the class-body match.

const ANDROID_ACTIVITY_BASE_RE = /\bclass\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*[\w.]*?(AppCompatActivity|ComponentActivity|FragmentActivity|Activity|PreferenceActivity)\b/g;
const ANDROID_FRAGMENT_BASE_RE = /\bclass\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*[\w.]*?(Fragment|DialogFragment|BottomSheetDialogFragment|PreferenceFragmentCompat)\b/g;
const ANDROID_COMPOSE_NAVHOST_RE = /\bcomposable\s*\(\s*(?:route\s*=\s*)?["']([^"']+)["']/g;

function detectAndroidScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
): void {
    for (const fp of serviceFiles) {
        const lang = detectLanguage(fp);
        if (lang !== 'kotlin' && lang !== 'java') continue;
        const content = readContent(snapshot.files[fp], fp, getContent);
        if (!content) continue;

        // Activity
        ANDROID_ACTIVITY_BASE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ANDROID_ACTIVITY_BASE_RE.exec(content)) !== null) {
            const className = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: className,
                framework: 'android-activity',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
        // Fragment
        ANDROID_FRAGMENT_BASE_RE.lastIndex = 0;
        while ((m = ANDROID_FRAGMENT_BASE_RE.exec(content)) !== null) {
            const className = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: className,
                framework: 'android-fragment',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
        // Compose NavHost destinations
        ANDROID_COMPOSE_NAVHOST_RE.lastIndex = 0;
        while ((m = ANDROID_COMPOSE_NAVHOST_RE.exec(content)) !== null) {
            const route = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: route,
                framework: 'android-compose',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// ── iOS screens (PR-D) ─────────────────────────────────────────────
// - UIKit:   `class Foo: UIViewController { ... }` (and subclasses)
// - SwiftUI: `struct Foo: View { ... }` — broad match because the
//   spec wants every SwiftUI View as a screen candidate. Refinement
//   to "only Views used as NavigationLink destinations / WindowGroup
//   roots" can land in a follow-up if the noise level proves a
//   problem in real projects.

const IOS_UIKIT_RE = /\bclass\s+(\w+)\s*:\s*([\w.]*?(?:UIViewController|UITableViewController|UICollectionViewController|UINavigationController|UITabBarController|UIPageViewController|UISplitViewController))\b/g;
const IOS_SWIFTUI_RE = /\bstruct\s+(\w+)\s*:\s*(?:\w+,\s*)*View\b/g;

function detectIosScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
): void {
    for (const fp of serviceFiles) {
        const lang = detectLanguage(fp);
        if (lang !== 'swift') continue;
        const content = readContent(snapshot.files[fp], fp, getContent);
        if (!content) continue;

        IOS_UIKIT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = IOS_UIKIT_RE.exec(content)) !== null) {
            const className = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: className,
                framework: 'ios-uikit',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
        IOS_SWIFTUI_RE.lastIndex = 0;
        while ((m = IOS_SWIFTUI_RE.exec(content)) !== null) {
            const structName = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: structName,
                framework: 'ios-swiftui',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// ── Flutter screens (PR-D) ─────────────────────────────────────────
// - GoRouter:  `GoRoute(path: '/...')` declarations — the path string
//              becomes the route.
// - Navigator: `MaterialPageRoute(builder: (context) => Foo())` — the
//              widget class instantiated inside the builder becomes the
//              route key. We match the simple form; complex builders
//              that wrap or compose multiple widgets are not detected.

const FLUTTER_GOROUTE_RE = /\bGoRoute\s*\(\s*[\s\S]{0,200}?path\s*:\s*['"]([^'"]+)['"]/g;
const FLUTTER_MATERIAL_PAGE_ROUTE_RE = /\bMaterialPageRoute\s*\(\s*[\s\S]{0,200}?builder\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+|new\s+)?(\w+)\s*\(/g;

function detectFlutterScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
): void {
    for (const fp of serviceFiles) {
        const lang = detectLanguage(fp);
        if (lang !== 'dart') continue;
        const content = readContent(snapshot.files[fp], fp, getContent);
        if (!content) continue;

        FLUTTER_GOROUTE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FLUTTER_GOROUTE_RE.exec(content)) !== null) {
            const route = m[1];
            emitScreen(screens, {
                serviceId: service.id,
                routePath: route,
                framework: 'flutter-goroute',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
        FLUTTER_MATERIAL_PAGE_ROUTE_RE.lastIndex = 0;
        while ((m = FLUTTER_MATERIAL_PAGE_ROUTE_RE.exec(content)) !== null) {
            const widget = m[1];
            // Filter very common Flutter built-ins so the L2a list isn't
            // polluted (`Container`, `Scaffold`, ...). These would never
            // be a meaningful "screen" key.
            if (/^(?:Container|Scaffold|Center|Column|Row|Padding|Material|Widget|StatelessWidget|StatefulWidget|Builder|FutureBuilder|StreamBuilder)$/.test(widget)) continue;
            emitScreen(screens, {
                serviceId: service.id,
                routePath: widget,
                framework: 'flutter-material-page-route',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// ── React SPA (react-router) screens (PR-E) ────────────────────────
// Each `<Route path="/foo" ... />` declaration becomes one screen.
// React Router 6 has two prevailing call shapes:
//   1. JSX:     `<Route path="/foo" element={<Foo />} />`
//   2. Object:  `createBrowserRouter([{ path: '/foo', element: <Foo /> }])`
//
// Both contribute their path string as the routePath. The component
// reference (`<Foo />` or `element: <Foo />`) isn't extracted in this
// first pass — the L2a label is the URL, which is what users navigate
// by anyway.

const REACT_ROUTE_JSX_RE = /<Route\s+(?:[^>]*\s)?path\s*=\s*[`'"]([^`'"]+)[`'"]/g;
const REACT_ROUTE_OBJECT_RE = /\{\s*[\s\S]{0,80}?path\s*:\s*[`'"]([^`'"]+)[`'"][\s\S]{0,200}?element\s*:/g;

function detectReactSpaScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
): void {
    // Skip mobile services that use React Native — those go through
    // `detectReactNativeNavScreens` below with a different JSX shape.
    if (service.technology === 'react-native') return;
    for (const fp of serviceFiles) {
        const lang = detectLanguage(fp);
        if (lang !== 'javascript' && lang !== 'typescript') continue;
        const content = readContent(snapshot.files[fp], fp, getContent);
        if (!content) continue;
        // Require some form of react-router import in the file to
        // avoid false matches on unrelated `<Route>` JSX (e.g. a
        // custom component named Route).
        if (!/from\s+['"]react-router(?:-dom)?['"]/.test(content)) continue;

        REACT_ROUTE_JSX_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = REACT_ROUTE_JSX_RE.exec(content)) !== null) {
            const route = m[1];
            // Skip empty/index sentinel paths that react-router supports.
            if (!route || route === '*') continue;
            emitScreen(screens, {
                serviceId: service.id,
                routePath: route,
                framework: 'react-spa',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
        REACT_ROUTE_OBJECT_RE.lastIndex = 0;
        while ((m = REACT_ROUTE_OBJECT_RE.exec(content)) !== null) {
            const route = m[1];
            if (!route || route === '*') continue;
            emitScreen(screens, {
                serviceId: service.id,
                routePath: route,
                framework: 'react-spa',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// ── React Native manual nav (PR-E) ─────────────────────────────────
// `<Stack.Screen name="Home" ... />` / `<Tab.Screen ... />` /
// `<Drawer.Screen ... />` declarations from `@react-navigation/native`'s
// native navigators. The `name` attribute is the route key.
//
// Only fires when the file imports something from
// `@react-navigation/*` — otherwise a custom component named
// `Stack.Screen` would false-match.

const RN_NAV_SCREEN_RE = /<(?:Stack|Tab|Drawer|BottomTab|MaterialTopTab|TopTab|NativeStack)\.Screen\s+(?:[^>]*\s)?name\s*=\s*[`'"]([^`'"]+)[`'"]/g;

function detectReactNativeNavScreens(
    service: ServiceRecord,
    serviceFiles: string[],
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
): void {
    for (const fp of serviceFiles) {
        const lang = detectLanguage(fp);
        if (lang !== 'javascript' && lang !== 'typescript') continue;
        const content = readContent(snapshot.files[fp], fp, getContent);
        if (!content) continue;
        // Require @react-navigation/* import in the file as the
        // disambiguator — same shape as the React Native SDK detection.
        if (!/from\s+['"]@react-navigation\//.test(content)) continue;

        RN_NAV_SCREEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RN_NAV_SCREEN_RE.exec(content)) !== null) {
            const route = m[1];
            if (!route) continue;
            emitScreen(screens, {
                serviceId: service.id,
                routePath: route,
                framework: 'react-native-nav',
                filePath: fp,
                anchor: fileAnchor(fp),
            });
        }
    }
}

// Exported helpers for unit tests — internal `is*` checks are easier
// to test in isolation than through the dispatcher.
export const _testing = {
    isNextAppRouterPage,
    isNextPagesPage,
    isNuxtPage,
    isRemixRoute,
    isSvelteKitPage,
    isExpoRouterScreen,
    expoRoutePath,
    NEXTJS_APP_ROUTER_RE,
    NEXTJS_PAGES_RE,
    ANDROID_ACTIVITY_BASE_RE,
    ANDROID_FRAGMENT_BASE_RE,
    ANDROID_COMPOSE_NAVHOST_RE,
    IOS_UIKIT_RE,
    IOS_SWIFTUI_RE,
    FLUTTER_GOROUTE_RE,
    FLUTTER_MATERIAL_PAGE_ROUTE_RE,
    REACT_ROUTE_JSX_RE,
    REACT_ROUTE_OBJECT_RE,
    RN_NAV_SCREEN_RE,
};
