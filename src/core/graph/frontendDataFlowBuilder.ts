/**
 * frontendDataFlowBuilder.ts — v2 phase 5 PR-A (#486 — L3 data-flow builders (frontend + mobile, sibling files)).
 *
 * Builds L3 sequence-style data-flow graphs for FE screens. One graph
 * per L2b item (interaction handler / data hook / lifecycle effect /
 * nav-in target / nav-out call) — matches spec §3 L3 root-resolution
 * table.
 *
 * PR-A (this PR) is the scaffolding step:
 *   - One graph per `L2bScreenItem` rooted at the item's
 *     handler/label.
 *   - Two participants: the screen component (leftmost) and the
 *     item's handler/hook on the right.
 *   - One message edge labelled with the item's `kind` (e.g.
 *     `interaction:click`, `lifecycle:effect`).
 *
 * PR-B onwards extends the walk — actual callees from the handler
 * (hooks invoked, stores read, fetchers called) become additional
 * participants and messages. Cross-link to backend L3 via
 * URL-pattern matching against the workspace's `apiIndex` lands in
 * PR-D.
 *
 * Backend behaviour is intact — `sequenceGraphBuilder.ts` continues
 * to own HTTP route handlers. This builder fires ONLY when the L2a
 * service category is `'frontend'`.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    L2bScreenItem,
    ScreenRecord,
    ApiRecord,
} from './graphTypes';

/**
 * Context the builder needs to walk past the scaffolding shape.
 *
 *   - `content`  — the screen file's source. When omitted, the builder
 *                  produces the PR-A scaffolding graph (2 participants,
 *                  1 message edge) and stamps `meta.isScaffoldOnly: true`.
 *                  When supplied, the walker scans the L2b item's
 *                  handler body for hook / store / fetcher / persistence
 *                  call sites and emits additional participant lanes
 *                  (PR-B+).
 *   - `apiIndex` — the workspace's backend API records. Used by the
 *                  walker to cross-link fetcher call sites to a specific
 *                  backend service when the call site's URL matches a
 *                  registered route. Without this the builder still
 *                  emits the fetcher lane but skips the Backend lane.
 */
export interface FlowBuildContext {
    content?: string;
    apiIndex?: Record<string, ApiRecord>;
}

/**
 * Build one FE L3 sequence graph per L2b item. Returns null for
 * malformed input (missing screen file path) so the caller can
 * silently skip.
 *
 * Graph id form: `sequence:<screenFilePath>:<itemId>` — matches the
 * existing `sequence:` prefix so the SequenceView renderer + router
 * paths in App.tsx pick it up with zero changes.
 */
export function buildFrontendDataFlowGraph(
    screen: ScreenRecord,
    item: L2bScreenItem,
    ctx?: FlowBuildContext,
): DiagramGraph | null {
    if (!screen.filePath) return null;
    const graphId = `sequence:${screen.filePath}:${item.itemId}`;
    const fileName = screen.filePath.split('/').pop() ?? screen.filePath;

    const screenAnchor: Anchor = screen.anchor;
    const itemAnchor: Anchor = item.anchor;
    const screenNode: GraphNode = {
        id: 'p:screen',
        type: 'participant',
        label: fileName,
        subtitle: '«component»',
        body: screen.routePath,
        diff: 'unchanged',
        anchor: screenAnchor,
    };
    const handlerLabel = item.handlerName || item.label || item.kind;
    const handlerNode: GraphNode = {
        id: 'p:handler',
        type: 'participant',
        label: handlerLabel,
        subtitle: subtitleForSection(item.section),
        body: item.kind,
        diff: 'unchanged',
        anchor: itemAnchor,
    };
    const nodes: GraphNode[] = [screenNode, handlerNode];
    const edges: GraphEdge[] = [{
        id: 'e:invoke',
        source: screenNode.id,
        target: handlerNode.id,
        label: item.kind,
        edgeType: 'message',
        diff: 'unchanged',
    }];
    const anchors: Record<string, Anchor> = {
        [screenNode.id]: screenAnchor,
        [handlerNode.id]: itemAnchor,
    };

    // v2 phase 5 PR-B/C — section-specific walk. Fires when we have
    // content. Inline-arrow handlers (`anonymous@onClick`) have no
    // addressable body for the named-function walk; the section-
    // window walk (PR-C) still applies because we anchor on the
    // item's source line instead of a named function declaration.
    let walked = false;
    if (ctx?.content) {
        const args: WalkArgs = {
            screen, item, content: ctx.content, apiIndex: ctx.apiIndex ?? {},
            nodes, edges, anchors,
            screenNodeId: screenNode.id, handlerNodeId: handlerNode.id,
        };
        if (item.section === 'interactions' && item.handlerName && !item.handlerName.startsWith('anonymous@')) {
            walked = walkInteractionHandler(args);
        } else if (item.section === 'lifecycle') {
            walked = walkLifecycleEffect(args);
        } else if (item.section === 'data') {
            walked = walkDataHookCallSite(args);
        } else if (item.section === 'nav-in') {
            walked = walkNavInTriggers(args);
        } else if (item.section === 'nav-out') {
            walked = walkNavOutDestination(args);
        }
    }

    return {
        graphId,
        type: 'sequence',
        nodes,
        edges,
        anchors,
        meta: {
            category: 'frontend',
            screenId: screen.screenId,
            itemId: item.itemId,
            section: item.section,
            framework: screen.framework,
            filePath: screen.filePath,
            // PR-B+ flips this to `false` when the walker actually
            // populated participant lanes. The renderer can show a
            // "scaffolding — full walk pending" affordance when this
            // is `true`.
            isScaffoldOnly: !walked,
        } as Record<string, unknown>,
    };
}

