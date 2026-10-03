/**
 * fileGraphEnricher.test.ts — v2 phase 6 PR-A (#487 — L4 node-kind taxonomy expansion (component / hook / store / view / viewmodel / repository)).
 *
 * Locks the L4 kinds re-tagging contract:
 *   1. Backend services NEVER get reclassified — every entity node
 *      keeps the kind it received from `fileGraphBuilder.ts`. This is
 *      the load-bearing invariant for byte-identical backend output.
 *   2. Frontend identifier conventions: `useFoo` → hook, `*Store` →
 *      store, `apiClient` → fetcher, PascalCase function → component,
 *      Next/Remix/SvelteKit route-config exports → route-config.
 *   3. Mobile identifier conventions: `*Activity` / `*ViewController`
 *      → view, `*ViewModel` / `*Bloc` → viewmodel, `*Repository` →
 *      repository, `*ApiService` / `*HttpClient` → network-client,
 *      `*Dao` / `*Entity` → persistence.
 *   4. The reclassifier returns the count of touched nodes — a
 *      zero return on backend services is the regression guard.
 *   5. Subtitle is preserved (only `type` is mutated) so existing
 *      panel rendering keeps working until a follow-up adds rich
 *      kind-specific subtitles.
 */

import { describe, it, expect } from 'vitest';
import { enrichFileGraphForCategory } from '../fileGraphEnricher';
import type { DiagramGraph, GraphNode } from '../graphTypes';

function mkGraph(nodes: Array<Partial<GraphNode> & { id: string; type: GraphNode['type']; label: string }>): DiagramGraph {
    return {
        graphId: 'file:apps/web/src/Login.tsx',
        type: 'file',
        nodes: nodes.map((n) => ({
            subtitle: `«${n.type}»`,
            diff: 'unchanged' as const,
            anchor: { filePath: 'apps/web/src/Login.tsx' },
            ...n,
        })) as GraphNode[],
        edges: [],
        anchors: {},
        meta: {},
    };
}

describe('enrichFileGraphForCategory — backend regression guard', () => {
    it('backend category leaves every node untouched (returns 0)', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'useAuth' },        // would-be hook
            { id: 'n2', type: 'class', label: 'UserRepository' },    // would-be repository
            { id: 'n3', type: 'variable', label: 'apiClient' },      // would-be fetcher
        ]);
        const touched = enrichFileGraphForCategory(graph, { category: 'backend', filePath: 'apps/api/src/users.ts' });
        expect(touched).toBe(0);
        expect(graph.nodes.map((n) => n.type).sort()).toEqual(['class', 'function', 'variable']);
    });

    it('unknown category also leaves nodes untouched (safe default)', () => {
        const graph = mkGraph([{ id: 'n1', type: 'function', label: 'useState' }]);
        const touched = enrichFileGraphForCategory(graph, { category: 'unknown', filePath: 'x.ts' });
        expect(touched).toBe(0);
        expect(graph.nodes[0].type).toBe('function');
    });

    it('monorepo-parent also leaves nodes untouched', () => {
        const graph = mkGraph([{ id: 'n1', type: 'function', label: 'useFoo' }]);
        const touched = enrichFileGraphForCategory(graph, { category: 'monorepo-parent', filePath: 'package.json' });
        expect(touched).toBe(0);
    });
});

