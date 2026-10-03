/**
 * communityDetector.ts
 *
 * Detects functional communities (feature/domain clusters) in a codebase
 * using **Louvain modularity optimization** on the workspace call graph,
 * with label propagation as a fallback.
 *
 * Louvain algorithm (Blondel et al. 2008):
 * 1. Each file starts in its own community
 * 2. Phase 1: greedily move each node to the neighbor community that maximizes
 *    modularity gain ΔQ. Repeat until no improvement.
 * 3. Phase 2: contract the graph (each community → super-node), preserve edge weights
 * 4. Repeat phases 1+2 until Q stabilizes
 *
 * Falls back to label propagation when Louvain produces < 2 communities
 * (e.g., fully connected small graphs).
 */

import * as path from 'path';
import type { Snapshot, FeatureCluster, DiffStatus, ApiRecord, ServiceRecord } from '../graph/graphTypes';
import { WorkspaceCallGraph, buildCallGraph, getFunctionKeysForFiles, resolveImportPath } from '../graph/callGraphResolver';

const MAX_ITERATIONS = 20;
const MIN_CLUSTER_SIZE = 2; // Singletons get merged into their closest neighbor's cluster

/**
 * Build file-to-file edges from import statements in the snapshot.
 * Used as a fallback when the call graph has no cross-file edges (e.g. sparse analysis).
 */
function buildImportEdges(snapshot: Snapshot): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>();
    for (const fp of Object.keys(snapshot.files)) {
        edges.set(fp, new Set());
    }
    for (const [fp, record] of Object.entries(snapshot.files)) {
        for (const imp of record.symbols?.imports ?? []) {
            if (!imp.source.startsWith('.')) continue; // skip npm packages
            const resolved = resolveImportPath(imp.source, fp, snapshot.files);
            if (resolved && resolved !== fp && edges.has(resolved)) {
                edges.get(fp)!.add(resolved);
                edges.get(resolved)!.add(fp);
            }
        }
    }
    return edges;
}

// ─── Louvain Modularity Optimization ───────────────────────────────────────

/**
 * Build a weighted undirected file-level adjacency graph.
 * Edge weight = number of call/import connections between two files.
 */
function buildWeightedFileGraph(
    graph: WorkspaceCallGraph,
    filePaths: string[],
    importEdges?: Map<string, Set<string>>,
): { adj: Map<string, Map<string, number>>; totalWeight: number } {
    const adj = new Map<string, Map<string, number>>();
    for (const fp of filePaths) {
        adj.set(fp, new Map());
    }

    // Track seen undirected pairs to avoid double-counting
    const seenPairs = new Set<string>();
    function pairKey(a: string, b: string): string {
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    }

    // Add call graph edges (directed → undirected: accumulate weights symmetrically)
    for (const node of graph.getAllNodes()) {
        for (const calleeKey of node.calls) {
            const calleeFile = calleeKey.split('::')[0];
            if (calleeFile && calleeFile !== node.filePath && adj.has(node.filePath) && adj.has(calleeFile)) {
                const w = adj.get(node.filePath)!.get(calleeFile) ?? 0;
                adj.get(node.filePath)!.set(calleeFile, w + 1);
                adj.get(calleeFile)!.set(node.filePath, (adj.get(calleeFile)!.get(node.filePath) ?? 0) + 1);
                seenPairs.add(pairKey(node.filePath, calleeFile));
            }
        }
    }

    // Add import edges (weight 1 per pair, only if no call edge exists)
    if (importEdges) {
        for (const [fp, neighbors] of importEdges) {
            for (const neighbor of neighbors) {
                if (adj.has(fp) && adj.has(neighbor) && !seenPairs.has(pairKey(fp, neighbor))) {
                    adj.get(fp)!.set(neighbor, (adj.get(fp)!.get(neighbor) ?? 0) + 1);
                    adj.get(neighbor)!.set(fp, (adj.get(neighbor)!.get(fp) ?? 0) + 1);
                    seenPairs.add(pairKey(fp, neighbor));
                }
            }
        }
    }

    // Issue 139: Add directory-based affinity — files in the same directory
    // get a bonus edge weight, encouraging Louvain to keep co-located files
    // in the same cluster. This prevents shared middleware imports (e.g., auth)
    // from pulling all controllers into a single cluster.
    const dirMap = new Map<string, string[]>();
    for (const fp of filePaths) {
        const dir = fp.substring(0, fp.lastIndexOf('/'));
        if (!dirMap.has(dir)) dirMap.set(dir, []);
        dirMap.get(dir)!.push(fp);
    }
    // #874 — the pairwise affinity is an O(d²) clique per directory. For a
    // normal feature directory (a handful of files) that's negligible AND the
    // bonus does its job (keep co-located files together). But on monorepo-
    // scale repos a single catch-all directory (`pkg/`, `internal/`, a
    // generated tree) can hold hundreds–thousands of files; the clique then
    // explodes — d=2000 is ~2M edge writes, and EVERY one of Louvain's ≤100
    // iterations re-walks them, which is a dominant slice of the init time.
    // Such a directory is not a cohesive feature anyway (the bonus would
    // wrongly force unrelated files into one cluster), so skip affinity above
    // MAX_AFFINITY_DIR_SIZE. Output is byte-identical for every normal-sized
    // directory (the entire fixture/verify:real corpus); only pathological
    // mono-directories change — and for the better (no spurious mega-merge).
    const MAX_AFFINITY_DIR_SIZE = Number(process.env.CODEATLAS_MAX_AFFINITY_DIR) || 200;
    for (const siblings of dirMap.values()) {
        if (siblings.length < 2 || siblings.length > MAX_AFFINITY_DIR_SIZE) continue;
        for (let i = 0; i < siblings.length; i++) {
            for (let j = i + 1; j < siblings.length; j++) {
                const a = siblings[i], b = siblings[j];
                // Add a small affinity bonus (0.5) for same-directory files
                adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + 0.5);
                adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + 0.5);
            }
        }
    }

    // totalWeight = sum of all adj entries (each undirected edge counted twice — once per direction)
    let totalWeight = 0;
    for (const neighbors of adj.values()) {
        for (const w of neighbors.values()) totalWeight += w;
    }

    return { adj, totalWeight };
}

