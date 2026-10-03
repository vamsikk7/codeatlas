/**
 * inspect-l3-l5.ts
 *
 * Walks each repo's state.json and audits L3 (sequence) + L5 (flow) graphs
 * for structural issues:
 *
 *   L3 / sequence:
 *     - graph has 0 participants
 *     - graph has 0 message edges
 *     - participant has 0 incident edges (orphaned in its own graph)
 *     - edge references a participant id that doesn't exist
 *     - graph has only 1 participant (no possible interaction)
 *
 *   L5 / flow:
 *     - graph has 0 nodes
 *     - graph has 1 node (trivial — no flow)
 *     - graph has 0 edges
 *     - node has 0 incident edges (and graph has > 1 node — orphan)
 *     - edge references a node id that doesn't exist
 *     - graph missing both terminals (start/end)
 *
 * Output: e2e/real-repos/.l3-l5-inspection.json + a per-repo stdout summary.
 */

import * as fs from 'fs';
import * as path from 'path';

interface Finding {
    severity: 'HIGH' | 'MED' | 'LOW';
    layer: 'L3' | 'L5';
    category: string;
    graphId: string;
    detail: string;
}

interface RepoReport {
    id: string;
    l3GraphCount: number;
    l5GraphCount: number;
    findings: Finding[];
    truncated: Record<string, number>;
}

const PER_CATEGORY_CAP = 10;

function load<T>(p: string): T | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function inspect(repoId: string, statePath: string): RepoReport {
    const state = load<any>(statePath);
    const findings: Finding[] = [];
    const truncated: Record<string, number> = {};
    const push = (f: Finding) => {
        const seen = findings.filter(x => x.layer === f.layer && x.category === f.category).length;
        if (seen >= PER_CATEGORY_CAP) {
            const k = `${f.layer}:${f.category}`;
            truncated[k] = (truncated[k] ?? 0) + 1;
            return;
        }
        findings.push(f);
    };
    if (!state) {
        return { id: repoId, l3GraphCount: 0, l5GraphCount: 0, findings, truncated };
    }
    const graphs: Record<string, any> = state.working?.graphs ?? {};
    let l3 = 0, l5 = 0;

    for (const [graphId, graph] of Object.entries(graphs) as [string, any][]) {
        const nodes: any[] = graph?.nodes ?? [];
        const edges: any[] = graph?.edges ?? [];
        const nodeIds = new Set(nodes.map(n => n?.id));

        if (graphId.startsWith('sequence:')) {
            l3++;
            const participants = nodes.filter(n => n.type === 'participant');
            const partIds = new Set(participants.map(p => p.id));

            if (participants.length === 0) {
                push({ severity: 'HIGH', layer: 'L3', category: 'no_participants', graphId,
                    detail: `sequence graph has 0 participant nodes (total nodes=${nodes.length})` });
            }
            if (edges.length === 0) {
                push({ severity: 'MED', layer: 'L3', category: 'no_messages', graphId,
                    detail: `sequence graph has ${participants.length} participants but 0 message edges` });
            }
            if (participants.length === 1 && edges.length === 0) {
                push({ severity: 'LOW', layer: 'L3', category: 'single_participant_isolated', graphId,
                    detail: `only 1 participant and no messages — degenerate sequence` });
            }

            // Per-participant orphan check
            const incidentByPart: Record<string, number> = {};
            for (const p of participants) incidentByPart[p.id] = 0;
            for (const e of edges) {
                if (partIds.has(e.source)) incidentByPart[e.source] = (incidentByPart[e.source] ?? 0) + 1;
                if (partIds.has(e.target) && e.target !== e.source) {
                    incidentByPart[e.target] = (incidentByPart[e.target] ?? 0) + 1;
                }
            }
            // Only flag orphan participants when the graph DOES have edges,
            // otherwise we're double-flagging the no_messages case.
            if (edges.length > 0) {
                for (const p of participants) {
                    if ((incidentByPart[p.id] ?? 0) === 0) {
                        push({ severity: 'MED', layer: 'L3', category: 'orphan_participant', graphId,
                            detail: `participant ${p.id} ("${p.label}") has no incident message edges` });
                    }
                }
            }

            // Edge points to a non-participant id
            for (const e of edges) {
                if (e.source && !partIds.has(e.source)) {
                    push({ severity: 'HIGH', layer: 'L3', category: 'edge_source_not_participant', graphId,
                        detail: `edge ${e.id ?? '?'} source=${e.source} not in participants[]` });
                }
                if (e.target && !partIds.has(e.target)) {
                    push({ severity: 'HIGH', layer: 'L3', category: 'edge_target_not_participant', graphId,
                        detail: `edge ${e.id ?? '?'} target=${e.target} not in participants[]` });
                }
            }
        } else if (graphId.startsWith('flow:')) {
            l5++;
            if (nodes.length === 0) {
                push({ severity: 'HIGH', layer: 'L5', category: 'no_nodes', graphId,
                    detail: `flow graph has 0 nodes` });
                continue;
            }
            if (nodes.length === 1) {
                push({ severity: 'LOW', layer: 'L5', category: 'single_node', graphId,
                    detail: `flow graph has only 1 node (trivial)` });
            }
            if (edges.length === 0 && nodes.length > 1) {
                push({ severity: 'MED', layer: 'L5', category: 'no_edges', graphId,
                    detail: `flow graph has ${nodes.length} nodes but 0 edges` });
            }
            // Terminal coverage
            const terminals = nodes.filter(n => n.type === 'terminal');
            if (terminals.length < 2 && nodes.length >= 3) {
                push({ severity: 'LOW', layer: 'L5', category: 'missing_terminal', graphId,
                    detail: `flow graph has ${terminals.length} terminal(s) (expected >= 2 for start+end)` });
            }
            // Orphan node: no incident edges and graph has > 1 node
            if (nodes.length > 1) {
                const incident: Record<string, number> = {};
                for (const n of nodes) incident[n.id] = 0;
                for (const e of edges) {
                    if (e.source && incident[e.source] !== undefined) incident[e.source]++;
                    if (e.target && incident[e.target] !== undefined && e.target !== e.source) incident[e.target]++;
                }
                for (const n of nodes) {
                    if (incident[n.id] === 0) {
                        push({ severity: 'MED', layer: 'L5', category: 'orphan_node', graphId,
                            detail: `node ${n.id} ("${n.label ?? ''}") has no incident edges` });
                    }
                }
            }
            // Dangling edge endpoints
            for (const e of edges) {
                if (e.source && !nodeIds.has(e.source)) {
                    push({ severity: 'HIGH', layer: 'L5', category: 'edge_source_dangling', graphId,
                        detail: `edge source=${e.source} not in nodes[]` });
                }
                if (e.target && !nodeIds.has(e.target)) {
                    push({ severity: 'HIGH', layer: 'L5', category: 'edge_target_dangling', graphId,
                        detail: `edge target=${e.target} not in nodes[]` });
                }
            }
        }
    }

    return { id: repoId, l3GraphCount: l3, l5GraphCount: l5, findings, truncated };
}