// ── PR-B: interaction-handler walk ─────────────────────────────────
//
// For each Interactions item with a named handler, locate the
// handler's function body in the screen file and scan it for the
// participant lanes the spec calls for:
//
//   - Hook lane:        `useQuery(...)`, `useSWR(...)`, custom `use*` hooks
//   - Store lane:       `useSelector(...)`, `useStore(...)`, `useAtom(...)`,
//                       `useRecoilValue(...)`, `useContext(...)`
//   - Fetcher lane:     `fetch(...)`, `axios.<verb>(...)`,
//                       `apolloClient.<query|mutate>(...)`,
//                       `useMutation(...)`
//   - Backend lane:     cross-link when the fetcher's URL literal
//                       matches a workspace `apiIndex` route
//   - Persistence lane: `localStorage.*`, `sessionStorage.*`,
//                       `AsyncStorage.*`, `document.cookie`
//
// Each distinct lane gets ONE participant node. Each call site gets
// ONE message edge from the handler to the lane labelled with the
// callee name (or URL for fetcher / backend lanes).

interface WalkArgs {
    screen: ScreenRecord;
    item: L2bScreenItem;
    content: string;
    apiIndex: Record<string, ApiRecord>;
    nodes: GraphNode[];
    edges: GraphEdge[];
    anchors: Record<string, Anchor>;
    screenNodeId: string;
    handlerNodeId: string;
}

const REACT_STORE_HOOKS: ReadonlySet<string> = new Set([
    'useContext', 'useSelector', 'useStore', 'useAtom', 'useAtomValue',
    'useSetAtom', 'useRecoilValue', 'useRecoilState', 'useReactiveVar',
]);
const REACT_LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
    'useEffect', 'useLayoutEffect', 'useFocusEffect', 'useInsertionEffect',
    'useImperativeHandle',
]);
const REACT_STATE_PRIMITIVE_HOOKS: ReadonlySet<string> = new Set([
    'useState', 'useReducer', 'useRef', 'useMemo', 'useCallback', 'useId',
    'useTransition', 'useDeferredValue', 'useSyncExternalStore',
]);
const FETCHER_HOOKS: ReadonlySet<string> = new Set([
    'useQuery', 'useMutation', 'useFetch', 'useSWR', 'useSWRInfinite',
    'useInfiniteQuery', 'useSuspenseQuery',
]);

function walkInteractionHandler(args: WalkArgs): boolean {
    const handlerName = args.item.handlerName!;
    const body = sliceFunctionBody(args.content, handlerName);
    if (!body) return false;
    return scanBodyForLanes(args, body.text, body.offset);
}

// PR-C — Lifecycle root walker.
//
// The L2b lifecycle item's `handlerName` is the hook NAME (`useEffect`,
// `LaunchedEffect`, `viewDidLoad`, …), not a function in source.
// The effect BODY is the arrow / closure passed to it. To find it we
// scan from the item's anchor line for the first `(` after the hook
// name, then balance-match to the closing `)`, then slice the inner
// callback body. For React this is `useEffect(() => { ... }, deps)`
// — the inner `() => { ... }` is the body we walk.
function walkLifecycleEffect(args: WalkArgs): boolean {
    const body = sliceLifecycleBody(args.content, args.item);
    if (!body) return false;
    return scanBodyForLanes(args, body.text, body.offset);
}

