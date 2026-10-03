/**
 * domainAnalyzer.ts — Issue #701 Domain clustering (MVP heuristic pass).
 *
 * Sits parallel to `communityDetector.ts` (Louvain structural clusters).
 * Where the Louvain pass answers "what files talk to each other?", this
 * one answers "what does this codebase DO?" — verb-led domains like
 * "Authenticate users", "Process payments", "Search content".
 *
 * The MVP (this PR) derives domains from two signals:
 *   1. **Route-path prefix** — `/auth/*` ⇒ "Authenticate users";
 *      `/payments/*` ⇒ "Process payments"; etc. Stable across rebuilds,
 *      deterministic, no LLM cost.
 *   2. **Cluster name fallback** — when a Louvain cluster's name matches
 *      a known domain keyword (`auth`, `billing`, `search`, …), every
 *      file in the cluster joins the domain even if no route maps to it.
 *      This catches utility files that don't host routes but belong to a
 *      domain by association.
 *
 * Full LLM-driven analysis (cluster-name-aware + body-text-aware +
 * evidence-gated, per the #701 issue) ships in a follow-up. The MVP gets
 * a reasonable baseline graph onto the canvas so the UX can iterate.
 *
 * Returns `Record<domainId, DomainCluster>` for ergonomic merging by the
 * snapshot store (same shape as `Record<clusterId, FeatureCluster>`).
 */

import type {
    Snapshot,
    DomainCluster,
    ApiRecord,
    FeatureCluster,
} from '../graph/graphTypes';

/**
 * Curated keyword → (verb, display-name) table. Order is significant —
 * earlier entries win when a route matches multiple buckets (e.g.
 * `/user/auth/login` matches both `user` and `auth`; `auth` first means
 * the route lands in the auth domain, which matches the developer
 * mental model better).
 *
 * Keys are matched as lowercase substrings of the route path AND of the
 * cluster label. Names mirror the verb-action convention from
 * `agents/domain-analyzer.md` in the inspiration repo.
 */
interface DomainKeyword {
    keyword: string;
    verb: string;
    name: string;
}

const DOMAIN_KEYWORDS: DomainKeyword[] = [
    { keyword: 'auth', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'login', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'signup', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'session', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'token', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'oauth', verb: 'authenticate', name: 'Authenticate users' },
    { keyword: 'payment', verb: 'process', name: 'Process payments' },
    { keyword: 'billing', verb: 'process', name: 'Process payments' },
    { keyword: 'invoice', verb: 'process', name: 'Process payments' },
    { keyword: 'checkout', verb: 'process', name: 'Process payments' },
    { keyword: 'subscription', verb: 'process', name: 'Process payments' },
    { keyword: 'order', verb: 'manage', name: 'Manage orders' },
    { keyword: 'cart', verb: 'manage', name: 'Manage orders' },
    { keyword: 'search', verb: 'search', name: 'Search content' },
    { keyword: 'query', verb: 'search', name: 'Search content' },
    { keyword: 'index', verb: 'search', name: 'Search content' },
    { keyword: 'notif', verb: 'notify', name: 'Send notifications' },
    { keyword: 'email', verb: 'notify', name: 'Send notifications' },
    { keyword: 'sms', verb: 'notify', name: 'Send notifications' },
    { keyword: 'push', verb: 'notify', name: 'Send notifications' },
    { keyword: 'webhook', verb: 'integrate', name: 'Integrate with external services' },
    { keyword: 'callback', verb: 'integrate', name: 'Integrate with external services' },
    { keyword: 'profile', verb: 'manage', name: 'Manage profiles' },
    { keyword: 'account', verb: 'manage', name: 'Manage profiles' },
    { keyword: 'user', verb: 'manage', name: 'Manage profiles' },
    { keyword: 'admin', verb: 'administer', name: 'Administer the system' },
    { keyword: 'analytic', verb: 'observe', name: 'Track analytics' },
    { keyword: 'metric', verb: 'observe', name: 'Track analytics' },
    { keyword: 'log', verb: 'observe', name: 'Audit & logging' },
    { keyword: 'audit', verb: 'observe', name: 'Audit & logging' },
    { keyword: 'health', verb: 'observe', name: 'Health & readiness' },
    { keyword: 'status', verb: 'observe', name: 'Health & readiness' },
    { keyword: 'upload', verb: 'transfer', name: 'Transfer files' },
    { keyword: 'download', verb: 'transfer', name: 'Transfer files' },
    { keyword: 'file', verb: 'transfer', name: 'Transfer files' },
    { keyword: 'media', verb: 'transfer', name: 'Transfer files' },
    { keyword: 'message', verb: 'communicate', name: 'Communicate in real time' },
    { keyword: 'chat', verb: 'communicate', name: 'Communicate in real time' },
    { keyword: 'comment', verb: 'communicate', name: 'Communicate in real time' },
    { keyword: 'article', verb: 'publish', name: 'Publish content' },
    { keyword: 'post', verb: 'publish', name: 'Publish content' },
    { keyword: 'blog', verb: 'publish', name: 'Publish content' },
    { keyword: 'feed', verb: 'publish', name: 'Publish content' },
    { keyword: 'tag', verb: 'publish', name: 'Publish content' },
    // BUG-POLAR-24: broaden commerce / SaaS route vocab so it doesn't dump into
    // "Other" (polar had 345 uncategorized ≈ 40%). All map to general intents,
    // not polar-specific names. Appended → existing keywords still match first.
    { keyword: 'customer', verb: 'manage', name: 'Manage customers' },
    { keyword: 'organization', verb: 'manage', name: 'Manage organizations' },
    { keyword: 'workspace', verb: 'manage', name: 'Manage organizations' },
    { keyword: 'product', verb: 'manage', name: 'Manage products' },
    { keyword: 'catalog', verb: 'manage', name: 'Manage products' },
    { keyword: 'inventory', verb: 'manage', name: 'Manage products' },
    { keyword: 'license', verb: 'manage', name: 'Manage licenses' },
    { keyword: 'refund', verb: 'process', name: 'Process payments' },
    { keyword: 'dispute', verb: 'process', name: 'Process payments' },
    { keyword: 'discount', verb: 'process', name: 'Process payments' },
    { keyword: 'coupon', verb: 'process', name: 'Process payments' },
    { keyword: 'price', verb: 'process', name: 'Process payments' },
    { keyword: 'pricing', verb: 'process', name: 'Process payments' },
    { keyword: 'report', verb: 'observe', name: 'Track analytics' },
    { keyword: 'setting', verb: 'configure', name: 'Configure the system' },
    { keyword: 'config', verb: 'configure', name: 'Configure the system' },
];