/**
 * Compute modularity Q for the current partition.
 * Q = (1/2m) * Σ_ij [A_ij - (k_i * k_j)/(2m)] * δ(c_i, c_j)
 */
function computeModularity(
    adj: Map<string, Map<string, number>>,
    communities: Map<string, number>,
    totalWeight: number,
): number {
    if (totalWeight === 0) return 0;
    const m2 = totalWeight; // already doubled (undirected)

    // Compute degree of each node (sum of edge weights)
    const degree = new Map<string, number>();
    for (const [node, neighbors] of adj) {
        let d = 0;
        for (const w of neighbors.values()) d += w;
        degree.set(node, d);
    }

    let Q = 0;
    for (const [i, neighbors] of adj) {
        const ci = communities.get(i)!;
        const ki = degree.get(i)!;
        for (const [j, aij] of neighbors) {
            const cj = communities.get(j)!;
            if (ci !== cj) continue;
            const kj = degree.get(j)!;
            Q += aij - (ki * kj) / m2;
        }
    }
    return Q / m2;
}

/**
 * Louvain Phase 1: greedily move nodes to maximize modularity.
 * Returns true if any node moved.
 */
function louvainPhase1(
    adj: Map<string, Map<string, number>>,
    communities: Map<string, number>,
    totalWeight: number,
): boolean {
    if (totalWeight === 0) return false;
    const m2 = totalWeight;

    // Degree per node
    const degree = new Map<string, number>();
    for (const [node, neighbors] of adj) {
        let d = 0;
        for (const w of neighbors.values()) d += w;
        degree.set(node, d);
    }

    // Sum of degrees per community: Σ_tot
    const communityDegree = new Map<number, number>();
    for (const [node, comm] of communities) {
        communityDegree.set(comm, (communityDegree.get(comm) ?? 0) + degree.get(node)!);
    }

    let anyMoved = false;
    const nodes = [...adj.keys()].sort(); // deterministic order

    for (const node of nodes) {
        const ki = degree.get(node)!;
        const currentComm = communities.get(node)!;

        // Compute edge weights from this node to each neighbor community
        const neighborCommWeights = new Map<number, number>();
        for (const [neighbor, w] of adj.get(node)!) {
            const nc = communities.get(neighbor)!;
            neighborCommWeights.set(nc, (neighborCommWeights.get(nc) ?? 0) + w);
        }

        // Remove node from its current community temporarily
        communityDegree.set(currentComm, (communityDegree.get(currentComm) ?? 0) - ki);

        let bestComm = currentComm;
        let bestDeltaQ = 0;

        for (const [targetComm, ki_in] of neighborCommWeights) {
            // ΔQ = [ki_in / m - (Σ_tot * ki) / (2m²)]
            const sigmaTot = communityDegree.get(targetComm) ?? 0;
            const deltaQ = ki_in / m2 - (sigmaTot * ki) / (m2 * m2);

            // For current community, also account for removing
            if (targetComm === currentComm) continue;

            const ki_in_current = neighborCommWeights.get(currentComm) ?? 0;
            const sigmaTotCurrent = communityDegree.get(currentComm) ?? 0;
            const removeDeltaQ = -(ki_in_current / m2 - (sigmaTotCurrent * ki) / (m2 * m2));

            const totalDelta = deltaQ + removeDeltaQ;
            if (totalDelta > bestDeltaQ) {
                bestDeltaQ = totalDelta;
                bestComm = targetComm;
            }
        }

        // Restore node to community (possibly new one)
        communityDegree.set(currentComm, (communityDegree.get(currentComm) ?? 0) + ki);

        if (bestComm !== currentComm && bestDeltaQ > 1e-10) {
            communityDegree.set(currentComm, (communityDegree.get(currentComm) ?? 0) - ki);
            communityDegree.set(bestComm, (communityDegree.get(bestComm) ?? 0) + ki);
            communities.set(node, bestComm);
            anyMoved = true;
        }
    }

    return anyMoved;
}

/**
 * Run Louvain community detection.
 * Returns a map of filePath → communityId (numeric).
 */
function louvainCommunities(
    graph: WorkspaceCallGraph,
    filePaths: string[],
    importEdges?: Map<string, Set<string>>,
): { communities: Map<string, number>; modularity: number } {
    if (filePaths.length === 0) return { communities: new Map(), modularity: 0 };

    const { adj, totalWeight } = buildWeightedFileGraph(graph, filePaths, importEdges);

    // If no edges, each file is its own community
    if (totalWeight === 0) {
        const communities = new Map<string, number>();
        filePaths.forEach((fp, i) => communities.set(fp, i));
        return { communities, modularity: 0 };
    }

    // Initialize: each file in its own community
    const communities = new Map<string, number>();
    filePaths.forEach((fp, i) => communities.set(fp, i));

    // Phase 1: greedy node moves (up to 100 iterations)
    for (let iter = 0; iter < 100; iter++) {
        const moved = louvainPhase1(adj, communities, totalWeight);
        if (!moved) break;
    }

    // Renumber communities to be contiguous (0, 1, 2, ...)
    const uniqueComms = [...new Set(communities.values())];
    const renumber = new Map<number, number>();
    uniqueComms.forEach((c, i) => renumber.set(c, i));
    for (const [node, comm] of communities) {
        communities.set(node, renumber.get(comm)!);
    }

    const modularity = computeModularity(adj, communities, totalWeight);
    return { communities, modularity };
}

// ─── Label Propagation (fallback) ──────────────────────────────────────────

/**
 * Run label propagation on the call graph to find file communities.
 * Returns a map of filePath → clusterId.
 */
