/**
 * mobile/flutter.ts — Flutter / Dart platform plugin.
 *
 * Detects StatelessWidget / StatefulWidget / HookWidget / ConsumerWidget
 * screens, Navigator + GoRouter + named MaterialApp routes, Dio / http /
 * retrofit_dart network calls, GetIt / Provider / Riverpod / @injectable
 * DI bindings, firebase_messaging + flutter_local_notifications push
 * handlers, and Workmanager background tasks.
 *
 * Gated by `package:flutter/` import presence so a plain Dart utility
 * file (CLI tool, server-side Dart) doesn't trigger Widget-tree detection.
 */

import type { MobilePlatformPlugin } from './types';
import type { ApiRecord } from '../../graph/graphTypes';
import { makeItem, isTestFile } from './_shared';

function isFlutterFile(source: string): boolean {
    return /import\s+['"]package:flutter\//.test(source);
}

const FLUTTER_SCREEN_BASES = new Set([
    'StatelessWidget', 'StatefulWidget', 'HookWidget', 'ConsumerWidget',
    'HookConsumerWidget', 'ConsumerStatefulWidget',
]);

// BUG-EXPLORE-10: NOT every `StatelessWidget`/`StatefulWidget` is a navigable
// SCREEN — Flutter apps model buttons, sections, list items, demo examples,
// etc. as widgets too (on the Material 3 demo ~35% of "screens" were widgets
// like `_ClearButton`, `BottomSheetSection`, `ButtonAnchorExample`). Only count
// a widget as a screen when it looks like one, mirroring the Kotlin/Compose
// reclassifier: explicit `*Screen`/`*Page`/`*View`/`*Flow` names, or a name that
// isn't an obvious component — and never a private (`_`-prefixed) widget.
const FLUTTER_SCREEN_SUFFIX = /(?:Screen|Page|View|Flow)$/;
const FLUTTER_COMPONENT_SUFFIX = /(?:Buttons?|Items?|Cards?|Chips?|Tiles?|Sections?|Examples?|Transitions?|Bars?|Dialogs?|Sheets?|Icons?|Rows?|Columns?|Fields?|Wrappers?|Widgets?|Dividers?|Avatars?|Badges?|Headers?|Footers?|Lists?|Grids?|Menus?|Panels?|Containers?|Demos?|Selectors?|Toggles?|Switches?|Sliders?|Pickers?|Indicators?|Actions?|App|Content|Anchors?|Labels?|Texts?|Images?|Logos?|Handles?|Thumbnails?|Previews?|Overlays?|Popups?|Tooltips?|Snackbars?|Banners?)$/;

export function isFlutterScreenName(name: string): boolean {
    if (!name || name.startsWith('_')) return false;      // private widgets aren't navigable screens
    if (FLUTTER_SCREEN_SUFFIX.test(name)) return true;    // explicit screen (HomeScreen / SettingsPage)
    if (FLUTTER_COMPONENT_SUFFIX.test(name)) return false; // obvious component (BrightnessButton / BottomSheetSection)
    return true;                                          // ambiguous (Feed / Profile) → keep as a screen
}

function detectFlutterItems(source: string, filePath: string): ApiRecord[] {
    if (!isFlutterFile(source) || isTestFile(filePath)) return [];
    const items: ApiRecord[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;

    // Screens: class extends StatelessWidget / StatefulWidget / etc.
    const classPattern = /class\s+(\w+)\s+extends\s+(\w+)/g;
    while ((m = classPattern.exec(source)) !== null) {
        const className = m[1];
        const parent = m[2];
        if (FLUTTER_SCREEN_BASES.has(parent) && isFlutterScreenName(className) && !seen.has(className)) {
            seen.add(className);
            items.push(makeItem('SCREEN', `/${className}`, className, filePath, m.index));
        }
    }

    // Navigation: Navigator.push / Navigator.pushNamed
    // pushNamed(context, '/route') — route string can be first or second arg
    const navigatorPush = /Navigator\s*\.\s*(?:push|pushNamed|pushReplacement|pushReplacementNamed)\s*\([^)]*['"]([^"']+)["']/g;
    while ((m = navigatorPush.exec(source)) !== null) {
        if (!seen.has(`nav:${m[1]}`)) {
            seen.add(`nav:${m[1]}`);
            items.push(makeItem('NAV_ROUTE', m[1], 'Navigator', filePath, m.index));
        }
    }

    // Navigation: GoRouter route paths
    const goRoute = /GoRoute\s*\([^)]*path\s*:\s*['"]([^"']+)["']/g;
    while ((m = goRoute.exec(source)) !== null) {
        if (!seen.has(`nav:${m[1]}`)) {
            seen.add(`nav:${m[1]}`);
            items.push(makeItem('NAV_ROUTE', m[1], 'GoRoute', filePath, m.index));
        }
    }

    // Navigation: context.push / context.go (GoRouter extension)
    const contextNav = /context\s*\.\s*(?:push|go|pushNamed|goNamed)\s*\(\s*['"]([^"']+)["']/g;
    while ((m = contextNav.exec(source)) !== null) {
        if (!seen.has(`nav:${m[1]}`)) {
            seen.add(`nav:${m[1]}`);
            items.push(makeItem('NAV_ROUTE', m[1], 'context.go', filePath, m.index));
        }
    }

    // Navigation: named routes in MaterialApp
    const namedRoute = /['"]\/(\w[^"']*)["']\s*:\s*\(\s*(?:context|_)\s*\)\s*=>/g;
    while ((m = namedRoute.exec(source)) !== null) {
        const route = `/${m[1]}`;
        if (!seen.has(`nav:${route}`)) {
            seen.add(`nav:${route}`);
            items.push(makeItem('NAV_ROUTE', route, 'namedRoute', filePath, m.index));
        }
    }

    // Network: Dio
    if (/import\s+['"]package:dio\//.test(source)) {
        const dioCall = /dio\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"]([^"']+)["']/gi;
        while ((m = dioCall.exec(source)) !== null) {
            items.push(makeItem('NETWORK', m[2], `Dio.${m[1]}`, filePath, m.index));
        }
    }

    // Network: http package
    if (/import\s+['"]package:http\//.test(source)) {
        const httpCall = /http\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(?:Uri\.parse\s*\(\s*)?['"]([^"']+)["']/gi;
        while ((m = httpCall.exec(source)) !== null) {
            items.push(makeItem('NETWORK', m[2], `http.${m[1]}`, filePath, m.index));
        }
    }

    // Network: Retrofit (retrofit.dart)
    if (/import\s+['"]package:retrofit\//.test(source)) {
        const retrofitDart = /@(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^"']+)["']\s*\)/g;
        while ((m = retrofitDart.exec(source)) !== null) {
            items.push(makeItem('NETWORK', m[2], m[1], filePath, m.index));
        }
    }

    // DI: GetIt
    if (/import\s+['"]package:get_it\//.test(source)) {
        const getIt = /(?:GetIt\.instance|getIt|locator)\s*\.\s*register(?:Singleton|Factory|LazySingleton)\s*<\s*(\w+)\s*>/g;
        while ((m = getIt.exec(source)) !== null) {
            items.push(makeItem('DI_BINDING', `GetIt:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // DI: Provider / Riverpod
    if (/import\s+['"]package:(?:provider|flutter_riverpod|riverpod)\//.test(source)) {
        const provider = /(?:final|var)\s+(\w+)\s*=\s*(?:Provider|StateProvider|FutureProvider|StreamProvider|ChangeNotifierProvider|StateNotifierProvider|NotifierProvider)\s*(?:<[^>]*(?:<[^>]*>)?[^>]*>)?\s*\(/g;
        while ((m = provider.exec(source)) !== null) {
            items.push(makeItem('DI_BINDING', `Provider:${m[1]}`, m[1], filePath, m.index));
        }
    }

    // DI: Injectable (@injectable, @singleton)
    const injectableAnno = /@(injectable|singleton|lazySingleton)\s*(?:\n|\r\n)?\s*class\s+(\w+)/gi;
    while ((m = injectableAnno.exec(source)) !== null) {
        items.push(makeItem('DI_BINDING', `@${m[1]} ${m[2]}`, m[2], filePath, m.index));
    }

    // Tier 2 (Issue 365 — Cascade rebuilds every api-list when one file changes) — Flutter push notifications: firebase_messaging
    // (FirebaseMessaging.instance.onMessage / onBackgroundMessage), flutter_local_notifications.
    if (/import\s+['"]package:firebase_messaging\//.test(source)) {
        const fbMessaging = /FirebaseMessaging\.(?:instance|onMessage|onBackgroundMessage|onMessageOpenedApp)(?:\.\w+)?/g;
        while ((m = fbMessaging.exec(source)) !== null) {
            const op = m[0].split('.').slice(-1)[0];
            items.push(makeItem('PUSH_HANDLER', `fcm:${op}`, op, filePath, m.index));
        }
    }
    if (/import\s+['"]package:flutter_local_notifications\//.test(source)) {
        const localNotif = /FlutterLocalNotificationsPlugin\s*\(\s*\)|onDidReceiveNotificationResponse|onDidReceiveBackgroundNotificationResponse/g;
        while ((m = localNotif.exec(source)) !== null) {
            const name = m[0].includes('onDid') ? m[0].replace(/[(){\s]/g, '') : 'FlutterLocalNotificationsPlugin';
            items.push(makeItem('PUSH_HANDLER', `local:${name}`, name, filePath, m.index));
        }
    }

    // Tier 2 — Flutter background tasks: workmanager package callbacks.
    if (/import\s+['"]package:workmanager\//.test(source)) {
        const wmRegister = /Workmanager\(\)\.(?:registerOneOffTask|registerPeriodicTask|registerTask)\s*\(\s*['"]([^'"]+)['"]/g;
        while ((m = wmRegister.exec(source)) !== null) {
            items.push(makeItem('BG_TASK', `worker:${m[1]}`, m[1], filePath, m.index));
        }
    }

    return items;
}

export const flutterPlugin: MobilePlatformPlugin = {
    id: 'flutter',
    languages: ['dart'],
    detect: (source, filePath) => detectFlutterItems(source, filePath),
};