const repoRoot = path.resolve(__dirname, '..');
const realReposDir = path.join(repoRoot, 'e2e/real-repos');
const repos = (load<{ repos: { id: string }[] }>(
    path.join(repoRoot, 'e2e/real-projects/repos.json'),
) ?? { repos: [] }).repos;

const reports: RepoReport[] = [];
for (const spec of repos) {
    const sp = path.join(realReposDir, spec.id, '.codeatlas/state.json');
    if (!fs.existsSync(sp)) {
        console.log(`[${spec.id}] state.json missing — skip`);
        continue;
    }
    reports.push(inspect(spec.id, sp));
}

const sevTotal = (sev: 'HIGH'|'MED'|'LOW') =>
    reports.reduce((a, r) => a + r.findings.filter(f => f.severity === sev).length
        + Object.entries(r.truncated).filter(([k]) => k).reduce((b, [_, v]) => b + (v ?? 0), 0) * 0
        , 0);

// Per-repo summary
console.log(`${'repo'.padEnd(22)}${'L3'.padStart(6)}${'L5'.padStart(7)}${'H'.padStart(5)}${'M'.padStart(5)}${'L'.padStart(5)}`);
console.log(`${'-'.repeat(22)}${'-'.repeat(6)}${'-'.repeat(7)}${'-'.repeat(5)}${'-'.repeat(5)}${'-'.repeat(5)}`);
for (const r of reports) {
    const h = r.findings.filter(f => f.severity === 'HIGH').length;
    const m = r.findings.filter(f => f.severity === 'MED').length;
    const l = r.findings.filter(f => f.severity === 'LOW').length;
    const trunc = Object.values(r.truncated).reduce((a, b) => a + b, 0);
    const lTotal = l + trunc;
    console.log(
        `${r.id.padEnd(22)}${String(r.l3GraphCount).padStart(6)}${String(r.l5GraphCount).padStart(7)}${String(h).padStart(5)}${String(m).padStart(5)}${String(lTotal).padStart(5)}`,
    );
}

// Category breakdown
const catCount: Record<string, number> = {};
for (const r of reports) {
    for (const f of r.findings) {
        const k = `${f.layer}:${f.category}`;
        catCount[k] = (catCount[k] ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(r.truncated)) catCount[k] = (catCount[k] ?? 0) + v;
}
console.log(`\nCategory totals:`);
for (const [k, v] of Object.entries(catCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
}

const totalH = reports.reduce((a, r) => a + r.findings.filter(f => f.severity === 'HIGH').length, 0);
const totalM = reports.reduce((a, r) => a + r.findings.filter(f => f.severity === 'MED').length, 0);
const totalL = reports.reduce((a, r) => a + r.findings.filter(f => f.severity === 'LOW').length
    + Object.values(r.truncated).reduce((b, v) => b + v, 0), 0);
console.log(`\nTotals: HIGH=${totalH}  MED=${totalM}  LOW=${totalL}`);

fs.writeFileSync(
    path.join(realReposDir, '.l3-l5-inspection.json'),
    JSON.stringify(reports, null, 2),
);
