/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `crossRepoHttpAnalyzer`.
 *
 * For each `httpClientPath` in the source repo's summary, finds repos
 * that EXPOSE a matching `(method, route)` and writes a row in
 * `cross_repo_http_edges`. Path matching tolerates Express-style /
 * Spring-style path parameters by reducing both sides to a normalised
 * pattern.
 *
 * Cleanup: when the source repo's summary changes, all prior edges with
 * `source_repo = repoId` are dropped before the new edges are inserted —
 * keeps `cross_repo_http_edges` consistent with the latest summary
 * without N+1 diff queries.
 *
 * Match algorithm (Phase C scope — keep simple):
 *   1. Extract path from each httpClientPath URL (strip scheme + host).
 *   2. Normalise `${id}` / `:slug` / `{username}` to a single `:_` token.
 *   3. Build a `(method, normalised-path)` index from every OTHER repo's
 *      summaries' apis.
 *   4. For each source path, find matches and emit one edge per match.
 *
 * The method defaults to GET when the source URL doesn't carry it
 * (today's `httpClientPaths` are raw URLs, no method); a future Phase C
 * follow-up can carry method through from the parser.
 */
import type { CrossRepoAnalyzer } from '../sync/crossRepoAnalyzer';
import type { RepoSummary, SummaryApi } from '../sync/repoSummary';
import type { IAggregatorStore } from '../storage/storeInterfaces';
import { ConsumedApiHashTracker } from '../sync/consumedApiHashTracker';

/**
 * UX-67c (2026-06-09) — module-scope tracker. Each `applySummary` call
 * either records the producer's hash (when this repo exposes the apis)
 * or records the consumer's recorded hash (when the analyzer attaches
 * an edge from this repo to another repo's API). `listStaleApis()`
 * surfaces apis whose producer hash has drifted from any consumer's
 * recorded hash so the cascade can flag consumer L1 / L3 edges as
 * `~ modified`.
 */
export const consumedApiHashTracker = new ConsumedApiHashTracker();

export const crossRepoHttpAnalyzer: CrossRepoAnalyzer = {
    id: 'crossRepoHttp',

    onSummaryApplied(
        repoId: string,
        newSummary: RepoSummary,
        _priorSummary: RepoSummary | undefined,
        store: IAggregatorStore,
    ): void {
        // Drop every prior edge sourced from this repo; we'll recompute.
        store.removeCrossRepoHttpEdgesFromSource(repoId);

        // UX-67c — record producer hashes for every api this repo exposes.
        // Other repos' consumer entries reference these; the tracker flags
        // a consumer as stale when its recorded hash trails the producer's.
        // When ANY producer hash actually changed vs. the prior summary,
        // walk every cross-repo edge whose target is this repo and
        // re-stamp `diff = 'modified'` so consumers' L1 / L3 light up
        // even though their own summaries haven't re-applied yet.
        const producerHashChanged: Record<string, boolean> = {};
        if (newSummary.apiHashes) {
            const priorHashes = _priorSummary?.apiHashes ?? {};
            for (const [apiId, hash] of Object.entries(newSummary.apiHashes)) {
                if (priorHashes[apiId] && priorHashes[apiId] !== hash) {
                    producerHashChanged[apiId] = true;
                }
                consumedApiHashTracker.recordProducerHash(apiId, hash);
            }
        }
        if (Object.keys(producerHashChanged).length > 0) {
            const existingEdges = store.listCrossRepoHttpEdges();
            for (const edge of existingEdges) {
                if (edge.targetRepo !== repoId) continue;
                if (edge.diff === 'modified') continue;
                // Re-stamp as modified — the producer just shifted its
                // surface shape and every existing consumer is now stale
                // against the new hash.
                store.upsertCrossRepoHttpEdge({ ...edge, diff: 'modified' });
            }
        }

        if (newSummary.httpClientPaths.length === 0) return;

        // Collect (method, normalisedRoute) → [{repoId, apiId, hash}] from every
        // OTHER repo's exposed APIs. We need other repos' summaries; we
        // ask the aggregator for every known repo and skip self.
        const targets = new Map<string, Array<{ repoId: string; apiId: string; hash?: string }>>();
        const allRepos = store.listRepos();
        for (const r of allRepos) {
            if (r.repoId === repoId) continue;
            const sum = store.getRepoSummary(r.repoId);
            if (!sum) continue;
            for (const api of sum.apis) {
                const k = `${api.method.toUpperCase()}|${normalisePath(api.route)}`;
                const arr = targets.get(k) ?? [];
                arr.push({ repoId: r.repoId, apiId: api.apiId, hash: sum.apiHashes?.[api.apiId] });
                targets.set(k, arr);
            }
        }

        for (const url of newSummary.httpClientPaths) {
            const p = parseUrl(url);
            if (!p) continue;
            // Try every standard HTTP verb; today's source paths don't
            // carry method, so we conservatively try GET first then the
            // others. First match wins to avoid 6× row inflation.
            const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
            let matchedAny = false;
            for (const verb of verbs) {
                const key = `${verb}|${normalisePath(p.path)}`;
                const candidates = targets.get(key);
                if (!candidates) continue;
                for (const target of candidates) {
                    // UX-67c full cascade (2026-06-09) — record THIS repo
                    // as consuming the target's API at the hash it just
                    // observed FIRST, then decide whether the edge is
                    // stale. If the consumer's just-recorded hash already
                    // trails the producer's latest hash, the edge gets
                    // `diff: 'modified'` so the consumer-side L1
                    // "consumes" edge + L3 sequence participants light
                    // up the `~ modified` badge automatically next
                    // render. When no hash info is available we keep
                    // the legacy `null` semantic.
                    let stale = false;
                    if (target.hash) {
                        consumedApiHashTracker.recordConsumer(target.apiId, repoId, target.hash);
                        stale = consumedApiHashTracker.isStale(target.apiId, target.hash);
                    }
                    store.upsertCrossRepoHttpEdge({
                        sourceRepo: repoId,
                        targetRepo: target.repoId,
                        method: verb,
                        route: p.path,
                        diff: stale ? 'modified' : null,
                    });
                    matchedAny = true;
                }
                if (matchedAny) break;
            }
        }
    },

    onRepoRemoved(repoId: string, store: IAggregatorStore): void {
        // Drop every edge sourced from this repo.
        store.removeCrossRepoHttpEdgesFromSource(repoId);
        // Targets-from-other-repos pointing at this repo: scan + remove
        // every edge whose target matches.
        for (const r of store.listRepos()) {
            const sum = store.getRepoSummary(r.repoId);
            if (!sum) continue;
            // No direct "remove by target" API — invalidate via the
            // analyzer re-apply on the next per-repo summary apply.
            // For Phase C scope, leaving target-targeting edges intact
            // until the next apply is acceptable (they become orphans
            // pointing at a non-existent repo, dropped at next L1 build).
        }
        void this;
    },
};

// ─── shared producer-edge reader (#817.1, 2026-06-10) ──────────────────────

/**
 * One consumer→producer edge, name-resolved for display. `consumerRepoId`
 * is the registry hex id (rows store ids); `consumerRepoName` falls back
 * to the raw id when the consumer is no longer registered (orphan edge —
 * see `onRepoRemoved`).
 */
export interface ProducerCrossRepoEdge {
    consumerRepoId: string;
    consumerRepoName: string;
    producerRepoId: string;
    method: string;
    route: string;
    diff: string | null;
}

/**
 * List every cross-repo edge whose TARGET is the given producer — i.e.
 * the consumers calling into this repo's APIs. Shared by the #817
 * cross-repo push (fan-out enumeration), the #818 replay coda (consumer
 * frame composition), and the #827 regression-scope `includeCrossRepo`
 * glue.
 *
 * `producer` accepts a registry repoId, name, or rootPath (pickers and
 * URL hashes pass names; stores pass ids). Unknown producer → []
 * (edges never match a non-registry id).
 *
 * Sort is deterministic (consumer name, route, method) so broadcast
 * payloads and coda frame order are stable across rebuilds.
 */
export function listCrossRepoEdgesForProducer(
    store: IAggregatorStore,
    producer: string,
): ProducerCrossRepoEdge[] {
    const repos = store.listRepos();
    const row = repos.find((r) => r.repoId === producer || r.name === producer || r.rootPath === producer);
    const producerId = row?.repoId ?? producer;
    const nameOf = (id: string): string => repos.find((r) => r.repoId === id)?.name ?? id;
    return [...store.listCrossRepoHttpEdges()]
        .filter((e) => e.targetRepo === producerId)
        .map((e) => ({
            consumerRepoId: e.sourceRepo,
            consumerRepoName: nameOf(e.sourceRepo),
            producerRepoId: producerId,
            method: e.method,
            route: e.route,
            diff: e.diff,
        }))
        .sort((a, b) =>
            a.consumerRepoName.localeCompare(b.consumerRepoName)
            || a.route.localeCompare(b.route)
            || a.method.localeCompare(b.method));
}

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * Reduce Express / Spring / Rails style param tokens to a single
 * placeholder so `/users/:id` and `/users/{id}` and `/users/${id}` all
 * match against an exposed `/users/:id`.
 *
 * Exported (#817, 2026-06-11) — the aggregator's `recomputeDiffs` matches
 * edge routes against producer summary apis with the same tolerance.
 */
export function normaliseRoutePath(p: string): string {
    return normalisePath(p);
}

function normalisePath(p: string): string {
    return p
        .replace(/\$\{[^}]+\}/g, ':_')   // ${id}
        .replace(/\{[^}]+\}/g, ':_')      // {id}
        .replace(/:[A-Za-z_][\w-]*/g, ':_')  // :id, :slug
        .replace(/\/+/g, '/')
        .replace(/\/$/, '') || '/';
}

interface ParsedUrl { path: string; }

function parseUrl(url: string): ParsedUrl | null {
    // Strip scheme + host. Falls back to the raw string if it already
    // looks like a path.
    if (url.startsWith('/')) return { path: url };
    const m = url.match(/^https?:\/\/[^/]+(\/[^?#]*)/);
    if (!m) return null;
    return { path: m[1] };
}

// Make sure SummaryApi is referenced (for tsc unused-import check).
const _unused: SummaryApi | undefined = undefined;
void _unused;