function labelPropagation(
    graph: WorkspaceCallGraph,
    filePaths: string[],
    importEdges?: Map<string, Set<string>>
): Map<string, string> {
    // Initialize: files in the same directory share the same starting label.
    // This prevents label propagation from accidentally merging well-separated
    // feature directories (e.g. features/auth/ and features/todos/) just because
    // they both call shared utilities. Cross-directory merging only happens when
    // one directory has more outbound connections to another directory than to itself.
    const labels = new Map<string, string>();
    for (const fp of filePaths) {
        const dir = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : fp;
        labels.set(fp, dir);
    }

    // Build adjacency: filePath → Set of neighboring filePaths (via calls)
    const fileNeighbors = new Map<string, Set<string>>();
    for (const fp of filePaths) {
        fileNeighbors.set(fp, new Set());
    }
    for (const node of graph.getAllNodes()) {
        for (const calleeKey of node.calls) {
            const calleeFile = calleeKey.split('::')[0];
            if (calleeFile && calleeFile !== node.filePath) {
                fileNeighbors.get(node.filePath)?.add(calleeFile);
                fileNeighbors.get(calleeFile)?.add(node.filePath);
            }
        }
    }

    // Supplement with import-based edges when the call graph is sparse
    if (importEdges) {
        for (const [fp, neighbors] of importEdges) {
            for (const neighbor of neighbors) {
                fileNeighbors.get(fp)?.add(neighbor);
                fileNeighbors.get(neighbor)?.add(fp);
            }
        }
    }

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        let changed = false;
        // Shuffle to avoid order bias (deterministic shuffle using index)
        const shuffled = [...filePaths].sort((a, b) => a.localeCompare(b));

        for (const fp of shuffled) {
            const neighbors = fileNeighbors.get(fp);
            if (!neighbors || neighbors.size === 0) continue;

            // Count neighbor labels
            const labelCounts = new Map<string, number>();
            for (const neighbor of neighbors) {
                const label = labels.get(neighbor) ?? neighbor;
                labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
            }

            // Find the maximum neighbor-label count.
            let maxCount = 0;
            for (const count of labelCounts.values()) {
                if (count > maxCount) maxCount = count;
            }

            // Stability tie-break: only adopt a new label when there is a UNIQUE winner
            // (exactly one label has the maximum count AND that count exceeds the current
            // label's count). When multiple labels are tied for the top, keep the current
            // label unchanged. This prevents hub nodes like "backend/index.js" — which
            // connect equally to auth and todos — from arbitrarily pulling one cluster
            // into the other through an irrelevant tie-break.
            const currentCount = labelCounts.get(labels.get(fp)!) ?? 0;
            let bestLabel = labels.get(fp)!;
            if (maxCount > currentCount) {
                const topLabels = [...labelCounts.entries()].filter(([, c]) => c === maxCount);
                if (topLabels.length === 1) {
                    bestLabel = topLabels[0][0];
                }
                // else: tie among competing labels → keep current (stability)
            }

            if (bestLabel !== labels.get(fp)) {
                labels.set(fp, bestLabel);
                changed = true;
            }
        }

        if (!changed) break;
    }

    return labels;
}

/**
 * Infer a human-readable cluster name from the propagation label and member file paths.
 *
 * Primary strategy: use the propagation label (the directory that label propagation
 * converged on, e.g. "backend/features/auth"). Walk backwards through its path
 * segments and return the deepest non-trivial (non-SKIP) segment — this gives
 * "auth" from "backend/features/auth", "todos" from "backend/features/todos", etc.
 *
 * Fallback: segment-counting across member file paths with depth tie-break.
 */
function inferClusterLabel(filePaths: string[], propagationLabel?: string, apiCountsByFile?: Map<string, number>): string {
    if (filePaths.length === 0) return 'unknown';

    const SKIP = new Set(['src', 'lib', 'app', 'api', 'utils', 'helpers', 'common',
        'shared', 'core', 'index', 'features', 'modules', 'components', 'services',
        'controllers', 'routes', 'models', 'middleware', 'config', 'types', 'hooks']);

    // Primary: extract deepest meaningful segment from the propagation label
    // e.g. "backend/features/auth" → "auth", "backend/features/todos" → "todos"
    if (propagationLabel) {
        const parts = propagationLabel.split('/');
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i].toLowerCase();
            if (!SKIP.has(part) && part.length > 1) {
                return part;
            }
        }
    }

    // Fallback: collect all directory path segments with their max depth.
    // 2026-06-03 — when the cluster mixes domains (Louvain groups files
    // that share many cross-calls), file-count alone can mislabel: a
    // cluster with 4 article-files-15-routes + 4 auth-files-4-routes gets
    // labeled "auth" because both sides have equal file counts. Weight
    // each file by its API count (or 1 when it has no APIs) so the
    // segment whose files own the most routes wins the label. Matches
    // user expectation ("the cluster of 19 routes — what's the dominant
    // surface?") and is backward-compatible: when `apiCountsByFile` is
    // omitted (older callers + tests) every file weighs 1, identical to
    // the prior behavior.
    const segmentCounts = new Map<string, number>();
    const segmentMaxDepth = new Map<string, number>();
    for (const fp of filePaths) {
        const apiWeight = (apiCountsByFile?.get(fp) ?? 0);
        // Cap the weight contribution so a single route-heavy file (e.g.
        // articles with 15 routes) doesn't dominate to the point where
        // a sibling cluster with 14 routes from 14 different files is
        // out-shouted by one outlier. 1 base + min(api count, 10).
        const weight = 1 + Math.min(apiWeight, 10);
        const parts = fp.split('/').slice(0, -1); // all but filename
        for (let i = 0; i < parts.length; i++) {
            const normalized = parts[i].toLowerCase();
            if (SKIP.has(normalized)) continue;
            segmentCounts.set(normalized, (segmentCounts.get(normalized) ?? 0) + weight);
            // Track max depth so deeper segments win ties (depth = 1-based index)
            const depth = i + 1;
            if (depth > (segmentMaxDepth.get(normalized) ?? 0)) {
                segmentMaxDepth.set(normalized, depth);
            }
        }
    }

    // Find best segment: highest count; tie-break by deepest path depth
    let bestSegment = '';
    let bestCount = 0;
    let bestDepth = 0;
    for (const [seg, count] of segmentCounts.entries()) {
        const depth = segmentMaxDepth.get(seg) ?? 0;
        if (count > bestCount || (count === bestCount && depth > bestDepth)) {
            bestSegment = seg;
            bestCount = count;
            bestDepth = depth;
        }
    }

    if (bestSegment) return bestSegment;

    // Fallback: longest common prefix of file paths
    const sorted = [...filePaths].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let prefix = '';
    for (let i = 0; i < Math.min(first.length, last.length); i++) {
        if (first[i] === last[i]) prefix += first[i];
        else break;
    }
    const dir = path.dirname(prefix.replace(/\/$/, ''));
    const label = dir.split('/').pop() || 'cluster';
    return label === '.' ? 'misc' : label;
}

