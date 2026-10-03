import { collectTopLevelEntities, type FileAnalysis } from '../parser/symbolExtractor';
import type { FileAnalysis as TSFileAnalysis } from '../parser/treeSitterExtractor';
import type { DiagramGraph, GraphNode, GraphEdge, Anchor, DiffStatus, FileRecord } from './graphTypes';

let idCounter = 0;
function nextId(prefix: string = 'node'): string {
    return `${prefix}_${++idCounter}`;
}

function resetIds(): void {
    idCounter = 0;
}

interface EntityDiff {
    diffByKey: Map<string, { deleted?: string; added?: string }>;
    bodyOnlyKeys: Set<string>;
    deletedOnly: any[];
    newAnalysis: FileAnalysis;
}

function buildEntityDiff(oldCode: string, newCode: string, fileName: string): EntityDiff {
    // Bug 7 follow-up: secret redaction may have corrupted the baseline
    // content (e.g. `password: ["can't be blank"]` → `password= [REDACTED]`),
    // which can no longer parse. Don't let a broken baseline kill the
    // entire rebuild — fall back to a "no diff baseline" so the new code
    // still produces a usable file graph + inline annotations are simply
    // skipped for this run.
    let oldA: FileAnalysis;
    try {
        oldA = collectTopLevelEntities(oldCode, fileName);
    } catch {
        return {
            diffByKey: new Map(),
            bodyOnlyKeys: new Set(),
            deletedOnly: [],
            newAnalysis: collectTopLevelEntities(newCode, fileName),
        };
    }
    const newA = collectTopLevelEntities(newCode, fileName);

    const oldMap = new Map(oldA.entities.map((e) => [e.key, e]));
    const newMap = new Map(newA.entities.map((e) => [e.key, e]));

    const diffByKey = new Map<string, { deleted?: string; added?: string }>();
    const bodyOnlyKeys = new Set<string>();
    const deletedOnly: any[] = [];

    for (const [key, oldE] of oldMap.entries()) {
        const newE = newMap.get(key);
        if (!newE) {
            deletedOnly.push(oldE);
            continue;
        }
        const sigChanged = oldE.signature !== newE.signature;
        const bodyChanged = oldE.bodyText !== newE.bodyText;
        if (sigChanged || bodyChanged) {
            if (sigChanged) {
                diffByKey.set(key, {
                    deleted: oldE.locText || oldE.signature,
                    added: newE.locText || newE.signature,
                });
            } else {
                diffByKey.set(key, {});
                bodyOnlyKeys.add(key);
            }
        }
    }

    for (const [key, newE] of newMap.entries()) {
        if (!oldMap.has(key)) {
            diffByKey.set(key, {
                added: newE.locText || newE.bodyText || newE.signature,
            });
        }
    }

    return { newAnalysis: newA, diffByKey, bodyOnlyKeys, deletedOnly };
}

function getDiffStatus(key: string, diffByKey: Map<string, { deleted?: string; added?: string }>): DiffStatus {
    const d = diffByKey.get(key);
    if (!d) return 'unchanged';
    if (d.added && d.deleted) return 'modified';
    if (d.added) return 'added';
    if (!d.deleted && !d.added) return 'modified'; // body-only change
    return 'deleted';
}

/**
 * Re-evaluate function-node diff status on an already-built file graph by
 * comparing against the AUTHORITATIVE un-redacted bodyText/signature stored
 * in `baselineFile.symbols.functions` — those were captured at scan time
 * against the original un-redacted source and survive every redaction pass.
 *
 * Why this exists: `buildFileGraph` calls `buildEntityDiff` which re-parses
 * the (possibly redacted) baseline content. When the baseline was redacted
 * at persistence time (e.g. `password: hashedPassword` → `password:
 * "[REDACTED]"`), the parsed bodyText differs from the fresh working
 * bodyText for every function containing a protected property — even when
 * the function body was never edited. This pass downgrades those false
 * positives and upgrades any genuine change that `buildFileGraph` missed.
 *
 * Mutates `fileGraph` in place. Also refreshes the file root + section
 * node diff annotations and the section label "(N changed + M)" suffix so
 * the L4 header summary stays consistent with the corrected entity diffs.
 *
 * Used by:
 *   - `rebuildFile` (file-save cascade path)
 *   - `buildFileGraphForPath` (L3→L4 navigation path)
 */
