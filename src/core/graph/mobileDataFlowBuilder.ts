/**
 * mobileDataFlowBuilder.ts — v2 phase 5 PR-A (#486 — L3 data-flow builders (frontend + mobile, sibling files)).
 *
 * Builds L3 sequence-style data-flow graphs for mobile screens
 * (Android Compose / Activity / Fragment, iOS UIKit / SwiftUI,
 * Flutter). Same shape as the frontend builder; differs only in
 * participant subtitles ("«view»" instead of "«component»") and the
 * spec §3 L3 mobile participant table (View / ViewModel / Repository /
 * Network / Platform service / Persistence).
 *
 * PR-A scaffolds the minimal graph per item. PR-D extends the walk
 * with ViewModel / Bloc / Provider / Repository / Network / Persistence
 * participants.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    L2bScreenItem,
    ScreenRecord,
} from './graphTypes';

import type { ApiRecord } from './graphTypes';

// FlowBuildContext mirrors the FE builder's shape so the dispatcher
// in `syncOrchestrator` can call either builder with the same args.
// PR-D consumes both fields for the mobile handler walk.
export interface FlowBuildContext {
    content?: string;
    apiIndex?: Record<string, ApiRecord>;
}

export function buildMobileDataFlowGraph(
    screen: ScreenRecord,
    item: L2bScreenItem,
    ctx?: FlowBuildContext,
): DiagramGraph | null {
    if (!screen.filePath) return null;
    const graphId = `sequence:${screen.filePath}:${item.itemId}`;
    const fileName = screen.filePath.split('/').pop() ?? screen.filePath;

    const viewNode: GraphNode = {
        id: 'p:view',
        type: 'participant',
        label: fileName,
        subtitle: '«view»',
        body: screen.routePath,
        diff: 'unchanged',
        anchor: screen.anchor,
    };
    const handlerLabel = item.handlerName || item.label || item.kind;
    const handlerNode: GraphNode = {
        id: 'p:handler',
        type: 'participant',
        label: handlerLabel,
        subtitle: subtitleForSection(item.section),
        body: item.kind,
        diff: 'unchanged',
        anchor: item.anchor,
    };
    const nodes: GraphNode[] = [viewNode, handlerNode];
    const edges: GraphEdge[] = [{
        id: 'e:invoke',
        source: viewNode.id,
        target: handlerNode.id,
        label: item.kind,
        edgeType: 'message',
        diff: 'unchanged',
    }];
    const anchors: Record<string, Anchor> = {
        [viewNode.id]: screen.anchor,
        [handlerNode.id]: item.anchor,
    };

    // v2 phase 5 PR-D — mobile handler walk. Same shape as the FE
    // walker (anchor-window slice + lane-detect regex) but with
    // platform-specific lane categories per spec §3 L3 participants:
    // View / ViewModel / Repository / Network / Platform service /
    // Persistence.
    //
    // Gate is `ctx` (any context object), not `ctx.content` — the
    // nav-out walker only needs `item.route` + `item.label`, which
    // are available regardless of source content.
    let walked = false;
    if (ctx) {
        const args: MobileWalkArgs = {
            screen, item, content: ctx.content ?? '', apiIndex: ctx.apiIndex ?? {},
            nodes, edges, anchors,
            handlerNodeId: handlerNode.id,
        };
        if (item.section === 'nav-out') {
            walked = walkMobileNavOut(args);
        } else if (ctx.content) {
            const body = sliceMobileBody(ctx.content, item);
            if (body) {
                walked = scanMobileBodyForLanes(args, body.text);
            }
        }
    }

    return {
        graphId,
        type: 'sequence',
        nodes,
        edges,
        anchors,
        meta: {
            category: 'mobile',
            screenId: screen.screenId,
            itemId: item.itemId,
            section: item.section,
            framework: screen.framework,
            filePath: screen.filePath,
            isScaffoldOnly: !walked,
        } as Record<string, unknown>,
    };
}

// ── Mobile lane scanner ───────────────────────────────────────────
//
// Body-text-takes-anything walker for mobile handler bodies. Detects
// six lane categories matching spec §3 L3 mobile participants:
//   - ViewModel / Provider — Kotlin: viewModel(), hiltViewModel(),
//     `by viewModels()`. Swift: @StateObject / @ObservedObject usage
//     in body. Dart: Provider.of, context.watch, ref.watch,
//     BlocBuilder, StreamBuilder.
//   - Repository — any identifier ending in `Repository` referenced
//     in body. Cross-language by convention.
//   - Network — Kotlin: \w+Api., HttpClient, ktorClient. Swift:
//     URLSession, Alamofire, AF., \w+API. Dart: dio., http., Dio().
//   - Persistence — Kotlin: Dao, SharedPreferences, DataStore. Swift:
//     CoreData, SwiftData, UserDefaults, Keychain, Realm(. Dart:
//     Hive., Sqflite., SharedPreferences., Isar.
//   - Platform service — Kotlin: FirebaseMessaging, WorkManager,
//     BiometricPrompt, KeyStore. Swift: UNUserNotificationCenter,
//     BGTaskScheduler, LAContext. Dart: FirebaseMessaging,
//     Workmanager, FlutterLocalNotifications.
//
// Backend cross-link fires when a Network call site has a literal URL
// path matching a workspace `apiIndex` route (same mechanism as FE).

interface MobileWalkArgs {
    screen: ScreenRecord;
    item: L2bScreenItem;
    content: string;
    apiIndex: Record<string, ApiRecord>;
    nodes: GraphNode[];
    edges: GraphEdge[];
    anchors: Record<string, Anchor>;
    handlerNodeId: string;
}

const VIEWMODEL_RE = /\b(viewModel|hiltViewModel|activityViewModels|viewModels|Provider\.of|context\.watch|context\.read|ref\.watch|ref\.read|BlocBuilder|BlocListener|StreamBuilder|FutureBuilder|Consumer|Selector|MultiProvider)\b/g;
const REPOSITORY_RE = /\b(\w+Repository)\b/g;
const NETWORK_RE = /\b(URLSession|Alamofire|AF|HttpClient|ktorClient|Retrofit|dio|Dio|http)\b/g;
const PERSISTENCE_RE = /\b(SharedPreferences|DataStore|RoomDatabase|\w+Dao|UserDefaults|Keychain|Realm|CoreData|SwiftData|Hive|Sqflite|Isar|Drift)\b/g;
const PLATFORM_SERVICE_RE = /\b(FirebaseMessaging|FirebaseAuth|WorkManager|Workmanager|BGTaskScheduler|BiometricPrompt|KeyStore|UNUserNotificationCenter|LAContext|FlutterLocalNotifications|GoogleSignIn|AppleID)\b/g;

// Network call sites with a URL literal — for backend cross-link.
//   Kotlin Retrofit:  `api.getUsers(...)`  → no URL; can't cross-link
//   Swift URLSession: `URLSession.shared.dataTask(with: URL(string: "https://x.com/api/users")!)`
//   Dart Dio:         `dio.get("/api/users")`
//   Dart http:        `http.get(Uri.parse("https://x.com/api/users"))`
// Allow `/` in both the relative-path and absolute-URL alternatives.
// Without `/` in the relative class the regex matched only `/api`
// from `/api/users/42` — the second `/` halted capture.
const NETWORK_CALL_WITH_URL_RE = /(?:dio\s*\.\s*\w+|http\s*\.\s*\w+|URL\s*\(\s*string\s*:|Uri\.parse)\s*\(\s*[`'"](\/[\w%.?&=:/-]+|https?:\/\/[\w%.?&=:/-]+)/g;

function scanMobileBodyForLanes(args: MobileWalkArgs, text: string): boolean {
    let added = false;
    let m: RegExpExecArray | null;

    // ViewModel / Provider / Bloc lane.
    VIEWMODEL_RE.lastIndex = 0;
    while ((m = VIEWMODEL_RE.exec(text)) !== null) {
        const name = m[1];
        addParticipantOnce(args, `p:viewmodel:${name}`, name, '«viewmodel»', args.screen.anchor);
        addMessageOnce(args, args.handlerNodeId, `p:viewmodel:${name}`, name);
        added = true;
    }

    // Repository lane — convention-named identifiers.
    REPOSITORY_RE.lastIndex = 0;
    while ((m = REPOSITORY_RE.exec(text)) !== null) {
        const name = m[1];
        addParticipantOnce(args, `p:repository:${name}`, name, '«repository»', args.screen.anchor);
        addMessageOnce(args, args.handlerNodeId, `p:repository:${name}`, name);
        added = true;
    }

    // Network lane — client name.
    NETWORK_RE.lastIndex = 0;
    while ((m = NETWORK_RE.exec(text)) !== null) {
        const name = m[1];
        addParticipantOnce(args, 'p:network', name, '«network»', args.screen.anchor);
        addMessageOnce(args, args.handlerNodeId, 'p:network', name);
        added = true;
    }

    // Network calls with literal URL → backend cross-link.
    NETWORK_CALL_WITH_URL_RE.lastIndex = 0;
    while ((m = NETWORK_CALL_WITH_URL_RE.exec(text)) !== null) {
        const url = m[1];
        if (url.startsWith('/')) {
            maybeAddBackendCrossLink(args, 'p:network', url);
            added = true;
        }
    }

    // Persistence lane.
    PERSISTENCE_RE.lastIndex = 0;
    while ((m = PERSISTENCE_RE.exec(text)) !== null) {
        const name = m[1];
        addParticipantOnce(args, 'p:persistence', name, '«persistence»', args.screen.anchor);
        addMessageOnce(args, args.handlerNodeId, 'p:persistence', name);
        added = true;
    }

    // Platform service lane.
    PLATFORM_SERVICE_RE.lastIndex = 0;
    while ((m = PLATFORM_SERVICE_RE.exec(text)) !== null) {
        const name = m[1];
        addParticipantOnce(args, `p:platform:${name}`, name, '«platform»', args.screen.anchor);
        addMessageOnce(args, args.handlerNodeId, `p:platform:${name}`, name);
        added = true;
    }

    return added;
}

function walkMobileNavOut(args: MobileWalkArgs): boolean {
    const target = args.item.route || args.item.label;
    if (!target) return false;
    addParticipantOnce(args, 'p:nav-target', target, '«target screen»', args.screen.anchor);
    addMessageOnce(args, args.handlerNodeId, 'p:nav-target', target);
    return true;
}

function addParticipantOnce(args: MobileWalkArgs, id: string, label: string, subtitle: string, anchor: Anchor): void {
    if (args.nodes.some((n) => n.id === id)) return;
    args.nodes.push({ id, type: 'participant', label, subtitle, diff: 'unchanged', anchor });
    args.anchors[id] = anchor;
}

function addMessageOnce(args: MobileWalkArgs, sourceId: string, targetId: string, label: string): void {
    const edgeId = `e:${sourceId}->${targetId}:${label}`;
    if (args.edges.some((e) => e.id === edgeId)) return;
    args.edges.push({
        id: edgeId, source: sourceId, target: targetId, label,
        edgeType: 'message', diff: 'unchanged',
    });
}

function maybeAddBackendCrossLink(args: MobileWalkArgs, fromId: string, url: string): void {
    const match = findBackendRouteMatch(args.apiIndex, url);
    if (!match) return;
    const backendId = `p:backend:${match.apiId}`;
    addParticipantOnce(args, backendId, match.label, '«backend»', match.anchor);
    addMessageOnce(args, fromId, backendId, `${match.method} ${match.route}`);
}

interface BackendMatch {
    apiId: string;
    method: string;
    route: string;
    label: string;
    anchor: Anchor;
}

function findBackendRouteMatch(apiIndex: Record<string, ApiRecord>, callPath: string): BackendMatch | null {
    const normalisedCall = callPath.replace(/\/+$/, '') || '/';
    for (const api of Object.values(apiIndex)) {
        if (!api.route) continue;
        if (routeMatches(normalisedCall, api.route)) {
            const label = api.handlerName || (api.filePath.split('/').pop() ?? api.apiId);
            return {
                apiId: api.apiId,
                method: api.method,
                route: api.route,
                label,
                anchor: api.anchor ?? { filePath: api.filePath },
            };
        }
    }
    return null;
}

function routeMatches(callPath: string, routeTemplate: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, '') || '/';
    const call = norm(callPath);
    const tmpl = norm(routeTemplate);
    if (call === tmpl) return true;
    const re = new RegExp('^' + tmpl
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:[a-zA-Z_][\w]*/g, '[^/]+')
        .replace(/\\\{[a-zA-Z_][\w]*\\\}/g, '[^/]+')
        .replace(/<[a-zA-Z_][\w]*>/g, '[^/]+') + '$');
    return re.test(call);
}

