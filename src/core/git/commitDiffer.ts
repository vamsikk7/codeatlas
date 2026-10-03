import { diffGraphs } from '../diff/graphDiff';
import {
    getFileListAtCommit,
    getFileContentAtCommit,
    getChangedFilesBetweenCommits,
} from './gitReader';
import { buildSnapshotFromFiles, type FileInput } from './snapshotBuilder';
import type { DiagramGraph, ApiRecord, FeatureCluster, Snapshot } from '../graph/graphTypes';
import { isGraphIdOfType } from '../graph/graphIdBuilder';

/**
 * #858 — find a `flow:`/`file:` graph for a participant's file, tolerating an
 * ABSOLUTE participant filePath anchor while graph keys are workspace-relative.
 * Cross-file sequence participants (a service reached through a controller) get
 * an absolute filePath, so the exact `flow:<path>:<fn>` lookup misses and the
 * L3→L2b→L2a→L1 cascade silently breaks. Try the exact key first, then
 * suffix-match the relative key path against the (possibly absolute) filePath.
 */
function findGraphByPath(
    diffedGraphs: Record<string, DiagramGraph>,
    prefix: 'flow' | 'file',
    filePath: string,
    suffix: string,
): DiagramGraph | undefined {
    const exact = diffedGraphs[`${prefix}:${filePath}${suffix}`];
    if (exact) return exact;
    const norm = filePath.replace(/\\/g, '/');
    for (const [gid, g] of Object.entries(diffedGraphs)) {
        if (!gid.startsWith(`${prefix}:`)) continue;
        if (suffix && !gid.endsWith(suffix)) continue;
        const mid = gid.slice(prefix.length + 1, suffix ? gid.length - suffix.length : undefined);
        if (mid && (norm === mid || norm.endsWith('/' + mid))) return g;
    }
    return undefined;
}

/**
 * Post-process sequence graphs: upgrade 'unchanged' participant nodes and
 * message edges to 'modified' when the underlying file or flow graph has changes.
 *
 * diffGraphs() compares graphs structurally (by label/type via stableNodeKey).
 * A participant whose label is unchanged but whose backing file was edited will
 * still be marked 'unchanged' by diffGraphs(). This pass fixes that by
 * consulting the file:/flow: graphs in diffedGraphs.
 */