export function recomputeFileGraphDiffFromAuthoritativeSymbols(
    fileGraph: DiagramGraph,
    baselineFile: FileRecord | undefined,
    workingAnalysis: FileAnalysis,
): void {
    if (!baselineFile?.symbols?.functions) return;

    // Issue 764 (2026-06-06) — the original recompute only walked
    // `type === 'function'` nodes, leaving variable / import / class
    // nodes stuck at `modified` after a revert. This pass now covers
    // every entity type the L4 graph builder emits so an unchanged-by-
    // content entity always downgrades, regardless of node type.
    const baselineFnByKey = new Map(
        baselineFile.symbols.functions.map(f => [f.stableKey, f] as const),
    );
    const baselineVarByKey = new Map(
        (baselineFile.symbols.variables ?? []).map(v => [v.stableKey, v] as const),
    );
    const baselineImportByKey = new Map(
        (baselineFile.symbols.imports ?? []).map(i => [i.stableKey, i] as const),
    );
    const workingFnByName = new Map(
        workingAnalysis.entities
            .filter(e => e.kind === 'function' || e.kind === 'class')
            .map(e => [e.name, e] as const),
    );
    const workingVarByName = new Map(
        workingAnalysis.entities
            .filter(e => e.kind === 'variable')
            .map(e => [e.name, e] as const),
    );
    // Imports use `source` (the `from '...'` path) as the natural key in
    // node.label; `entity.name` may be a synthesised local. Match both
    // shapes so the lookup works regardless of which the node was
    // labelled with.
    const workingImportByName = new Map(
        workingAnalysis.entities
            .filter(e => e.kind === 'import')
            .flatMap(e => {
                const out: Array<readonly [string, typeof e]> = [[e.name, e] as const];
                const src = (e as any).source;
                if (typeof src === 'string' && src && src !== e.name) {
                    out.push([src, e] as const);
                }
                return out;
            }),
    );

    for (const node of fileGraph.nodes) {
        if (node.type === 'function' || node.type === 'class') {
            const workingFn = workingFnByName.get(node.label ?? '');
            if (!workingFn) continue;
            const baselineFn = baselineFnByKey.get(workingFn.key);
            if (!baselineFn) {
                if (node.diff === 'unchanged') node.diff = 'added';
                continue;
            }
            const sigSame = baselineFn.signature === workingFn.signature;
            const bodySame = baselineFn.bodyText === workingFn.bodyText;
            if (sigSame && bodySame) {
                if (node.diff === 'modified' || node.diff === 'added') {
                    node.diff = 'unchanged';
                    (node as any).diffDetail = undefined;
                }
            } else if (node.diff === 'unchanged') {
                node.diff = 'modified';
            }
        } else if (node.type === 'variable') {
            const workingVar = workingVarByName.get(node.label ?? '');
            if (!workingVar) continue;
            const baselineVar = baselineVarByKey.get(workingVar.key);
            if (!baselineVar) {
                if (node.diff === 'unchanged') node.diff = 'added';
                continue;
            }
            const sigSame = baselineVar.signature === workingVar.signature;
            const bodySame = baselineVar.bodyText === workingVar.bodyText;
            if (sigSame && bodySame) {
                if (node.diff === 'modified' || node.diff === 'added') {
                    node.diff = 'unchanged';
                    (node as any).diffDetail = undefined;
                }
            } else if (node.diff === 'unchanged') {
                node.diff = 'modified';
            }
        } else if (node.type === 'import') {
            const workingImport = workingImportByName.get(node.label ?? '');
            if (!workingImport) continue;
            const baselineImport = baselineImportByKey.get(workingImport.key);
            if (!baselineImport) {
                if (node.diff === 'unchanged') node.diff = 'added';
                continue;
            }
            // For imports the only thing that can change without becoming
            // a different entity is the specifier list (`{ foo }` →
            // `{ foo, bar }`). The stableKey already covers `source`, so
            // a key match is sufficient evidence of "same import";
            // downgrade any stale modified flag.
            if (node.diff === 'modified' || node.diff === 'added') {
                node.diff = 'unchanged';
                (node as any).diffDetail = undefined;
            }
        }
    }

    const fileRoot = fileGraph.nodes.find(n => n.type === 'file');
    const anyEntityChanged = fileGraph.nodes.some(n =>
        n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
    );
    if (fileRoot) fileRoot.diff = anyEntityChanged ? 'modified' : 'unchanged';

    const childrenBySectionId = new Map<string, string[]>();
    for (const edge of fileGraph.edges) {
        if (edge.edgeType !== 'contains') continue;
        const src = fileGraph.nodes.find(n => n.id === edge.source);
        if (src?.type !== 'section') continue;
        if (!childrenBySectionId.has(src.id)) childrenBySectionId.set(src.id, []);
        childrenBySectionId.get(src.id)!.push(edge.target);
    }

    for (const section of fileGraph.nodes.filter(n => n.type === 'section')) {
        const items = (section.meta as any)?.items as Array<{ id: string; diff?: string }> | undefined;
        if (items) {
            for (const item of items) {
                const matching = fileGraph.nodes.find(n => n.id === item.id);
                if (matching) item.diff = matching.diff;
            }
        }
        // The JS path emits `contains` edges (childNodes is non-empty).
        // The tree-sitter path emits BOTH `contains` edges AND populates
        // `meta.items` — but they mirror the same entity set. Counting both
        // would double the changedCount and inflate the label. Prefer
        // childNodes when present; fall back to items when the section has
        // no contains edges (legacy single-source paths).
        const childIds = childrenBySectionId.get(section.id) ?? [];
        const childNodes = childIds
            .map(id => fileGraph.nodes.find(n => n.id === id))
            .filter(Boolean) as Array<{ diff?: string }>;
        const useChildNodes = childNodes.length > 0;
        const changedCount = useChildNodes
            ? childNodes.filter(n => n.diff && n.diff !== 'unchanged').length
            : (items ?? []).filter(it => it.diff && it.diff !== 'unchanged').length;
        const totalCount = useChildNodes ? childNodes.length : (items ?? []).length;
        const unchangedCount = totalCount - changedCount;
        section.diff = changedCount > 0 ? 'modified' : 'unchanged';
        if (typeof section.label === 'string') {
            const stripped = section.label.replace(/\s*\(.*?\)\s*$/, '');
            // Issue #380: bare clean form when nothing changed.
            // Issue #395: explicit "N changed" form when everything changed
            // (informative for users — "(N)" alone could mean either "all
            // clean" or "all modified").
            if (changedCount === 0) {
                section.label = `${stripped} (${totalCount})`;
            } else if (unchangedCount > 0) {
                section.label = `${stripped} (${changedCount} changed + ${unchangedCount})`;
            } else {
                section.label = `${stripped} (${changedCount} changed)`;
            }
        }
        // #493: subtitle must reflect POST-recompute counts. The original
        // subtitle was built by `buildFileGraph` at edit time when 1 node was
        // genuinely 'modified'; the recompute loop above just flipped that
        // node back to 'unchanged' (revert) but the stale subtitle ("~1
        // modified · 2 unchanged") sticks. Rewrite to match the current
        // (post-recompute) child diff breakdown so post-revert working
        // matches the init baseline (which also emits "N unchanged").
        const childForSubtitle = useChildNodes ? childNodes : (items ?? []);
        const added = childForSubtitle.filter((n: any) => n.diff === 'added').length;
        const modified = childForSubtitle.filter((n: any) => n.diff === 'modified').length;
        const deleted = childForSubtitle.filter((n: any) => n.diff === 'deleted').length;
        const parts: string[] = [];
        if (added > 0) parts.push(`+${added} added`);
        if (modified > 0) parts.push(`~${modified} modified`);
        if (deleted > 0) parts.push(`-${deleted} deleted`);
        if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
        section.subtitle = parts.length > 0 ? parts.join(' · ') : undefined;
    }

    // Issue #423 (php-symfony residual): edges were marked at file-graph BUILD
    // time via `edgeDiffFromEndpoints(fromDiff, toDiff)`. The recompute loop
    // above resets node diffs (e.g., function body matches baseline → reset
    // to 'unchanged'), but the edges KEEP their old 'modified' diff. That
    // leaves the L4 file graph technically still "modified" even though every
    // entity node is now unchanged. Re-derive edge diffs from the (now-current)
    // endpoint nodes. Skip `added`/`deleted` edges (those are structural — set
    // by buildFileGraph when the edge's endpoint was added/deleted in baseline
    // vs working — and should not be downgraded by this recompute).
    const nodeById = new Map(fileGraph.nodes.map(n => [n.id, n]));
    for (const edge of fileGraph.edges) {
        if (edge.diff !== 'modified') continue;
        if (edge.edgeType === 'contains') continue; // tree-structural, stays unchanged
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        if (!src || !tgt) continue;
        const fromDiff = (src.diff ?? 'unchanged') as DiffStatus;
        const toDiff = (tgt.diff ?? 'unchanged') as DiffStatus;
        if (fromDiff === 'unchanged' && toDiff === 'unchanged') {
            edge.diff = 'unchanged';
        }
    }
}