/**
 * Assign each file to its service based on rootPath prefix matching.
 * Returns a map of filePath → serviceId.
 */
function buildFileToServiceMap(
    filePaths: string[],
    services: Record<string, ServiceRecord>
): Map<string, string> {
    const result = new Map<string, string>();
    const serviceList = Object.values(services).sort(
        // Longer rootPaths match first (more specific wins)
        (a, b) => b.rootPath.length - a.rootPath.length
    );
    for (const fp of filePaths) {
        for (const svc of serviceList) {
            if (svc.rootPath === '' || fp.startsWith(svc.rootPath + '/') || fp === svc.rootPath) {
                result.set(fp, svc.id);
                break;
            }
        }
    }
    return result;
}

// ─── Pre-clustering file filter ────────────────────────────────────────────

// Paths containing any of these segments are test/tooling infrastructure
const TEST_DIR_SEGMENTS = new Set([
    'tests', 'test', '__tests__', '__test__', 'e2e', 'cypress', 'playwright',
    'fixtures', 'mocks', '__mocks__', 'support', 'spec', 'specs',
]);

// Files matching these patterns are test/config files
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|\.e2e\.|-test\.|\.mock\.)/;

// Config/tooling files at any depth
const CONFIG_BASENAME_PATTERN = /^(?:jest|vitest|babel|webpack|rollup|esbuild|tsconfig|eslint|prettier|tailwind|postcss|vite)[\.\-]/;

// Root-level entry points
const ENTRY_BASENAME_PATTERN = /^(?:main|app|index|server|bootstrap)\.\w+$/;

// Setup/teardown files
const SETUP_BASENAME_PATTERN = /^(?:setup|teardown|global-setup|global-teardown|test-setup|test-teardown)\.\w+$/;

// Seed/migration files
const SEED_PATTERN = /(?:\/seed\.\w+$|\/seeds\/|\/migrations\/)/;

/**
 * Determines if a file should be included in feature clustering.
 * Excludes test files, config files, root-level entry points, and seed scripts.
 */
function isClusterableFile(fp: string, apiFilePaths?: Set<string>): boolean {
    const parts = fp.split('/');
    const basename = parts[parts.length - 1] ?? '';

    // Any path segment matching a test/tooling directory
    for (const part of parts.slice(0, -1)) {
        if (TEST_DIR_SEGMENTS.has(part)) return false;
    }

    // Test files by name pattern
    if (TEST_FILE_PATTERN.test(basename)) return false;

    // Config/tooling files
    if (CONFIG_BASENAME_PATTERN.test(basename)) return false;

    // Setup/teardown files
    if (SETUP_BASENAME_PATTERN.test(basename)) return false;

    // Seed/migration files — but KEEP those that carry detected entry points
    // (DB_MIGRATION / DB_SEED records) so they cluster and surface in the L2a
    // feature view (same escape hatch as entry files below). Without this the
    // 50 polar Alembic migrations were dropped from clustering → invisible in
    // L2a (no MIGRATE tab), even though they exist in the apiIndex. BUG-MIGRATION-SURFACE.
    if (SEED_PATTERN.test(fp)) {
        if (!apiFilePaths || !apiFilePaths.has(fp)) return false;
    }

    // Root-level entry points (main.ts, app.ts) are infra, not features.
    // Exception: in example/demo repos the entry file IS the routes file
    // (e.g. koajs/examples blog/app.js, remix server.ts) — keep these so
    // their APIs show up in L2b. We treat "has detected APIs" as the
    // signal that the entry file carries feature content.
    if (parts.length <= 2 && ENTRY_BASENAME_PATTERN.test(basename)) {
        if (!apiFilePaths || !apiFilePaths.has(fp)) return false;
    }

    // Mock files
    if (basename.includes('mock') || basename.includes('Mock')) return false;

    return true;
}

/**
 * Build feature clusters from a snapshot.
 * Uses the call graph for community detection.
 * When services are provided, each cluster is tagged with the service it primarily belongs to.
 */