export function upgradeSequenceDiffAnnotations(diffedGraphs: Record<string, DiagramGraph>): void {
    const hasChanges = (n: { diff?: string }) => n.diff === 'modified' || n.diff === 'added' || n.diff === 'deleted';

    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        if (graph.type !== 'sequence') continue;
        let touched = false;

        // Bug 6: reset all participant + message-edge diff annotations to
        // 'unchanged' before re-deriving them. Without this, stale
        // 'modified' annotations from a prior cascade run (when the user
        // edited a different function in the same file, or when the old
        // blanket-propagation rule was active) would persist forever — the
        // anchor-based pass below short-circuits on `edge.diff !==
        // 'unchanged'`. We never reset 'added' since those are structural
        // diffs from the diffGraphs() pass.
        //
        // Issue #423 (ts-nestjs residual): distinguish "genuine ghost sequence"
        // (handler removed from source — sequence graph should keep all
        // participants deleted) from "stale-state mis-marked participants"
        // (handler still exists; participants got wrongly marked deleted by
        // an earlier cascade pass and three downstream layers — L2b api-list,
        // L2a feature cluster, L1 microservice — are now bubbling false
        // modified diffs from this stuck state).
        //
        // Discriminator: extract the handlerName from the graphId
        // (`sequence:<filePath>:<handlerName>`) and check the matching flow
        // graph (`flow:<filePath>:<handlerName>`). If the flow graph still
        // exists AND has at least one non-deleted node, the handler is alive
        // and the sequence's "deleted" participants are stale — reset them.
        let handlerStillExists = false;
        const seqIdMatch = /^sequence:(.+):([^:]+)$/.exec(graphId);
        if (seqIdMatch) {
            const seqFile = seqIdMatch[1];
            const seqHandler = seqIdMatch[2];
            const flow = diffedGraphs[`flow:${seqFile}:${seqHandler}`];
            if (flow && flow.nodes.some((n) => n.diff !== 'deleted')) {
                handlerStillExists = true;
            }
        }

        for (const node of graph.nodes) {
            if (node.type !== 'participant') continue;
            if (node.diff === 'modified') { node.diff = 'unchanged'; touched = true; }
            else if (node.diff === 'deleted' && handlerStillExists) {
                const isGhost = typeof node.label === 'string' && / \(deleted\)$/.test(node.label);
                if (!isGhost) {
                    node.diff = 'unchanged';
                    touched = true;
                }
            }
        }
        for (const edge of graph.edges) {
            if (edge.edgeType !== 'message') continue;
            if (edge.diff === 'modified') {
                edge.diff = 'unchanged';
                touched = true;
                // #495: also drop the visual diff residue carried by
                // `buildSequenceDiff` when it found a previous edit. The
                // `styleKind: 'changed'` flag and the `- old\n+ new` diff
                // label are written into the EDGE object when the sequence
                // is rebuilt during cross-file cascade — and they survive
                // the diff reset above. On revert (when working == baseline)
                // the diff field is correctly reset to 'unchanged', but the
                // styleKind + label remain, leaving `sequence:*` graphs
                // permanently diverged from baseline. Strip the residue
                // when we reset to unchanged so post-revert state is byte-
                // identical to baseline. Detect the `- foo\n+ bar` shape
                // emitted by `sequenceGraphBuilder.ts:1628`.
                if ((edge as any).styleKind === 'changed') (edge as any).styleKind = 'normal';
                if (typeof edge.label === 'string' && /^- .+\n\+ /.test(edge.label)) {
                    // Keep the `added` side of the diff label — it's the
                    // current call signature. (Both lines should be byte-
                    // identical when the diff was a false positive driven
                    // by surrounding-source shift; either half is a clean
                    // restore in that case.)
                    const m = /^- .+\n\+ (.+)$/s.exec(edge.label);
                    if (m) edge.label = m[1];
                }
            }
            // Issue #423 (ts-nestjs residual): same logic as participants —
            // when the handler is alive (live flow graph), a 'deleted' edge
            // marker is stale. Otherwise it's a genuine ghost message. Edges
            // can also be ghosts via the styleKind='deleted' marker carried
            // explicitly by sequence-builder ghost code; we don't touch
            // those since they have styleKind set.
            else if (edge.diff === 'deleted' && handlerStillExists && (edge as any).styleKind !== 'deleted') {
                edge.diff = 'unchanged';
                touched = true;
            }
        }

        // Collect the set of function symbols that appear as messages in this sequence,
        // keyed by the target participant's file path.
        // This lets us check ONLY message-relevant functions, not every function in the file.
        const messageFnsByFile = new Map<string, Set<string>>();
        for (const edge of graph.edges) {
            if (edge.edgeType !== 'message') continue;
            const anchor = graph.anchors[edge.id];
            if (anchor?.filePath && anchor?.symbol) {
                if (!messageFnsByFile.has(anchor.filePath)) messageFnsByFile.set(anchor.filePath, new Set());
                messageFnsByFile.get(anchor.filePath)!.add(anchor.symbol);
            }
            // Fallback: infer function name from edge label for unanchored messages
            if (!anchor?.filePath) {
                const targetNode = graph.nodes.find(n => n.id === edge.target);
                const targetFp = targetNode?.anchor?.filePath ?? graph.anchors[targetNode?.id ?? '']?.filePath;
                const symbol = edge.label?.match(/^([^(\s]+)\s*\(/)?.[1];
                if (targetFp && symbol) {
                    if (!messageFnsByFile.has(targetFp)) messageFnsByFile.set(targetFp, new Set());
                    messageFnsByFile.get(targetFp)!.add(symbol);
                }
            }
        }

        // Upgrade participant nodes.
        // A participant is marked 'modified' when:
        //   1. The sequence's entry handler (derived from graphId) lives in
        //      this file and its flow graph has modified nodes. Required for
        //      handlers whose body has no internal call-chain — Python FastAPI
        //      decorator routes and Go Gin handlers commonly fall here.
        //      Without this, a body-only edit on `read_item` / `ArticleCreate`
        //      marks L4 modified but every L3 participant stays unchanged
        //      because no message edge points back at the entry root.
        //      (Issue 529 — Cascade L3 modified-node fails for py-fastapi + go-gin (framework-specific))
        //   2. A message-specific function in its file changed (flow graph check), OR
        //   3. A structural element (import, variable, class) in its file changed, OR
        //   4. NOT when an unrelated function (not a message in this sequence) changed

        // Pre-compute: does the sequence's own entry handler have a modified flow?
        // graphId shape is `sequence:<filePath>:<handler>`. Extract once;
        // reuse for every participant check below.
        let entryHandlerModified = false;
        let entryFilePath: string | undefined;
        const seqIdM = /^sequence:(.+):([^:]+)$/.exec(graphId);
        if (seqIdM) {
            entryFilePath = seqIdM[1];
            const entryHandler = seqIdM[2];
            const entryFlow = diffedGraphs[`flow:${entryFilePath}:${entryHandler}`];
            if (entryFlow?.nodes.some(hasChanges)) entryHandlerModified = true;
        }

        for (const node of graph.nodes) {
            if (node.type !== 'participant' || node.diff !== 'unchanged') continue;
            if (node.label === 'API Client' || node.subtitle === '«actor»') continue;
            const filePath = node.anchor?.filePath ?? graph.anchors[node.id]?.filePath;
            if (!filePath) continue;
            // A fallback-anchored participant (external service/import whose own
            // file couldn't be resolved) borrowed the handler's filePath. The
            // file-based checks below would then mis-attribute the handler's
            // changed flow/structure to it — the prisma.user / Jsonwebtoken
            // over-marking. It can still be marked via a changed message edge to
            // it; it just doesn't "own" this file's changes.
            if ((node.anchor as any)?.fallback) continue;

            // Check 1: entry-handler modified for this participant's file.
            if (entryHandlerModified && filePath === entryFilePath) {
                node.diff = 'modified';
                touched = true;
                continue;
            }

            // Check 2: message-specific function changes (via flow graphs)
            const messageFns = messageFnsByFile.get(filePath);
            if (messageFns) {
                for (const fnName of messageFns) {
                    const flowGraph = findGraphByPath(diffedGraphs, 'flow', filePath, `:${fnName}`);
                    if (flowGraph?.nodes.some(hasChanges)) {
                        node.diff = 'modified';
                        touched = true;
                        break;
                    }
                }
                if (node.diff !== 'unchanged') continue;
            }

            // Check 2: structural changes — imports, variables, classes (not functions)
            // These affect the module's behavior even if no message-function body changed
            const fileGraph = findGraphByPath(diffedGraphs, 'file', filePath, '');
            if (fileGraph?.nodes.some(n => hasChanges(n) && n.type !== 'function' && n.type !== 'section' && n.type !== 'file')) {
                node.diff = 'modified';
                touched = true;
            }
        }

        // Upgrade message edges whose backing function or structural file elements changed
        for (const edge of graph.edges) {
            if (edge.edgeType !== 'message' || edge.diff !== 'unchanged') continue;

            // #375: return edges anchor back to the *caller* function and would
            // otherwise re-fire the flow-graph check below — every return edge
            // from a modified function would be marked `modified` purely
            // because the function body grew, even when the returned value
            // expression is byte-identical. The forward "call into" edge that
            // points at the same function already carries the correct
            // `modified` annotation; the return arrow is a visual cue, not a
            // separate diff target. Leave it `unchanged`.
            if ((edge.meta as { isReturn?: boolean } | undefined)?.isReturn) continue;
            const anchor = graph.anchors[edge.id];

            // Fallback for JS-path message edges that carry no anchor:
            // infer target file from the target participant node, function name from edge label.
            if (!anchor?.filePath) {
                const targetNode = graph.nodes.find(n => n.id === edge.target);
                const targetFilePath = targetNode?.anchor?.filePath
                    ?? graph.anchors[targetNode?.id ?? '']?.filePath;
                const graphFilePath = (graph.meta as any)?.filePath;
                if (!targetFilePath || targetFilePath === graphFilePath) continue;

                const symbol = edge.label?.match(/^([^(\s]+)\s*\(/)?.[1];
                if (symbol) {
                    const flowGraph = diffedGraphs[`flow:${targetFilePath}:${symbol}`];
                    if (flowGraph?.nodes.some(hasChanges)) {
                        edge.diff = 'modified';
                        touched = true;
                    }
                }
                continue;
            }

            // Check the specific function's flow graph
            if (anchor.symbol) {
                const flowGraph = diffedGraphs[`flow:${anchor.filePath}:${anchor.symbol}`];
                if (flowGraph?.nodes.some(hasChanges)) {
                    edge.diff = 'modified';
                    touched = true;
                    continue;
                }
            }
            // Fallback: check for structural (non-function) file changes
            const fileGraph = diffedGraphs[`file:${anchor.filePath}`];
            if (fileGraph?.nodes.some(n => hasChanges(n) && n.type !== 'function' && n.type !== 'section' && n.type !== 'file')) {
                edge.diff = 'modified';
                touched = true;
            }
        }

        // #385: write the mutated graph back via proxy assignment so the
        // LazyGraphMap stores it in `dirty` (never evicted). Otherwise the
        // LRU may evict the cached graph and the next access re-loads from
        // SQLite, returning the pre-mutation state — silently undoing the
        // cascade. Same write-back pattern applied at the L2a feature pass
        // and the L1 microservice pass below.
        if (touched) diffedGraphs[graphId] = graph;

        // Bug 6 (per user): do NOT blanket-propagate participant.diff onto
        // every message edge. A participant being `modified` only means
        // *some* function in that file changed; it does not mean every call
        // INTO or OUT OF that participant is affected. Only the edges whose
        // anchored function actually changed (handled by the anchor-based
        // pass above) should be marked modified — keeping `prisma.user.find
        // Unique` / `generateToken` / etc. correctly `unchanged` when the
        // edit was scoped to a different function in the same file.
    }
}

/**
 * Post-process file graphs: update section nodes' meta.items diff status to match
 * the actual entity node diffs computed by diffGraphs().
 *
 * In git diff mode, both snapshots are built independently (no baseline provided
 * to buildFileGraphFromAnalysis), so all meta.items start with diff:'unchanged'.
 * diffGraphs() correctly annotates structural changes (added/deleted) but misses
 * body-only changes (same name/signature, different implementation). This pass:
 *  1. Detects body-only modifications by comparing bodyText in the file records
 *  2. Syncs meta.items diff from entity nodes so ClassBlockNode shows correct colors
 */
export function upgradeFileDiffAnnotations(
    diffedGraphs: Record<string, DiagramGraph>,
    baseSnapshot: Snapshot,
    headSnapshot: Snapshot,
): void {
    for (const graph of Object.values(diffedGraphs)) {
        if (graph.type !== 'file') continue;

        const relativePath = graph.graphId.replace(/^file:/, '');
        const baseFile = baseSnapshot.files[relativePath];
        const headFile = headSnapshot.files[relativePath];

        // Build bodyText maps (name → bodyText) for body-only change detection
        const baseBodyByName = new Map<string, string>();
        const headBodyByName = new Map<string, string>();
        for (const fn of baseFile?.symbols.functions ?? []) {
            baseBodyByName.set(fn.name, fn.bodyText ?? '');
        }
        for (const fn of headFile?.symbols.functions ?? []) {
            headBodyByName.set(fn.name, fn.bodyText ?? '');
        }

        // Build map: entity node id → diff status (includes deleted_ prefixed nodes)
        const nodeById = new Map<string, DiagramGraph['nodes'][number]>();
        for (const node of graph.nodes) {
            nodeById.set(node.id, node);

            // Upgrade 'unchanged' function/class nodes whose body actually changed
            if (node.diff === 'unchanged' && (node.type === 'function' || node.type === 'class')) {
                const baseTxt = baseBodyByName.get(node.label);
                const headTxt = headBodyByName.get(node.label);
                if (baseTxt !== undefined && headTxt !== undefined && baseTxt !== headTxt) {
                    node.diff = 'modified';
                }
            }
        }

        // Build section → entity node IDs using 'contains' edges (includes hidden)
        const sectionToEntityIds = new Map<string, string[]>();
        for (const edge of graph.edges) {
            if (edge.edgeType !== 'contains') continue;
            const src = nodeById.get(edge.source);
            const tgt = nodeById.get(edge.target);
            if (src?.type !== 'section') continue;
            if (!tgt || tgt.type === 'section' || tgt.type === 'file') continue;
            if (!sectionToEntityIds.has(edge.source)) sectionToEntityIds.set(edge.source, []);
            sectionToEntityIds.get(edge.source)!.push(edge.target);
        }

        // Update each section node's diff (and meta.items if present).
        // Issue #401-followup: the JS `buildFileGraph` path emits sections
        // WITHOUT `meta.items`. Previously we skipped them entirely, so the
        // Functions/Imports/Variables section diff for JS/TS commit-diff
        // graphs stayed stale ('unchanged' despite a modified function).
        // Fall back to deriving the diff from `contains`-edge children when
        // items is absent.
        for (const node of graph.nodes) {
            if (node.type !== 'section') continue;

            const entityIds = sectionToEntityIds.get(node.id) ?? [];
            const items = Array.isArray(node.meta?.items) ? (node.meta!.items as any[]) : null;

            // Map entity IDs to their post-upgrade diff status.
            const entityDiffById = new Map<string, string>();
            const deletedItemsToAdd: any[] = [];
            for (const entityId of entityIds) {
                const entityNode = nodeById.get(entityId);
                if (!entityNode) continue;
                if (entityNode.diff === 'deleted') {
                    deletedItemsToAdd.push({
                        id: entityId,
                        type: entityNode.type,
                        label: entityNode.label.replace(/ \(deleted\)$/, ''),
                        subtitle: entityNode.subtitle,
                        diff: 'deleted',
                        anchor: entityNode.anchor,
                    });
                } else {
                    entityDiffById.set(entityId, entityNode.diff || 'unchanged');
                }
            }

            // If meta.items is present (tree-sitter path), sync it to the
            // current entity diffs and add deleted-ghost items.
            if (items) {
                for (const item of items) {
                    const diff = entityDiffById.get(item.id);
                    if (diff !== undefined) item.diff = diff;
                }
                const existingIds = new Set(items.map((i: any) => i.id));
                for (const del of deletedItemsToAdd) {
                    if (!existingIds.has(del.id)) items.push(del);
                }
            }

            // Compute the section's overall diff from EITHER items (when
            // present) or directly from the entity children via contains
            // edges. Both paths converge on the same per-entity diff list.
            const diffs: string[] = items
                ? items.map((i: any) => i.diff || 'unchanged')
                : [
                    ...Array.from(entityDiffById.values()),
                    ...deletedItemsToAdd.map(d => d.diff),
                ];
            const hasAdded = diffs.some(d => d === 'added');
            const hasDeleted = diffs.some(d => d === 'deleted');
            const hasModified = diffs.some(d => d === 'modified');
            if (hasAdded && hasDeleted) node.diff = 'modified';
            else if (hasDeleted) node.diff = 'deleted';
            else if (hasAdded) node.diff = 'added';
            else if (hasModified) node.diff = 'modified';
            else node.diff = 'unchanged';
        }

        // Propagate to the file root node. Without this, a body-only edit
        // marks the function and Functions section modified but the L4 file
        // root stays `unchanged` (Issue #401-followup). Only override when
        // the existing diff is `unchanged` — preserve legitimate
        // file-level `added` / `deleted` markers from whole-file changes.
        const fileRoot = graph.nodes.find(n => n.type === 'file');
        if (fileRoot && (fileRoot.diff ?? 'unchanged') === 'unchanged') {
            const anyEntityChanged = graph.nodes.some(n =>
                n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
            );
            if (anyEntityChanged) fileRoot.diff = 'modified';
        }
    }
}

/**
 * Post-process feature and microservice graphs using cascade propagation:
 *
 *   L2a cluster ← L2b API list changes (cascade from L3)
 *                + structural file changes (imports/variables/classes from L4)
 *   L1 service  ← L2a cluster changes (cascade from L2a)
 *
 * Must be called AFTER upgradeSequenceDiffAnnotations() and buildApiListGraphsForSnapshots()
 * so that L3 and L2b diff annotations are already in place.
 */
export function upgradeServiceClusterDiffAnnotations(
    diffedGraphs: Record<string, DiagramGraph>,
): string[] {
    // L1-C2 (2026-06-07): track every graphId we mutate so the caller can
    // include them in its WS broadcast / refresh ids. Before this, the LLM-
    // naming `.then()` callback in syncOrchestrator mutated
    // `microservice:workspace` in place but only broadcast feature + api-list
    // ids, leaving the user with a stale `~ modified` chip after revert.
    const touchedGraphIds = new Set<string>();
    const hasChanges = (n: { diff?: string }) => n.diff === 'modified' || n.diff === 'added' || n.diff === 'deleted';

    // Pre-compute: files with ANY content change at the file level (functions,
    // imports, variables, classes — everything except the container `section` /
    // `file` grouping nodes). These propagate to L2a/L1 directly.
    //
    // #929 — function-node changes are now INCLUDED. Previously they were excluded
    // (`n.type !== 'function'`) so a function-internal body edit only reached L1/L2a
    // when it touched an API chain. Per product decision (2026-06-26), editing a
    // service's code — even a private helper — should mark that service "modified"
    // at L1/L2a (git-status intuition: "this service has uncommitted changes"). The
    // granular change is still shown at L4/L5; this just also surfaces it on the
    // system canvas.
    const filesWithChanges = new Set<string>();
    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        if (graph.type !== 'file') continue;
        if (graph.nodes.some(n => hasChanges(n) && n.type !== 'section' && n.type !== 'file')) {
            filesWithChanges.add(graphId.replace(/^file:/, ''));
        }
    }

    // Pre-compute: clusters with changed APIs in their L2b API list
    const clustersWithApiChanges = new Set<string>();
    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        if (!isGraphIdOfType(graphId, 'api-list')) continue;
        const apis = (graph.meta as any)?.apis as any[] | undefined;
        if (apis?.some((a: any) => a.diff && a.diff !== 'unchanged')) {
            const clusterId = (graph.meta as any)?.clusterId as string | undefined;
            if (clusterId) clustersWithApiChanges.add(clusterId);
        }
    }

    // L2a: upgrade cluster nodes based on L2b API changes + structural file changes
    const modifiedClusterServiceIds = new Set<string>();
    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        if (graph.type !== 'feature') continue;
        let touched = false;
        // #385: reset modified→unchanged FIRST (mirror sequence + microservice
        // reset pattern). Without this, an undo doesn't downgrade cluster
        // nodes that were marked modified by a prior cascade and now have
        // no downstream changes — the L2a Feature Areas view stays orange
        // even though L2b/L3/L4/L5 all reset correctly.
        for (const node of graph.nodes) {
            if (node.type !== 'cluster') continue;
            if (node.diff === 'modified') { node.diff = 'unchanged'; touched = true; }
        }
        for (const node of graph.nodes) {
            const svcId = (node.meta as any)?.serviceId as string | undefined;
            if (node.diff !== 'unchanged') {
                // Already marked (e.g., added/deleted cluster) — track its service
                if (hasChanges(node) && svcId) modifiedClusterServiceIds.add(svcId);
                continue;
            }
            const clusterId = node.clusterMembership ?? (node.meta as any)?.clusterId as string | undefined;

            // Check 1: cascade from L2b — cluster's API list has changed APIs
            if (clusterId && clustersWithApiChanges.has(clusterId)) {
                node.diff = 'modified';
                touched = true;
                if (svcId) modifiedClusterServiceIds.add(svcId);
                continue;
            }

            // Check 2: ANY content change (functions/imports/variables/classes) in
            // member files (#929 — now includes function-body edits).
            const clusterFiles = node.meta?.files as string[] | undefined;
            if (clusterFiles?.some(f => filesWithChanges.has(f))) {
                node.diff = 'modified';
                touched = true;
                if (svcId) modifiedClusterServiceIds.add(svcId);
            }
        }
        // #385: write back so LRU eviction doesn't discard the mutations.
        if (touched) {
            diffedGraphs[graphId] = graph;
            touchedGraphIds.add(graphId);
        }
    }

    // L1: upgrade service nodes based on L2a cluster changes (cascade).
    // #385: reset modified→unchanged FIRST, then re-derive. Write back via
    // proxy assignment so the LazyGraphMap moves the mutated graph into
    // `dirty` (never evicted by the LRU). Without this, undoing an edit
    // leaves the main service node stuck as `modified` even though every
    // downstream layer correctly returned to `unchanged`.
    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        if (graph.type !== 'microservice') continue;
        let touched = false;
        for (const node of graph.nodes) {
            if (node.meta?.external) continue;
            if (node.diff === 'modified') { node.diff = 'unchanged'; touched = true; }
        }
        for (const node of graph.nodes) {
            if (node.diff !== 'unchanged' || node.meta?.external) continue;
            const svcId = node.serviceId ?? (node.meta as any)?.serviceId as string | undefined;
            if (svcId && modifiedClusterServiceIds.has(svcId)) {
                node.diff = 'modified';
                touched = true;
            }
        }
        if (touched) {
            diffedGraphs[graphId] = graph;
            touchedGraphIds.add(graphId);
        }
    }

    return [...touchedGraphIds];
}

