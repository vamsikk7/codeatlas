/**
 * frontendDataFlowBuilder.test.ts — v2 phase 5 PR-A.
 *
 * Locks the scaffolding contract:
 *   1. Graph id is `sequence:<screenFilePath>:<itemId>` so the
 *      SequenceView renderer + App.tsx hash routing pick it up with
 *      zero extra plumbing.
 *   2. The graph type is `'sequence'` so the existing SequenceView
 *      renders it. (FE/mobile L3 reuses the backend sequence
 *      renderer per spec §3 L3.)
 *   3. Two participants minimum: screen component + the L2b item's
 *      handler. PR-B+ adds hook / store / fetcher participants
 *      between them.
 *   4. Meta carries `category: 'frontend'`, the section, the screenId,
 *      and `isScaffoldOnly: true` so PR-B can detect partial-walk
 *      graphs and replace them.
 *   5. Subtitle picks the right Section-specific stereotype
 *      (`«handler»` / `«data source»` / `«lifecycle»` / `«nav-in»` /
 *      `«nav-out»`).
 */

import { describe, it, expect } from 'vitest';
import { buildFrontendDataFlowGraph } from '../frontendDataFlowBuilder';
import type { ScreenRecord, L2bScreenItem, ApiRecord, DiagramGraph } from '../graphTypes';