export function detectCommunities(
    snapshot: Snapshot,
    workspaceCallGraph?: WorkspaceCallGraph,
    services?: Record<string, ServiceRecord>,
    baselineClusters?: Record<string, FeatureCluster>,
): Record<string, FeatureCluster> {
    const graph = workspaceCallGraph ?? buildCallGraph(snapshot);
    const allFilePaths = Object.keys(snapshot.files);
    const allApis = Object.values(snapshot.apiIndex);
    const apiFilePaths = new Set(allApis.map(a => a.filePath));
    // Filter out test files, seed files, and root-level entry points before clustering.
    // These are infrastructure/tooling, not feature domains — except entry files
    // that carry detected APIs (example-repo case where app.js IS the routes).
    const filePaths = allFilePaths.filter(fp => isClusterableFile(fp, apiFilePaths));

    if (filePaths.length === 0) return {};

    const fileToService = services ? buildFileToServiceMap(filePaths, services) : new Map<string, string>();

    // Build import-based edges as fallback for sparse call graphs
    const importEdges = buildImportEdges(snapshot);

    // Run Louvain as primary clustering algorithm
    const { communities: louvainResult, modularity } = louvainCommunities(graph, filePaths, importEdges);
    const louvainCommCount = new Set(louvainResult.values()).size;

    // Fall back to label propagation if Louvain produces < 2 communities
    // (e.g., fully connected small graph where everything merges)
    let labels: Map<string, string>;
    let clusterModularity = modularity;

    if (louvainCommCount >= 2) {
        // Convert numeric community IDs to directory-based labels for naming
        // Group files by Louvain community, then use the directory path of
        // the majority of files as the propagation label (same as label propagation would produce)
        labels = new Map<string, string>();
        const commGroups = new Map<number, string[]>();
        for (const [fp, comm] of louvainResult) {
            if (!commGroups.has(comm)) commGroups.set(comm, []);
            commGroups.get(comm)!.push(fp);
        }
        // For each Louvain community, find the most common directory prefix
        // and use it as the propagation label (so inferClusterLabel works identically)
        for (const [, files] of commGroups) {
            const dirCounts = new Map<string, number>();
            for (const fp of files) {
                const dir = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : fp;
                dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
            }
            let bestDir = files[0];
            let bestCount = 0;
            for (const [dir, count] of dirCounts) {
                if (count > bestCount) { bestCount = count; bestDir = dir; }
            }
            for (const fp of files) {
                labels.set(fp, bestDir);
            }
        }
    } else {
        // Louvain failed to split — fall back to label propagation
        labels = labelPropagation(graph, filePaths, importEdges);
        clusterModularity = 0;
    }

    // Group files by cluster label
    const clusterFiles = new Map<string, string[]>();
    for (const [fp, label] of labels.entries()) {
        if (!clusterFiles.has(label)) clusterFiles.set(label, []);
        clusterFiles.get(label)!.push(fp);
    }

    // Merge tiny clusters (< MIN_CLUSTER_SIZE) into most-called neighbor
    const largeClusterLabels = new Set<string>();
    for (const [label, files] of clusterFiles.entries()) {
        if (files.length >= MIN_CLUSTER_SIZE) largeClusterLabels.add(label);
    }

    for (const [label, files] of [...clusterFiles.entries()]) {
        if (files.length >= MIN_CLUSTER_SIZE) continue;
        // Find nearest large cluster neighbor
        let bestNeighbor: string | null = null;
        let bestEdgeCount = 0;
        for (const fp of files) {
            for (const node of graph.getAllNodes().filter((n) => n.filePath === fp)) {
                for (const calleeKey of [...node.calls, ...node.calledBy]) {
                    const calleeFile = calleeKey.split('::')[0];
                    const calleeCluster = labels.get(calleeFile);
                    if (calleeCluster && largeClusterLabels.has(calleeCluster)) {
                        bestEdgeCount++;
                        bestNeighbor = calleeCluster;
                    }
                }
            }
        }
        if (bestNeighbor) {
            for (const fp of files) {
                labels.set(fp, bestNeighbor);
            }
        }
    }

    // Regroup after merging
    const finalGroups = new Map<string, string[]>();
    for (const [fp, label] of labels.entries()) {
        if (!finalGroups.has(label)) finalGroups.set(label, []);
        finalGroups.get(label)!.push(fp);
    }

    // Remove shared infrastructure files: files imported by most clusters are infra (e.g., prisma-client.ts).
    // Only applies to larger projects (5+ clusters) to avoid over-filtering small codebases.
    if (finalGroups.size >= 5) {
        const fileToCluster = new Map<string, string>();
        for (const [label, files] of finalGroups) {
            for (const fp of files) fileToCluster.set(fp, label);
        }
        // Count how many distinct clusters import each file
        const importedByClusterCount = new Map<string, Set<string>>();
        for (const [fp, imports] of importEdges) {
            for (const imp of imports) {
                const impCluster = fileToCluster.get(imp);
                if (impCluster) {
                    if (!importedByClusterCount.has(imp)) importedByClusterCount.set(imp, new Set());
                    importedByClusterCount.get(imp)!.add(fileToCluster.get(fp) ?? '');
                }
            }
        }
        // Remove files imported by 80%+ of clusters (shared infra like db clients)
        // but never remove files that contain API routes (controllers/services)
        // (apiFilePaths declared at outer scope)
        const threshold = Math.max(3, Math.ceil(finalGroups.size * 0.8));
        for (const [fp, clusterSet] of importedByClusterCount) {
            if (clusterSet.size >= threshold && !apiFilePaths.has(fp)) {
                const clusterLabel = fileToCluster.get(fp);
                if (clusterLabel) {
                    const files = finalGroups.get(clusterLabel);
                    if (files) {
                        const filtered = files.filter(f => f !== fp);
                        if (filtered.length === 0) {
                            finalGroups.delete(clusterLabel);
                        } else {
                            finalGroups.set(clusterLabel, filtered);
                        }
                    }
                }
            }
        }
    }

    // Post-process: split groups that contain API files from multiple distinct feature
    // directories. Louvain often groups controllers together because they share auth
    // middleware, error handling, etc. — creating one mega-cluster with all API routes.
    // Splitting by directory restores the intended feature boundaries.
    // (apiFilePaths already declared at the top of detectCommunities for entry-file inclusion)
    for (const [label, files] of [...finalGroups.entries()]) {
        const apiFilesInGroup = files.filter(f => apiFilePaths.has(f));
        if (apiFilesInGroup.length <= 1) continue;

        // Get distinct parent directories of API files
        const apiDirToFiles = new Map<string, string[]>();
        for (const fp of apiFilesInGroup) {
            const dir = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : '';
            if (!apiDirToFiles.has(dir)) apiDirToFiles.set(dir, []);
            apiDirToFiles.get(dir)!.push(fp);
        }
        if (apiDirToFiles.size <= 1) continue; // all API files in same directory — no split

        // Split: remove original group, create one sub-group per API directory
        finalGroups.delete(label);

        // Assign non-API files to the sub-group whose directory best matches
        const nonApiFiles = files.filter(f => !apiFilePaths.has(f));
        for (const fp of nonApiFiles) {
            const dir = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : '';
            let bestDir = '';
            let bestLen = 0;
            for (const apiDir of apiDirToFiles.keys()) {
                // Longest common prefix match
                if ((dir === apiDir || dir.startsWith(apiDir + '/') || apiDir.startsWith(dir + '/'))
                    && apiDir.length > bestLen) {
                    bestDir = apiDir;
                    bestLen = apiDir.length;
                }
            }
            if (!bestDir) {
                // No directory match — assign to the largest sub-group
                let maxSize = 0;
                for (const [d, fs] of apiDirToFiles) {
                    if (fs.length > maxSize) { maxSize = fs.length; bestDir = d; }
                }
            }
            if (!apiDirToFiles.has(bestDir)) apiDirToFiles.set(bestDir, []);
            apiDirToFiles.get(bestDir)!.push(fp);
        }

        for (const [dir, groupFiles] of apiDirToFiles) {
            const newLabel = dir || label;
            // Use unique key to avoid collisions
            const key = finalGroups.has(newLabel) ? `${newLabel}__${label}` : newLabel;
            finalGroups.set(key, groupFiles);
        }
    }

    // Build FeatureCluster objects.
    // First pass: compute the inferred label for each propagation group, then
    // collect all groups that share the same inferred label into one bucket.
    // This prevents duplicate cluster names (e.g. two "backend" clusters arising
    // when a singleton like authMiddleware.js ends up with the same human-readable
    // label as another group after generic segments like "middleware" are skipped).
    const clusters: Record<string, FeatureCluster> = {};
    const apiFiles = new Set(
        Object.values(snapshot.apiIndex).map((a) => a.filePath)
    );
    // 2026-06-03 — per-file API count so cluster labeling can weight route-
    // owning files higher than passive support files. Without this weight,
    // a cluster containing one 15-route controller + several 1-route
    // controllers used to label by the directory with the most FILES, not
    // the directory with the most ROUTES. See inferClusterLabel.
    const apiCountsByFile = new Map<string, number>();
    for (const api of Object.values(snapshot.apiIndex)) {
        apiCountsByFile.set(api.filePath, (apiCountsByFile.get(api.filePath) ?? 0) + 1);
    }

    // Group propagation-label buckets by their inferred cluster name
    const byInferredLabel = new Map<string, string[]>();
    for (const [propagationLabel, files] of finalGroups.entries()) {
        const clusterLabel = inferClusterLabel(files, propagationLabel, apiCountsByFile);
        if (!byInferredLabel.has(clusterLabel)) byInferredLabel.set(clusterLabel, []);
        byInferredLabel.get(clusterLabel)!.push(...files);
    }

    for (const [clusterLabel, files] of byInferredLabel.entries()) {
        const clusterId = `cluster:${clusterLabel}`;

        // Count internal vs external calls
        const fileSet = new Set(files);
        let internalCallCount = 0;
        let externalCallCount = 0;

        for (const node of graph.getAllNodes().filter((n) => fileSet.has(n.filePath))) {
            for (const calleeKey of node.calls) {
                const calleeFile = calleeKey.split('::')[0];
                if (fileSet.has(calleeFile)) internalCallCount++;
                else externalCallCount++;
            }
        }

        // Find API handler entry points
        const entryPoints: string[] = [];
        for (const fp of files) {
            if (apiFiles.has(fp)) {
                const fnKeys = getFunctionKeysForFiles([fp], graph);
                entryPoints.push(...fnKeys);
            }
        }

        // Determine majority service for this cluster
        let serviceId: string | undefined;
        if (fileToService.size > 0) {
            const svcCounts = new Map<string, number>();
            for (const fp of files) {
                const svc = fileToService.get(fp);
                if (svc) svcCounts.set(svc, (svcCounts.get(svc) ?? 0) + 1);
            }
            let bestCount = 0;
            for (const [svc, count] of svcCounts.entries()) {
                if (count > bestCount) { bestCount = count; serviceId = svc; }
            }
        }

        // Collect APIs + mobile items whose files are in this cluster
        const apisInCluster = allApis.filter((a) => fileSet.has(a.filePath));

        // Split into L2b categories
        const MOBILE_METHODS: Record<string, keyof FeatureCluster> = {
            SCREEN: 'screensInCluster',
            NAV_ROUTE: 'navRoutesInCluster',
            NETWORK: 'networkCallsInCluster',
            DI_BINDING: 'diBindingsInCluster',
        };
        const screensInCluster = apisInCluster.filter(a => a.method === 'SCREEN');
        const navRoutesInCluster = apisInCluster.filter(a => a.method === 'NAV_ROUTE');
        const networkCallsInCluster = apisInCluster.filter(a => a.method === 'NETWORK');
        const diBindingsInCluster = apisInCluster.filter(a => a.method === 'DI_BINDING');

        clusters[clusterId] = {
            id: clusterId,
            label: clusterLabel,
            name: clusterLabel,
            serviceId,
            files: [...files].sort(),
            entryPoints,
            apisInCluster,
            screensInCluster: screensInCluster.length > 0 ? screensInCluster : undefined,
            navRoutesInCluster: navRoutesInCluster.length > 0 ? navRoutesInCluster : undefined,
            networkCallsInCluster: networkCallsInCluster.length > 0 ? networkCallsInCluster : undefined,
            diBindingsInCluster: diBindingsInCluster.length > 0 ? diBindingsInCluster : undefined,
            internalCallCount,
            externalCallCount,
            modularity: clusterModularity,
        };
    }

    // Sub-cluster large clusters (>15 files) recursively (1 level only)
    for (const [clusterId, cluster] of Object.entries(clusters)) {
        if (cluster.files.length > SUB_CLUSTER_THRESHOLD) {
            const subClusters = detectSubClusters(cluster, graph, importEdges, allApis);
            if (subClusters && Object.keys(subClusters).length >= 2) {
                cluster.subClusters = subClusters;
            }
        }
    }

    return stabilizeClusters(clusters, baselineClusters);
}

