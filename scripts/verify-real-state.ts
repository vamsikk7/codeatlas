/**
 * verify-real-state.ts
 *
 * Walks the state.json produced by `dump-real-state.ts` for each real-repo
 * and emits structural findings: broken paths, dangling edges, cross-layer
 * references, sequence-participant mismatches, and so on.
 *
 * Output: e2e/real-repos/.verification-report.json (and a stdout summary).
 *
 * This is deterministic, fast, and exhaustive. We use LLM agents only for the
 * follow-up "does this look semantically right" pass, scoped to top-N findings.
 */

import * as fs from 'fs';
import * as path from 'path';

type Severity = 'HIGH' | 'MED' | 'LOW';

interface Finding {
    severity: Severity;
    category: string;
    graphId?: string;
    where?: string;
    detail: string;
}

interface RepoReport {
    id: string;
    fileCount: number;
    apiCount: number;
    graphCount: number;
    findings: Finding[];
    truncatedCategories: Record<string, number>;
}

const PER_CATEGORY_CAP = 10;

function loadJson<T>(p: string): T | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function fileExists(repoPath: string, anchorPath: string): boolean {
    if (!anchorPath) return true; // empty anchor is fine
    const cleaned = anchorPath.replace(/^\/+/, '');
    return fs.existsSync(path.join(repoPath, cleaned));
}