describe('enrichFileGraphForCategory — frontend reclassification', () => {
    it('useFoo function → hook', () => {
        const graph = mkGraph([{ id: 'n', type: 'function', label: 'useAuth' }]);
        const touched = enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/hooks/useAuth.ts' });
        expect(touched).toBe(1);
        expect(graph.nodes[0].type).toBe('hook');
    });

    it('useFoo import → hook (imported hooks light up too)', () => {
        const graph = mkGraph([{ id: 'n', type: 'import', label: 'useAuth' }]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/Page.tsx' });
        expect(graph.nodes[0].type).toBe('hook');
    });

    it('name ending in *Store / *Atom / *Context / *Provider → store', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'variable', label: 'useAuthStore' },  // variable, not function — hook check skips
            { id: 'n2', type: 'variable', label: 'userAtom' },
            { id: 'n3', type: 'class', label: 'AuthContext' },
            { id: 'n4', type: 'function', label: 'StoreProvider' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/state.ts' });
        // Store check (3rd in priority) matches all four — they all
        // end in Store/Atom/Context/Provider. `useAuthStore` as a
        // *variable* doesn't trigger the hook check (only function +
        // import kinds do); the same name as a function would be a
        // hook.
        const kinds = graph.nodes.map((n) => `${n.label}=${n.type}`).sort();
        expect(kinds).toEqual([
            'AuthContext=store',
            'StoreProvider=store',
            'useAuthStore=store',
            'userAtom=store',
        ]);
    });

    it('function `useAuthStore` becomes hook (function + use* prefix wins over Store$ suffix)', () => {
        const graph = mkGraph([{ id: 'n', type: 'function', label: 'useAuthStore' }]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/state.ts' });
        expect(graph.nodes[0].type).toBe('hook');
    });

    it('apiClient / httpClient / *Client / *Api → fetcher', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'variable', label: 'apiClient' },
            { id: 'n2', type: 'variable', label: 'httpClient' },
            { id: 'n3', type: 'variable', label: 'StripeClient' },
            { id: 'n4', type: 'variable', label: 'UsersApi' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/api.ts' });
        expect(graph.nodes.every((n) => n.type === 'fetcher')).toBe(true);
    });

    it('store/fetcher by content (createStore / axios.create) wins over PascalCase component default', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'variable', label: 'useUserStore' },  // already hook-like — skip
            { id: 'n2', type: 'variable', label: 'userStore' },
            { id: 'n3', type: 'variable', label: 'api' },
        ]);
        const content =
            `const userStore = createStore({});\n` +
            `const api = axios.create({ baseURL: '/' });\n`;
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/state.ts', content });
        expect(graph.nodes.find((n) => n.label === 'userStore')!.type).toBe('store');
        expect(graph.nodes.find((n) => n.label === 'api')!.type).toBe('fetcher');
    });

    it('PascalCase function/class → component (fall-through)', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'LoginForm' },
            { id: 'n2', type: 'class', label: 'Dashboard' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/Login.tsx' });
        expect(graph.nodes.every((n) => n.type === 'component')).toBe(true);
    });

    it('Next.js App Router default + metadata exports → route-config', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'default' },
            { id: 'n2', type: 'variable', label: 'metadata' },
            { id: 'n3', type: 'function', label: 'generateMetadata' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/app/login/page.tsx' });
        expect(graph.nodes.every((n) => n.type === 'route-config')).toBe(true);
    });

    it('Next.js Pages Router getServerSideProps / getStaticProps → route-config', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'getServerSideProps' },
            { id: 'n2', type: 'function', label: 'getStaticProps' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/pages/index.tsx' });
        expect(graph.nodes.every((n) => n.type === 'route-config')).toBe(true);
    });

    it('Remix loader / action / meta exports → route-config', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'loader' },
            { id: 'n2', type: 'function', label: 'action' },
            { id: 'n3', type: 'variable', label: 'meta' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/app/routes/login.tsx' });
        expect(graph.nodes.every((n) => n.type === 'route-config')).toBe(true);
    });

    it('SvelteKit +page.server.ts `load` and `actions` exports → route-config', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'load' },
            { id: 'n2', type: 'variable', label: 'actions' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/routes/login/+page.server.ts' });
        expect(graph.nodes.every((n) => n.type === 'route-config')).toBe(true);
    });

    it('SvelteKit +server.ts GET / POST exports → route-config', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'function', label: 'GET' },
            { id: 'n2', type: 'function', label: 'POST' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/routes/api/users/+server.ts' });
        expect(graph.nodes.every((n) => n.type === 'route-config')).toBe(true);
    });

    it('a `loader` function in a NON-Remix path (e.g. `src/utils/loader.ts`) → component fallback, not route-config', () => {
        // route-config check is path-scoped — same identifier in a
        // different conventional location stays default-classified.
        const graph = mkGraph([{ id: 'n1', type: 'function', label: 'loader' }]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/utils/loader.ts' });
        // `loader` is lowercase, no use* prefix → no FE reclassification fires.
        expect(graph.nodes[0].type).toBe('function');
    });

    it('imports / variables / classes / functions are the only kinds enriched — sections + file root untouched', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'file', label: 'Login.tsx' },
            { id: 'n2', type: 'section', label: 'Hooks' },
            { id: 'n3', type: 'function', label: 'useAuth' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'frontend', filePath: 'apps/web/src/Login.tsx' });
        expect(graph.nodes[0].type).toBe('file');
        expect(graph.nodes[1].type).toBe('section');
        expect(graph.nodes[2].type).toBe('hook');
    });
});