function domainIdFor(name: string): string {
    return `domain:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/**
 * Walk the route path + cluster label looking for the FIRST matching
 * keyword. Returns null when no keyword matches — the caller drops the
 * route into a generic "Other" bucket (see `assignToOther` below).
 */
function pickDomainKeyword(route: string, clusterLabel: string | undefined): DomainKeyword | null {
    const haystack = `${route} ${clusterLabel ?? ''}`.toLowerCase();
    for (const k of DOMAIN_KEYWORDS) {
        if (haystack.includes(k.keyword)) return k;
    }
    return null;
}

/**
 * Compute heuristic domain clusters from a snapshot.
 *
 * Implementation:
 *   1. Walk `snapshot.apiIndex`. For each route, pick the first matching
 *      `DomainKeyword` from the route path + the owning cluster's label.
 *      Add the route to that domain; add the route's file path too.
 *   2. Walk `snapshot.clusters`. For each cluster whose label matches a
 *      keyword, add every file in the cluster to the corresponding
 *      domain (catches non-route files that share the domain by name).
 *   3. Routes with no keyword match aggregate into a single "Other"
 *      bucket so they remain reachable from the L2a Domain toggle
 *      instead of vanishing.
 *
 * Confidence is set to `0.6` for direct route matches, `0.4` for cluster-
 * label-only matches, and `0.2` for the catch-all "Other" bucket. The LLM
 * follow-up will overwrite these with calibrated scores.
 */
export function detectDomains(
    snapshot: Snapshot,
): Record<string, DomainCluster> {
    const domains: Record<string, DomainCluster> = {};

    function getOrCreate(name: string, verb: string): DomainCluster {
        const id = domainIdFor(name);
        let existing = domains[id];
        if (!existing) {
            existing = {
                id,
                name,
                verb,
                routes: [],
                files: [],
                confidence: 0,
                source: 'heuristic',
            };
            domains[id] = existing;
        }
        return existing;
    }

    function bumpConfidence(d: DomainCluster, target: number): void {
        if (target > d.confidence) d.confidence = target;
    }

    // 1. Walk APIs
    const apis: ApiRecord[] = Object.values(snapshot.apiIndex ?? {});
    const fileToCluster = buildFileToClusterIndex(Object.values(snapshot.clusters ?? {}));
    for (const api of apis) {
        const clusterId = fileToCluster.get(api.filePath);
        const clusterLabel = clusterId ? snapshot.clusters?.[clusterId]?.label : undefined;
        const kw = pickDomainKeyword(api.route, clusterLabel);
        if (!kw) continue;
        const d = getOrCreate(kw.name, kw.verb);
        if (!d.routes.includes(api.apiId)) d.routes.push(api.apiId);
        if (!d.files.includes(api.filePath)) d.files.push(api.filePath);
        bumpConfidence(d, 0.6);
    }

    // 2. Walk Louvain clusters for label-only matches
    for (const cluster of Object.values(snapshot.clusters ?? {})) {
        const label = cluster.label ?? '';
        const kw = pickDomainKeyword('', label);
        if (!kw) continue;
        const d = getOrCreate(kw.name, kw.verb);
        for (const fp of cluster.files) {
            if (!d.files.includes(fp)) d.files.push(fp);
        }
        bumpConfidence(d, 0.4);
    }

    // 3. "Other" bucket — routes that didn't match any keyword. Helpful
    //    so the user can see "we have N unclassified routes" instead of
    //    silently dropping them off the Domain canvas.
    const unclaimedRoutes = apis.filter(api => {
        const clusterId = fileToCluster.get(api.filePath);
        const clusterLabel = clusterId ? snapshot.clusters?.[clusterId]?.label : undefined;
        return !pickDomainKeyword(api.route, clusterLabel);
    });
    if (unclaimedRoutes.length > 0) {
        const other = getOrCreate('Other', 'other');
        for (const api of unclaimedRoutes) {
            if (!other.routes.includes(api.apiId)) other.routes.push(api.apiId);
            if (!other.files.includes(api.filePath)) other.files.push(api.filePath);
        }
        bumpConfidence(other, 0.2);
    }

    // Tag each domain with the dominant service id when one service
    // accounts for ≥70% of the domain's files. Helps the renderer place
    // the domain under the right service swimlane.
    for (const d of Object.values(domains)) {
        const svcCount: Record<string, number> = {};
        for (const fp of d.files) {
            const clusterId = fileToCluster.get(fp);
            const svcId = clusterId ? snapshot.clusters?.[clusterId]?.serviceId : undefined;
            if (!svcId) continue;
            svcCount[svcId] = (svcCount[svcId] ?? 0) + 1;
        }
        let dominant: string | undefined;
        let dominantCount = 0;
        for (const [svc, count] of Object.entries(svcCount)) {
            if (count > dominantCount) {
                dominant = svc;
                dominantCount = count;
            }
        }
        if (dominant && d.files.length > 0 && dominantCount / d.files.length >= 0.7) {
            d.serviceId = dominant;
        }
    }

    return domains;
}

function buildFileToClusterIndex(clusters: FeatureCluster[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of clusters) {
        for (const fp of c.files) out.set(fp, c.id);
    }
    return out;
}

/**
 * Diff working-vs-baseline domain sets. Mirrors `diffClusters` semantics:
 *   - new domain id → diff: 'added'
 *   - missing domain id → kept in result as a tombstone with diff: 'deleted'
 *   - same id, different route/file set → diff: 'modified'
 *
 * Idempotent and stateless; safe to call on each rebuild.
 */
export function diffDomains(
    baselineDomains: Record<string, DomainCluster> | undefined,
    workingDomains: Record<string, DomainCluster>,
): Record<string, DomainCluster> {
    const out: Record<string, DomainCluster> = {};
    const baselineIds = new Set(Object.keys(baselineDomains ?? {}));

    for (const [id, d] of Object.entries(workingDomains)) {
        if (!baselineIds.has(id)) {
            out[id] = { ...d, diff: 'added' };
            continue;
        }
        const prev = baselineDomains![id]!;
        const sameRoutes = sortedEqual(prev.routes, d.routes);
        const sameFiles = sortedEqual(prev.files, d.files);
        out[id] = { ...d, diff: sameRoutes && sameFiles ? 'unchanged' : 'modified' };
    }
    // Tombstone deleted domains
    for (const id of baselineIds) {
        if (!(id in workingDomains)) {
            out[id] = { ...baselineDomains![id], diff: 'deleted' };
        }
    }
    return out;
}

function sortedEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
}