export interface CommitDiffResult {
    diffedGraphs: Record<string, DiagramGraph>;
    apiIndex: Record<string, ApiRecord>;
    headSnapshot: Snapshot;
    baseSnapshot: Snapshot;
}

/**
 * Build api-list DiagramGraph objects for every cluster present in headSnapshot,
 * diffing APIs against baseSnapshot.
 *
 * This mirrors `buildApiListGraph` in extension.ts but operates on two in-memory
 * snapshots rather than the live snapshotStore — used by the git diff feature so
 * that clicking a cluster node in a diffed feature diagram correctly navigates to
 * an `api-list:<clusterId>` panel instead of silently doing nothing.
 *
 * The function is intentionally self-contained so it can be unit-tested without
 * VS Code imports.
 */
export function buildApiListGraphsForSnapshots(
    headSnapshot: Snapshot,
    baseSnapshot: Snapshot,
    diffedGraphs: Record<string, DiagramGraph>,
): Record<string, DiagramGraph> {
    const result: Record<string, DiagramGraph> = {};

    const headClusters = headSnapshot.clusters ?? {};

    for (const cluster of Object.values(headClusters)) {
        const graphId = `api-list:${cluster.id}`;
        const clusterFileSet = new Set(cluster.files);
        const subsystemMap = new Map<string, { label: string; kind: string; filePath?: string }>();

        // Compute per-API diff status: compare headSnapshot apiIndex vs baseSnapshot apiIndex,
        // and check whether the corresponding sequence graph (after upgrade pass) has any
        // added/deleted/modified nodes or edges.
        //
        // #496: defensive filter (parallel to apiListGraphBuilder.ts). Drop
        // any api whose `filePath` lives outside this cluster's `files` set
        // before computing diffs. Prevents the live failure where editing
        // `getCurrentUser` in auth caused article routes to appear in the
        // auth L2b panel during timeline replay.
        const scopedApisInCluster = (cluster.apisInCluster ?? []).filter((api) =>
            !api.filePath || clusterFileSet.has(api.filePath),
        );
        const apisWithDiff: ApiRecord[] = scopedApisInCluster.map((api) => {
            const seqGraph = diffedGraphs[`sequence:${api.filePath}:${api.handlerName}`]
                ?? headSnapshot.graphs[`sequence:${api.filePath}:${api.handlerName}`];

            // Collect subsystem participants from this API's sequence graph
            if (seqGraph) {
                for (const node of seqGraph.nodes) {
                    if (node.type !== 'participant') continue;
                    if (node.label === 'API Client') continue;
                    const anchor = node.anchor ?? seqGraph.anchors[node.id];
                    if (anchor?.filePath && clusterFileSet.has(anchor.filePath)) continue;
                    const kind = (node.subtitle ?? '«module»').replace(/«|»/g, '').trim();
                    subsystemMap.set(node.label, { label: node.label, kind, filePath: anchor?.filePath });
                }
            }

            // Determine diff status for this API entry
            let diff: 'added' | 'modified' | 'unchanged' | 'deleted' = 'unchanged';
            if (!baseSnapshot.apiIndex[api.apiId]) {
                diff = 'added';
            } else if (seqGraph) {
                const hasChanges =
                    seqGraph.nodes.some(n => n.diff === 'modified' || n.diff === 'added' || n.diff === 'deleted') ||
                    seqGraph.edges.some(e => e.diff === 'modified' || e.diff === 'added' || e.diff === 'deleted');
                if (hasChanges) diff = 'modified';
            }

            return { ...api, diff };
        });

        // Surface APIs that existed in baseSnapshot for this cluster's files but are now gone
        for (const [apiId, api] of Object.entries(baseSnapshot.apiIndex)) {
            if (api.filePath && clusterFileSet.has(api.filePath) && !headSnapshot.apiIndex[apiId]) {
                apisWithDiff.push({ ...api, diff: 'deleted' as const });
            }
        }

        result[graphId] = {
            graphId,
            type: 'api-list',
            nodes: [],
            edges: [],
            anchors: {},
            meta: {
                clusterId: cluster.id,
                clusterLabel: cluster.label,
                serviceId: cluster.serviceId,
                apis: apisWithDiff,
                files: cluster.files,
                entryPoints: cluster.entryPoints,
                subsystems: [...subsystemMap.values()],
            },
        };
    }

    // #229: surface clusters that existed in the base but are entirely gone
    // in head as deleted api-list graphs, so users see the removed APIs in
    // the commit-diff view instead of silently losing them.
    const baseClusters = baseSnapshot.clusters ?? {};
    for (const cluster of Object.values(baseClusters)) {
        if (headClusters[cluster.id]) continue;
        const graphId = `api-list:${cluster.id}`;
        if (result[graphId]) continue;
        const clusterFileSet = new Set(cluster.files);
        const apisWithDiff: any[] = [];
        for (const [apiId, api] of Object.entries(baseSnapshot.apiIndex)) {
            if (api.filePath && clusterFileSet.has(api.filePath)) {
                apisWithDiff.push({ ...api, diff: 'deleted' as const });
            }
        }
        if (apisWithDiff.length === 0) continue;
        result[graphId] = {
            graphId,
            type: 'api-list',
            nodes: [],
            edges: [],
            anchors: {},
            meta: {
                clusterId: cluster.id,
                clusterName: cluster.label,
                apis: apisWithDiff,
                diff: 'deleted',
                subsystems: [],
            },
        };
    }

    return result;
}

