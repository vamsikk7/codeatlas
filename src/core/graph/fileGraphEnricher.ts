/**
 * fileGraphEnricher.ts — v2 phase 6 PR-A (#487 — L4 node-kind taxonomy expansion (component / hook / store / view / viewmodel / repository)).
 *
 * Post-process a file graph emitted by `fileGraphBuilder.ts` and
 * re-tag its entity nodes with FE/mobile-specific kinds per spec §3
 * (L4) + §5. The default builder emits the backend kinds
 * (`function`, `variable`, `import`, `class`); the enricher only
 * mutates node `type` when the owning service category is `frontend`
 * or `mobile`, so backend file graphs stay byte-identical.
 *
 * The mutation is in-place: callers pass a `DiagramGraph` reference
 * that the enricher walks; matched nodes get their `type` reassigned
 * to the more specific category-aware kind (e.g. a `function` node
 * named `useAuth` in a frontend file becomes a `hook`).
 *
 * Subtitle is preserved (kept as `«function»` / `«variable»`) so
 * existing UI rendering keeps working. The renderer can use
 * `node.type` to apply richer icon / color treatment in a follow-up
 * PR without breaking the existing kind-agnostic layout.
 */

import type {
    DiagramGraph,
    GraphNode,
    RepoCategory,
} from './graphTypes';

export interface EnrichContext {
    category: RepoCategory;
    /** File path of the screen / module being enriched. Used to spot
     *  Next.js page exports / SvelteKit `+page.server.ts` etc. */
    filePath: string;
    /** Optional source content — when present the enricher inspects
     *  it for store / fetcher / route-config patterns that file-path
     *  conventions alone can't disambiguate. */
    content?: string;
}

/**
 * Re-tag entity nodes in `graph` for FE/mobile category services.
 * Returns the count of nodes whose `type` changed — useful for
 * tests + the orchestrator's progress log.
 */
export function enrichFileGraphForCategory(
    graph: DiagramGraph,
    ctx: EnrichContext,
): number {
    if (ctx.category !== 'frontend' && ctx.category !== 'mobile') return 0;
    let touched = 0;
    for (const node of graph.nodes) {
        // Only re-tag entity nodes — leave the root `file` node and
        // section headers alone.
        if (node.type !== 'function' && node.type !== 'variable' &&
            node.type !== 'class' && node.type !== 'import') continue;
        const reclassified = classifyNode(node, ctx);
        if (reclassified && reclassified !== node.type) {
            node.type = reclassified;
            touched++;
        }
    }
    return touched;
}

/**
 * Classify a single entity node using a combination of:
 *   1. Identifier conventions (the node's `label`).
 *   2. The owning category (frontend vs mobile).
 *   3. Optional content patterns from `ctx.content`.
 *
 * Returns `null` when no FE/mobile-specific reclassification applies
 * (the caller leaves the node at its default kind).
 */
function classifyNode(node: GraphNode, ctx: EnrichContext): GraphNode['type'] | null {
    const name = node.label || '';
    const category = ctx.category;

    if (category === 'frontend') {
        return classifyFrontendNode(node, name, ctx);
    }
    if (category === 'mobile') {
        return classifyMobileNode(node, name, ctx);
    }
    return null;
}

// ── Frontend reclassification ──────────────────────────────────────

/**
 * Identifiers that should reclassify regardless of node kind.
 */
function classifyFrontendNode(node: GraphNode, name: string, ctx: EnrichContext): GraphNode['type'] | null {
    // route-config — Next.js / Remix / SvelteKit conventions are
    // determined by file path + symbol name. Highest priority because
    // the same identifier (e.g. `loader`) means different things in
    // different file conventions.
    if (isRouteConfigSymbol(name, ctx.filePath)) {
        return 'route-config';
    }

    // hook — function with name starting `use[A-Z]` (the standard
    // React + RN + Next-side custom-hook convention).
    if (node.type === 'function' && /^use[A-Z]/.test(name)) {
        return 'hook';
    }
    // hook — imported `useFoo` becomes a hook node too (so users
    // see imported hooks in the same lane as locally-defined ones).
    if (node.type === 'import' && /^use[A-Z]/.test(name)) {
        return 'hook';
    }

    // store — Zustand / Redux / Recoil / Jotai conventions. A
    // const declared via `create*` API or a name ending with
    // `Store` / `Atom` / `Slice`. Context providers (`*Context`
    // / `*Provider`) also count.
    if (node.type === 'variable' || node.type === 'function' || node.type === 'class') {
        if (/Store$|Atom$|Slice$|Context$|Provider$/.test(name)) {
            return 'store';
        }
        if (ctx.content && isStoreByContent(name, ctx.content)) {
            return 'store';
        }
    }

    // fetcher — name conventions like `apiClient`, `api`, `httpClient`,
    // identifiers ending in `Client` / `Api`. Also if the variable
    // body assigns to an axios.create() / new ApolloClient() / similar.
    if (node.type === 'variable' || node.type === 'function') {
        if (/^(?:api|apiClient|httpClient|http|client)$/i.test(name) ||
            /Client$|Api$/.test(name)) {
            return 'fetcher';
        }
        if (ctx.content && isFetcherByContent(name, ctx.content)) {
            return 'fetcher';
        }
    }

    // component — PascalCase function or class that returns JSX
    // (heuristic: name starts uppercase + isn't already classified
    // as hook/store/fetcher above). Lowest priority because the
    // PascalCase convention is broadly used.
    if ((node.type === 'function' || node.type === 'class') && /^[A-Z]/.test(name)) {
        return 'component';
    }

    return null;
}