// ─── Sub-Clustering ─────────────────────────────────────────────────────────

const SUB_CLUSTER_THRESHOLD = 15;

/**
 * Sub-divide a large cluster into smaller sub-clusters using Louvain on the sub-graph.
 * Returns null if the cluster can't be meaningfully split (fully connected or too small).
 * Recursive depth is limited to 1 (no sub-sub-clusters).
 */
export function detectSubClusters(
    cluster: FeatureCluster,
    graph: WorkspaceCallGraph,
    importEdges?: Map<string, Set<string>>,
    allApis?: ApiRecord[],
    depth: number = 0,
): Record<string, FeatureCluster> | null {
    // Issue 189: Enforce max depth = 1 (no sub-sub-clusters)
    if (depth >= 1) return null;
    const filePaths = cluster.files;
    if (filePaths.length <= SUB_CLUSTER_THRESHOLD) return null;

    // Filter import edges to only include files in this cluster
    const clusterFileSet = new Set(filePaths);
    let filteredImportEdges: Map<string, Set<string>> | undefined;
    if (importEdges) {
        filteredImportEdges = new Map<string, Set<string>>();
        for (const fp of filePaths) {
            const neighbors = importEdges.get(fp);
            if (neighbors) {
                const filtered = new Set<string>();
                for (const n of neighbors) {
                    if (clusterFileSet.has(n)) filtered.add(n);
                }
                filteredImportEdges.set(fp, filtered);
            } else {
                filteredImportEdges.set(fp, new Set());
            }
        }
    }

    // Run Louvain on the sub-graph
    const { communities, modularity } = louvainCommunities(graph, filePaths, filteredImportEdges);
    const commCount = new Set(communities.values()).size;

    // If Louvain can't split (1 community), or produces too many tiny clusters, skip
    if (commCount < 2) return null;

    // Group files by sub-community
    const commGroups = new Map<number, string[]>();
    for (const [fp, comm] of communities) {
        if (!commGroups.has(comm)) commGroups.set(comm, []);
        commGroups.get(comm)!.push(fp);
    }

    // Build sub-cluster objects
    const subClusters: Record<string, FeatureCluster> = {};
    const apiRecords = allApis ?? [];
    const apiFiles = new Set(apiRecords.map(a => a.filePath));

    for (const [, files] of commGroups) {
        const subLabel = inferClusterLabel(files);
        const subId = `${cluster.id}/${subLabel}`;
        const fileSet = new Set(files);

        // Count internal vs external calls (within the sub-cluster)
        let internalCallCount = 0;
        let externalCallCount = 0;
        for (const node of graph.getAllNodes().filter(n => fileSet.has(n.filePath))) {
            for (const calleeKey of node.calls) {
                const calleeFile = calleeKey.split('::')[0];
                if (fileSet.has(calleeFile)) internalCallCount++;
                else externalCallCount++;
            }
        }

        const entryPoints: string[] = [];
        for (const fp of files) {
            if (apiFiles.has(fp)) {
                entryPoints.push(...getFunctionKeysForFiles([fp], graph));
            }
        }

        const apisInCluster = apiRecords.filter(a => fileSet.has(a.filePath));

        subClusters[subId] = {
            id: subId,
            label: subLabel,
            name: subLabel,
            serviceId: cluster.serviceId,
            files: [...files].sort(),
            entryPoints,
            apisInCluster,
            internalCallCount,
            externalCallCount,
            modularity,
        };
    }

    return Object.keys(subClusters).length >= 2 ? subClusters : null;
}