/**
 * Compute most severe diff among a list of entity nodes.
 * Mixed added+deleted → 'modified' (both change types present at this level).
 */
function mostSevereDiff(nodes: GraphNode[]): DiffStatus {
    const hasAdded = nodes.some(n => n.diff === 'added');
    const hasDeleted = nodes.some(n => n.diff === 'deleted');
    const hasModified = nodes.some(n => n.diff === 'modified');
    if (hasAdded && hasDeleted) return 'modified'; // mixed → orange
    if (hasDeleted) return 'deleted';
    if (hasAdded) return 'added';
    if (hasModified) return 'modified';
    return 'unchanged';
}

/**
 * Compute edge diff from the diffs of its two endpoints.
 *   deleted endpoint → deleted edge (red)
 *   added source     → added edge (green — new function's edges are all new)
 *   modified/added target or modified source → modified edge (orange)
 *   otherwise        → unchanged
 */
function edgeDiffFromEndpoints(fromDiff: DiffStatus, toDiff: DiffStatus): DiffStatus {
    // Issue 202: Correct priority — deleted > added > modified > unchanged
    if (fromDiff === 'deleted' || toDiff === 'deleted') return 'deleted';
    if (fromDiff === 'added' || toDiff === 'added') return 'added';
    if (fromDiff === 'modified' || toDiff === 'modified') return 'modified';
    return 'unchanged';
}

/**
 * Build a section subtitle showing diff summary (diff mode only).
 * e.g. "+2 added · ~1 modified · -1 deleted · 3 unchanged"
 */