/**
 * Next.js / Remix / SvelteKit route-config export names — these are
 * special exports the framework consumes (loaders, actions, metadata,
 * server-side props). Tagging them as `route-config` makes them
 * stand apart from regular helpers in the L4 file view.
 */
function isRouteConfigSymbol(name: string, filePath: string): boolean {
    // Next.js (App + Pages) — page exports + data fetching.
    const isNextPage = /(?:^|\/)(?:src\/)?(?:app|pages)\//.test(filePath);
    if (isNextPage) {
        if (name === 'default' || name === 'metadata' || name === 'generateMetadata' ||
            name === 'generateStaticParams' || name === 'dynamic' || name === 'revalidate' ||
            name === 'getServerSideProps' || name === 'getStaticProps' || name === 'getStaticPaths') {
            return true;
        }
    }
    // Remix — `loader` / `action` / `meta` / `links` / `headers`
    // exports in `app/routes/`.
    if (/(?:^|\/)(?:app\/routes|routes)\//.test(filePath)) {
        if (name === 'loader' || name === 'action' || name === 'meta' ||
            name === 'links' || name === 'headers' || name === 'ErrorBoundary') {
            return true;
        }
    }
    // SvelteKit — `+page.server.ts` / `+page.ts` / `+layout.server.ts`
    // exports `load` / `actions`. `+server.ts` exports `GET` / `POST`.
    if (/\+(?:page|layout)\.(?:server\.)?\w+$/.test(filePath)) {
        if (name === 'load' || name === 'actions' || name === 'prerender' ||
            name === 'csr' || name === 'ssr') {
            return true;
        }
    }
    if (/\+server\.\w+$/.test(filePath)) {
        if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) {
            return true;
        }
    }
    return false;
}

function isStoreByContent(name: string, content: string): boolean {
    // Match a variable's RHS = store-creator API. Conservative — only
    // common patterns to avoid over-tagging.
    const re = new RegExp(
        `\\b(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*` +
        `(?:create(?:Store|Slice|Context|Reducer)|configureStore|combineReducers|atom|atomWithStorage|selectAtom|useAtom|createReactiveStore|defineStore|createState|create<)`,
    );
    return re.test(content);
}

function isFetcherByContent(name: string, content: string): boolean {
    const re = new RegExp(
        `\\b(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*` +
        `(?:axios\\.create|new\\s+ApolloClient|createTRPC(?:Proxy)?Client|new\\s+HttpClient|hc<)`,
    );
    return re.test(content);
}

// ── Mobile reclassification ────────────────────────────────────────

function classifyMobileNode(node: GraphNode, name: string, ctx: EnrichContext): GraphNode['type'] | null {
    // view — class extending Activity / Fragment / UIViewController
    // (the parent name lives in node.subtitle for non-JS languages
    // via the tree-sitter `extends` capture). Naming conventions
    // are also a strong signal: `*Activity`, `*Fragment`,
    // `*ViewController`, `*Screen`, `*View`.
    if (node.type === 'class' || node.type === 'function') {
        if (/Activity$|Fragment$|ViewController$|Screen$|Widget$/.test(name)) {
            return 'view';
        }
        if (node.subtitle && /(?:UIViewController|AppCompatActivity|Activity|Fragment|ComponentActivity|StatelessWidget|StatefulWidget)/.test(node.subtitle)) {
            return 'view';
        }
    }

    // viewmodel — class name ending `ViewModel` / `Bloc` / `Cubit`
    // / `Provider`. Riverpod notifier variants too.
    if (node.type === 'class' || node.type === 'function') {
        if (/ViewModel$|Bloc$|Cubit$|StateNotifier$|Notifier$/.test(name)) {
            return 'viewmodel';
        }
    }

    // repository — any identifier ending in `Repository` /
    // `RepositoryImpl` / `DataSource`.
    if (node.type === 'class' || node.type === 'variable' || node.type === 'function') {
        if (/Repository$|RepositoryImpl$|DataSource$/.test(name)) {
            return 'repository';
        }
    }

    // network-client — Retrofit interface / Ktor client / Dio /
    // URLSession wrapper. Convention: name ending in `Api` /
    // `ApiService` / `Client`.
    if (node.type === 'class' || node.type === 'function' || node.type === 'variable') {
        if (/ApiService$|Service$|ApiClient$|HttpClient$|NetworkClient$/.test(name)) {
            return 'network-client';
        }
        if (/^(?:dio|http|api|client)$/i.test(name)) {
            return 'network-client';
        }
    }

    // persistence — Room DAO / CoreData entity / SwiftData @Model
    // / Hive box.
    if (node.type === 'class' || node.type === 'variable') {
        if (/Dao$|Entity$|Database$|Box$/.test(name)) {
            return 'persistence';
        }
        if (ctx.content && isPersistenceByContent(name, ctx.content)) {
            return 'persistence';
        }
    }

    return null;
}

function isPersistenceByContent(name: string, content: string): boolean {
    const re = new RegExp(
        `(?:@Entity|@Dao|@Database|@Model|@HiveType)\\s+[\\s\\S]{0,200}?\\b${escapeRegex(name)}\\b`,
    );
    return re.test(content);
}

// ── Helpers ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for unit tests
export const _testing = {
    classifyNode,
    isRouteConfigSymbol,
    isStoreByContent,
    isFetcherByContent,
    isPersistenceByContent,
};