// ─── Cluster ID Stability ────────────────────────────────────────────────────

/**
 * Stabilize cluster IDs across rebuilds using Jaccard similarity matching.
 *
 * When baseline clusters exist, computes Jaccard similarity between every
 * (baseline, fresh) pair of clusters, then greedily assigns 1:1 matches
 * (highest Jaccard first). Matched fresh clusters inherit the baseline
 * cluster's ID. Unmatched clusters keep their generated ID with suffix
 * dedup if there's a collision.
 */
export function stabilizeClusters(
    freshClusters: Record<string, FeatureCluster>,
    baselineClusters: Record<string, FeatureCluster> | undefined,
): Record<string, FeatureCluster> {
    if (!baselineClusters || Object.keys(baselineClusters).length === 0) {
        return freshClusters;
    }

    const baseEntries = Object.values(baselineClusters);
    const freshEntries = Object.values(freshClusters);

    if (freshEntries.length === 0) return freshClusters;

    // Compute Jaccard similarity for every (baseline, fresh) pair
    const pairs: Array<{ baseId: string; freshId: string; jaccard: number }> = [];
    for (const base of baseEntries) {
        const baseSet = new Set(base.files);
        for (const fresh of freshEntries) {
            const freshSet = new Set(fresh.files);
            let intersection = 0;
            for (const f of freshSet) {
                if (baseSet.has(f)) intersection++;
            }
            const union = baseSet.size + freshSet.size - intersection;
            const jaccard = union > 0 ? intersection / union : 0;
            if (jaccard > 0) {
                pairs.push({ baseId: base.id, freshId: fresh.id, jaccard });
            }
        }
    }

    // Sort descending by Jaccard
    pairs.sort((a, b) => b.jaccard - a.jaccard);

    // Greedy 1:1 matching with threshold
    const JACCARD_THRESHOLD = 0.3;
    const matchedBase = new Set<string>();
    const matchedFresh = new Set<string>();
    const freshToBaseId = new Map<string, string>(); // freshId → inherited baselineId

    for (const { baseId, freshId, jaccard } of pairs) {
        if (jaccard < JACCARD_THRESHOLD) break; // sorted desc, so all remaining are below threshold
        if (matchedBase.has(baseId) || matchedFresh.has(freshId)) continue;
        matchedBase.add(baseId);
        matchedFresh.add(freshId);
        freshToBaseId.set(freshId, baseId);
    }

    // Remap: matched clusters get baseline ID; unmatched keep theirs (with dedup)
    const result: Record<string, FeatureCluster> = {};
    const usedIds = new Set<string>();

    for (const [freshId, cluster] of Object.entries(freshClusters)) {
        const inheritedId = freshToBaseId.get(freshId);
        let finalId: string;

        if (inheritedId) {
            finalId = inheritedId;
        } else {
            finalId = freshId;
        }

        // Dedup: if this ID is already taken, append a numeric suffix
        if (usedIds.has(finalId)) {
            let suffix = 2;
            while (usedIds.has(`${finalId}_${suffix}`)) suffix++;
            finalId = `${finalId}_${suffix}`;
        }

        usedIds.add(finalId);
        result[finalId] = { ...cluster, id: finalId };
    }

    return result;
}