function buildDiffSummarySubtitle(
    changedNodes: GraphNode[],
    unchangedCount: number,
    inDiffMode: boolean,
): string | undefined {
    if (!inDiffMode) return undefined;
    const added = changedNodes.filter(n => n.diff === 'added').length;
    const deleted = changedNodes.filter(n => n.diff === 'deleted').length;
    const modified = changedNodes.filter(n => n.diff === 'modified').length;
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added} added`);
    if (modified > 0) parts.push(`~${modified} modified`);
    if (deleted > 0) parts.push(`-${deleted} deleted`);
    if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Build a UML-style file dependency diagram from parsed file analysis.
 *
 * Structure:
 *   file → section (Imports/Variables/Functions) → entity nodes
 *
 * In diff mode (oldCode provided):
 *   - Changed entities (added/modified/deleted) shown as individual nodes
 *   - Unchanged entities collapsed into a single summary node per section
 *   - Section subtitle shows "+N added · ~N modified · -N deleted · N unchanged"
 *   - calls/uses/depends edge diff derived from endpoint diffs
 */
export function buildFileGraph(
    code: string,
    filePath: string,
    oldCode?: string
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};
    const fileName = filePath.split('/').pop() || filePath;
    const inDiffMode = oldCode != null;

    let analysis: FileAnalysis;
    let diffByKey = new Map<string, { deleted?: string; added?: string }>();
    let bodyOnlyKeys = new Set<string>();
    let deletedOnly: any[] = [];

    if (inDiffMode) {
        const diff = buildEntityDiff(oldCode!, code, fileName);
        analysis = diff.newAnalysis;
        diffByKey = diff.diffByKey;
        bodyOnlyKeys = diff.bodyOnlyKeys;
        deletedOnly = diff.deletedOnly;
    } else {
        analysis = collectTopLevelEntities(code, fileName);
    }

    const fileNode: GraphNode = {
        id: nextId('file'),
        type: 'file',
        label: fileName,
        subtitle: '«file diagram» top-level dependencies',
        body: 'Imports / Variables / Functions',
        diff: 'unchanged',
        anchor: { filePath },
    };
    nodes.push(fileNode);
    anchors[fileNode.id] = fileNode.anchor!;

    const nodeIdByEntityKey = new Map<string, string>();

    // Bucket entities by kind
    const importEntities = analysis.entities.filter(e => e.kind === 'import');
    const variableEntities = analysis.entities.filter(e => e.kind === 'variable');
    const functionEntities = analysis.entities.filter(e => e.kind !== 'import' && e.kind !== 'variable');

    const deletedImports: any[] = [];
    const deletedVariables: any[] = [];
    const deletedFunctions: any[] = [];
    for (const e of deletedOnly) {
        if (e.kind === 'import') deletedImports.push(e);
        else if (e.kind === 'variable') deletedVariables.push(e);
        else deletedFunctions.push(e);
    }

    function buildBucketNodes(
        sectionLabel: string,
        liveEntities: typeof analysis.entities,
        deletedEntities: any[],
    ): void {
        if (liveEntities.length === 0 && deletedEntities.length === 0) return;

        // All entity nodes — shown individually so users can click/navigate to any of them
        const allEntityNodes: GraphNode[] = [];

        for (const e of liveEntities) {
            const nodeType = e.kind === 'import' ? 'import' : e.kind === 'variable' ? 'variable' : e.kind === 'class' ? 'class' : 'function';
            let subtitle = e.kind === 'import' ? '«import»' : e.kind === 'variable' ? '«variable»' : `«${e.kind}»`;
            // Issue 204: Show both extends and implements in class subtitles
            if (e.kind === 'class') {
                const ext = (e as any).extendsClass ? `extends ${(e as any).extendsClass}` : '';
                const impl = (e as any).implementsInterfaces?.length ? `implements ${(e as any).implementsInterfaces.join(', ')}` : '';
                const hier = [ext, impl].filter(Boolean).join(' ');
                if (hier) subtitle = `«class» ${hier}`;
            }
            const body = e.kind === 'function' ? e.signature : e.bodyText;
            const rawDiff = diffByKey.get(e.key);
            const diffStatus = getDiffStatus(e.key, diffByKey);
            const diffDetail = bodyOnlyKeys.has(e.key) ? undefined : rawDiff || undefined;

            const node: GraphNode = {
                id: nextId('node'),
                type: nodeType,
                label: e.name,
                subtitle,
                body,
                diff: diffStatus,
                diffDetail,
                anchor: { filePath, symbol: e.name },
            };

            nodes.push(node);
            allEntityNodes.push(node);
            nodeIdByEntityKey.set(e.key, node.id);
            anchors[node.id] = node.anchor!;
        }

        // Deleted ghost nodes always shown
        for (const e of deletedEntities) {
            const ghost: GraphNode = {
                id: nextId('ghost'),
                type: e.kind as any,
                label: `${e.name} (deleted)`,
                subtitle: `«${e.kind}»`,
                diff: 'deleted',
                diffDetail: { deleted: e.locText || e.bodyText || e.signature },
                anchor: { filePath, symbol: e.name },
            };
            nodes.push(ghost);
            allEntityNodes.push(ghost);
            anchors[ghost.id] = ghost.anchor!;
        }

        const total = liveEntities.length + deletedEntities.length;
        const unchangedCount = allEntityNodes.filter(n => n.diff === 'unchanged').length;
        // Issue 206: In diff mode, show changed count + collapsed unchanged summary
        const changedCount = total - unchangedCount;
        const displayCount = inDiffMode && unchangedCount > 0
            ? `${changedCount} changed` + (unchangedCount > 0 ? ` + ${unchangedCount}` : '')
            : `${total}`;
        // #493: JS init (inDiffMode=false) returns undefined subtitle, but
        // cascade rebuild produces a real subtitle. After
        // `recomputeFileGraphDiffFromAuthoritativeSymbols` rewrites node diffs
        // back to `unchanged` post-revert, the subtitle stays at its stale
        // edit-time value (e.g. "~1 modified · 2 unchanged"). Baseline init
        // then diverges from post-revert working forever. Mirror the non-JS
        // path's #448-C fix: when buildDiffSummarySubtitle returns nothing but
        // there ARE unchanged entities, emit "N unchanged" so init matches the
        // post-revert subtitle that recompute will later produce.
        let sectionSubtitle = buildDiffSummarySubtitle(allEntityNodes, unchangedCount, inDiffMode);
        if (!sectionSubtitle && unchangedCount > 0) {
            sectionSubtitle = `${unchangedCount} unchanged`;
        }
        const sectionNode: GraphNode = {
            id: nextId('section'),
            type: 'section',
            label: `${sectionLabel} (${displayCount})`,
            subtitle: sectionSubtitle,
            diff: mostSevereDiff(allEntityNodes),
            anchor: { filePath },
        };
        nodes.push(sectionNode);
        anchors[sectionNode.id] = sectionNode.anchor!;

        // file → section
        edges.push({
            id: nextId('edge'),
            source: fileNode.id, target: sectionNode.id,
            label: 'contains', edgeType: 'contains', diff: 'unchanged',
        });

        // section → each entity node
        for (const en of allEntityNodes) {
            edges.push({
                id: nextId('edge'),
                source: sectionNode.id, target: en.id,
                label: 'contains', edgeType: 'contains',
                diff: en.diff === 'deleted' ? 'deleted' : 'unchanged',
            });
        }

    }

    buildBucketNodes('Imports', importEntities, deletedImports);
    buildBucketNodes('Variables', variableEntities, deletedVariables);
    buildBucketNodes('Functions', functionEntities, deletedFunctions);

    // Propagate child changes to file root node
    if (inDiffMode) {
        const hasAnyChange = nodes.some(n => n !== fileNode && n.type !== 'section' && n.diff && n.diff !== 'unchanged');
        if (hasAnyChange) fileNode.diff = 'modified';
    }

    // Build node diff lookup for edge diff propagation
    const nodeDiffById = new Map<string, DiffStatus>();
    for (const n of nodes) nodeDiffById.set(n.id, n.diff || 'unchanged');

    // Dependency edges (calls/uses/depends) between visible entity nodes
    for (const fn of analysis.funcs.values()) {
        const fnId = nodeIdByEntityKey.get(fn.key);
        if (!fnId) continue;

        const fnDiff = nodeDiffById.get(fnId) || 'unchanged';

        if (fn.calls) {
            for (const calleeName of fn.calls) {
                const calleeKey = `function:${calleeName}`;
                const toId = nodeIdByEntityKey.get(calleeKey);
                if (!toId || toId === fnId) continue;
                const toDiff = nodeDiffById.get(toId) || 'unchanged';
                edges.push({
                    id: nextId('edge'),
                    source: fnId, target: toId,
                    label: 'calls', edgeType: 'calls',
                    diff: inDiffMode ? edgeDiffFromEndpoints(fnDiff, toDiff) : 'unchanged',
                });
            }
        }

        if (fn.usesVars) {
            for (const v of fn.usesVars) {
                const varKey = `variable:${v}`;
                const toId = nodeIdByEntityKey.get(varKey);
                if (!toId) continue;
                const toDiff = nodeDiffById.get(toId) || 'unchanged';
                edges.push({
                    id: nextId('edge'),
                    source: fnId, target: toId,
                    label: 'uses', edgeType: 'uses',
                    diff: inDiffMode ? edgeDiffFromEndpoints(fnDiff, toDiff) : 'unchanged',
                });
            }
        }

        if (fn.usesImports) {
            for (const localImport of fn.usesImports) {
                const source = analysis.importsByLocal.get(localImport);
                if (!source) continue;
                const importKey = `import:${source}`;
                const toId = nodeIdByEntityKey.get(importKey);
                if (!toId) continue;
                const toDiff = nodeDiffById.get(toId) || 'unchanged';
                edges.push({
                    id: nextId('edge'),
                    source: fnId, target: toId,
                    label: 'depends', edgeType: 'depends',
                    diff: inDiffMode ? edgeDiffFromEndpoints(fnDiff, toDiff) : 'unchanged',
                });
            }
        }
    }

    // Mark unused imports (no incoming 'depends' edge from any function)
    const importNodeIds = new Set<string>();
    for (const [key, id] of nodeIdByEntityKey.entries()) {
        if (key.startsWith('import:')) importNodeIds.add(id);
    }
    const usedImportIds = new Set<string>();
    for (const e of edges) {
        if (e.edgeType === 'depends' && importNodeIds.has(e.target)) {
            usedImportIds.add(e.target);
        }
    }
    for (const importId of importNodeIds) {
        if (!usedImportIds.has(importId)) {
            const node = nodes.find(n => n.id === importId);
            if (node && node.diff !== 'deleted' && node.diff !== 'added') {
                node.meta = { ...node.meta, unused: true };
            }
        }
    }

    return {
        graphId: `file:${filePath}`,
        type: 'file',
        nodes,
        edges: dedupeEdges(edges),
        anchors,
        meta: { filePath, fileName },
    };
}

/**
 * Extract the import source path from an import entity key.
 * treeSitterExtractor format: `import::${source}::${local}`
 * symbolExtractor (JS) format: `import:${source}`
 *
 * Issue #423 Pattern B: Rust `use bytes::Bytes;` produces source = "bytes::Bytes"
 * → stableKey = "import::bytes::Bytes::Bytes". A naive `split('::')[1]` returns
 * just "bytes" — losing the rest of the source path. The fix: strip the
 * `import::` prefix, then everything before the LAST `::` is the full source
 * (anything after is the local name). For JS old format (`import:source` with
 * single colon) no `::` is present, so we return the trimmed prefix as-is.
 */
function extractImportSource(entityKey: string): string {
    if (entityKey.startsWith('import::')) {
        const trimmed = entityKey.slice('import::'.length);
        const lastSep = trimmed.lastIndexOf('::');
        if (lastSep > 0) return trimmed.slice(0, lastSep);
        return trimmed; // edge case: no local part (shouldn't happen, but be safe)
    }
    return entityKey.replace(/^import:/, ''); // old format: import:source
}

export interface BaselineSymbols {
    functions: Array<{ name: string; signature?: string; bodyText?: string; stableKey: string }>;
    variables: Array<{ name: string; bodyText?: string; stableKey: string }>;
    imports: Array<{ source: string; stableKey: string }>;
}

/**
 * Build a file diagram from a pre-computed FileAnalysis (tree-sitter path).
 *
 * In diff mode (baselineSymbols provided):
 *   - Changed entities shown individually; unchanged collapsed to summary node
 *   - Section subtitle shows diff breakdown
 *   - calls edge diff derived from endpoint diffs
 */
export function buildFileGraphFromAnalysis(
    analysis: TSFileAnalysis,
    filePath: string,
    baselineSymbols?: BaselineSymbols,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};
    const fileName = filePath.split('/').pop() || filePath;
    const inDiffMode = baselineSymbols != null;

    // Issue #423 Pattern B (variables): Rust / Go / Kotlin top-level extraction
    // can produce multiple entries with the SAME stableKey when a file has
    // multiple variables of the same name in different scopes (e.g. routing.rs
    // has `let routes = vec![]` and `let routes = parse_routes_table(table)`).
    // A simple Map<key, single> kept only the LAST one, so the diff comparison
    // false-marked the OTHER copies as modified. Switched to multi-value maps
    // (Map<key, Array>) so all duplicates are preserved and diff matches when
    // ANY baseline entry with the same key+bodyText exists.
    const baselineFuncByKey = new Map<string, BaselineSymbols['functions']>();
    const baselineVarByKey = new Map<string, BaselineSymbols['variables']>();
    // Index baseline imports by source path — works with both old stableKey formats
    // (old: "import:${source}", new: "import::${source}::${local}")
    const baselineImportBySource = new Map<string, BaselineSymbols['imports'][number]>();
    // #452-B: also index by stableKey for canonical match. extractImportSource
    // on Rust brace-expanded keys (e.g. `import::axum::body::Bytes` where local
    // = `body::Bytes` contains `::`) returns the wrong source via lastIndexOf,
    // so the source-only lookup misses and every cascade re-marks the import
    // as 'added'. Direct stableKey equality is unambiguous.
    const baselineImportByStableKey = new Set<string>();
    if (baselineSymbols) {
        for (const f of baselineSymbols.functions) {
            const list = baselineFuncByKey.get(f.stableKey) ?? [];
            list.push(f);
            baselineFuncByKey.set(f.stableKey, list);
        }
        for (const v of baselineSymbols.variables) {
            const list = baselineVarByKey.get(v.stableKey) ?? [];
            list.push(v);
            baselineVarByKey.set(v.stableKey, list);
        }
        for (const i of baselineSymbols.imports) {
            baselineImportBySource.set(i.source, i);
            if (i.stableKey) baselineImportByStableKey.add(i.stableKey);
        }
    }

    const fileNode: GraphNode = {
        id: nextId('file'),
        type: 'file',
        label: fileName,
        subtitle: '«file diagram» top-level dependencies',
        body: 'Imports / Variables / Functions',
        diff: 'unchanged',
        anchor: { filePath },
    };
    nodes.push(fileNode);
    anchors[fileNode.id] = fileNode.anchor!;

    const nodeIdByEntityKey = new Map<string, string>();
    const funcByName = new Map<string, string>();

    function computeNonJsDiff(
        entityKey: string,
        kind: 'function' | 'variable' | 'import',
        currentSig?: string,
        currentBody?: string,
    ): DiffStatus {
        if (!baselineSymbols) return 'unchanged';
        if (kind === 'import') {
            // #452-B: match by exact stableKey first (canonical, unambiguous —
            // handles Rust brace imports where `local` contains `::`). Fall back
            // to source-path match for legacy baseline records lacking stableKey.
            if (baselineImportByStableKey.has(entityKey)) return 'unchanged';
            const importSource = extractImportSource(entityKey);
            return baselineImportBySource.has(importSource) ? 'unchanged' : 'added';
        }
        // Issue #423 Pattern B (variables): the maps are now multi-value
        // (Map<key, Array>) so a file with duplicate variable names doesn't
        // collapse all but one into 'added'/'modified'. Match unchanged if
        // ANY baseline entry with the same key has matching sig+body.
        const candidates: Array<{ signature?: string; bodyText?: string }> | undefined =
            kind === 'function' ? baselineFuncByKey.get(entityKey) : baselineVarByKey.get(entityKey);
        if (!candidates || candidates.length === 0) return 'added';
        // Look for an exact match across all baseline entries for this key.
        for (const cand of candidates) {
            const sigMatch = currentSig === undefined || cand.signature === undefined || currentSig === cand.signature;
            const bodyMatch = currentBody === undefined || cand.bodyText === undefined || currentBody === cand.bodyText;
            if (sigMatch && bodyMatch) return 'unchanged';
        }
        // No exact match → modified (some baseline entry exists with this key,
        // but signature or body shifted).
        return 'modified';
    }

    const importEntities = analysis.entities.filter(e => e.kind === 'import');
    const variableEntities = analysis.entities.filter(e => e.kind === 'variable');
    const functionEntities = analysis.entities.filter(e => e.kind !== 'import' && e.kind !== 'variable');

    // Deleted ghost nodes (baseline entities not present in current)
    const seenFuncKeys = new Set(functionEntities.map(e => e.key));
    const seenVarKeys = new Set(variableEntities.map(e => e.key));
    const seenImportKeys = new Set(importEntities.map(e => e.key));

    const deletedFuncGhosts: GraphNode[] = [];
    const deletedVarGhosts: GraphNode[] = [];
    const deletedImportGhosts: GraphNode[] = [];

    if (baselineSymbols) {
        for (const f of baselineSymbols.functions) {
            if (!seenFuncKeys.has(f.stableKey)) {
                const g: GraphNode = {
                    id: nextId('ghost'), type: 'function',
                    label: `${f.name} (deleted)`, subtitle: '«function»',
                    diff: 'deleted', anchor: { filePath, symbol: f.name },
                };
                deletedFuncGhosts.push(g);
                nodes.push(g);
                anchors[g.id] = g.anchor!;
            }
        }
        for (const v of baselineSymbols.variables) {
            if (!seenVarKeys.has(v.stableKey)) {
                const g: GraphNode = {
                    id: nextId('ghost'), type: 'variable',
                    label: `${v.name} (deleted)`, subtitle: '«variable»',
                    diff: 'deleted', anchor: { filePath, symbol: v.name },
                };
                deletedVarGhosts.push(g);
                nodes.push(g);
                anchors[g.id] = g.anchor!;
            }
        }
        for (const i of baselineSymbols.imports) {
            // #452-B: match by stableKey first (canonical, unambiguous), then
            // fall back to source path. extractImportSource on Rust keys with
            // `local` containing `::` (e.g. `tower_http::compression::CompressionLayer`)
            // incorrectly returned `tower_http::compression` via `lastIndexOf`,
            // missing the equality with baseline `i.source = "tower_http"`. The
            // ghost-import generation then re-fires on every cascade rebuild
            // even when working == baseline. Match by stableKey when both
            // sides have it (post-#357); fall back to source for legacy
            // baseline records that lack stableKey.
            const stillPresent = importEntities.some(e =>
                (i.stableKey && e.key === i.stableKey) ||
                extractImportSource(e.key) === i.source
            );
            if (!stillPresent) {
                // Use last path segment as the display label (e.g. "TodoDto" from "com.example.TodoDto")
                const localName = i.source.split('.').pop()?.split('/').pop() ?? i.source;
                const g: GraphNode = {
                    id: nextId('ghost'), type: 'import',
                    label: `${localName} (deleted)`, subtitle: '«import»',
                    diff: 'deleted', anchor: { filePath },
                };
                deletedImportGhosts.push(g);
                nodes.push(g);
                anchors[g.id] = g.anchor!;
            }
        }
    }

    function buildSection(
        sectionLabel: string,
        liveEntities: TSFileAnalysis['entities'],
        deletedGhosts: GraphNode[],
    ): void {
        if (liveEntities.length === 0 && deletedGhosts.length === 0) return;

        // All entity nodes shown individually so users can click/navigate to any of them
        const allEntityNodes: GraphNode[] = [];

        const sectionItems: any[] = [];

        for (const e of liveEntities) {
            const nodeType = e.kind === 'import' ? 'import' : e.kind === 'variable' ? 'variable' : e.kind === 'class' ? 'class' : 'function';
            let subtitle = e.kind === 'import' ? '«import»' : e.kind === 'variable' ? '«variable»' : `«${e.kind}»`;
            // Issue 204: Show both extends and implements in class subtitles
            if (e.kind === 'class') {
                const ext = e.extendsClass ? `extends ${e.extendsClass}` : '';
                const impl = (e as any).implementsInterfaces?.length ? `implements ${(e as any).implementsInterfaces.join(', ')}` : '';
                const hier = [ext, impl].filter(Boolean).join(' ');
                if (hier) subtitle = `«class» ${hier}`;
            }
            const body = e.kind === 'function' || e.kind === 'class' ? e.signature : e.bodyText;
            const kind: 'function' | 'variable' | 'import' =
                e.kind === 'import' ? 'import' : e.kind === 'variable' ? 'variable' : 'function';
            const diffStatus = computeNonJsDiff(e.key, kind, e.signature, e.bodyText);

            const anchor = { filePath, symbol: e.name };
            const node: GraphNode = {
                id: nextId('node'),
                type: nodeType,
                label: e.name,
                subtitle,
                body,
                diff: diffStatus,
                anchor,
                hidden: true, // Hide from UI, shown inside ClassBlockNode
            };

            sectionItems.push({
                id: node.id,
                type: nodeType,
                label: e.name,
                subtitle,
                body,
                diff: diffStatus,
                anchor,
            });

            nodes.push(node);
            allEntityNodes.push(node);
            nodeIdByEntityKey.set(e.key, node.id);
            anchors[node.id] = anchor;
            if (e.kind === 'function' || e.kind === 'class') funcByName.set(e.name, node.id);
        }

        for (const g of deletedGhosts) {
            g.hidden = true; // Hide ghost nodes too
            allEntityNodes.push(g);
            sectionItems.push({
                id: g.id,
                type: g.type,
                label: g.label,
                subtitle: g.subtitle,
                diff: g.diff,
                anchor: g.anchor,
            });
        }

        const total = liveEntities.length + deletedGhosts.length;
        const unchangedCount = allEntityNodes.filter(n => n.diff === 'unchanged').length;
        // #448-C: subtitle and label must reach the same format at init AND on
        // every cascade rebuild. `buildDiffSummarySubtitle` returns undefined
        // when !inDiffMode (init), but the cascade rebuild produces a real
        // subtitle. Compute the "N unchanged" subtitle unconditionally so init
        // (where working == baseline) matches what cascade produces after a
        // revert. Label gets `(${total})` for the same reason — at init,
        // `recomputeFileGraphDiffFromAuthoritativeSymbols` would rewrite to
        // this exact form on the first edit; matching it eagerly avoids the
        // baseline/working asymmetry that surfaced on every backend repo in
        // the verify sweep.
        let sectionSubtitle = buildDiffSummarySubtitle(allEntityNodes, unchangedCount, inDiffMode);
        if (!sectionSubtitle && unchangedCount > 0) {
            sectionSubtitle = `${unchangedCount} unchanged`;
        }
        const sectionNode: GraphNode = {
            id: nextId('section'),
            type: 'section',
            label: `${sectionLabel} (${total})`,
            subtitle: sectionSubtitle,
            diff: mostSevereDiff(allEntityNodes),
            anchor: { filePath },
            meta: { items: sectionItems },
        };
        nodes.push(sectionNode);
        anchors[sectionNode.id] = sectionNode.anchor!;

        edges.push({
            id: nextId('edge'),
            source: fileNode.id, target: sectionNode.id,
            label: 'contains', edgeType: 'contains', diff: 'unchanged',
        });

        for (const child of allEntityNodes) {
            edges.push({
                id: nextId('edge'),
                source: sectionNode.id, target: child.id,
                label: 'contains', edgeType: 'contains',
                diff: child.diff === 'deleted' ? 'deleted' : 'unchanged',
                hidden: true, // Hide contains edges from UI to prevent clutter
            });
        }
    }

    buildSection('Imports', importEntities, deletedImportGhosts);
    buildSection('Variables', variableEntities, deletedVarGhosts);
    buildSection('Functions', functionEntities, deletedFuncGhosts);

    // Propagate changes to file root
    if (inDiffMode) {
        const hasAnyChange = nodes.some(n => n !== fileNode && n.type !== 'section' && n.diff && n.diff !== 'unchanged');
        if (hasAnyChange) fileNode.diff = 'modified';
    }

    // Build node diff lookup
    const nodeDiffById = new Map<string, DiffStatus>();
    for (const n of nodes) nodeDiffById.set(n.id, n.diff || 'unchanged');

    // Dependency edges (calls) between visible function nodes
    for (const fn of analysis.funcs.values()) {
        const fnId = nodeIdByEntityKey.get(fn.key);
        if (!fnId) continue;

        const fnDiff = nodeDiffById.get(fnId) || 'unchanged';

        if (fn.calls) {
            for (const calleeName of fn.calls) {
                const toId = funcByName.get(calleeName);
                if (!toId || toId === fnId) continue;
                // Skip if callee is a collapsed entity (funcByName only has visible nodes)
                const toDiff = nodeDiffById.get(toId) || 'unchanged';
                edges.push({
                    id: nextId('edge'),
                    source: fnId, target: toId,
                    label: 'calls', edgeType: 'calls',
                    diff: inDiffMode ? edgeDiffFromEndpoints(fnDiff, toDiff) : 'unchanged',
                });
            }
        }
    }

    return {
        graphId: `file:${filePath}`,
        type: 'file',
        nodes,
        edges: dedupeEdges(edges),
        anchors,
        meta: { filePath, fileName },
    };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
    const seen = new Set<string>();
    const out: GraphEdge[] = [];
    for (const e of edges) {
        // Issue 205: Include edgeType in dedup key to preserve edges with same endpoints but different types
        const k = `${e.source}|${e.target}|${e.edgeType ?? ''}|${e.label}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
    }
    return out;
}