function verify(repoId: string, repoPath: string, statePath: string): RepoReport {
    const findings: Finding[] = [];
    const truncated: Record<string, number> = {};
    const push = (f: Finding) => {
        const cat = f.category;
        const seen = findings.filter((x) => x.category === cat).length;
        if (seen >= PER_CATEGORY_CAP) {
            truncated[cat] = (truncated[cat] ?? 0) + 1;
            return;
        }
        findings.push(f);
    };

    const state = loadJson<any>(statePath);
    if (!state) {
        return {
            id: repoId, fileCount: 0, apiCount: 0, graphCount: 0,
            findings: [{ severity: 'HIGH', category: 'state_unreadable', detail: `Cannot read ${statePath}` }],
            truncatedCategories: {},
        };
    }

    const working = state.working ?? {};
    const files: Record<string, any> = working.files ?? {};
    const apiIndex: Record<string, any> = working.apiIndex ?? {};
    const graphs: Record<string, any> = working.graphs ?? {};
    const clusters: Record<string, any> = working.clusters ?? {};

    const fileCount = Object.keys(files).length;
    const apiCount = Object.keys(apiIndex).length;
    const graphCount = Object.keys(graphs).length;

    // ─── 1 & 3. Per-graph node-anchor + edge integrity ──────────────────
    for (const [graphId, graph] of Object.entries(graphs) as [string, any][]) {
        const nodes: any[] = graph?.nodes ?? [];
        const edges: any[] = graph?.edges ?? [];
        const nodeIds = new Set(nodes.map((n) => n?.id));

        for (const node of nodes) {
            // 1. Broken file paths
            const ap = node?.anchor?.filePath;
            if (ap && !fileExists(repoPath, ap)) {
                push({
                    severity: 'HIGH',
                    category: 'broken_path',
                    graphId,
                    where: `node ${node.id} (${node.label})`,
                    detail: `anchor.filePath does not exist on disk: ${ap}`,
                });
            }
            // Empty label
            if (typeof node.label !== 'string' || node.label.trim() === '') {
                push({
                    severity: 'MED',
                    category: 'empty_label',
                    graphId,
                    where: `node ${node.id}`,
                    detail: `label is empty/missing (type=${node.type})`,
                });
            }
        }

        // 3. Dangling edges
        for (const edge of edges) {
            if (edge?.source && !nodeIds.has(edge.source)) {
                push({
                    severity: 'HIGH',
                    category: 'dangling_edge_source',
                    graphId,
                    where: `edge ${edge.id ?? '?'}`,
                    detail: `source ${edge.source} → target ${edge.target} (source not in nodes)`,
                });
            }
            if (edge?.target && !nodeIds.has(edge.target)) {
                push({
                    severity: 'HIGH',
                    category: 'dangling_edge_target',
                    graphId,
                    where: `edge ${edge.id ?? '?'}`,
                    detail: `source ${edge.source} → target ${edge.target} (target not in nodes)`,
                });
            }
        }

        // Duplicate node ids
        const seenIds = new Set<string>();
        for (const node of nodes) {
            if (seenIds.has(node.id)) {
                push({
                    severity: 'MED',
                    category: 'duplicate_node_id',
                    graphId,
                    detail: `node id ${node.id} appears more than once`,
                });
            }
            seenIds.add(node.id);
        }

        // 6. File-graph empty audit
        if (graphId.startsWith('file:') && nodes.length === 0) {
            const fp = graphId.slice('file:'.length);
            try {
                const full = path.join(repoPath, fp);
                if (fs.existsSync(full)) {
                    const lines = fs.readFileSync(full, 'utf8').split('\n').length;
                    if (lines > 50) {
                        push({
                            severity: 'MED',
                            category: 'empty_file_graph',
                            graphId,
                            detail: `file has ${lines} lines but file graph has 0 nodes`,
                        });
                    }
                }
            } catch { /* ignore */ }
        }

        // 7. Sequence participant integrity
        if (graphId.startsWith('sequence:')) {
            const participants = new Set(
                nodes.filter((n) => n.type === 'participant').map((n) => n.id),
            );
            for (const e of edges) {
                if (e.source && !participants.has(e.source)) {
                    push({
                        severity: 'MED',
                        category: 'sequence_missing_participant',
                        graphId,
                        detail: `edge source ${e.source} not in participants`,
                    });
                }
                if (e.target && !participants.has(e.target)) {
                    push({
                        severity: 'MED',
                        category: 'sequence_missing_participant',
                        graphId,
                        detail: `edge target ${e.target} not in participants`,
                    });
                }
            }
        }
    }

    // ─── 4. Layer cross-references ──────────────────────────────────────
    // L1 microservice nodes carrying clusterId must point to a real cluster.
    const microservice = graphs['microservice:workspace'];
    if (microservice) {
        for (const node of microservice.nodes ?? []) {
            const cid = node?.meta?.clusterId;
            if (cid && !clusters[cid]) {
                push({
                    severity: 'MED',
                    category: 'l1_dangling_cluster_ref',
                    graphId: 'microservice:workspace',
                    where: `node ${node.id}`,
                    detail: `cluster ${cid} referenced but missing from working.clusters`,
                });
            }
        }
    }

    // L2b api-list APIs must exist in working.apiIndex.
    for (const [graphId, graph] of Object.entries(graphs) as [string, any][]) {
        if (!graphId.startsWith('api-list:')) continue;
        const apisMeta = graph?.meta?.apis ?? [];
        for (const api of apisMeta) {
            if (api?.apiId && !apiIndex[api.apiId]) {
                push({
                    severity: 'MED',
                    category: 'apilist_orphan_api',
                    graphId,
                    detail: `api ${api.apiId} not in working.apiIndex`,
                });
            }
        }
        // 5. Subsystem dangling
        const subs = graph?.meta?.subsystems ?? [];
        for (const sys of subs) {
            if (sys?.filePath && !fileExists(repoPath, sys.filePath)) {
                push({
                    severity: 'MED',
                    category: 'subsystem_broken_path',
                    graphId,
                    detail: `subsystem ${sys.label} → ${sys.filePath} (does not exist)`,
                });
            }
        }
    }

    // L3 sequence handlers should map to L5 flow graphs OR be anonymous@.
    // sequenceGraphBuilder emits two graphId shapes:
    //   sequence:<file>:<handler>   per-handler sequence (expects a flow graph)
    //   sequence:<file>             file-level sequence (no expected flow)
    // Only the per-handler shape needs the flow check (Issue 334).
    //
    // Class-based controllers (NestJS, Spring, ASP.NET) store flow graphs as
    // `flow:<file>:<Class>.<method>` while the api detector emits
    // `<method>` as handler. Accept the suffix-match shape too (Issue 338).
    for (const graphId of Object.keys(graphs)) {
        if (!graphId.startsWith('sequence:')) continue;
        const seqMeta = graphs[graphId]?.meta;
        const handler = (seqMeta?.handlerName ?? '').trim();
        if (!handler) continue;
        if (handler.startsWith('anonymous@')) continue;
        const filePath = seqMeta?.filePath ?? '';
        const expectedFlow = `flow:${filePath}:${handler}`;
        if (graphs[expectedFlow]) continue;
        // Suffix match: any flow:<file>:Class.<handler> (the class name is
        // part of the key after the file prefix, separated by `.`).
        const filePrefix = `flow:${filePath}:`;
        const dotSuffix = `.${handler}`;
        const suffixMatch = Object.keys(graphs).some(k => {
            if (!k.startsWith(filePrefix)) return false;
            const tail = k.slice(filePrefix.length);
            return tail === handler || tail.endsWith(dotSuffix);
        });
        if (suffixMatch) continue;
        // Cross-file match: handler is `register_user` but the actual fn lives
        // in another file (Django CBV pattern with `urls.py` referring to
        // `views.py`; Rust `auth/.../main.rs` referring to
        // `register_handler::register_user`). Accept any
        // `flow:<other-file>:<handler>` in the same workspace.
        // For Django CBVs the handler is the *class* name and the flow graphs
        // are keyed by `Class.method` — accept any flow whose Class part
        // matches the handler too.
        const dot = `.`;
        const xFileMatch = Object.keys(graphs).some(k => {
            if (!k.startsWith('flow:')) return false;
            const lastColon = k.lastIndexOf(':');
            if (lastColon < 5) return false;
            const tail = k.slice(lastColon + 1);
            if (tail === handler) return true;
            // Django CBV: handler === Class, flow tail === `Class.method`.
            if (tail.startsWith(handler + dot)) return true;
            // Or handler === `Class.method`, flow tail === `method`.
            if (handler.includes(dot)) {
                const methodPart = handler.split(dot).pop()!;
                if (tail === methodPart) return true;
            }
            // Issue 352: flow tail === `Class.method` where method === handler
            // (Swift Vapor `, use: todoController.index` captures `index` —
            // matches `flow:TodoController.swift:TodoController.index`).
            if (tail.endsWith(dot + handler)) return true;
            return false;
        });
        if (xFileMatch) continue;
        push({
            severity: 'LOW',
            category: 'sequence_no_flow',
            graphId,
            detail: `no matching flow graph ${expectedFlow}`,
        });
    }

    // L4 file graphs must point to a real file in working.files
    for (const graphId of Object.keys(graphs)) {
        if (!graphId.startsWith('file:')) continue;
        const fp = graphId.slice('file:'.length);
        if (!files[fp]) {
            push({
                severity: 'MED',
                category: 'l4_orphan_file_graph',
                graphId,
                detail: `path ${fp} not in working.files`,
            });
        }
    }

    // API records must have anchor pointing to a real file
    for (const api of Object.values(apiIndex) as any[]) {
        if (api?.filePath && !fileExists(repoPath, api.filePath)) {
            push({
                severity: 'HIGH',
                category: 'api_broken_file',
                where: api.apiId,
                detail: `API filePath does not exist: ${api.filePath}`,
            });
        }
    }

    return {
        id: repoId, fileCount, apiCount, graphCount,
        findings, truncatedCategories: truncated,
    };
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const realReposDir = path.join(repoRoot, 'e2e/real-repos');
    const reposJson = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'e2e/real-projects/repos.json'), 'utf8'),
    ) as { repos: { id: string }[] };

    const filterIds = new Set(process.argv.slice(2));
    const targets = filterIds.size > 0
        ? reposJson.repos.filter(r => filterIds.has(r.id))
        : reposJson.repos;

    const reports: RepoReport[] = [];
    for (const spec of targets) {
        const repoPath = path.join(realReposDir, spec.id);
        const statePath = path.join(repoPath, '.codeatlas/state.json');
        if (!fs.existsSync(statePath)) {
            console.error(`[skip] ${spec.id} — state.json missing (run dump-real-state.ts)`);
            continue;
        }
        const r = verify(spec.id, repoPath, statePath);
        reports.push(r);
        const high = r.findings.filter((f) => f.severity === 'HIGH').length;
        const med = r.findings.filter((f) => f.severity === 'MED').length;
        const low = r.findings.filter((f) => f.severity === 'LOW').length;
        console.log(`[${spec.id}] files=${r.fileCount} apis=${r.apiCount} graphs=${r.graphCount} | findings: H${high} M${med} L${low}`);
    }

    fs.writeFileSync(
        path.join(realReposDir, '.verification-report.json'),
        JSON.stringify(reports, null, 2),
    );

    // Top-level summary
    const totals = reports.reduce(
        (acc, r) => {
            for (const f of r.findings) {
                acc[f.severity] = (acc[f.severity] ?? 0) + 1;
                acc[`cat:${f.category}`] = (acc[`cat:${f.category}`] ?? 0) + 1;
            }
            return acc;
        },
        {} as Record<string, number>,
    );
    console.log('\n=== TOTALS ===');
    console.log(`Repos: ${reports.length}`);
    console.log(`HIGH=${totals.HIGH ?? 0}  MED=${totals.MED ?? 0}  LOW=${totals.LOW ?? 0}`);
    console.log('\n=== Categories ===');
    for (const [k, v] of Object.entries(totals)) {
        if (k.startsWith('cat:')) console.log(`  ${k.slice(4)}: ${v}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