// PR-C — Data source root walker.
//
// The hook call lives at the screen's module level (or inside the
// component's render body). The participant is the hook itself —
// already added as `p:handler`. We walk the surrounding window for
// downstream consumers (fetchers + persistence access that runs as
// the hook resolves). Anchor-window approach: ±400 chars around the
// item's source line. PR-D may refine with a proper component-body
// scan when the screen is a single-component file.
function walkDataHookCallSite(args: WalkArgs): boolean {
    const window = sliceAnchorWindow(args.content, args.item, 400);
    if (!window) return false;
    return scanBodyForLanes(args, window.text, window.offset, { skipHookCalls: true });
}

// PR-C — Nav-in root walker.
//
// Nav-in items come from `apiIndex` (DEEP_LINK / PUSH_HANDLER /
// WIDGET / CONTENT_PROVIDER). The L3 root is the screen entry — we
// walk the screen module top-level for the data sources / lifecycle
// hooks the screen runs when first reached via the nav-in trigger.
// Bound the scan to the top 2000 chars of the file (component
// declarations + their immediate hook calls live here in practice).
function walkNavInTriggers(args: WalkArgs): boolean {
    const top = args.content.slice(0, 2000);
    return scanBodyForLanes(args, top, 0);
}

// PR-C — Nav-out root walker.
//
// The L2b nav-out item already carries the destination route (URL or
// component name). Emit a single Target participant + edge so the L1
// renderer can later draw a screen-to-screen edge. PR-D adds cross-
// link to the target screen's L3 root for Nav-in.
function walkNavOutDestination(args: WalkArgs): boolean {
    const target = args.item.route || args.item.label;
    if (!target) return false;
    addParticipantOnce(args, 'p:nav-target', target, '«target screen»', args.screen.anchor);
    addMessageOnce(args, args.handlerNodeId, 'p:nav-target', target);
    return true;
}

interface ScanOptions {
    /** When true, skip the `use*` hook calls — used by data-source
     *  walker so the hook itself (which IS the participant) doesn't
     *  emit a redundant self-edge. */
    skipHookCalls?: boolean;
}

/**
 * Shared body-scanning core: detects Hook / Store / Fetcher /
 * Persistence call sites + cross-links matching backend routes.
 * Used by all five FE walkers — each slices its own body region first.
 */
