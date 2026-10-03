/**
 * screenContentExtractor.ts — Per-screen L2b content extraction.
 *
 * v2 phase 4 (#485 — L2b screen contents — 5 sections + visual inventory) per `docs/v2-frontend-mobile-layer-spec.md` §3 (L2b).
 * For each FE/mobile screen detected by `screenDetector.ts`, emit a
 * `L2bScreenItem[]` partitioned across five primary sections
 * (Interactions / Data sources / Lifecycle / Nav-in / Nav-out) plus
 * a collapsible Visual elements inventory.
 *
 * Detection strategy: file-content regex per framework, gated by the
 * declaring screen's `framework` field. Backend services don't reach
 * this module — the dispatcher early-returns when an L2a screen is
 * absent or the service category is `'backend' | 'unknown' | 'monorepo-parent'`.
 *
 * Per-framework detectors are added incrementally across PR-B through
 * PR-E of v2 phase 4:
 *
 *   - PR-B: Interactions (onClick / @click / .onTapGesture /
 *           Modifier.clickable / onPressed / android:onClick / addTarget)
 *   - PR-C: Data sources + Lifecycle (use* / useEffect families,
 *           SwiftUI @StateObject + .onAppear/.task, Compose
 *           collectAsState + LaunchedEffect, Flutter Provider +
 *           initState / dispose, native Activity / UIViewController
 *           lifecycle overrides)
 *   - PR-D: Nav-in + Nav-out (deep-link / push / widget targets;
 *           <Link> / router.push / Navigator.push / NavController)
 *   - PR-E: Visual element classifier (Buttons / Inputs / Lists /
 *           Labels / Images / Forms / Layout / Dividers / Indicators /
 *           Modals / Custom)
 *
 * PR-A (this PR) lands the types, storage, scaffolding, and the empty
 * dispatcher. Per-screen detectors are stubs that return [];
 * `extractScreenContents()` returns an empty `Record<string,
 * L2bScreenItem[]>`.
 */

import type {
    Snapshot,
    ScreenRecord,
    ScreenFramework,
    L2bScreenItem,
    FileRecord,
    Anchor,
    VisualElementKind,
} from '../graph/graphTypes';
// #485-VISUAL (2026-06-07) — standalone classifiers consumed by the
// Vue + Svelte visual extractors. The dispatchers map PascalCase →
// lowercase via CLASSIFIER_KIND_MAP further down.
import { classifyVueElement } from './visualElementClassifier/vue';
import { classifySvelteElement } from './visualElementClassifier/svelte';

/**
 * Optional content fallback for files whose `FileRecord.content` has
 * been lazy-dropped post-save. Same shape as `screenDetector.ts`.
 */
export type ContentProvider = (filePath: string) => string | undefined;

/**
 * Resolver for Android XML layout files (`res/layout/<name>.xml`).
 *
 * v2 follow-up #718 — Android XML layouts aren't in `snapshot.files`
 * (only Kotlin/Java sources are). The orchestrator passes a resolver
 * that does a bounded fs-walk under the workspace and returns content
 * for the requested layout name (without `.xml`). Tests can pass an
 * in-memory map.
 */
export type XmlLayoutResolver = (layoutName: string) => string | undefined;

function readContent(rec: FileRecord | undefined, fp: string, getContent?: ContentProvider): string {
    if (rec && typeof rec.content === 'string' && rec.content.length > 0) return rec.content;
    return getContent?.(fp) ?? '';
}

function anchorAt(filePath: string, line = 1): Anchor {
    return { filePath, lineStart: line, lineEnd: line };
}

/**
 * Frameworks that compile to JSX-shape source files (React + Next.js +
 * Remix + Expo Router + SvelteKit's TS pages + React SPA + React Native
 * manual nav). All share the `on{Capital}={handler}` attribute shape.
 */
const JSX_SCREEN_FRAMEWORKS: ReadonlySet<ScreenFramework> = new Set([
    'nextjs-app', 'nextjs-pages',
    'remix',
    'expo-router',
    'react-spa',
    'react-native-nav',
]);

/**
 * Extract L2b content items for every screen in the workspace.
 *
 * Returns a record keyed by `screenId` so the L2b panel can scope its
 * rendering to the active L2a screen with O(1) lookup. Empty record
 * when no screens qualify (backend-only repos and pre-phase-4 builds).
 */
export function extractScreenContents(
    snapshot: Snapshot,
    screens: Record<string, ScreenRecord>,
    getContent?: ContentProvider,
    getXmlLayout?: XmlLayoutResolver,
): Record<string, L2bScreenItem[]> {
    const out: Record<string, L2bScreenItem[]> = {};
    for (const screen of Object.values(screens)) {
        const content = readContent(snapshot.files[screen.filePath], screen.filePath, getContent);
        if (!content) continue;
        const items: L2bScreenItem[] = [];
        // PR-B — interactions per screen framework. Per-section
        // detectors append into `items`; future PRs add more
        // sections (data sources, lifecycle, nav-in, nav-out, visual).
        if (JSX_SCREEN_FRAMEWORKS.has(screen.framework)) {
            extractJsxInteractions(screen, content, items);
            extractJsxData(screen, content, items);
            extractJsxLifecycle(screen, content, items);
            extractJsxNavOut(screen, content, items);
            extractJsxVisual(screen, content, items);
        } else if (screen.framework === 'nuxt') {
            extractVueInteractions(screen, content, items);
            extractVueData(screen, content, items);
            extractVueLifecycle(screen, content, items);
            extractVueNavOut(screen, content, items);
            // #485-VISUAL (2026-06-07) — bridge to the standalone Vue
            // classifier so Vuetify (`v-*`), Element Plus (`el-*`),
            // Naive UI (`n-*`), and Quasar (`q-*`) primitives stop
            // collapsing into `custom`. Falls back to extractJsxVisual
            // for HTML primitives the inline JSX table still owns.
            extractVueVisual(screen, content, items);
        } else if (screen.framework === 'sveltekit') {
            extractSvelteInteractions(screen, content, items);
            extractSvelteData(screen, content, items);
            extractSvelteLifecycle(screen, content, items);
            extractSvelteNavOut(screen, content, items);
            // #485-VISUAL (2026-06-07) — bridge to the standalone
            // Svelte classifier so `<svelte:component>` / `<svelte:fragment>`
            // are classified as layout instead of custom.
            extractSvelteVisual(screen, content, items);
        } else if (screen.framework === 'ios-swiftui' || screen.framework === 'ios-uikit') {
            extractSwiftInteractions(screen, content, items);
            extractSwiftData(screen, content, items);
            extractSwiftLifecycle(screen, content, items);
            extractSwiftNavOut(screen, content, items);
            extractSwiftVisual(screen, content, items);
        } else if (screen.framework === 'android-compose' ||
                   screen.framework === 'android-activity' ||
                   screen.framework === 'android-fragment') {
            extractKotlinInteractions(screen, content, items);
            extractKotlinData(screen, content, items);
            extractKotlinLifecycle(screen, content, items);
            extractKotlinNavOut(screen, content, items);
            extractKotlinVisual(screen, content, items, getXmlLayout);
        } else if (screen.framework === 'flutter-goroute' ||
                   screen.framework === 'flutter-material-page-route') {
            extractFlutterInteractions(screen, content, items);
            extractFlutterData(screen, content, items);
            extractFlutterLifecycle(screen, content, items);
            extractFlutterNavOut(screen, content, items);
            extractFlutterVisual(screen, content, items);
        }
        // Nav-in is cross-cutting: pull from snapshot.apiIndex for
        // DEEP_LINK / PUSH_HANDLER records that point at this screen.
        extractNavInFromApiIndex(screen, snapshot, items);
        if (items.length > 0) {
            out[screen.screenId] = items;
        }
    }
    return out;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Stable item id form: `<section>:<file>:<symbol>`. Falls back to
 * `<section>:<file>:<index>` when no symbol is available so duplicate
 * shapes in one file don't collide.
 */
function makeItemId(section: string, filePath: string, symbol: string, fallbackIndex: number): string {
    if (symbol && symbol.length > 0) return `${section}:${filePath}:${symbol}`;
    return `${section}:${filePath}:${fallbackIndex}`;
}

function emitItem(items: L2bScreenItem[], item: L2bScreenItem): void {
    if (items.some((existing) => existing.itemId === item.itemId)) return;
    items.push(item);
}

// ── JSX / React / RN / Next / Remix / Expo / SPA / RN-nav ──────────
// `on{Capital}={handler}` attributes (onClick, onPress, onSubmit,
// onChange, onKeyDown, onLongPress, onScroll, ...). Extracts the
// verb (lowercased) + handler name.

const JSX_INTERACTION_RE = /\bon([A-Z]\w*)\s*=\s*\{\s*([\w.[\]]+|\([^)]*\)\s*=>\s*[\s\S]{0,80}?)\s*\}/g;

function extractJsxInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    JSX_INTERACTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = JSX_INTERACTION_RE.exec(content)) !== null) {
        const verb = m[1].toLowerCase();
        // Skip false-positives — react lifecycle hooks aren't event
        // handlers. The verbs we care about start with a real
        // user-event prefix; conventional non-events get filtered.
        if (verb === 'load' || verb === 'error' || verb === 'message') {
            // `onLoad`/`onError`/`onMessage` ARE real DOM events,
            // keep them.
        }
        const raw = m[2].trim();
        // Extract a handler-name display label. If the value is an
        // inline arrow function, label it `anonymous@on<Verb>`.
        const isArrow = /=>/.test(raw);
        const handlerName = isArrow ? `anonymous@on${m[1]}` : raw.replace(/[[\]()]/g, '').slice(0, 60);
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label: handlerName,
            handlerName: isArrow ? undefined : handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Vue (Nuxt) ─────────────────────────────────────────────────────
// `@click="handler"` / `@submit.prevent="handler"` / `v-on:click="handler"`

// Vue: `@click="handler"`, `@submit.prevent="x"`, `v-on:click="x"`.
// No `\b` prefix — `@` is a non-word character and word-boundary
// matching against the preceding whitespace fails. A simple lookbehind
// for `\s` or `<` (start of attribute) is sufficient.
const VUE_INTERACTION_RE = /(?:[\s<])(?:@|v-on:)([\w-]+)(?:\.[\w-]+)*\s*=\s*["']([^"']+)["']/g;

function extractVueInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    VUE_INTERACTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = VUE_INTERACTION_RE.exec(content)) !== null) {
        const verb = m[1].toLowerCase();
        const handlerName = m[2].trim();
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label: handlerName,
            handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Svelte ─────────────────────────────────────────────────────────
// `on:click={handler}` / `on:submit|preventDefault={handler}`

const SVELTE_INTERACTION_RE = /\bon:([\w-]+)(?:\|[\w-]+)*\s*=\s*\{([^}]+)\}/g;

function extractSvelteInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    SVELTE_INTERACTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = SVELTE_INTERACTION_RE.exec(content)) !== null) {
        const verb = m[1].toLowerCase();
        const raw = m[2].trim();
        const isArrow = /=>/.test(raw);
        const handlerName = isArrow ? `anonymous@on:${verb}` : raw;
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label: handlerName,
            handlerName: isArrow ? undefined : handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── SwiftUI / UIKit ────────────────────────────────────────────────
// SwiftUI:
//   - `.onTapGesture { ... }` / `.onSubmit { ... }` / `.onLongPressGesture { ... }`
//   - `Button(action: { ... }) { ... }` / `Button("Save", action: save) { ... }`
//
// UIKit:
//   - `<receiver>.addTarget(self, action: #selector(...), for: .touchUpInside)`

const SWIFTUI_GESTURE_RE = /\.(?:on(TapGesture|Submit|LongPressGesture|HoverGesture|DragGesture|RotationGesture|MagnificationGesture|onAppear))\s*\(?[\s\S]{0,80}?\{/g;
const SWIFTUI_BUTTON_ACTION_RE = /\bButton\s*(?:\([^)]*\))?\s*(?:\{[\s\S]{0,40}?action\s*:\s*([\w.]+))?/g;
const UIKIT_ADD_TARGET_RE = /\.\s*addTarget\s*\(\s*\w+\s*,\s*action\s*:\s*#selector\s*\(\s*([\w.]+)/g;

function extractSwiftInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    SWIFTUI_GESTURE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SWIFTUI_GESTURE_RE.exec(content)) !== null) {
        const captured = m[1] || 'TapGesture';
        const verb = captured.replace('Gesture', '').toLowerCase();
        // Filter onAppear — that's a lifecycle, not an interaction.
        if (verb === 'appear' || verb === 'onappear') continue;
        const line = lineNumberOf(content, m.index ?? 0);
        // Include the `on` prefix in the anonymous label so the L2b
        // row reads `anonymous@onTapGesture` rather than just
        // `anonymous@TapGesture` (which is ambiguous about what kind
        // of event fired).
        const handlerName = `anonymous@on${captured}`;
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label: handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    UIKIT_ADD_TARGET_RE.lastIndex = 0;
    while ((m = UIKIT_ADD_TARGET_RE.exec(content)) !== null) {
        const handlerName = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: 'interaction:click',
            label: handlerName,
            handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Kotlin / Compose / Activity / Fragment ─────────────────────────
// Compose:
//   - `Modifier.clickable { ... }` / `Modifier.combinedClickable { ... }`
//   - `Button(onClick = { ... })` / `IconButton(onClick = ::handler)`
//
// Activity / Fragment (XML-based UI):
//   - `findViewById<Button>(R.id.x).setOnClickListener { ... }`
//   - `view.setOnClickListener(handler)`

const COMPOSE_CLICKABLE_RE = /\bModifier\s*\.\s*(?:combined)?[Cc]lickable\s*(?:\([^)]*\))?\s*\{/g;
const COMPOSE_ON_CLICK_RE = /\b(?:Button|IconButton|TextButton|OutlinedButton|FloatingActionButton|ExtendedFloatingActionButton)\s*\(\s*[\s\S]{0,200}?onClick\s*=\s*(?:::)?([\w.]+|\{)/g;
// Two shapes for Kotlin / Android listener wiring:
//   1. Method reference / function call: `setOnClickListener(::onClick)`
//      / `setOnClickListener(viewModel::onClick)` — capture the
//      identifier after `::`.
//   2. Trailing lambda: `setOnClickListener { … }` — anonymous handler.
const KOTLIN_SET_LISTENER_RE = /\.\s*setOn(\w+?)Listener\s*(?:\(\s*(?:[\w.]*::)?([\w.]+)\s*\)|(\{))/g;

function extractKotlinInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    COMPOSE_CLICKABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPOSE_CLICKABLE_RE.exec(content)) !== null) {
        const line = lineNumberOf(content, m.index ?? 0);
        const handlerName = 'anonymous@clickable';
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: 'interaction:click',
            label: handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    COMPOSE_ON_CLICK_RE.lastIndex = 0;
    while ((m = COMPOSE_ON_CLICK_RE.exec(content)) !== null) {
        const raw = (m[1] ?? '').trim();
        const isArrow = raw === '{';
        const handlerName = isArrow ? 'anonymous@onClick' : raw || 'anonymous@onClick';
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: 'interaction:click',
            label: handlerName,
            handlerName: isArrow ? undefined : handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    KOTLIN_SET_LISTENER_RE.lastIndex = 0;
    while ((m = KOTLIN_SET_LISTENER_RE.exec(content)) !== null) {
        const verb = m[1].toLowerCase();
        // m[2] = method-reference / call form; m[3] = trailing-lambda
        // open brace. Mutually exclusive — only one fires per match.
        const refHandler = m[2];
        const isLambda = m[3] === '{';
        const handlerName = refHandler ?? (isLambda ? undefined : undefined);
        const label = handlerName ?? `anonymous@setOn${m[1]}Listener`;
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, label, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label,
            handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Flutter (Dart) ─────────────────────────────────────────────────
// `onPressed: handler`, `onTap: handler`, `onChanged: handler`,
// `onLongPress: handler`, `onSubmitted: handler`, with handler either
// a function name reference or an inline arrow `() => ...`.

const FLUTTER_INTERACTION_RE = /\bon(Pressed|Tap|LongPress|Changed|Submitted|Submit|DoubleTap|TapDown|TapUp|SecondaryTap|HorizontalDragStart|VerticalDragStart)\s*:\s*([\w.]+|\([^)]*\)\s*=>\s*[\s\S]{0,80}?)(?=\s*[,)])/g;

function extractFlutterInteractions(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    FLUTTER_INTERACTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = FLUTTER_INTERACTION_RE.exec(content)) !== null) {
        const verb = m[1].toLowerCase();
        const raw = m[2].trim();
        const isArrow = /=>/.test(raw);
        const handlerName = isArrow ? `anonymous@on${m[1]}` : raw;
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('interactions', screen.filePath, handlerName, idx++),
            screenId: screen.screenId,
            section: 'interactions',
            kind: `interaction:${verb}`,
            label: handlerName,
            handlerName: isArrow ? undefined : handlerName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ─────────────────────────────────────────────────────────────────────
// PR-C — Data sources + Lifecycle per framework family.
// ─────────────────────────────────────────────────────────────────────

// ── JSX: data hooks + store/context bindings ───────────────────────
// `use{Capital}(...)` calls at the top of a screen body.
//   - Classified as `data:hook` for fetcher-shape hooks (useQuery,
//     useSWR, useMutation, useFetch, useInfiniteQuery, etc.) and
//     custom `use*` hooks that aren't on the store list.
//   - Classified as `data:store` for the well-known store/context
//     consumers (useContext, useSelector, useStore, useAtom, useAtomValue,
//     useRecoilValue).
//
// Skip the lifecycle hooks (useEffect, useLayoutEffect, useFocusEffect,
// useInsertionEffect) — those go through the lifecycle extractor below
// so we don't double-emit.

const JSX_USE_CALL_RE = /\b(use[A-Z]\w*)\s*\(/g;

const REACT_STORE_HOOKS: ReadonlySet<string> = new Set([
    'useContext',
    'useSelector',
    'useStore',
    'useAtom',
    'useAtomValue',
    'useSetAtom',
    'useRecoilValue',
    'useRecoilState',
    'useRecoilCallback',
    'useReactiveVar',
]);

const REACT_LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
    'useEffect',
    'useLayoutEffect',
    'useFocusEffect',
    'useInsertionEffect',
    'useImperativeHandle',
]);

// Hooks that are purely state primitives — these are common enough that
// L2b would be drowned in noise if we counted them as data sources. They
// belong in the visual inventory / L4 file view, not L2b.
const REACT_STATE_PRIMITIVE_HOOKS: ReadonlySet<string> = new Set([
    'useState',
    'useReducer',
    'useRef',
    'useMemo',
    'useCallback',
    'useId',
    'useTransition',
    'useDeferredValue',
    'useSyncExternalStore',
]);

function extractJsxData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    JSX_USE_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = JSX_USE_CALL_RE.exec(content)) !== null) {
        const hookName = m[1];
        if (REACT_LIFECYCLE_HOOKS.has(hookName)) continue;
        if (REACT_STATE_PRIMITIVE_HOOKS.has(hookName)) continue;
        const kind = REACT_STORE_HOOKS.has(hookName) ? 'data:store' : 'data:hook';
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, hookName, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind,
            label: hookName,
            handlerName: hookName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

const JSX_LIFECYCLE_RE = /\b(useEffect|useLayoutEffect|useFocusEffect|useInsertionEffect|useImperativeHandle)\s*\(/g;

function extractJsxLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    JSX_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = JSX_LIFECYCLE_RE.exec(content)) !== null) {
        const hookName = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, hookName, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${hookName.slice(3).toLowerCase()}`,  // useEffect → 'lifecycle:effect'
            label: hookName,
            handlerName: hookName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Vue (Nuxt) data + lifecycle ───────────────────────────────────
//   data:   useFetch / useAsyncData / useStore / storeToRefs / inject
//   lifecycle: onMounted / onActivated / onUpdated / onUnmounted /
//              onBeforeUnmount / onBeforeMount

const VUE_DATA_RE = /\b(useFetch|useAsyncData|useStore|storeToRefs|inject)\s*\(/g;
const VUE_LIFECYCLE_RE = /\b(onMounted|onActivated|onUpdated|onUnmounted|onBeforeUnmount|onBeforeMount|onDeactivated|onErrorCaptured)\s*\(/g;

function extractVueData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    VUE_DATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = VUE_DATA_RE.exec(content)) !== null) {
        const name = m[1];
        const kind = name === 'useFetch' || name === 'useAsyncData' ? 'data:hook'
            : name === 'inject' ? 'data:inject'
            : 'data:store';
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

function extractVueLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    VUE_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = VUE_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.replace(/^on/, '').toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Svelte data + lifecycle ───────────────────────────────────────
//   data:   $page / $session / $<storeName> auto-subscription /
//           getContext / setContext (rare)
//   lifecycle: onMount / onDestroy / beforeUpdate / afterUpdate / tick
//
// Svelte's `$storeName` shorthand binds to any store value — we detect
// it via `$` prefix in `<script>` or template position. Generic
// regex is high-noise; restrict to known Svelte store names
// (`$page`, `$session`, `$navigating`) plus a `getContext('...')` form.

// `$app` is the import namespace (`$app/stores`, `$app/navigation`) — not
// a SvelteKit store value. Restrict to the actual store identifiers
// (`$page`, `$session`, `$navigating`, `$updated`) so the import line
// `from '$app/stores'` doesn't false-emit a `$app` store-binding row.
const SVELTE_DATA_RE = /\$(page|session|navigating|updated)\b|\bgetContext\s*\(\s*['"]([^'"]+)['"]/g;
const SVELTE_LIFECYCLE_RE = /\b(onMount|onDestroy|beforeUpdate|afterUpdate|tick)\s*\(/g;

function extractSvelteData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    SVELTE_DATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = SVELTE_DATA_RE.exec(content)) !== null) {
        const name = m[1] ? `$${m[1]}` : `getContext:${m[2]}`;
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:store',
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

function extractSvelteLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    SVELTE_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = SVELTE_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.replace(/^on/, '').toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── SwiftUI / UIKit data + lifecycle ──────────────────────────────
//   SwiftUI data:    @StateObject / @ObservedObject / @EnvironmentObject /
//                    @Environment / @FetchRequest / @Query
//   SwiftUI lifecycle: .onAppear / .onDisappear / .task / .task(id:) /
//                      .onChange(of:)
//   UIKit lifecycle: viewDidLoad / viewWillAppear / viewDidAppear /
//                    viewWillDisappear / viewDidDisappear /
//                    viewWillLayoutSubviews / viewDidLayoutSubviews

const SWIFTUI_DATA_RE = /@(StateObject|ObservedObject|EnvironmentObject|Environment|FetchRequest|Query)\b/g;
const SWIFTUI_LIFECYCLE_RE = /\.(onAppear|onDisappear|task|onChange)\s*\(?(?:\(of:\s*[^)]+\))?\s*\{?/g;
const UIKIT_LIFECYCLE_OVERRIDE_RE = /\boverride\s+func\s+(viewDidLoad|viewWillAppear|viewDidAppear|viewWillDisappear|viewDidDisappear|viewWillLayoutSubviews|viewDidLayoutSubviews|viewWillTransition|didReceiveMemoryWarning)\s*\(/g;

function extractSwiftData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    SWIFTUI_DATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = SWIFTUI_DATA_RE.exec(content)) !== null) {
        const name = `@${m[1]}`;
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:store',
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

function extractSwiftLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    SWIFTUI_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SWIFTUI_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.replace(/^on/, '').toLowerCase()}`,
            label: `.${name}`,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    UIKIT_LIFECYCLE_OVERRIDE_RE.lastIndex = 0;
    while ((m = UIKIT_LIFECYCLE_OVERRIDE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.replace(/^view/, '').toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Kotlin / Compose / Activity / Fragment data + lifecycle ───────
//   data:    viewModel() / hiltViewModel() / collectAsState() /
//            observeAsState() / Flow.collectAsState() / @Inject /
//            by viewModels() (Activity delegate)
//   lifecycle (Compose):  LaunchedEffect / DisposableEffect / SideEffect /
//                         rememberCoroutineScope / produceState
//   lifecycle (Activity/Fragment): onCreate / onStart / onResume /
//                                  onPause / onStop / onDestroy /
//                                  onSaveInstanceState / onCreateView /
//                                  onViewCreated

const COMPOSE_DATA_RE = /\b(viewModel|hiltViewModel|collectAsState|observeAsState|collectAsStateWithLifecycle)\s*\(/g;
const KOTLIN_INJECT_RE = /@(Inject)\s+(?:private\s+|protected\s+)?(?:val|var|lateinit\s+var)\s+(\w+)/g;
const KOTLIN_VIEWMODEL_DELEGATE_RE = /\b(?:private\s+|protected\s+)?val\s+(\w+)\s*:\s*[\w<>?]+\s*by\s+(viewModels|activityViewModels|hiltViewModels)\s*\(/g;

const COMPOSE_LIFECYCLE_RE = /\b(LaunchedEffect|DisposableEffect|SideEffect|rememberCoroutineScope|produceState)\s*(?:\([^)]*\))?\s*\{?/g;
const ANDROID_CLASS_LIFECYCLE_RE = /\boverride\s+fun\s+(onCreate|onStart|onResume|onPause|onStop|onDestroy|onSaveInstanceState|onCreateView|onViewCreated|onAttach|onDetach|onActivityResult|onNewIntent|onRestart|onConfigurationChanged)\s*\(/g;

function extractKotlinData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    COMPOSE_DATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPOSE_DATA_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:store',
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    KOTLIN_INJECT_RE.lastIndex = 0;
    while ((m = KOTLIN_INJECT_RE.exec(content)) !== null) {
        const fieldName = m[2];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, fieldName, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:inject',
            label: `@Inject ${fieldName}`,
            handlerName: fieldName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    KOTLIN_VIEWMODEL_DELEGATE_RE.lastIndex = 0;
    while ((m = KOTLIN_VIEWMODEL_DELEGATE_RE.exec(content)) !== null) {
        const fieldName = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, fieldName, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:store',
            label: `by ${m[2]}() (${fieldName})`,
            handlerName: fieldName,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

function extractKotlinLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    COMPOSE_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPOSE_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
    ANDROID_CLASS_LIFECYCLE_RE.lastIndex = 0;
    while ((m = ANDROID_CLASS_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.replace(/^on/, '').toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ── Flutter data + lifecycle ───────────────────────────────────────
//   data:    Provider.of<T> / context.watch<T> / context.read<T> /
//            Consumer<T> / BlocBuilder<T> / StreamBuilder /
//            FutureBuilder / Riverpod ref.watch / ref.read
//   lifecycle (State): initState / dispose / didChangeDependencies /
//                      didUpdateWidget / build /
//                      WidgetsBinding.addPostFrameCallback

const FLUTTER_DATA_RE = /\b(Provider\.of|context\.watch|context\.read|ref\.watch|ref\.read|Consumer|BlocBuilder|BlocListener|StreamBuilder|FutureBuilder|Selector|MultiProvider)\s*[<(]/g;
const FLUTTER_LIFECYCLE_RE = /\b(?:@override\s+)?(?:void\s+|Future<\w+>\s+)?(initState|dispose|didChangeDependencies|didUpdateWidget|reassemble|deactivate|activate)\s*\(/g;

function extractFlutterData(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    FLUTTER_DATA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = FLUTTER_DATA_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('data', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'data',
            kind: 'data:store',
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

function extractFlutterLifecycle(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    FLUTTER_LIFECYCLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = FLUTTER_LIFECYCLE_RE.exec(content)) !== null) {
        const name = m[1];
        const line = lineNumberOf(content, m.index ?? 0);
        emitItem(items, {
            itemId: makeItemId('lifecycle', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'lifecycle',
            kind: `lifecycle:${name.toLowerCase()}`,
            label: name,
            handlerName: name,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, line),
        });
    }
}

// ─────────────────────────────────────────────────────────────────────
// PR-D — Nav-in + Nav-out per framework.
// ─────────────────────────────────────────────────────────────────────

// ── JSX nav-out ────────────────────────────────────────────────────
// `<Link to="/foo">`, `<NavLink to="/foo">`, `<a href="/internal">`,
// `useNavigate()` invocations (`navigate('/foo')`), `router.push('/foo')`
// / `router.replace(...)` (Next.js + Remix shared shape).

const JSX_LINK_TO_RE = /<(?:Link|NavLink|NuxtLink)\b[^>]*?\bto\s*=\s*[`'"]([^`'"]+)[`'"]/g;
const JSX_ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*[`'"]([^`'"]+)[`'"]/g;
const JSX_ROUTER_PUSH_RE = /\b(?:router|navigation|nav)\s*\.\s*(push|replace|navigate)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const JSX_USE_NAVIGATE_RE = /\bnavigate\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

// Next.js `<Link href="/path">` (App + Pages Router). React-router / Remix use
// `to=` (handled above); Next's `<Link>` uses `href`, so it went undetected.
const JSX_NEXT_LINK_HREF_RE = /<(?:Link|NavLink)\b[^>]*?\bhref\s*=\s*[`'"]([^`'"]+)[`'"]/g;

// Next.js App Router server-side navigation from `next/navigation`:
// `redirect('/path')` / `permanentRedirect('/path')` → nav-out to that path;
// `notFound()` → renders the not-found route. Gated on the `next/navigation`
// import so a local `redirect`/`notFound` helper isn't mis-attributed.
const NEXT_NAVIGATION_IMPORT_RE = /\bfrom\s+['"]next\/navigation['"]/;
const NEXT_REDIRECT_RE = /\b(?:permanentRedirect|redirect)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;
const NEXT_NOT_FOUND_RE = /\bnotFound\s*\(\s*\)/g;

function extractJsxNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    JSX_LINK_TO_RE.lastIndex = 0;
    while ((m = JSX_LINK_TO_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:link', m[1], content, m.index ?? 0, idx++);
    }
    JSX_NEXT_LINK_HREF_RE.lastIndex = 0;
    while ((m = JSX_NEXT_LINK_HREF_RE.exec(content)) !== null) {
        const href = m[1];
        // External hrefs (http://…, mailto:, tel:, #anchor) aren't in-app nav.
        if (/^(?:https?:|mailto:|tel:|#|javascript:)/i.test(href)) continue;
        emitNavOut(items, screen, 'nav-out:link', href, content, m.index ?? 0, idx++);
    }
    JSX_ANCHOR_HREF_RE.lastIndex = 0;
    while ((m = JSX_ANCHOR_HREF_RE.exec(content)) !== null) {
        const href = m[1];
        // External hrefs (http://…, mailto:, tel:) aren't in-app nav.
        if (/^(?:https?:|mailto:|tel:|#|javascript:)/i.test(href)) continue;
        emitNavOut(items, screen, 'nav-out:link', href, content, m.index ?? 0, idx++);
    }
    JSX_ROUTER_PUSH_RE.lastIndex = 0;
    while ((m = JSX_ROUTER_PUSH_RE.exec(content)) !== null) {
        emitNavOut(items, screen, `nav-out:${m[1]}`, m[2], content, m.index ?? 0, idx++);
    }
    JSX_USE_NAVIGATE_RE.lastIndex = 0;
    while ((m = JSX_USE_NAVIGATE_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:navigate', m[1], content, m.index ?? 0, idx++);
    }
    // Next.js server-side navigation — only when `next/navigation` is imported.
    if (NEXT_NAVIGATION_IMPORT_RE.test(content)) {
        NEXT_REDIRECT_RE.lastIndex = 0;
        while ((m = NEXT_REDIRECT_RE.exec(content)) !== null) {
            emitNavOut(items, screen, 'nav-out:redirect', m[1], content, m.index ?? 0, idx++);
        }
        NEXT_NOT_FOUND_RE.lastIndex = 0;
        while ((m = NEXT_NOT_FOUND_RE.exec(content)) !== null) {
            emitNavOut(items, screen, 'nav-out:not-found', 'notFound', content, m.index ?? 0, idx++);
        }
    }
}

// ── Vue nav-out ────────────────────────────────────────────────────
// `<NuxtLink to="/foo">`, `<router-link to="/foo">`, `router.push('/foo')`
// from `useRouter()`.

const VUE_LINK_RE = /<(?:NuxtLink|router-link)\b[^>]*?\b(?:to|href)\s*=\s*["']([^"']+)["']/g;
const VUE_ROUTER_PUSH_RE = /\b(?:router|useRouter\(\))\s*\.\s*(push|replace)\s*\(\s*["']([^"']+)["']/g;

function extractVueNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    VUE_LINK_RE.lastIndex = 0;
    while ((m = VUE_LINK_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:link', m[1], content, m.index ?? 0, idx++);
    }
    VUE_ROUTER_PUSH_RE.lastIndex = 0;
    while ((m = VUE_ROUTER_PUSH_RE.exec(content)) !== null) {
        emitNavOut(items, screen, `nav-out:${m[1]}`, m[2], content, m.index ?? 0, idx++);
    }
}

// ── Svelte nav-out ─────────────────────────────────────────────────
// `<a href="/foo">`, `goto('/foo')` from `$app/navigation`.

const SVELTE_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/g;
const SVELTE_GOTO_RE = /\bgoto\s*\(\s*["']([^"']+)["']/g;

function extractSvelteNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    SVELTE_HREF_RE.lastIndex = 0;
    while ((m = SVELTE_HREF_RE.exec(content)) !== null) {
        const href = m[1];
        if (/^(?:https?:|mailto:|tel:|#)/i.test(href)) continue;
        emitNavOut(items, screen, 'nav-out:link', href, content, m.index ?? 0, idx++);
    }
    SVELTE_GOTO_RE.lastIndex = 0;
    while ((m = SVELTE_GOTO_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:goto', m[1], content, m.index ?? 0, idx++);
    }
}

// ── SwiftUI / UIKit nav-out ────────────────────────────────────────
// SwiftUI: `NavigationLink(destination: <View>())`, `NavigationLink(value:)`,
//          `dismiss()`, `presentationMode.wrappedValue.dismiss()`
// UIKit:   `present(<vc>, animated: true)`, `pushViewController(<vc>, ...)`,
//          `performSegue(withIdentifier: "<id>", sender: ...)`

const SWIFTUI_NAV_LINK_RE = /\bNavigationLink\s*\(\s*(?:destination\s*:\s*)?(\w+|"[^"]+")/g;
const SWIFTUI_DISMISS_RE = /\b(?:dismiss\s*\(\s*\)|presentationMode\.wrappedValue\.dismiss\s*\(\s*\))/g;
const UIKIT_PUSH_VIEW_RE = /\b(?:navigationController\??\.)?pushViewController\s*\(\s*(\w+)/g;
const UIKIT_PRESENT_RE = /\.\s*present\s*\(\s*(\w+)/g;
const UIKIT_PERFORM_SEGUE_RE = /\bperformSegue\s*\(\s*withIdentifier\s*:\s*"([^"]+)"/g;

function extractSwiftNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    SWIFTUI_NAV_LINK_RE.lastIndex = 0;
    while ((m = SWIFTUI_NAV_LINK_RE.exec(content)) !== null) {
        const dest = m[1].replace(/[()"]/g, '');
        emitNavOut(items, screen, 'nav-out:link', dest, content, m.index ?? 0, idx++);
    }
    SWIFTUI_DISMISS_RE.lastIndex = 0;
    while ((m = SWIFTUI_DISMISS_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:dismiss', 'dismiss', content, m.index ?? 0, idx++);
    }
    UIKIT_PUSH_VIEW_RE.lastIndex = 0;
    while ((m = UIKIT_PUSH_VIEW_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:push', m[1], content, m.index ?? 0, idx++);
    }
    UIKIT_PRESENT_RE.lastIndex = 0;
    while ((m = UIKIT_PRESENT_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:present', m[1], content, m.index ?? 0, idx++);
    }
    UIKIT_PERFORM_SEGUE_RE.lastIndex = 0;
    while ((m = UIKIT_PERFORM_SEGUE_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:segue', m[1], content, m.index ?? 0, idx++);
    }
}

// ── Compose / Android nav-out ──────────────────────────────────────
// Compose: `navController.navigate("route")`, `navController.popBackStack()`
// Android: `startActivity(Intent(this, NextActivity::class.java))`,
//          `findNavController().navigate(R.id.action_x)`,
//          `findNavController().navigate(directions)`

const COMPOSE_NAV_CONTROLLER_RE = /\bnavController\s*\.\s*navigate\s*\(\s*(?:route\s*=\s*)?["']([^"']+)["']/g;
const COMPOSE_POP_BACK_STACK_RE = /\bnavController\s*\.\s*popBackStack\s*\(/g;
const ANDROID_START_ACTIVITY_RE = /\bstartActivity\s*\(\s*Intent\s*\(\s*[\w@?.]+\s*,\s*(\w+)::class\.java/g;
const ANDROID_NAV_CONTROLLER_RE = /\bfindNavController\s*\(\s*\)\s*\.\s*navigate\s*\(\s*([\w.]+)/g;

function extractKotlinNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    COMPOSE_NAV_CONTROLLER_RE.lastIndex = 0;
    while ((m = COMPOSE_NAV_CONTROLLER_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:navigate', m[1], content, m.index ?? 0, idx++);
    }
    COMPOSE_POP_BACK_STACK_RE.lastIndex = 0;
    while ((m = COMPOSE_POP_BACK_STACK_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:pop', 'popBackStack', content, m.index ?? 0, idx++);
    }
    ANDROID_START_ACTIVITY_RE.lastIndex = 0;
    while ((m = ANDROID_START_ACTIVITY_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:start-activity', m[1], content, m.index ?? 0, idx++);
    }
    ANDROID_NAV_CONTROLLER_RE.lastIndex = 0;
    while ((m = ANDROID_NAV_CONTROLLER_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:navigate', m[1], content, m.index ?? 0, idx++);
    }
}

// ── Flutter nav-out ────────────────────────────────────────────────
// `Navigator.push(context, MaterialPageRoute(builder: ...))`,
// `Navigator.pushNamed(context, '/foo')`, `Navigator.pop(context)`,
// `context.go('/foo')`, `context.push('/foo')`, `context.pop()`.

const FLUTTER_NAVIGATOR_PUSH_NAMED_RE = /\bNavigator\s*\.\s*(pushNamed|pushReplacementNamed|popAndPushNamed)\s*\(\s*context\s*,\s*['"]([^'"]+)['"]/g;
const FLUTTER_NAVIGATOR_PUSH_RE = /\bNavigator\s*\.\s*push\s*\(\s*context\s*,\s*MaterialPageRoute\s*\(\s*[\s\S]{0,80}?builder\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+|new\s+)?(\w+)/g;
const FLUTTER_NAVIGATOR_POP_RE = /\bNavigator\s*\.\s*(pop|popUntil)\s*\(/g;
const FLUTTER_CONTEXT_GO_RE = /\bcontext\s*\.\s*(go|push|pushReplacement|pushNamed|replace)\s*\(\s*['"]([^'"]+)['"]/g;
const FLUTTER_CONTEXT_POP_RE = /\bcontext\s*\.\s*pop\s*\(/g;

function extractFlutterNavOut(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    let idx = 0;
    let m: RegExpExecArray | null;
    FLUTTER_NAVIGATOR_PUSH_NAMED_RE.lastIndex = 0;
    while ((m = FLUTTER_NAVIGATOR_PUSH_NAMED_RE.exec(content)) !== null) {
        emitNavOut(items, screen, `nav-out:${m[1]}`, m[2], content, m.index ?? 0, idx++);
    }
    FLUTTER_NAVIGATOR_PUSH_RE.lastIndex = 0;
    while ((m = FLUTTER_NAVIGATOR_PUSH_RE.exec(content)) !== null) {
        // Filter Flutter built-ins same as PR-D flutter screen detector.
        const widget = m[1];
        if (/^(?:Container|Scaffold|Center|Column|Row|Padding|Material|Widget|Builder|FutureBuilder|StreamBuilder)$/.test(widget)) continue;
        emitNavOut(items, screen, 'nav-out:push', widget, content, m.index ?? 0, idx++);
    }
    FLUTTER_NAVIGATOR_POP_RE.lastIndex = 0;
    while ((m = FLUTTER_NAVIGATOR_POP_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:pop', m[1], content, m.index ?? 0, idx++);
    }
    FLUTTER_CONTEXT_GO_RE.lastIndex = 0;
    while ((m = FLUTTER_CONTEXT_GO_RE.exec(content)) !== null) {
        emitNavOut(items, screen, `nav-out:${m[1]}`, m[2], content, m.index ?? 0, idx++);
    }
    FLUTTER_CONTEXT_POP_RE.lastIndex = 0;
    while ((m = FLUTTER_CONTEXT_POP_RE.exec(content)) !== null) {
        emitNavOut(items, screen, 'nav-out:pop', 'pop', content, m.index ?? 0, idx++);
    }
}

function emitNavOut(
    items: L2bScreenItem[],
    screen: ScreenRecord,
    kind: string,
    route: string,
    content: string,
    offset: number,
    idx: number,
): void {
    const line = lineNumberOf(content, offset);
    emitItem(items, {
        itemId: makeItemId('nav-out', screen.filePath, route, idx),
        screenId: screen.screenId,
        section: 'nav-out',
        kind,
        label: route,
        route,
        filePath: screen.filePath,
        anchor: anchorAt(screen.filePath, line),
    });
}

// ── Nav-in via apiIndex cross-reference ────────────────────────────
// Pull `DEEP_LINK` / `PUSH_HANDLER` / `WIDGET` / `BG_TASK` /
// `CONTENT_PROVIDER` ApiRecord entries that point at this screen's
// file, and surface them under the screen's nav-in section.
//
// The existing `mobileDetector.ts` and `apiDetector.ts` already
// produce these records during init (PR-2 phase 1+) — we just look
// them up keyed by filePath. The cross-file resolution is approximate:
// we match by file path equality, which is conservative (avoids
// over-attaching nav-in events from sibling files). PR-F can later
// refine by walking the actual Android `<intent-filter>` target
// activity reference.

const NAV_IN_METHODS: ReadonlySet<string> = new Set([
    'DEEP_LINK',
    'PUSH_HANDLER',
    'WIDGET',
    'CONTENT_PROVIDER',
    'BG_TASK',
]);

function extractNavInFromApiIndex(
    screen: ScreenRecord,
    snapshot: Snapshot,
    items: L2bScreenItem[],
): void {
    let idx = 0;
    for (const api of Object.values(snapshot.apiIndex)) {
        if (!NAV_IN_METHODS.has(api.method)) continue;
        if (api.filePath !== screen.filePath) continue;
        const kindSuffix = api.method.toLowerCase().replace(/_/g, '-');
        emitItem(items, {
            itemId: makeItemId('nav-in', screen.filePath, api.route || api.handlerName, idx++),
            screenId: screen.screenId,
            section: 'nav-in',
            kind: `nav-in:${kindSuffix}`,
            label: api.route || api.handlerName,
            handlerName: api.handlerName,
            route: api.route,
            filePath: api.filePath,
            anchor: api.anchor ?? anchorAt(screen.filePath, 1),
        });
    }
}

// ─────────────────────────────────────────────────────────────────────
// PR-E — Visual element classifier (bottom-of-panel collapsible inventory).
//
// Strategy: per-framework lookup table maps known component / tag
// names to a `VisualElementKind`. Anything PascalCase that doesn't
// match becomes `'custom'`. To keep snapshots compact, items are
// aggregated by (visualKind, elementName) — one row per unique
// combination, with the label carrying the count: `Button × 3`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Element name → visual kind lookup. Per-framework tables are merged
 * per the spec §4 classifier table. Lookups are case-sensitive — the
 * caller normalises HTML tags to lowercase first.
 */
const JSX_VISUAL_KINDS: Record<string, VisualElementKind> = {
    // ── HTML primitives ───────────────────────────────────────────
    // Button
    'button': 'button', 'Button': 'button',
    'TouchableOpacity': 'button', 'TouchableHighlight': 'button',
    'Pressable': 'button', 'TouchableWithoutFeedback': 'button',
    // Input
    'input': 'input', 'textarea': 'input', 'select': 'input',
    'TextInput': 'input', 'TextField': 'input',
    // Toggle (RN Switch + SwiftUI Toggle render as inputs)
    'Switch': 'input',
    // List
    'ul': 'list', 'ol': 'list', 'table': 'list',
    'FlatList': 'list', 'SectionList': 'list', 'VirtualizedList': 'list',
    // Label / Text
    'span': 'label', 'p': 'label', 'label': 'label',
    'h1': 'label', 'h2': 'label', 'h3': 'label', 'h4': 'label', 'h5': 'label', 'h6': 'label',
    'Text': 'label',
    // Image
    'img': 'image', 'Image': 'image', 'picture': 'image', 'figure': 'image',
    // Form
    'form': 'form',
    // Layout
    'div': 'layout', 'section': 'layout', 'header': 'layout', 'footer': 'layout', 'main': 'layout', 'nav': 'layout',
    'View': 'layout', 'SafeAreaView': 'layout', 'ScrollView': 'layout',
    'KeyboardAvoidingView': 'layout', 'KeyboardAwareScrollView': 'layout',
    // Divider
    'hr': 'divider',
    // Indicator
    'progress': 'indicator', 'ActivityIndicator': 'indicator', 'RefreshControl': 'indicator',
    // Modal / Sheet
    'Modal': 'modal', 'Dialog': 'modal', 'Drawer': 'modal',
    // ── Material UI (@mui/material) ───────────────────────────────
    // v2 phase 7 PR-A — recognises the most-used MUI components so
    // users of Next.js + MUI / RemixJS + MUI see real component kinds
    // in the L2b visual section instead of the `custom` bucket.
    'IconButton': 'button', 'Fab': 'button', 'LoadingButton': 'button',
    'ToggleButton': 'input', 'ToggleButtonGroup': 'input',
    'OutlinedInput': 'input', 'FilledInput': 'input', 'Input': 'input',
    'Autocomplete': 'input', 'Select': 'input', 'Slider': 'input',
    'Checkbox': 'input', 'Radio': 'input', 'RadioGroup': 'input',
    'Rating': 'input',
    'List': 'list', 'ListItem': 'list', 'ListItemButton': 'list',
    'Table': 'list', 'TableRow': 'list', 'TableCell': 'list',
    'Typography': 'label',
    'Avatar': 'image', 'CardMedia': 'image',
    'FormControl': 'form', 'FormGroup': 'form',
    'Box': 'layout', 'Container': 'layout', 'Stack': 'layout',
    'Grid': 'layout', 'Paper': 'layout', 'Card': 'layout', 'CardContent': 'layout',
    'AppBar': 'layout', 'Toolbar': 'layout',
    'Divider': 'divider',
    'CircularProgress': 'indicator', 'LinearProgress': 'indicator',
    'Skeleton': 'indicator', 'Snackbar': 'indicator',
    'Tooltip': 'indicator', 'Alert': 'indicator',
    // (Modal / Dialog / Drawer already declared above; Popover is new.)
    'Popover': 'modal',
    // ── shadcn/ui + Radix UI primitives ───────────────────────────
    // shadcn re-exports Radix components with capitalised names.
    'AlertDialog': 'modal', 'Sheet': 'modal',
    'DialogContent': 'modal', 'DialogTrigger': 'button',
    'PopoverContent': 'modal', 'PopoverTrigger': 'button',
    'Tabs': 'layout', 'TabsTrigger': 'button',
    // ── React Native built-ins (extras) ───────────────────────────
    'StatusBar': 'indicator', 'SectionHeaderComponent': 'label',
    // ── Chakra UI ─────────────────────────────────────────────────
    'Flex': 'layout', 'HStack': 'layout', 'VStack': 'layout', 'Wrap': 'layout',
    'Heading': 'label',
};

const SWIFTUI_VISUAL_KINDS: Record<string, VisualElementKind> = {
    // ── SwiftUI native ────────────────────────────────────────────
    'Button': 'button', 'Link': 'button',
    'TextField': 'input', 'SecureField': 'input', 'TextEditor': 'input',
    'Toggle': 'input', 'Stepper': 'input', 'Slider': 'input',
    'Picker': 'input', 'DatePicker': 'input', 'ColorPicker': 'input',
    'List': 'list', 'ForEach': 'list', 'LazyVStack': 'list', 'LazyHStack': 'list',
    'LazyVGrid': 'list', 'LazyHGrid': 'list',
    'Text': 'label', 'Label': 'label', 'Markdown': 'label',
    'Image': 'image', 'AsyncImage': 'image',
    'Form': 'form', 'Group': 'layout',
    'VStack': 'layout', 'HStack': 'layout', 'ZStack': 'layout', 'Grid': 'layout',
    'ScrollView': 'layout', 'GeometryReader': 'layout',
    'NavigationStack': 'layout', 'NavigationView': 'layout', 'NavigationSplitView': 'layout',
    'TabView': 'layout', 'TabItem': 'layout',
    'Divider': 'divider', 'Spacer': 'divider',
    'ProgressView': 'indicator',
    // ── SwiftUI Sheets / Alerts (callbacks attached via modifiers
    //   — not direct identifiers — but we still want to surface them
    //   when they appear as struct types). ────────────────────────
    'Alert': 'modal', 'ConfirmationDialog': 'modal',
};

const COMPOSE_VISUAL_KINDS: Record<string, VisualElementKind> = {
    // ── Buttons (Material 3 + Material 2) ─────────────────────────
    'Button': 'button', 'TextButton': 'button', 'IconButton': 'button',
    'OutlinedButton': 'button', 'FilledTonalButton': 'button', 'ElevatedButton': 'button',
    'FloatingActionButton': 'button', 'ExtendedFloatingActionButton': 'button',
    'SmallFloatingActionButton': 'button', 'LargeFloatingActionButton': 'button',
    'Chip': 'button', 'AssistChip': 'button', 'FilterChip': 'button', 'InputChip': 'button',
    'SuggestionChip': 'button',
    // ── Inputs (Material 3 + Material 2) ──────────────────────────
    'TextField': 'input', 'OutlinedTextField': 'input', 'BasicTextField': 'input',
    'SearchBar': 'input', 'DockedSearchBar': 'input',
    'Switch': 'input', 'Checkbox': 'input', 'RadioButton': 'input', 'TriStateCheckbox': 'input',
    'DropdownMenu': 'input', 'ExposedDropdownMenuBox': 'input',
    'Slider': 'input', 'RangeSlider': 'input',
    // ── Lists / Scrollable containers ─────────────────────────────
    'LazyColumn': 'list', 'LazyRow': 'list',
    'LazyVerticalGrid': 'list', 'LazyHorizontalGrid': 'list',
    'LazyVerticalStaggeredGrid': 'list', 'LazyHorizontalStaggeredGrid': 'list',
    // ── Labels / Text ────────────────────────────────────────────
    'Text': 'label', 'OutlinedText': 'label', 'BasicText': 'label',
    // ── Images / Icons ───────────────────────────────────────────
    'Image': 'image', 'AsyncImage': 'image', 'Icon': 'image', 'CoilImage': 'image',
    // ── Layout containers ────────────────────────────────────────
    'Column': 'layout', 'Row': 'layout', 'Box': 'layout',
    'Surface': 'layout', 'Scaffold': 'layout', 'Card': 'layout',
    'BoxWithConstraints': 'layout', 'ConstraintLayout': 'layout',
    'BottomAppBar': 'layout', 'TopAppBar': 'layout', 'CenterAlignedTopAppBar': 'layout',
    'NavigationBar': 'layout', 'NavigationRail': 'layout', 'NavigationDrawer': 'layout',
    // ── Dividers / Spacers ───────────────────────────────────────
    'Divider': 'divider', 'HorizontalDivider': 'divider', 'VerticalDivider': 'divider',
    'Spacer': 'divider',
    // ── Indicators ───────────────────────────────────────────────
    'CircularProgressIndicator': 'indicator', 'LinearProgressIndicator': 'indicator',
    'Snackbar': 'indicator', 'Badge': 'indicator',
    // ── Dialogs / Sheets ─────────────────────────────────────────
    'AlertDialog': 'modal', 'ModalBottomSheet': 'modal', 'BasicAlertDialog': 'modal',
    'BottomSheetScaffold': 'modal', 'DatePickerDialog': 'modal', 'TimePickerDialog': 'modal',
};

const FLUTTER_VISUAL_KINDS: Record<string, VisualElementKind> = {
    // ── Buttons (Material + Cupertino) ───────────────────────────
    'ElevatedButton': 'button', 'TextButton': 'button', 'IconButton': 'button',
    'FloatingActionButton': 'button', 'OutlinedButton': 'button',
    'MaterialButton': 'button', 'InkWell': 'button', 'GestureDetector': 'button',
    'CupertinoButton': 'button', 'BackButton': 'button', 'CloseButton': 'button',
    'PopupMenuButton': 'button',
    // ── Inputs ───────────────────────────────────────────────────
    'TextField': 'input', 'TextFormField': 'input', 'CupertinoTextField': 'input',
    'Switch': 'input', 'CupertinoSwitch': 'input',
    'Checkbox': 'input', 'CheckboxListTile': 'input',
    'Radio': 'input', 'RadioListTile': 'input',
    'DropdownButton': 'input', 'DropdownMenu': 'input',
    'Slider': 'input', 'CupertinoSlider': 'input',
    'SearchBar': 'input', 'SearchAnchor': 'input',
    // ── Lists / Scrollables ──────────────────────────────────────
    'ListView': 'list', 'GridView': 'list',
    'SliverList': 'list', 'SliverGrid': 'list',
    'ReorderableListView': 'list', 'PageView': 'list',
    'CustomScrollView': 'list', 'NestedScrollView': 'list',
    'Wrap': 'layout',
    // ── Text / Labels ───────────────────────────────────────────
    'Text': 'label', 'RichText': 'label', 'SelectableText': 'label',
    'DefaultTextStyle': 'label',
    // ── Images / Icons ──────────────────────────────────────────
    'Image': 'image', 'NetworkImage': 'image', 'CachedNetworkImage': 'image',
    'Icon': 'image', 'CircleAvatar': 'image',
    // ── Forms ───────────────────────────────────────────────────
    'Form': 'form',
    // ── Layout containers ────────────────────────────────────────
    'Column': 'layout', 'Row': 'layout', 'Stack': 'layout',
    'Padding': 'layout', 'Container': 'layout', 'SafeArea': 'layout', 'Scaffold': 'layout',
    'Center': 'layout', 'Align': 'layout', 'Positioned': 'layout',
    'Expanded': 'layout', 'Flexible': 'layout',
    'AppBar': 'layout', 'BottomNavigationBar': 'layout', 'NavigationBar': 'layout',
    'TabBar': 'layout', 'TabBarView': 'layout',
    'CupertinoPageScaffold': 'layout', 'CupertinoTabScaffold': 'layout',
    'CupertinoNavigationBar': 'layout',
    // ── Dividers / Spacers ──────────────────────────────────────
    'Divider': 'divider', 'VerticalDivider': 'divider',
    'SizedBox': 'divider', 'Spacer': 'divider',
    // ── Indicators ──────────────────────────────────────────────
    'CircularProgressIndicator': 'indicator', 'LinearProgressIndicator': 'indicator',
    'CupertinoActivityIndicator': 'indicator',
    'SnackBar': 'indicator', 'Banner': 'indicator', 'Tooltip': 'indicator',
    // ── Modals / Sheets ──────────────────────────────────────────
    'Dialog': 'modal', 'AlertDialog': 'modal', 'CupertinoAlertDialog': 'modal',
    'CupertinoActionSheet': 'modal', 'BottomSheet': 'modal',
    'SimpleDialog': 'modal', 'ModalBarrier': 'modal',
};

/**
 * Detect every `<Tag ...>` opening in JSX / Vue / Svelte template
 * content. The same regex serves all three because Vue / Svelte use
 * the same `<Tag ...>` shape inside their templates.
 *
 * Custom components (PascalCase, no match in JSX_VISUAL_KINDS) get
 * the `'custom'` bucket so they're visible to the user.
 */
const HTML_TAG_OPEN_RE = /<([A-Za-z][\w-]*)\b/g;

function extractJsxVisual(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    extractTagBasedVisual(screen, content, items, JSX_VISUAL_KINDS, /^[a-z]/);
}

// #485-VISUAL (2026-06-07) — bridge between the standalone Vue /
// Svelte classifiers (PascalCase kinds) and the extractor's lowercase
// `VisualElementKind`. The standalone classifiers ship under
// `visualElementClassifier/` with their own test coverage; this map
// is the integration boundary, not the classification logic.
const CLASSIFIER_KIND_MAP: Record<string, VisualElementKind> = {
    Button: 'button',
    Input: 'input',
    Toggle: 'input',
    Picker: 'input',
    List: 'list',
    Label: 'label',
    Image: 'image',
    Form: 'form',
    Layout: 'layout',
    Divider: 'divider',
    Indicator: 'indicator',
    Modal: 'modal',
    Custom: 'custom',
};

function extractVueVisual(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    extractTagBasedVisualViaClassifier(screen, content, items, classifyVueElement, /^[a-z]/);
}

function extractSvelteVisual(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    extractTagBasedVisualViaClassifier(screen, content, items, classifySvelteElement, /^[a-z]/);
}

/**
 * #485-VISUAL (2026-06-07) — tag-based extractor that walks the source
 * with `HTML_TAG_OPEN_RE` (same as `extractTagBasedVisual`) but routes
 * each tag through a PascalCase-kind classifier function rather than
 * an inline table. The dispatcher maps PascalCase → lowercase via
 * `CLASSIFIER_KIND_MAP`.
 */
function extractTagBasedVisualViaClassifier(
    screen: ScreenRecord,
    content: string,
    items: L2bScreenItem[],
    classifier: (name: string) => string | undefined,
    lowerCasePrimitivePattern: RegExp,
): void {
    const agg = new Map<string, { kind: VisualElementKind; count: number; line: number }>();
    HTML_TAG_OPEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HTML_TAG_OPEN_RE.exec(content)) !== null) {
        const tag = m[1];
        if (/^(?:script|style|meta|link|head|html|body|template|slot)$/i.test(tag)) continue;
        const pascalKind = classifier(tag);
        let kind: VisualElementKind | undefined = pascalKind ? CLASSIFIER_KIND_MAP[pascalKind] : undefined;
        if (!kind) {
            if (lowerCasePrimitivePattern.test(tag)) continue;
            kind = 'custom';
        }
        const existing = agg.get(tag);
        if (existing) {
            existing.count++;
        } else {
            agg.set(tag, { kind, count: 1, line: lineNumberOf(content, m.index ?? 0) });
        }
    }
    emitVisualAggregates(screen, items, agg);
}

/**
 * SwiftUI / UIKit: View / View-like types appear as `Identifier(`,
 * `Identifier {`, or `Identifier()` followed by a modifier chain.
 */
const SWIFT_VIEW_RE = /\b([A-Z]\w*)\s*(?:\(|\{)/g;

function extractSwiftVisual(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    extractIdentifierBasedVisual(screen, content, items, SWIFTUI_VISUAL_KINDS, SWIFT_VIEW_RE);
}

/**
 * Compose: `@Composable` calls appear as `Identifier(` or `Identifier {`.
 * Same shape as SwiftUI on the call side.
 */
const COMPOSE_VIEW_RE = /\b([A-Z]\w*)\s*(?:\(|\{)/g;

function extractKotlinVisual(
    screen: ScreenRecord,
    content: string,
    items: L2bScreenItem[],
    getXmlLayout?: XmlLayoutResolver,
): void {
    extractIdentifierBasedVisual(screen, content, items, COMPOSE_VISUAL_KINDS, COMPOSE_VIEW_RE);
    // v2 follow-up #718 — classic Activity / Fragment screens drive
    // their visual tree from `res/layout/X.xml` rather than Compose
    // calls. Walk the source for `setContentView(R.layout.X)` /
    // `inflate(R.layout.X, …)` references, then merge the XML
    // primitives into the same visual section as Compose calls.
    if (!getXmlLayout) return;
    if (screen.framework !== 'android-activity' && screen.framework !== 'android-fragment') return;
    extractAndroidXmlVisual(screen, content, items, getXmlLayout);
}

/**
 * v2 follow-up #718 — Android XML layout primitives → VisualElementKind.
 *
 * Keys are the XML tag's simple name (last segment after `.`).
 * Fully-qualified tags like `androidx.constraintlayout.widget.ConstraintLayout`
 * normalize to `ConstraintLayout` before lookup. Tags not in this
 * table fall through to `'custom'` so unfamiliar widgets still
 * surface in the L2b panel.
 */
const ANDROID_XML_VISUAL_KINDS: Record<string, VisualElementKind> = {
    // ── Buttons ───────────────────────────────────────────────────
    'Button': 'button', 'ImageButton': 'button',
    'MaterialButton': 'button', 'FloatingActionButton': 'button',
    'ExtendedFloatingActionButton': 'button',
    'CheckedTextView': 'button', 'Chip': 'button',
    // ── Inputs ────────────────────────────────────────────────────
    'EditText': 'input', 'AutoCompleteTextView': 'input',
    'MultiAutoCompleteTextView': 'input', 'TextInputEditText': 'input',
    'TextInputLayout': 'input',
    'Switch': 'input', 'SwitchCompat': 'input', 'SwitchMaterial': 'input',
    'CheckBox': 'input', 'RadioButton': 'input', 'RadioGroup': 'input',
    'Spinner': 'input', 'SeekBar': 'input', 'RatingBar': 'input',
    'DatePicker': 'input', 'TimePicker': 'input', 'NumberPicker': 'input',
    // ── Labels ────────────────────────────────────────────────────
    'TextView': 'label',
    // ── Images ────────────────────────────────────────────────────
    'ImageView': 'image', 'ShapeableImageView': 'image',
    // ── Lists ─────────────────────────────────────────────────────
    'ListView': 'list', 'GridView': 'list', 'RecyclerView': 'list',
    'ExpandableListView': 'list', 'ViewPager': 'list', 'ViewPager2': 'list',
    // ── Layouts ───────────────────────────────────────────────────
    'LinearLayout': 'layout', 'RelativeLayout': 'layout',
    'ConstraintLayout': 'layout', 'FrameLayout': 'layout',
    'CoordinatorLayout': 'layout', 'TableLayout': 'layout',
    'TableRow': 'layout', 'ScrollView': 'layout',
    'HorizontalScrollView': 'layout', 'NestedScrollView': 'layout',
    'AppBarLayout': 'layout', 'CollapsingToolbarLayout': 'layout',
    'Toolbar': 'layout', 'DrawerLayout': 'layout',
    'BottomNavigationView': 'layout', 'TabLayout': 'layout',
    'FragmentContainerView': 'layout',
    // ── Indicators ────────────────────────────────────────────────
    'ProgressBar': 'indicator',
    'LinearProgressIndicator': 'indicator',
    'CircularProgressIndicator': 'indicator',
    // ── Dividers ──────────────────────────────────────────────────
    'View': 'divider',  // <View android:background="?android:listDivider" .../>
    'Space': 'divider',
    // ── Modals ────────────────────────────────────────────────────
    'AlertDialog': 'modal',
};

/**
 * Matches `setContentView(R.layout.activity_main)` and
 * `inflater.inflate(R.layout.fragment_home, …)` plus DataBinding's
 * `DataBindingUtil.setContentView(this, R.layout.foo)` and ViewBinding
 * generated calls. Captures the layout name (group 1).
 */
const ANDROID_LAYOUT_REF_RE = /R\.layout\.([A-Za-z_][\w]*)/g;

/**
 * Matches `<Tag` openings in an XML layout, capturing the tag name.
 * Skips XML declarations (`<?xml`), comments (`<!--`), and closing
 * tags (`</`).
 */
const ANDROID_XML_TAG_RE = /<([A-Za-z_][\w.]*)\b/g;

function extractAndroidXmlVisual(
    screen: ScreenRecord,
    sourceContent: string,
    items: L2bScreenItem[],
    getXmlLayout: XmlLayoutResolver,
): void {
    ANDROID_LAYOUT_REF_RE.lastIndex = 0;
    const layoutNames = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = ANDROID_LAYOUT_REF_RE.exec(sourceContent)) !== null) {
        layoutNames.add(m[1]);
    }
    if (layoutNames.size === 0) return;
    // Aggregate across all referenced layouts. Each `(simpleTag)` is
    // emitted once per screen with a count summary so the L2b panel
    // doesn't drown in 30+ rows for a heavy layout.
    const agg = new Map<string, { kind: VisualElementKind; count: number; layoutName: string; line: number }>();
    for (const layoutName of layoutNames) {
        const xml = getXmlLayout(layoutName);
        if (!xml) continue;
        ANDROID_XML_TAG_RE.lastIndex = 0;
        let t: RegExpExecArray | null;
        while ((t = ANDROID_XML_TAG_RE.exec(xml)) !== null) {
            const fullTag = t[1];
            // XML reserved openings — `?xml`, comment openers — never
            // match the regex above (it requires `[A-Za-z_]` first
            // character). Closing tags `</Foo>` start with `<` then
            // `/` so they don't match either.
            const simple = fullTag.includes('.') ? fullTag.slice(fullTag.lastIndexOf('.') + 1) : fullTag;
            // Skip `<include>` / `<merge>` / `<requestFocus>` —
            // structural directives, not visual elements.
            if (simple === 'include' || simple === 'merge' || simple === 'requestFocus') continue;
            let kind = ANDROID_XML_VISUAL_KINDS[simple];
            if (!kind) {
                // PascalCase non-primitive → custom widget. Lowercase
                // unknown tags (xmlns, etc.) get dropped.
                if (!/^[A-Z]/.test(simple)) continue;
                kind = 'custom';
            }
            const existing = agg.get(simple);
            if (existing) {
                existing.count++;
            } else {
                agg.set(simple, {
                    kind,
                    count: 1,
                    layoutName,
                    line: lineNumberOf(xml, t.index ?? 0),
                });
            }
        }
    }
    // Emit with anchors pointing at the layout XML (best-effort —
    // we don't know the actual file path because the resolver hides
    // it; we synthesize `res/layout/<name>.xml`).
    let idx = 0;
    const entries = [...agg.entries()].sort((a, b) => {
        if (a[1].kind !== b[1].kind) return a[1].kind.localeCompare(b[1].kind);
        return b[1].count - a[1].count;
    });
    for (const [name, info] of entries) {
        const xmlFilePath = `res/layout/${info.layoutName}.xml`;
        emitItem(items, {
            itemId: makeItemId('visual', xmlFilePath, name, idx++),
            screenId: screen.screenId,
            section: 'visual',
            kind: `visual:${info.kind}`,
            label: info.count > 1 ? `${name} × ${info.count}` : name,
            visualKind: info.kind,
            filePath: xmlFilePath,
            anchor: anchorAt(xmlFilePath, info.line),
        });
    }
}

/**
 * Flutter widgets always have a constructor call: `Widget(...)`.
 */
const FLUTTER_WIDGET_RE = /\b([A-Z]\w*)\s*\(/g;

function extractFlutterVisual(screen: ScreenRecord, content: string, items: L2bScreenItem[]): void {
    extractIdentifierBasedVisual(screen, content, items, FLUTTER_VISUAL_KINDS, FLUTTER_WIDGET_RE);
}

/**
 * Aggregate `<Tag>` matches by name and emit one item per unique
 * `(visualKind, tagName)` pair. JSX / Vue / Svelte share this shape.
 *
 * @param lowerCasePrimitivePattern Matches lowercase HTML primitives
 *   (`div`, `button`, `input`). Used so the classifier doesn't bucket
 *   custom user components like `<Login>` under 'layout' just because
 *   they start with lowercase.
 */
function extractTagBasedVisual(
    screen: ScreenRecord,
    content: string,
    items: L2bScreenItem[],
    table: Record<string, VisualElementKind>,
    lowerCasePrimitivePattern: RegExp,
): void {
    // Aggregation: (name) → { kind, count, firstLine }
    const agg = new Map<string, { kind: VisualElementKind; count: number; line: number }>();
    HTML_TAG_OPEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HTML_TAG_OPEN_RE.exec(content)) !== null) {
        const tag = m[1];
        // HTML reserves a small set of tags that never count as visual
        // (script, style, meta, etc.).
        if (/^(?:script|style|meta|link|head|html|body|template|slot)$/i.test(tag)) continue;
        let kind = table[tag];
        if (!kind) {
            // Lowercase primitive not in table → ignore (not all HTML
            // tags are L2b-worthy). PascalCase non-primitive → custom.
            if (lowerCasePrimitivePattern.test(tag)) continue;
            kind = 'custom';
        }
        const existing = agg.get(tag);
        if (existing) {
            existing.count++;
        } else {
            agg.set(tag, { kind, count: 1, line: lineNumberOf(content, m.index ?? 0) });
        }
    }
    emitVisualAggregates(screen, items, agg);
}

/**
 * Aggregate `Identifier(` or `Identifier {` matches by name for
 * SwiftUI / Compose / Flutter. Same emit shape as the tag-based
 * variant; only the detection regex differs.
 */
function extractIdentifierBasedVisual(
    screen: ScreenRecord,
    content: string,
    items: L2bScreenItem[],
    table: Record<string, VisualElementKind>,
    pattern: RegExp,
): void {
    const agg = new Map<string, { kind: VisualElementKind; count: number; line: number }>();
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
        const name = m[1];
        // Skip language-level keywords / common framework calls that
        // happen to be PascalCase but aren't views (e.g. SwiftUI's
        // `if`/`else` aren't matched, but `String(...)`, `Int(...)`
        // are noisy). Filter common type constructors out.
        if (/^(?:String|Int|Double|Float|Bool|Array|Set|Dictionary|Optional|Result|Error|Date|UUID|URL|Data|Color)$/.test(name)) continue;
        let kind = table[name];
        if (!kind) {
            kind = 'custom';
        }
        const existing = agg.get(name);
        if (existing) {
            existing.count++;
        } else {
            agg.set(name, { kind, count: 1, line: lineNumberOf(content, m.index ?? 0) });
        }
    }
    emitVisualAggregates(screen, items, agg);
}

function emitVisualAggregates(
    screen: ScreenRecord,
    items: L2bScreenItem[],
    agg: Map<string, { kind: VisualElementKind; count: number; line: number }>,
): void {
    let idx = 0;
    // Sort by kind then count desc so the bottom-of-panel inventory
    // renders deterministically and Buttons / Inputs / Lists bubble up.
    const entries = [...agg.entries()].sort((a, b) => {
        if (a[1].kind !== b[1].kind) return a[1].kind.localeCompare(b[1].kind);
        return b[1].count - a[1].count;
    });
    for (const [name, info] of entries) {
        emitItem(items, {
            itemId: makeItemId('visual', screen.filePath, name, idx++),
            screenId: screen.screenId,
            section: 'visual',
            kind: `visual:${info.kind}`,
            label: info.count > 1 ? `${name} × ${info.count}` : name,
            visualKind: info.kind,
            filePath: screen.filePath,
            anchor: anchorAt(screen.filePath, info.line),
        });
    }
}

function lineNumberOf(content: string, offset: number): number {
    // 1-based line number for an offset within `content`. Cheap +
    // accurate enough for anchor jump-to-definition; avoids pulling in
    // tree-sitter just for line counting.
    let line = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
        if (content.charCodeAt(i) === 10) line++;
    }
    return line;
}

// Exported for unit tests
export const _testing = {
    JSX_INTERACTION_RE,
    VUE_INTERACTION_RE,
    SVELTE_INTERACTION_RE,
    SWIFTUI_GESTURE_RE,
    UIKIT_ADD_TARGET_RE,
    COMPOSE_CLICKABLE_RE,
    COMPOSE_ON_CLICK_RE,
    KOTLIN_SET_LISTENER_RE,
    FLUTTER_INTERACTION_RE,
    JSX_USE_CALL_RE,
    JSX_LIFECYCLE_RE,
    REACT_STORE_HOOKS,
    REACT_LIFECYCLE_HOOKS,
    REACT_STATE_PRIMITIVE_HOOKS,
    VUE_DATA_RE,
    VUE_LIFECYCLE_RE,
    SVELTE_DATA_RE,
    SVELTE_LIFECYCLE_RE,
    SWIFTUI_DATA_RE,
    SWIFTUI_LIFECYCLE_RE,
    UIKIT_LIFECYCLE_OVERRIDE_RE,
    COMPOSE_DATA_RE,
    KOTLIN_INJECT_RE,
    KOTLIN_VIEWMODEL_DELEGATE_RE,
    COMPOSE_LIFECYCLE_RE,
    ANDROID_CLASS_LIFECYCLE_RE,
    FLUTTER_DATA_RE,
    FLUTTER_LIFECYCLE_RE,
    lineNumberOf,
};
