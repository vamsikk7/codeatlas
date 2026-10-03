/**
 * mobile/react.ts — React / Next.js / React Native / Expo Router plugin.
 *
 * Single plugin covers four overlapping ecosystems that all live in JS/TS:
 *   - React (web): page/screen directories, react-router `<Route>`/`<Link>`
 *   - Next.js: `pages/` / `app/` default exports, `router.push`
 *   - React Native: `*Screen` components, navigation stacks, push handlers
 *   - Expo Router: `<Stack.Screen>`, `<Tabs.Screen>`, `<Redirect>`, group routes
 *
 * Plus framework-agnostic data hooks (TanStack Query, SWR, Redux,
 * Zustand, Jotai) and `fetch()` in non-API files. Gates by language
 * (JS / TS only); each block has its own import gate so unrelated React
 * code doesn't trigger Expo / RN-specific detection.
 */

import type { MobilePlatformPlugin } from './types';
import type { ApiRecord } from '../../graph/graphTypes';
import type { SupportedLanguage } from '../treeSitterParser';
import { makeItem, isTestFile } from './_shared';

function isReactNativeFile(source: string): boolean {
    return /from\s+['"]react-native['"]|require\s*\(\s*['"]react-native['"]/.test(source);
}

function isReactScreenPath(filePath: string): boolean {
    return /(?:^|\/)(?:pages|screens|views|app)\//.test(filePath) &&
        !/(?:^|\/)(?:pages\/api|app\/api)\//.test(filePath);
}

/**
 * Framework special files that live under pages/ or app/ but are NOT
 * navigable screens (BUG-VERIFY-5). Covers Next.js Pages Router
 * (`_app`, `_document`, `_error`, `404`, `500`), Next.js App Router
 * (`layout`, `loading`, `error`, `global-error`, `not-found`, `template`,
 * `default`, metadata routes), and Expo Router (`_layout`, `+not-found`,
 * `+html`, `+native-intent`). Mirrors the exclusions screenDetector.ts
 * already enforces (lines 148, 315-317) so the apiIndex SCREEN list can't
 * diverge from snapshot.screens. Basename is taken before the FIRST dot so
 * platform suffixes (`.web`/`.native`/`.ios`/`.android`) don't defeat it.
 */
const SCREEN_SPECIAL_BASENAMES = new Set([
    '_app', '_document', '_error', '404', '500',
    'layout', '_layout', 'loading', 'error', 'global-error',
    'not-found', '+not-found', 'template', 'default',
    'robots', 'sitemap', 'manifest', 'favicon',
    '+html', '+native-intent',
]);

function isScreenSpecialFile(filePath: string): boolean {
    const base = (filePath.split('/').pop() ?? '').split('.')[0].toLowerCase();
    if (SCREEN_SPECIAL_BASENAMES.has(base)) return true;
    if (base.endsWith('-wrapper')) return true;                 // children-wrapper etc.
    if (/^(?:apple-)?icon\d*$/.test(base)) return true;         // metadata icon routes
    if (/(?:opengraph|twitter)-image/.test(base)) return true;  // metadata image routes
    return false;
}

/** Script / mock / build directories are never screen locations. */
function isNonScreenLocation(filePath: string): boolean {
    return /(?:^|\/)(?:scripts?|__mocks__|\.expo|\.next|node_modules|dist|build|coverage|\.storybook)\//.test(filePath);
}

/**
 * Infer screen route from file path convention.
 * pages/dashboard.tsx → /dashboard, app/settings/page.tsx → /settings
 */
function inferScreenRoute(filePath: string): string {
    for (const prefix of ['pages/', 'app/', 'screens/', 'views/', 'src/pages/', 'src/app/', 'src/screens/']) {
        const idx = filePath.indexOf(prefix);
        if (idx === -1) continue;
        let route = filePath.slice(idx + prefix.length);
        // Strip Expo Router group segments: (auth)/, (tabs)/, etc.
        route = route.replace(/\([^)]+\)\//g, '');
        // Strip _layout files (Expo Router layout files)
        route = route.replace(/\/?_layout\.\w+$/, '');
        route = route.replace(/\/page\.\w+$/, '').replace(/(?:^|\/)index\.\w+$/, '').replace(/\.\w+$/, '');
        if (!route.startsWith('/')) route = '/' + route;
        return route.replace(/\/+$/, '') || '/';
    }
    return '/' + (filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? '');
}

function detectReactItems(source: string, filePath: string, language: SupportedLanguage): ApiRecord[] {
    if (language !== 'javascript' && language !== 'typescript') return [];
    if (isTestFile(filePath)) return [];
    const items: ApiRecord[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;

    // A file is a candidate screen location only when it isn't a framework
    // special file (_layout / _app / 404 / not-found / …) and isn't a
    // script/mock/build path (BUG-VERIFY-5).
    const isScreenCandidate = !isScreenSpecialFile(filePath) && !isNonScreenLocation(filePath);

    // Screens: export default in page/screen directories
    if (isReactScreenPath(filePath) && isScreenCandidate) {
        const defaultExport = /export\s+default\s+(?:function|class)\s+(\w+)/g;
        while ((m = defaultExport.exec(source)) !== null) {
            const name = m[1];
            if (!seen.has(`screen:${name}`)) {
                seen.add(`screen:${name}`);
                const route = inferScreenRoute(filePath);
                items.push(makeItem('SCREEN', route, name, filePath, m.index));
            }
        }
    }

    // React Native screens
    if (isReactNativeFile(source) && isScreenCandidate) {
        const rnScreen = /(?:export\s+(?:default\s+)?)?(?:function|class)\s+(\w+Screen)\b/g;
        while ((m = rnScreen.exec(source)) !== null) {
            if (!seen.has(`screen:${m[1]}`)) {
                seen.add(`screen:${m[1]}`);
                items.push(makeItem('SCREEN', `/${m[1]}`, m[1], filePath, m.index));
            }
        }
    }

    // Navigation: <Route path="...">
    const routeTag = /<Route\s+[^>]*path\s*=\s*["']([^"']+)["']/g;
    while ((m = routeTag.exec(source)) !== null) {
        items.push(makeItem('NAV_ROUTE', m[1], 'Route', filePath, m.index));
    }

    // Navigation: router.push("...")
    const routerPush = /router\.push\s*\(\s*["']([^"']+)["']/g;
    while ((m = routerPush.exec(source)) !== null) {
        items.push(makeItem('NAV_ROUTE', m[1], 'router.push', filePath, m.index));
    }

    // Navigation: <Link to="..."> or <Link href="...">
    const linkTag = /<Link\s+[^>]*(?:to|href)\s*=\s*["']([^"']+)["']/g;
    while ((m = linkTag.exec(source)) !== null) {
        if (!seen.has(`nav:${m[1]}`)) {
            seen.add(`nav:${m[1]}`);
            items.push(makeItem('NAV_ROUTE', m[1], 'Link', filePath, m.index));
        }
    }

    // Navigation: createStackNavigator / createBrowserRouter
    const createNav = /create(?:Stack|Tab|Drawer|Browser|Hash|Memory)(?:Navigator|Router)\s*\(/g;
    while ((m = createNav.exec(source)) !== null) {
        items.push(makeItem('NAV_ROUTE', 'navigator', m[0].match(/create(\w+)/)?.[1] ?? 'Navigator', filePath, m.index));
    }

    // Network: useSWR, useQuery
    const useSWR = /useSWR\s*\(\s*["'`]([^"'`]+)["'`]/g;
    while ((m = useSWR.exec(source)) !== null) {
        items.push(makeItem('NETWORK', m[1], 'useSWR', filePath, m.index));
    }

    const useQuery = /useQuery\s*\(\s*\[?\s*["'`]([^"'`]+)["'`]/g;
    while ((m = useQuery.exec(source)) !== null) {
        items.push(makeItem('NETWORK', m[1], 'useQuery', filePath, m.index));
    }

    // Network: fetch with URL (in non-API files)
    if (!filePath.includes('/api/')) {
        const fetchCall = /fetch\s*\(\s*["'`](\/[^"'`]+)["'`]/g;
        while ((m = fetchCall.exec(source)) !== null) {
            items.push(makeItem('NETWORK', m[1], 'fetch', filePath, m.index));
        }
    }

    // DI: createContext / useContext
    const createCtx = /(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?createContext\s*\(/g;
    while ((m = createCtx.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `Context:${m[1]}`, m[1], filePath, m.index));
    }

    // DI: Redux store
    const reduxStore = /(?:createStore|configureStore)\s*\(/g;
    while ((m = reduxStore.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', 'Redux Store', 'store', filePath, m.index));
    }

    const reduxSlice = /createSlice\s*\(\s*\{[^}]*name\s*:\s*["']([^"']+)["']/g;
    while ((m = reduxSlice.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `Slice:${m[1]}`, m[1], filePath, m.index));
    }

    // Network: useMutation, useInfiniteQuery (TanStack Query / React Query)
    const useMutation = /useMutation\s*\(/g;
    while ((m = useMutation.exec(source)) !== null) {
        items.push(makeItem('NETWORK', 'mutation', 'useMutation', filePath, m.index));
    }
    const useInfiniteQuery = /useInfiniteQuery\s*\(\s*\[?\s*["'`]([^"'`]+)["'`]/g;
    while ((m = useInfiniteQuery.exec(source)) !== null) {
        items.push(makeItem('NETWORK', m[1], 'useInfiniteQuery', filePath, m.index));
    }

    // DI: Zustand store
    const zustand = /(?:const|let)\s+(\w+)\s*=\s*create\s*(?:<[^>]+>)?\s*\(\s*(?:\(\s*set|set\s*=>)/g;
    while ((m = zustand.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `Zustand:${m[1]}`, m[1], filePath, m.index));
    }

    // DI: Jotai atom
    const jotaiAtom = /(?:const|let)\s+(\w+)\s*=\s*atom\s*\(/g;
    while ((m = jotaiAtom.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `Atom:${m[1]}`, m[1], filePath, m.index));
    }

    // Expo Router (gated by expo-router import)
    const isExpoRouter = /from\s+['"]expo-router['"]/.test(source);
    if (isExpoRouter) {
        // Navigation: <Stack.Screen name="..."> / <Tabs.Screen name="...">
        const expoScreen = /<(?:Stack|Tabs)\.Screen\s+[^>]*name\s*=\s*["']([^"']+)["']/g;
        while ((m = expoScreen.exec(source)) !== null) {
            if (!seen.has(`nav:expo:${m[1]}`)) {
                seen.add(`nav:expo:${m[1]}`);
                items.push(makeItem('NAV_ROUTE', m[1], 'ExpoScreen', filePath, m.index));
            }
        }

        // Navigation: router.push / router.replace
        const expoRouterNav = /router\.(?:push|replace)\s*\(\s*["']([^"']+)["']/g;
        while ((m = expoRouterNav.exec(source)) !== null) {
            if (!seen.has(`nav:${m[1]}`)) {
                seen.add(`nav:${m[1]}`);
                items.push(makeItem('NAV_ROUTE', m[1], 'router.push', filePath, m.index));
            }
        }

        // Navigation: <Redirect href="...">
        const expoRedirect = /<Redirect\s+[^>]*href\s*=\s*["']([^"']+)["']/g;
        while ((m = expoRedirect.exec(source)) !== null) {
            if (!seen.has(`nav:${m[1]}`)) {
                seen.add(`nav:${m[1]}`);
                items.push(makeItem('NAV_ROUTE', m[1], 'Redirect', filePath, m.index));
            }
        }
    }

    // Tier 2 (Issue 365 — Cascade rebuilds every api-list when one file changes) — React Native push notifications: react-native-push-notification,
    // @react-native-firebase/messaging, expo-notifications, notifee.
    const pushImports = /(?:from\s+|require\s*\(\s*)['"](?:@react-native-firebase\/messaging|react-native-push-notification|expo-notifications|@notifee\/react-native|@react-native-community\/push-notification-ios)['"]/;
    if (pushImports.test(source)) {
        const onMsg = /\b(?:messaging|Notifications|Notifee|PushNotification)(?:\(\))?\s*\.\s*(onMessage|onNotificationOpenedApp|setBackgroundMessageHandler|addNotificationReceivedListener|addNotificationResponseReceivedListener|configure|onNotification|setOnEvent)\s*\(/g;
        while ((m = onMsg.exec(source)) !== null) {
            items.push(makeItem('PUSH_HANDLER', `push:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // Tier 2 — React Native background tasks: react-native-background-fetch,
    // @react-native-async-storage, expo-background-fetch, expo-task-manager.
    const bgImports = /(?:from\s+|require\s*\(\s*)['"](?:react-native-background-fetch|expo-task-manager|expo-background-fetch|@react-native-community\/background-task)['"]/;
    if (bgImports.test(source)) {
        const bgRegister = /\b(?:BackgroundFetch|TaskManager|BackgroundTask)\s*\.\s*(?:configure|defineTask|registerTaskAsync|register)\s*\(\s*['"]?([^'"`,\s)]+)/g;
        while ((m = bgRegister.exec(source)) !== null) {
            const taskName = m[1] || 'background-task';
            items.push(makeItem('BG_TASK', `bgtask:${taskName}`, taskName, filePath, m.index));
        }
    }

    return items;
}

export const reactPlugin: MobilePlatformPlugin = {
    id: 'react',
    languages: ['javascript', 'typescript'],
    detect: (source, filePath, language) => detectReactItems(source, filePath, language),
};