/**
 * Build two snapshots (one per commit) and diff every graph between them.
 * Returns the fully annotated diff graphs and the head commit's API index
 * (used for navigation when the user drills into diagrams in git diff mode).
 */
export async function buildCommitDiffGraphs(
    workspaceRoot: string,
    baseHash: string,
    headHash: string,
    log: (msg: string) => void = () => {},
): Promise<CommitDiffResult> {
    log(`[CommitDiffer] Fetching file lists for ${baseHash.slice(0, 7)}..${headHash.slice(0, 7)}`);

    const [baseFiles, headFiles, changedFiles] = await Promise.all([
        Promise.resolve(getFileListAtCommit(workspaceRoot, baseHash)),
        Promise.resolve(getFileListAtCommit(workspaceRoot, headHash)),
        Promise.resolve(getChangedFilesBetweenCommits(workspaceRoot, baseHash, headHash)),
    ]);

    const changedSet = new Set(changedFiles);
    const baseSet = new Set(baseFiles);
    const headSet = new Set(headFiles);
    const allFiles = new Set([...baseFiles, ...headFiles]);

    log(`[CommitDiffer] ${baseFiles.length} base files, ${headFiles.length} head files, ${changedFiles.length} changed`);

    // Guard: if base has files but head has none AND no changed files were reported,
    // the HEAD commit is unknown locally (git ls-tree and git diff both silently
    // return empty for unrecognised hashes). This happens when diffing a PR from
    // an unfetched fork branch. Fail fast with a clear message rather than silently
    // producing an all-deleted diff.
    // Note: changedFiles.length > 0 means git diff succeeded (HEAD is reachable) so
    // we don't fire here when a valid PR legitimately deletes all files in a tiny repo.
    if (headFiles.length === 0 && baseFiles.length > 0 && changedFiles.length === 0) {
        throw new Error(
            `HEAD commit ${headHash.slice(0, 7)} not found locally. ` +
            `Run "git fetch" to download the PR branch before diffing.`
        );
    }

    // Fetch file contents, minimising git show calls:
    // - unchanged files: only fetch from head (reuse for base)
    // - changed/deleted/added files: fetch from whichever side they exist on
    const baseInputs: FileInput[] = [];
    const headInputs: FileInput[] = [];

    for (const f of allFiles) {
        const inBase = baseSet.has(f);
        const inHead = headSet.has(f);
        const isChanged = changedSet.has(f);

        if (inHead && !isChanged) {
            // Unchanged: fetch once, use for both
            const content = getFileContentAtCommit(workspaceRoot, headHash, f);
            if (content !== null) {
                baseInputs.push({ relativePath: f, content });
                headInputs.push({ relativePath: f, content });
            }
        } else {
            if (inBase) {
                const content = getFileContentAtCommit(workspaceRoot, baseHash, f);
                if (content !== null) baseInputs.push({ relativePath: f, content });
            }
            if (inHead) {
                const content = getFileContentAtCommit(workspaceRoot, headHash, f);
                if (content !== null) headInputs.push({ relativePath: f, content });
            }
        }
    }

    log(`[CommitDiffer] Building base snapshot (${baseInputs.length} files)…`);
    const baseSnapshot = await buildSnapshotFromFiles(baseInputs, workspaceRoot, log);

    log(`[CommitDiffer] Building head snapshot (${headInputs.length} files)…`);
    const headSnapshot = await buildSnapshotFromFiles(headInputs, workspaceRoot, log);

    // Diff every graph in the union of both snapshots
    const allGraphIds = new Set([
        ...Object.keys(baseSnapshot.graphs),
        ...Object.keys(headSnapshot.graphs),
    ]);

    log(`[CommitDiffer] Diffing ${allGraphIds.size} graphs…`);

    const diffedGraphs: Record<string, DiagramGraph> = {};

    for (const graphId of allGraphIds) {
        const baseGraph = baseSnapshot.graphs[graphId];
        const headGraph = headSnapshot.graphs[graphId];

        if (baseGraph && headGraph) {
            diffedGraphs[graphId] = diffGraphs(baseGraph, headGraph).graph;
        } else if (headGraph) {
            // Entirely new graph — mark all nodes/edges as added
            diffedGraphs[graphId] = {
                ...headGraph,
                nodes: headGraph.nodes.map(n => ({ ...n, diff: 'added' as const })),
                edges: headGraph.edges.map(e => ({ ...e, diff: 'added' as const })),
            };
        } else if (baseGraph) {
            // Graph removed — mark all nodes/edges as deleted
            diffedGraphs[graphId] = {
                ...baseGraph,
                nodes: baseGraph.nodes.map(n => ({ ...n, diff: 'deleted' as const })),
                edges: baseGraph.edges.map(e => ({ ...e, diff: 'deleted' as const })),
            };
        }
    }

    // Upgrade file graph diff annotations: sync section node meta.items diff status
    // with the actual entity node diffs computed by diffGraphs(), and detect body-only
    // modifications using the file symbol records from both snapshots.
    upgradeFileDiffAnnotations(diffedGraphs, baseSnapshot, headSnapshot);

    // Upgrade sequence graph diff annotations: participant nodes and message edges
    // that are structurally unchanged but whose backing file/function was modified
    // get upgraded from 'unchanged' to 'modified'. Must run before api-list building
    // so that the hasChanges check in buildApiListGraphsForSnapshots sees the
    // propagated annotations.
    upgradeSequenceDiffAnnotations(diffedGraphs);

    // Build api-list graphs (L2b) — must run BEFORE L2a/L1 upgrade since cascade
    // propagation flows L3 → L2b → L2a → L1.
    log(`[CommitDiffer] Building api-list graphs for ${Object.keys(headSnapshot.clusters ?? {}).length} clusters…`);
    const apiListGraphs = buildApiListGraphsForSnapshots(headSnapshot, baseSnapshot, diffedGraphs);
    for (const [graphId, graph] of Object.entries(apiListGraphs)) {
        diffedGraphs[graphId] = graph;
    }

    // Upgrade L2a/L1 via cascade: L2a ← L2b API changes + structural file changes,
    // L1 ← L2a cluster changes.
    upgradeServiceClusterDiffAnnotations(diffedGraphs);

    log(`[CommitDiffer] Done — ${Object.keys(diffedGraphs).length} diffed graphs`);

    return {
        diffedGraphs,
        apiIndex: headSnapshot.apiIndex,
        headSnapshot,
        baseSnapshot,
    };
}