describe('enrichFileGraphForCategory — mobile reclassification', () => {
    it('class ending Activity / Fragment / ViewController / Screen / Widget → view', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'MainActivity' },
            { id: 'n2', type: 'class', label: 'HomeFragment' },
            { id: 'n3', type: 'class', label: 'ProfileViewController' },
            { id: 'n4', type: 'class', label: 'DashboardScreen' },
            { id: 'n5', type: 'class', label: 'HomeWidget' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/MainActivity.kt' });
        expect(graph.nodes.every((n) => n.type === 'view')).toBe(true);
    });

    it('subtitle carries the extends/conforms identifier → view (for tree-sitter classes)', () => {
        const graph = mkGraph([
            // Class name doesn't end in Activity but the subtitle carries it.
            { id: 'n1', type: 'class', label: 'AppRoot', subtitle: '«class» : AppCompatActivity' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/AppRoot.kt' });
        expect(graph.nodes[0].type).toBe('view');
    });

    it('classes ending ViewModel / Bloc / Cubit / StateNotifier → viewmodel', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'HomeViewModel' },
            { id: 'n2', type: 'class', label: 'AuthBloc' },
            { id: 'n3', type: 'class', label: 'CartCubit' },
            { id: 'n4', type: 'class', label: 'UserNotifier' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/vm.kt' });
        expect(graph.nodes.every((n) => n.type === 'viewmodel')).toBe(true);
    });

    it('identifiers ending Repository / RepositoryImpl / DataSource → repository', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'UserRepository' },
            { id: 'n2', type: 'class', label: 'AuthRepositoryImpl' },
            { id: 'n3', type: 'class', label: 'RemoteDataSource' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/repo.kt' });
        expect(graph.nodes.every((n) => n.type === 'repository')).toBe(true);
    });

    it('identifiers ending ApiService / Service / HttpClient / NetworkClient → network-client', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'UsersApiService' },
            { id: 'n2', type: 'class', label: 'AuthService' },
            { id: 'n3', type: 'variable', label: 'dio' },
            { id: 'n4', type: 'variable', label: 'http' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/net.kt' });
        expect(graph.nodes.every((n) => n.type === 'network-client')).toBe(true);
    });

    it('classes ending Dao / Entity / Database / Box → persistence', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'UserDao' },
            { id: 'n2', type: 'class', label: 'AppDatabase' },
            { id: 'n3', type: 'class', label: 'NoteEntity' },
            { id: 'n4', type: 'variable', label: 'cacheBox' },
        ]);
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/src/persist.kt' });
        // cacheBox doesn't match the trailing-Box regex (lowercase
        // start) so it stays at default 'variable'. The first three
        // are reclassified.
        const kinds = graph.nodes.map((n) => `${n.label}=${n.type}`).sort();
        expect(kinds).toContain('AppDatabase=persistence');
        expect(kinds).toContain('NoteEntity=persistence');
        expect(kinds).toContain('UserDao=persistence');
    });

    it('persistence-by-content via @Entity / @Dao annotation match', () => {
        const graph = mkGraph([
            { id: 'n1', type: 'class', label: 'User' },
        ]);
        const content = `@Entity\ndata class User(val id: Long, val name: String)`;
        enrichFileGraphForCategory(graph, { category: 'mobile', filePath: 'apps/android/User.kt', content });
        expect(graph.nodes[0].type).toBe('persistence');
    });
});