/**
 * Diff clusters between baseline and working snapshots.
 * Attaches DiffStatus to each working cluster.
 * A cluster is 'modified' if its membership changed OR if any member file's
 * content hash changed between baseline and working file records.
 */
export function diffClusters(
    baseline: Record<string, FeatureCluster>,
    working: Record<string, FeatureCluster>,
    baselineFiles?: Record<string, { hash: string }>,
    workingFiles?: Record<string, { hash: string }>
): Record<string, FeatureCluster> {
    const result: Record<string, FeatureCluster> = {};

    // Match by ID (stable after stabilizeClusters), fall back to label for legacy state.json
    const baselineById = new Map(Object.values(baseline).map((c) => [c.id, c]));
    const baselineByLabel = new Map(Object.values(baseline).map((c) => [c.label, c]));

    // Issue #423 A2: build a flat set of every file that lived in SOME baseline
    // cluster so we can recognise Louvain "splits" — working clusters whose
    // entire file set already existed in the baseline cluster space. Those
    // are clustering jitter, not new clusters, and should not propagate as
    // `added` through L2a → L1.
    const baselineClusteredFiles = new Set<string>();
    for (const baseCluster of Object.values(baseline)) {
        for (const f of baseCluster.files) baselineClusteredFiles.add(f);
    }

    for (const [id, cluster] of Object.entries(working)) {
        const baseCluster = baselineById.get(id) ?? baselineByLabel.get(cluster.label);
        let diff: DiffStatus = 'unchanged';

        if (!baseCluster) {
            // Issue #423 A2: distinguish "real new cluster" from "Louvain
            // split off an existing baseline cluster." If every file in this
            // working cluster already lived in SOME baseline cluster AND
            // none of them had a content-hash change, this is jitter — mark
            // as `unchanged` so the diff doesn't bubble false 'added' annotations
            // up through L2a feature graphs into L1 microservice nodes.
            const allPreExisting = cluster.files.length > 0 &&
                cluster.files.every((fp) => baselineClusteredFiles.has(fp));
            let anyContentChange = false;
            if (allPreExisting && baselineFiles && workingFiles) {
                anyContentChange = cluster.files.some((fp) => {
                    const baseHash = baselineFiles[fp]?.hash;
                    const workHash = workingFiles[fp]?.hash;
                    return baseHash !== undefined && workHash !== undefined && baseHash !== workHash;
                });
            }
            diff = (allPreExisting && !anyContentChange) ? 'unchanged' : 'added';
        } else if (baselineFiles && workingFiles) {
            // #373: a cluster is `modified` only when one of its member files
            // has actually-changed content OR was added to / removed from the
            // codebase. Pure membership shifts (Louvain reassigning an
            // otherwise-unchanged file to a different cluster between two
            // snapshots) used to trigger `modified` here and surfaced as L2a
            // false positives — clusters with no real edits lit up orange
            // because clustering jitter moved a file between them.
            const baseFiles = new Set(baseCluster.files);
            const fileTouched = (fp: string): boolean => {
                const baseHash = baselineFiles[fp]?.hash;
                const workHash = workingFiles[fp]?.hash;
                // Content actually changed
                if (baseHash && workHash && baseHash !== workHash) return true;
                // File appeared in the codebase (no baseline record at all)
                if (!baselineFiles[fp] && workingFiles[fp]) return true;
                return false;
            };

            // Walk current working membership + any baseline files no longer in
            // working (potential deletes). A baseline file absent from working
            // *and* absent from the working file index = real deletion from the
            // codebase → modified.
            const anyContentChange = cluster.files.some(fileTouched);
            const anyMemberDeletedFromRepo = baseCluster.files.some(
                (fp) => !cluster.files.includes(fp) && !workingFiles[fp]
            );
            if (anyContentChange || anyMemberDeletedFromRepo) diff = 'modified';
        } else {
            // Legacy path (callers that didn't pass file maps): fall back to
            // the old membership-changed heuristic. Loud but better than
            // silently missing diffs when hashes aren't available.
            const baseFiles = new Set(baseCluster.files);
            const workFiles = new Set(cluster.files);
            const membershipChanged =
                cluster.files.some((f) => !baseFiles.has(f)) ||
                baseCluster.files.some((f) => !workFiles.has(f));
            if (membershipChanged) diff = 'modified';
        }

        result[id] = { ...cluster, diff };
    }

    // Mark deleted clusters (in baseline but not in working) — match by ID first, fall back to label
    const workingIds = new Set(Object.keys(working));
    const workingLabels = new Set(Object.values(working).map((c) => c.label));
    for (const cluster of Object.values(baseline)) {
        if (!workingIds.has(cluster.id) && !workingLabels.has(cluster.label)) {
            result[`${cluster.id}__deleted`] = { ...cluster, diff: 'deleted' };
        }
    }

    return result;
}

/**
 * Find the cluster that owns a given file. Linear scan over `Object.values`
 * — adequate for the workspaces we target (≤ ~100 clusters). For larger repos
 * consider building a `filePath → clusterId` map at detection time and
 * passing that in instead.
 *
 * @param filePath - Workspace-relative path
 * @param clusters - The full `snapshot.clusters` map
 * @returns The owning `FeatureCluster`, or `undefined` if the file is not a
 *          member of any cluster (e.g. unreachable code, generated files,
 *          files filtered out by `DEFAULT_IGNORE`)
 */
export function findClusterForFile(
    filePath: string,
    clusters: Record<string, FeatureCluster>
): FeatureCluster | undefined {
    return Object.values(clusters).find((c) => c.files.includes(filePath));
}