function mkScreen(over: Partial<ScreenRecord> & { screenId: string }): ScreenRecord {
    return {
        serviceId: 'service:web',
        routePath: '/login',
        framework: 'nextjs-app',
        filePath: 'apps/web/app/login/page.tsx',
        anchor: { filePath: 'apps/web/app/login/page.tsx', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

function mkItem(over: Partial<L2bScreenItem> & { itemId: string; section: L2bScreenItem['section']; kind: string }): L2bScreenItem {
    return {
        screenId: 'screen:service:web:/login',
        label: 'handleSubmit',
        handlerName: 'handleSubmit',
        filePath: 'apps/web/app/login/page.tsx',
        anchor: { filePath: 'apps/web/app/login/page.tsx', lineStart: 12, lineEnd: 18 },
        ...over,
    };
}

describe('buildFrontendDataFlowGraph — PR-A scaffolding', () => {
    it('graph id matches sequence:<screenFilePath>:<itemId> shape', () => {
        const screen = mkScreen({ screenId: 's' });
        const item = mkItem({ itemId: 'interactions:apps/web/app/login/page.tsx:handleSubmit', section: 'interactions', kind: 'interaction:click' });
        const graph = buildFrontendDataFlowGraph(screen, item);
        expect(graph).not.toBeNull();
        expect(graph!.graphId).toBe(
            'sequence:apps/web/app/login/page.tsx:interactions:apps/web/app/login/page.tsx:handleSubmit',
        );
        expect(graph!.type).toBe('sequence');
    });

    it('two participants — screen component + handler', () => {
        const graph = buildFrontendDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:click' }),
        );
        const participants = graph!.nodes.filter((n) => n.type === 'participant');
        expect(participants.length).toBe(2);
        const labels = participants.map((p) => p.label).sort();
        expect(labels).toEqual(['handleSubmit', 'page.tsx']);
    });

    it('section-specific subtitle stereotypes for the handler participant', () => {
        const cases: Array<[L2bScreenItem['section'], string]> = [
            ['interactions', '«handler»'],
            ['data', '«data source»'],
            ['lifecycle', '«lifecycle»'],
            ['nav-in', '«nav-in»'],
            ['nav-out', '«nav-out»'],
        ];
        for (const [section, expectedSubtitle] of cases) {
            const graph = buildFrontendDataFlowGraph(
                mkScreen({ screenId: 's' }),
                mkItem({ itemId: 'x', section, kind: `${section}:test` }),
            );
            const handler = graph!.nodes.find((n) => n.id === 'p:handler');
            expect(handler!.subtitle, `subtitle for section=${section}`).toBe(expectedSubtitle);
        }
    });

    it('one message edge from screen → handler with the kind as label', () => {
        const graph = buildFrontendDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:submit' }),
        );
        expect(graph!.edges.length).toBe(1);
        expect(graph!.edges[0].label).toBe('interaction:submit');
        expect(graph!.edges[0].edgeType).toBe('message');
        expect(graph!.edges[0].source).toBe('p:screen');
        expect(graph!.edges[0].target).toBe('p:handler');
    });

    it('meta carries the scaffolding markers PR-B will key off', () => {
        const screen = mkScreen({ screenId: 's', framework: 'remix' });
        const item = mkItem({ itemId: 'x', section: 'lifecycle', kind: 'lifecycle:effect' });
        const graph = buildFrontendDataFlowGraph(screen, item);
        expect(graph!.meta).toMatchObject({
            category: 'frontend',
            screenId: 's',
            itemId: 'x',
            section: 'lifecycle',
            framework: 'remix',
            isScaffoldOnly: true,
        });
    });

    it('null screen filePath produces null (silent skip)', () => {
        const graph = buildFrontendDataFlowGraph(
            mkScreen({ screenId: 's', filePath: '' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'x' }),
        );
        expect(graph).toBeNull();
    });

    it('handler participant falls back to label then kind when handlerName is missing', () => {
        const graph = buildFrontendDataFlowGraph(
            mkScreen({ screenId: 's' }),
            { ...mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:click', label: 'anonymous@onClick' }), handlerName: undefined },
        );
        const handler = graph!.nodes.find((n) => n.id === 'p:handler');
        expect(handler!.label).toBe('anonymous@onClick');
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 5 PR-B — FE interaction-handler walk.
//
// What the walker produces beyond the PR-A scaffolding:
//   - One Hook participant lane per distinct `useFoo(...)` call inside
//     the handler body (excluding lifecycle hooks and React state
//     primitives, which would be noise).
//   - One Store lane per `useSelector/useContext/useAtom/useStore`.
//   - One Fetcher lane per `fetch(...)` / `axios.<verb>(...)` /
//     `useQuery/useMutation` call site.
//   - One Backend lane when a fetcher's URL literal matches a workspace
//     `apiIndex` route (cross-link to backend L3).
//   - One Persistence lane per `localStorage/sessionStorage/AsyncStorage/
//     document.cookie` reference.
//   - Message edges from the handler participant to each lane.
//   - `meta.isScaffoldOnly` flips to `false` so the renderer can tell
//     the difference between a walked and a placeholder graph.
//
// Coverage focus:
//   1. Each lane appears with the right participant subtitle.
//   2. Lanes dedup: multiple `fetch` calls collapse to ONE Fetcher lane.
//   3. Edges dedup by (source, target, label).
//   4. Cross-link to backend fires when a URL matches `apiIndex`.
//   5. Hooks that are lifecycle (`useEffect`) or state primitives
//      (`useState`) are NOT participants here — they belong in
//      Lifecycle / Data sections, not in the handler walk.
//   6. Inline-arrow handlers (`anonymous@onClick`) skip the walk —
//      the graph stays at PR-A scaffolding shape.
// ─────────────────────────────────────────────────────────────────────

describe('buildFrontendDataFlowGraph — PR-B interaction-handler walk', () => {
    function mkBuild(handlerBody: string, opts?: { extraFile?: string; apiIndex?: Record<string, ApiRecord> }) {
        const handlerName = 'handleSubmit';
        const content =
            `import { useState } from 'react';\n` +
            `function ${handlerName}() {\n${handlerBody}\n}\n` +
            (opts?.extraFile ?? '');
        const screen = mkScreen({ screenId: 's' });
        const item = mkItem({
            itemId: `interactions:${screen.filePath}:${handlerName}`,
            section: 'interactions',
            kind: 'interaction:submit',
            handlerName,
            label: handlerName,
        });
        return buildFrontendDataFlowGraph(screen, item, { content, apiIndex: opts?.apiIndex ?? {} });
    }

    function participants(graph: DiagramGraph): string[] {
        return graph.nodes.filter((n) => n.type === 'participant').map((n) => n.label).sort();
    }

    function edgeLabels(graph: DiagramGraph): string[] {
        return graph.edges.map((e) => e.label ?? '').sort();
    }

    it('fetch("/api/foo") adds Fetcher lane + edge labelled with the URL', () => {
        const graph = mkBuild(`  await fetch("/api/users");\n  return null;`);
        expect(participants(graph)).toContain('fetch');
        expect(edgeLabels(graph)).toContain('/api/users');
        expect(graph!.meta.isScaffoldOnly).toBe(false);
    });

    it('axios.post("/api/users") adds Fetcher lane', () => {
        const graph = mkBuild(`  axios.post("/api/users", { name: "x" });`);
        expect(participants(graph)).toContain('axios');
    });

    it('useQuery + useMutation classify as Fetcher lanes (hooks that fetch)', () => {
        const graph = mkBuild(`  const q = useQuery({});\n  const m = useMutation();`);
        const labels = participants(graph);
        expect(labels).toContain('useQuery');
        expect(labels).toContain('useMutation');
    });

    it('useSelector / useContext classify as Store lanes', () => {
        const graph = mkBuild(`  const user = useSelector(s => s.user);\n  const ctx = useContext(AuthCtx);`);
        const labels = participants(graph);
        expect(labels).toContain('useSelector');
        expect(labels).toContain('useContext');
    });

    it('useState / useEffect / useRef are NOT participants (filtered noise)', () => {
        const graph = mkBuild(`  const [x, setX] = useState(0);\n  useEffect(() => {}, []);\n  const ref = useRef(null);`);
        const labels = participants(graph);
        expect(labels).not.toContain('useState');
        expect(labels).not.toContain('useEffect');
        expect(labels).not.toContain('useRef');
    });

    it('localStorage / sessionStorage / AsyncStorage / document.cookie collapse to ONE Persistence lane', () => {
        const graph = mkBuild(`  localStorage.setItem("k", "v");\n  sessionStorage.getItem("k");\n  document.cookie = "x=1";`);
        const persist = graph!.nodes.filter((n) => n.subtitle === '«persistence»');
        expect(persist.length).toBe(1);
        // But three distinct edges (one per accessor).
        const persistEdges = graph!.edges.filter((e) => e.target === 'p:persistence');
        expect(persistEdges.length).toBe(3);
    });

    it('duplicate fetch calls collapse to one Fetcher lane + dedup edges by URL', () => {
        const graph = mkBuild(`  await fetch("/api/a");\n  await fetch("/api/b");\n  await fetch("/api/a");`);
        const fetchers = graph!.nodes.filter((n) => n.label === 'fetch');
        expect(fetchers.length).toBe(1);
        const urls = graph!.edges.filter((e) => e.target === 'p:fetcher:fetch').map((e) => e.label).sort();
        expect(urls).toEqual(['/api/a', '/api/b']);  // /api/a dedup'd to one edge
    });

    it('cross-link to backend when fetch URL matches workspace apiIndex route', () => {
        const apiIndex: Record<string, ApiRecord> = {
            'a1': {
                apiId: 'a1', method: 'GET', route: '/api/users/:id',
                handlerName: 'getUserById', filePath: 'apps/api/src/users.ts',
                anchor: { filePath: 'apps/api/src/users.ts', lineStart: 5, lineEnd: 12 },
            },
        };
        const graph = mkBuild(`  await fetch("/api/users/42");`, { apiIndex });
        const backend = graph!.nodes.find((n) => n.subtitle === '«backend»');
        expect(backend).toBeDefined();
        expect(backend!.label).toBe('getUserById');
        // Edge from fetcher → backend exists with method+route label.
        const xlink = graph!.edges.find((e) => e.target === backend!.id);
        expect(xlink).toBeDefined();
        expect(xlink!.label).toBe('GET /api/users/:id');
    });

    it('fetch URL NOT matching any backend route → no Backend lane', () => {
        const apiIndex: Record<string, ApiRecord> = {
            'a1': {
                apiId: 'a1', method: 'GET', route: '/api/articles',
                handlerName: 'listArticles', filePath: 'apps/api/src/a.ts',
                anchor: { filePath: 'apps/api/src/a.ts', lineStart: 1, lineEnd: 1 },
            },
        };
        const graph = mkBuild(`  await fetch("https://external.example.com/foo");`, { apiIndex });
        expect(graph!.nodes.find((n) => n.subtitle === '«backend»')).toBeUndefined();
    });

    it('inline-arrow handler (handlerName undefined) keeps the PR-A scaffold shape', () => {
        const screen = mkScreen({ screenId: 's' });
        const item = { ...mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:click', label: 'anonymous@onClick' }), handlerName: undefined };
        const graph = buildFrontendDataFlowGraph(screen, item, { content: 'something' });
        expect(graph!.meta.isScaffoldOnly).toBe(true);
        // Only the 2 PR-A participants.
        expect(graph!.nodes.filter((n) => n.type === 'participant').length).toBe(2);
    });

    it('handlerName that does not appear in source falls back to scaffold (no false-emit)', () => {
        const screen = mkScreen({ screenId: 's' });
        const item = mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:click', handlerName: 'doesNotExist' });
        const graph = buildFrontendDataFlowGraph(screen, item, { content: '// no matching function in here' });
        expect(graph!.meta.isScaffoldOnly).toBe(true);
        expect(graph!.nodes.filter((n) => n.type === 'participant').length).toBe(2);
    });

    it('without ctx, builder produces scaffolding shape (back-compat for PR-A callers)', () => {
        const graph = buildFrontendDataFlowGraph(
            mkScreen({ screenId: 's' }),
            mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:click' }),
        );
        expect(graph!.meta.isScaffoldOnly).toBe(true);
    });

    it('arrow-function handler with body brace counts walks the body', () => {
        const handlerName = 'onSave';
        const content = `const ${handlerName} = async (e) => {\n  e.preventDefault();\n  const r = useMutation();\n  await fetch("/api/save");\n};`;
        const screen = mkScreen({ screenId: 's' });
        const item = mkItem({ itemId: 'x', section: 'interactions', kind: 'interaction:submit', handlerName, label: handlerName });
        const graph = buildFrontendDataFlowGraph(screen, item, { content });
        expect(graph!.meta.isScaffoldOnly).toBe(false);
        const labels = participants(graph!);
        expect(labels).toContain('useMutation');
        expect(labels).toContain('fetch');
    });
});

// ─────────────────────────────────────────────────────────────────────
// v2 phase 5 PR-C — Lifecycle / Data / Nav-in / Nav-out walks.
//
// Coverage focus:
//   1. Lifecycle: inline `useEffect(() => { … })` body is sliced and
//      walked. Internal `fetch` / hook / persistence calls become
//      participant lanes.
//   2. Lifecycle: when the effect body has NO inline callback
//      (`useEffect(myFn, [])`), the walker silently falls back
//      to scaffold (we can't follow the reference here — that's PR-D
//      cross-file walk).
//   3. Data sources: the hook's call-site window is walked. The
//      hook itself (already the `p:handler` participant) is NOT
//      duplicated as a lane.
//   4. Nav-in: walks the screen file top-level for hooks / effects
//      that fire on first reach.
//   5. Nav-out: emits a single `p:nav-target` participant labelled
//      with the destination route.
// ─────────────────────────────────────────────────────────────────────

describe('buildFrontendDataFlowGraph — PR-C lifecycle/data/nav walks', () => {
    function participants(graph: DiagramGraph): string[] {
        return graph.nodes.filter((n) => n.type === 'participant').map((n) => n.label).sort();
    }

    it('lifecycle: useEffect(() => { fetch(...) }, []) walks the inline callback body', () => {
        const screen = mkScreen({ screenId: 's' });
        const content = `useEffect(() => {\n  fetch("/api/users");\n  localStorage.setItem("k", "v");\n}, []);`;
        const item: L2bScreenItem = {
            itemId: 'lifecycle:apps/web/app/login/page.tsx:useEffect',
            screenId: 's',
            section: 'lifecycle',
            kind: 'lifecycle:effect',
            label: 'useEffect',
            handlerName: 'useEffect',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content });
        expect(graph!.meta.isScaffoldOnly).toBe(false);
        const labels = participants(graph!);
        expect(labels).toContain('fetch');
        expect(labels).toContain('localStorage');
    });

    it('lifecycle: useEffect(referencedHandler, []) without inline body → scaffold (no walk)', () => {
        const screen = mkScreen({ screenId: 's' });
        const content = `useEffect(myExternalHandler, []);`;
        const item: L2bScreenItem = {
            itemId: 'lifecycle:apps/web/app/login/page.tsx:useEffect',
            screenId: 's',
            section: 'lifecycle',
            kind: 'lifecycle:effect',
            label: 'useEffect',
            handlerName: 'useEffect',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content });
        expect(graph!.meta.isScaffoldOnly).toBe(true);
    });

    it('data source: useSWR(...) walks the call-site window, surfaces nearby fetch/persistence', () => {
        const screen = mkScreen({ screenId: 's' });
        const content =
            `const data = useSWR("/api/foo");\n` +
            `await fetch("/api/related");\n` +
            `localStorage.setItem("cache", JSON.stringify(data));\n`;
        const item: L2bScreenItem = {
            itemId: 'data:apps/web/app/login/page.tsx:useSWR',
            screenId: 's',
            section: 'data',
            kind: 'data:hook',
            label: 'useSWR',
            handlerName: 'useSWR',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content });
        const labels = participants(graph!);
        // Direct fetch + persistence picked up via window walk.
        expect(labels).toContain('fetch');
        expect(labels).toContain('localStorage');
        // The data hook itself is the `p:handler` participant — NOT a
        // duplicate Hook lane. The walker skips `use*` hook calls
        // for the data section so we don't get a self-edge.
        const useSwrLane = graph!.nodes.find((n) => n.id === 'p:hook:useSWR');
        expect(useSwrLane).toBeUndefined();
    });

    it('nav-in: walks the screen top-level for hook + effect call sites', () => {
        const screen = mkScreen({ screenId: 's' });
        const content =
            `import { useAuth } from './hooks';\n` +
            `export default function Login() {\n` +
            `  const user = useAuth();\n` +
            `  useEffect(() => { fetch("/api/init"); }, []);\n` +
            `  return null;\n` +
            `}\n`;
        const item: L2bScreenItem = {
            itemId: 'nav-in:apps/web/app/login/page.tsx:deep-link',
            screenId: 's',
            section: 'nav-in',
            kind: 'nav-in:deep-link',
            label: '/login',
            route: '/login',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content });
        const labels = participants(graph!);
        expect(labels).toContain('useAuth');
        expect(labels).toContain('fetch');
        // `useEffect` is filtered as a lifecycle hook (would be noise
        // here — the L2b lifecycle section already shows it).
        expect(labels).not.toContain('useEffect');
    });

    it('nav-out: emits one «target screen» participant labelled with the destination route', () => {
        const screen = mkScreen({ screenId: 's' });
        const item: L2bScreenItem = {
            itemId: 'nav-out:apps/web/app/login/page.tsx:dashboard',
            screenId: 's',
            section: 'nav-out',
            kind: 'nav-out:push',
            label: '/dashboard',
            route: '/dashboard',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 5, lineEnd: 5 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content: 'router.push("/dashboard");' });
        const target = graph!.nodes.find((n) => n.subtitle === '«target screen»');
        expect(target).toBeDefined();
        expect(target!.label).toBe('/dashboard');
        // Single edge from handler → target.
        const edge = graph!.edges.find((e) => e.target === target!.id);
        expect(edge).toBeDefined();
        expect(graph!.meta.isScaffoldOnly).toBe(false);
    });

    it('nav-out with no route AND no label → falls back to scaffold (defensive)', () => {
        const screen = mkScreen({ screenId: 's' });
        const item: L2bScreenItem = {
            itemId: 'nav-out:malformed',
            screenId: 's',
            section: 'nav-out',
            kind: 'nav-out:unknown',
            label: '',
            filePath: screen.filePath,
            anchor: { filePath: screen.filePath, lineStart: 1, lineEnd: 1 },
        };
        const graph = buildFrontendDataFlowGraph(screen, item, { content: '' });
        expect(graph!.meta.isScaffoldOnly).toBe(true);
    });
});
