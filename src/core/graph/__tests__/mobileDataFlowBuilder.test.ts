/**
 * mobileDataFlowBuilder.test.ts — v2 phase 5 PR-A.
 *
 * Same scaffolding contract as the FE builder; the only differences:
 *   - Screen-side participant subtitle is `«view»` instead of
 *     `«component»` (per spec §3 L3 mobile participants).
 *   - Data sources get `«viewmodel»` instead of `«data source»`.
 *   - `meta.category === 'mobile'`.
 */

import { describe, it, expect } from 'vitest';
import { buildMobileDataFlowGraph } from '../mobileDataFlowBuilder';
import type { ScreenRecord, L2bScreenItem, ApiRecord, DiagramGraph } from '../graphTypes';

function mkScreen(over: Partial<ScreenRecord> & { screenId: string }): ScreenRecord {
    return {
        serviceId: 'service:mobile',
        routePath: 'HomeActivity',
        framework: 'android-activity',
        filePath: 'apps/android/src/MainActivity.kt',
        anchor: { filePath: 'apps/android/src/MainActivity.kt', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

function mkItem(over: Partial<L2bScreenItem> & { itemId: string; section: L2bScreenItem['section']; kind: string }): L2bScreenItem {
    return {
        screenId: 'screen:service:mobile:HomeActivity',
        label: 'onCreate',
        handlerName: 'onCreate',
        filePath: 'apps/android/src/MainActivity.kt',
        anchor: { filePath: 'apps/android/src/MainActivity.kt', lineStart: 10, lineEnd: 15 },
        ...over,
    };
}

describe('buildMobileDataFlowGraph — PR-A scaffolding', () => {
    it('graph id matches sequence:<screenFilePath>:<itemId>', () => {
        const graph = buildMobileDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'lifecycle:apps/android/src/MainActivity.kt:onCreate', section: 'lifecycle', kind: 'lifecycle:create' }),
        );
        expect(graph!.graphId).toBe(
            'sequence:apps/android/src/MainActivity.kt:lifecycle:apps/android/src/MainActivity.kt:onCreate',
        );
        expect(graph!.type).toBe('sequence');
    });

    it('screen participant subtitle is «view» (mobile flavour)', () => {
        const graph = buildMobileDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'lifecycle', kind: 'lifecycle:create' }),
        );
        const view = graph!.nodes.find((n) => n.id === 'p:view');
        expect(view!.subtitle).toBe('«view»');
    });

    it('data-source items get «viewmodel» subtitle (mobile-specific)', () => {
        const graph = buildMobileDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'data', kind: 'data:store', handlerName: 'HomeViewModel' }),
        );
        const handler = graph!.nodes.find((n) => n.id === 'p:handler');
        expect(handler!.subtitle).toBe('«viewmodel»');
    });

    it('meta.category is `mobile` so downstream dispatch knows the dialect', () => {
        const graph = buildMobileDataFlowGraph(
            mkScreen({ screenId: 's', framework: 'ios-swiftui' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:tap' }),
        );
        expect(graph!.meta).toMatchObject({
            category: 'mobile',
            framework: 'ios-swiftui',
            isScaffoldOnly: true,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 5 PR-D — mobile handler walk.
//
// Cross-language lane detection: same item.section dispatch as the
// FE builder; lane categories differ to match spec §3 L3 mobile
// participants (View / ViewModel / Repository / Network / Platform
// service / Persistence).
//
// Coverage focus:
//   1. Kotlin Compose: viewModel() / Repository / Retrofit /
//      WorkManager / KeyStore — all classify into the right lanes.
//   2. Swift SwiftUI: @StateObject (via class body) /
//      URLSession / UNUserNotificationCenter / UserDefaults.
//   3. Dart Flutter: Provider.of / Dio / Hive / FirebaseMessaging.
//   4. Backend cross-link fires for Dio + URLSession when the URL
//      literal matches a workspace `apiIndex` route.
//   5. nav-out items emit the «target screen» participant.
// ─────────────────────────────────────────────────────────────────────

describe('buildMobileDataFlowGraph — PR-D walks', () => {
    function participants(graph: DiagramGraph): string[] {
        return graph.nodes.filter((n) => n.type === 'participant').map((n) => n.label).sort();
    }
    function laneById(graph: DiagramGraph, id: string) {
        return graph.nodes.find((n) => n.id === id);
    }

    it('Kotlin Compose handler — viewModel() + Repository + Retrofit → ViewModel/Repository/Network lanes', () => {
        const screen = mkScreen({
            screenId: 's',
            framework: 'android-compose',
            filePath: 'apps/android/src/HomeScreen.kt',
            anchor: { filePath: 'apps/android/src/HomeScreen.kt', lineStart: 5, lineEnd: 5 },
        });
        const content =
            `@Composable\n` +
            `fun HomeScreen() {\n` +
            `  val vm: HomeViewModel = viewModel()\n` +
            `  val repo: UserRepository = vm.userRepo\n` +
            `  vm.refresh()\n` +
            `  HttpClient.get("/api/users")\n` +
            `}\n`;
        const item = mkItem({
            itemId: 'interactions:HomeScreen.kt:click',
            section: 'interactions',
            kind: 'interaction:click',
            handlerName: 'HomeScreen',
            label: 'HomeScreen',
            anchor: { filePath: screen.filePath, lineStart: 5, lineEnd: 5 },
        });
        const graph = buildMobileDataFlowGraph(screen, item, { content });
        expect(graph!.meta.isScaffoldOnly).toBe(false);
        const labels = participants(graph!);
        expect(labels).toContain('viewModel');
        expect(labels).toContain('UserRepository');
        expect(labels).toContain('HttpClient');
    });

    it('Swift SwiftUI handler — URLSession + UserDefaults + UNUserNotificationCenter classify correctly', () => {
        const screen = mkScreen({
            screenId: 's',
            framework: 'ios-swiftui',
            filePath: 'apps/ios/HomeView.swift',
            anchor: { filePath: 'apps/ios/HomeView.swift', lineStart: 3, lineEnd: 3 },
        });
        const content =
            `struct HomeView: View {\n` +
            `  func load() {\n` +
            `    let url = URL(string: "/api/users")!\n` +
            `    URLSession.shared.dataTask(with: url)\n` +
            `    UserDefaults.standard.set(true, forKey: "k")\n` +
            `    UNUserNotificationCenter.current().requestAuthorization()\n` +
            `  }\n` +
            `}\n`;
        const item = mkItem({
            itemId: 'interactions:HomeView.swift:load',
            section: 'interactions',
            kind: 'interaction:tap',
            handlerName: 'load',
            label: 'load',
            anchor: { filePath: screen.filePath, lineStart: 2, lineEnd: 2 },
        });
        const graph = buildMobileDataFlowGraph(screen, item, { content });
        const labels = participants(graph!);
        expect(labels).toContain('URLSession');
        expect(labels).toContain('UserDefaults');
        expect(labels).toContain('UNUserNotificationCenter');
    });

    it('Dart Flutter handler — Dio + Hive + Provider.of + FirebaseMessaging classify correctly', () => {
        const screen = mkScreen({
            screenId: 's',
            framework: 'flutter-goroute',
            filePath: 'apps/flutter/lib/home.dart',
            anchor: { filePath: 'apps/flutter/lib/home.dart', lineStart: 4, lineEnd: 4 },
        });
        const content =
            `class HomeWidget extends StatelessWidget {\n` +
            `  Future<void> load(BuildContext context) async {\n` +
            `    final auth = Provider.of<AuthService>(context);\n` +
            `    final res = await dio.get("/api/users");\n` +
            `    Hive.box('cache').put('users', res.data);\n` +
            `    FirebaseMessaging.instance.subscribeToTopic('news');\n` +
            `  }\n` +
            `}\n`;
        const item = mkItem({
            itemId: 'interactions:home.dart:load',
            section: 'interactions',
            kind: 'interaction:tap',
            handlerName: 'load',
            label: 'load',
            anchor: { filePath: screen.filePath, lineStart: 3, lineEnd: 3 },
        });
        const graph = buildMobileDataFlowGraph(screen, item, { content });
        const labels = participants(graph!);
        expect(labels).toContain('Provider.of');
        expect(labels).toContain('Hive');
        expect(labels).toContain('FirebaseMessaging');
        expect(labels).toContain('dio');
    });

    it('cross-link to backend when Dio URL literal matches workspace apiIndex route', () => {
        const screen = mkScreen({
            screenId: 's',
            framework: 'flutter-goroute',
            filePath: 'apps/flutter/lib/home.dart',
            anchor: { filePath: 'apps/flutter/lib/home.dart', lineStart: 3, lineEnd: 3 },
        });
        const content = `await dio.get("/api/users/42");`;
        const apiIndex: Record<string, ApiRecord> = {
            'a1': {
                apiId: 'a1', method: 'GET', route: '/api/users/:id',
                handlerName: 'getUserById', filePath: 'apps/api/src/users.ts',
                anchor: { filePath: 'apps/api/src/users.ts', lineStart: 5, lineEnd: 12 },
            },
        };
        const item = mkItem({
            itemId: 'interactions:home.dart:loadUser',
            section: 'interactions',
            kind: 'interaction:tap',
            handlerName: 'loadUser',
            label: 'loadUser',
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        });
        const graph = buildMobileDataFlowGraph(screen, item, { content, apiIndex });
        const backend = graph!.nodes.find((n) => n.subtitle === '«backend»');
        expect(backend).toBeDefined();
        expect(backend!.label).toBe('getUserById');
    });

    it('nav-out: emits «target screen» participant labelled with the destination', () => {
        const screen = mkScreen({ screenId: 's', framework: 'android-compose' });
        const item = mkItem({
            itemId: 'nav-out:home:dashboard',
            section: 'nav-out',
            kind: 'nav-out:navigate',
            label: 'dashboard',
            route: 'dashboard',
        });
        const graph = buildMobileDataFlowGraph(screen, item, { content: '' });
        const target = graph!.nodes.find((n) => n.subtitle === '«target screen»');
        expect(target).toBeDefined();
        expect(target!.label).toBe('dashboard');
        expect(graph!.meta.isScaffoldOnly).toBe(false);
    });

    it('without ctx, builder produces scaffolding shape (back-compat for PR-A callers)', () => {
        const graph = buildMobileDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:tap' }),
        );
        expect(graph!.meta.isScaffoldOnly).toBe(true);
    });

    it('body with no recognised lane keywords → scaffold (no false-emit)', () => {
        const screen = mkScreen({ screenId: 's' });
        const item = mkItem({ itemId: 'x', section: 'lifecycle', kind: 'lifecycle:resume' });
        const graph = buildMobileDataFlowGraph(screen, item, { content: '// just a comment\nfun trivial() { val x = 1 }' });
        expect(graph!.meta.isScaffoldOnly).toBe(true);
        // Voids the unused helper. (Kept here to anchor: laneById is used in other tests.)
        expect(laneById(graph!, 'p:viewmodel:viewModel')).toBeUndefined();
    });
});