function scanBodyForLanes(args: WalkArgs, text: string, bodyOffset: number, opts: ScanOptions = {}): boolean {
    let added = false;
    let m: RegExpExecArray | null;

    if (!opts.skipHookCalls) {
        const useCallRe = /\b(use[A-Z]\w*)\s*\(/g;
        while ((m = useCallRe.exec(text)) !== null) {
            const hook = m[1];
            if (REACT_LIFECYCLE_HOOKS.has(hook)) continue;
            if (REACT_STATE_PRIMITIVE_HOOKS.has(hook)) continue;
            const kind = REACT_STORE_HOOKS.has(hook) ? 'store'
                : FETCHER_HOOKS.has(hook) ? 'fetcher'
                : 'hook';
            const subtitle = kind === 'store' ? '«store»'
                : kind === 'fetcher' ? '«api client»'
                : '«hook»';
            addParticipantOnce(args, `p:${kind}:${hook}`, hook, subtitle, anchorAtBody(args.screen, bodyOffset, m.index ?? 0));
            addMessageOnce(args, args.handlerNodeId, `p:${kind}:${hook}`, hook);
            added = true;
        }
    }

    const fetchRe = /\bfetch\s*\(\s*[`'"]?([\/\w%.?&=:-]+)?/g;
    while ((m = fetchRe.exec(text)) !== null) {
        const url = m[1] && m[1].startsWith('/') ? m[1] : null;
        addParticipantOnce(args, 'p:fetcher:fetch', 'fetch', '«api client»', anchorAtBody(args.screen, bodyOffset, m.index ?? 0));
        addMessageOnce(args, args.handlerNodeId, 'p:fetcher:fetch', url ?? 'fetch()');
        added = true;
        if (url) maybeAddBackendCrossLink(args, 'p:fetcher:fetch', url);
    }
    const axiosRe = /\baxios\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(\s*[`'"]?([\/\w%.?&=:-]+)?/g;
    while ((m = axiosRe.exec(text)) !== null) {
        const verb = m[1].toUpperCase();
        const url = m[2] && m[2].startsWith('/') ? m[2] : null;
        addParticipantOnce(args, 'p:fetcher:axios', 'axios', '«api client»', anchorAtBody(args.screen, bodyOffset, m.index ?? 0));
        addMessageOnce(args, args.handlerNodeId, 'p:fetcher:axios', url ?? `axios.${verb.toLowerCase()}()`);
        added = true;
        if (url) maybeAddBackendCrossLink(args, 'p:fetcher:axios', url);
    }
    const persistRe = /\b(localStorage|sessionStorage|AsyncStorage|document\.cookie)\b/g;
    while ((m = persistRe.exec(text)) !== null) {
        const sym = m[1];
        addParticipantOnce(args, 'p:persistence', sym, '«persistence»', anchorAtBody(args.screen, bodyOffset, m.index ?? 0));
        addMessageOnce(args, args.handlerNodeId, 'p:persistence', sym);
        added = true;
    }
    return added;
}

/**
 * Slice the inner callback body of a lifecycle hook call site.
 *
 * Example: `useEffect(() => { load(); }, []);`
 *   - The item's `handlerName` is `useEffect`.
 *   - We find the first `useEffect\s*\(` from the item's anchor line.
 *   - Then we scan past the opening `(`, find the first `{` (the
 *     callback body brace), and balance-match to its closing `}`.
 *
 * Returns null if the hook call has no inline-callback body shape
 * (e.g. `useEffect(handler, [])` where `handler` is a reference).
 * Falls back to the full file content's top 2KB so the data-source /
 * lifecycle walker still sees SOMETHING in that case.
 */
function sliceLifecycleBody(content: string, item: L2bScreenItem): BodySlice | null {
    const hookName = item.handlerName ?? item.label ?? '';
    if (!hookName) return null;
    // Find the hook call site at-or-after the item's anchor line.
    const startLine = item.anchor.lineStart ?? 1;
    let searchOffset = 0;
    {
        let line = 1;
        for (let i = 0; i < content.length && line < startLine; i++) {
            if (content.charCodeAt(i) === 10) line++;
            searchOffset = i + 1;
        }
    }
    const re = new RegExp(`\\b${hookName.replace(/[^\w$]/g, '')}\\s*\\(`);
    const sliced = content.slice(searchOffset);
    const m = re.exec(sliced);
    if (!m) return null;
    const absoluteStart = searchOffset + (m.index ?? 0) + m[0].length;
    // Walk forward — find the first `{` AT paren-depth 1 (the
    // callback's opening brace; everything before it is the hook's
    // argument list).
    let depth = 1;
    let i = absoluteStart;
    let openBrace = -1;
    while (i < content.length) {
        const ch = content.charCodeAt(i);
        if (ch === 40) depth++;       // (
        else if (ch === 41) {
            depth--;
            if (depth === 0) break;
        }
        else if (depth === 1 && ch === 123) {
            openBrace = i;
            break;
        }
        i++;
    }
    if (openBrace < 0) return null;
    // Balance braces.
    let bd = 1;
    let j = openBrace + 1;
    while (j < content.length && bd > 0) {
        const ch = content.charCodeAt(j);
        if (ch === 123) bd++;
        else if (ch === 125) bd--;
        j++;
    }
    if (bd !== 0) return null;
    return { text: content.slice(openBrace + 1, j - 1), offset: openBrace + 1 };
}

/**
 * Slice a ±`radius` char window around the L2b item's anchor line
 * in the source. Used by data-source / nav-in walkers when there's
 * no named function body to anchor on.
 */
function sliceAnchorWindow(content: string, item: L2bScreenItem, radius: number): BodySlice | null {
    const startLine = item.anchor.lineStart ?? 1;
    let lineStartOffset = 0;
    let line = 1;
    for (let i = 0; i < content.length && line < startLine; i++) {
        if (content.charCodeAt(i) === 10) line++;
        lineStartOffset = i + 1;
    }
    const from = Math.max(0, lineStartOffset - Math.floor(radius / 2));
    const to = Math.min(content.length, lineStartOffset + Math.ceil(radius / 2));
    return { text: content.slice(from, to), offset: from };
}

function addParticipantOnce(args: WalkArgs, id: string, label: string, subtitle: string, anchor: Anchor): void {
    if (args.nodes.some((n) => n.id === id)) return;
    const node: GraphNode = {
        id, type: 'participant', label, subtitle, diff: 'unchanged', anchor,
    };
    args.nodes.push(node);
    args.anchors[id] = anchor;
}

function addMessageOnce(args: WalkArgs, sourceId: string, targetId: string, label: string): void {
    // Dedup by (source, target, label) — multiple call sites with the
    // same callee + same URL collapse to one edge.
    const edgeId = `e:${sourceId}->${targetId}:${label}`;
    if (args.edges.some((e) => e.id === edgeId)) return;
    args.edges.push({
        id: edgeId,
        source: sourceId,
        target: targetId,
        label,
        edgeType: 'message',
        diff: 'unchanged',
    });
}

function maybeAddBackendCrossLink(args: WalkArgs, fromId: string, url: string): void {
    if (!args.apiIndex) return;
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
 * Locate a top-level function declaration's body in `content` and
 * return the body string + the source offset where it begins.
 *
 * Supports three shapes:
 *   - `function name(...) { ... }`
 *   - `const name = (...) => { ... }`
 *   - `const name = async (...) => { ... }`
 *   - `async function name(...) { ... }`
 *
 * Returns null when the function isn't found or the body brace can't
 * be brace-counted. Inline arrow handlers with no name reach this
 * function via `name === 'anonymous@onClick'` etc. — the caller
 * skips those before invoking this helper.
 */
function sliceFunctionBody(content: string, name: string): BodySlice | null {
    if (!name || /[^\w$]/.test(name)) return null;
    // Each pattern carries a flag for whether the match ENDS inside
    // the argument-list parens (`\\(` was consumed) or AFTER everything
    // (the opening `{` was consumed for the object-method shorthand).
    const patterns: Array<[RegExp, 'inside-parens' | 'on-open-brace']> = [
        [new RegExp(`\\bfunction\\s+${name}\\s*\\(`), 'inside-parens'],
        [new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?\\(`), 'inside-parens'],
        [new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*async\\s+function\\s*\\(`), 'inside-parens'],
        [new RegExp(`\\basync\\s+function\\s+${name}\\s*\\(`), 'inside-parens'],
        // Object-method shorthand: `name(arg) { ... }` — match ends ON `{`.
        [new RegExp(`(?:^|[,{;])\\s*${name}\\s*\\([^)]*\\)\\s*\\{`), 'on-open-brace'],
    ];
    let openBraceIdx = -1;
    for (const [p, mode] of patterns) {
        const m = p.exec(content);
        if (!m) continue;
        const matchEnd = (m.index ?? 0) + m[0].length;
        if (mode === 'on-open-brace') {
            // `{` was the last consumed char.
            openBraceIdx = matchEnd - 1;
            break;
        }
        // We're inside the args-list parens (depth = 1 implicitly).
        // Walk forward, paren-balancing, and stop at the first `{`
        // after the parens close.
        let depth = 1;
        let i = matchEnd;
        while (i < content.length) {
            const ch = content.charCodeAt(i);
            if (ch === 40) depth++;       // (
            else if (ch === 41) depth--;  // )
            else if (depth === 0 && ch === 123) {
                openBraceIdx = i;
                break;
            }
            i++;
        }
        if (openBraceIdx >= 0) break;
    }
    if (openBraceIdx < 0) return null;
    // Brace-count to find the matching closing brace.
    let depth = 1;
    let j = openBraceIdx + 1;
    while (j < content.length && depth > 0) {
        const ch = content.charCodeAt(j);
        if (ch === 123) depth++;
        else if (ch === 125) depth--;
        j++;
    }
    if (depth !== 0) return null;
    return { text: content.slice(openBraceIdx + 1, j - 1), offset: openBraceIdx + 1 };
}

function anchorAtBody(screen: ScreenRecord, bodyOffset: number, withinBody: number): Anchor {
    void bodyOffset;
    void withinBody;
    // First cut: anchor lands on the screen file at line 1. Line-
    // precise anchors require threading the full content through —
    // can be added in a follow-up. The L2b panel anchors already
    // capture the precise line for the handler/hook call.
    return screen.anchor;
}

function subtitleForSection(section: L2bScreenItem['section']): string {
    switch (section) {
        case 'interactions': return '«handler»';
        case 'data':         return '«data source»';
        case 'lifecycle':    return '«lifecycle»';
        case 'nav-in':       return '«nav-in»';
        case 'nav-out':      return '«nav-out»';
        case 'visual':       return '«visual»';
    }
}