interface BodySlice { text: string; offset: number; }

/**
 * Mobile body slice: anchor-window approach across all sections.
 *
 * Kotlin / Swift / Dart function declarations vary significantly
 * (`override fun onCreate`, `func viewDidLoad`, `void initState`,
 * `Future<void> handler() async`, `@Composable fun Screen()` etc.).
 * A robust named-function slice would need per-language parsing.
 *
 * Pragmatic approach for PR-D: slice ±500 chars around the item's
 * anchor line. That captures most handler bodies + their immediate
 * callers without language-specific parsing. PR-E (future) can
 * upgrade to language-aware function-body slicing if the window
 * approach proves too lossy in real fixtures.
 */
function sliceMobileBody(content: string, item: L2bScreenItem): BodySlice | null {
    const startLine = item.anchor.lineStart ?? 1;
    let lineStartOffset = 0;
    let line = 1;
    for (let i = 0; i < content.length && line < startLine; i++) {
        if (content.charCodeAt(i) === 10) line++;
        lineStartOffset = i + 1;
    }
    const radius = 500;
    const from = Math.max(0, lineStartOffset - Math.floor(radius / 4));
    const to = Math.min(content.length, lineStartOffset + Math.ceil(radius * 3 / 4));
    return { text: content.slice(from, to), offset: from };
}

function subtitleForSection(section: L2bScreenItem['section']): string {
    switch (section) {
        case 'interactions': return '«handler»';
        case 'data':         return '«viewmodel»';
        case 'lifecycle':    return '«lifecycle»';
        case 'nav-in':       return '«nav-in»';
        case 'nav-out':      return '«nav-out»';
        case 'visual':       return '«visual»';
    }
}
