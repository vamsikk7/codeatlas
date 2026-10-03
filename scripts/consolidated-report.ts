/**
 * consolidated-report.ts
 *
 * Reads each repo's .codeatlas/state.json and the expectations.json baseline,
 * prints a per-repo expected-vs-actual table covering APIs, feature clusters,
 * and per-layer diagram counts (L1/L2a/L2b/L3/L4/L5), plus the deterministic
 * verifier finding count.
 */

import * as fs from 'fs';
import * as path from 'path';

interface Expectation {
    minApiCount: number;
    minFeatureClusters: number;
    minMicroservices: number;
    minSequenceGraphs: number;
    minFileGraphs: number;
    minFlowGraphs: number;
    minRouteApiCount?: number;
}

function readJson<T>(p: string): T | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function countByPrefix(graphs: Record<string, any>, prefix: string): number {
    return Object.keys(graphs).filter((g) => g.startsWith(prefix)).length;
}

function l2bApiCount(graphs: Record<string, any>): number {
    let total = 0;
    for (const [gid, g] of Object.entries(graphs)) {
        if (!gid.startsWith('api-list:')) continue;
        const apis = (g as any)?.meta?.apis ?? [];
        total += apis.length;
    }
    return total;
}

const repoRoot = path.resolve(__dirname, '..');
const realReposDir = path.join(repoRoot, 'e2e/real-repos');
const repos = (readJson<{ repos: { id: string }[] }>(
    path.join(repoRoot, 'e2e/real-projects/repos.json'),
) ?? { repos: [] }).repos;
const expectations = readJson<Record<string, Expectation>>(
    path.join(repoRoot, 'e2e/real-projects/expectations.json'),
) ?? {};
const verifyReport = readJson<any[]>(
    path.join(realReposDir, '.verification-report.json'),
) ?? [];
const findingsByRepo: Record<string, { high: number; med: number; low: number }> = {};
for (const r of verifyReport) {
    findingsByRepo[r.id] = {
        high: r.findings.filter((f: any) => f.severity === 'HIGH').length,
        med: r.findings.filter((f: any) => f.severity === 'MED').length,
        low: r.findings.filter((f: any) => f.severity === 'LOW').length
            + (r.truncatedCategories?.sequence_no_flow ?? 0),
    };
}

const HEADER = [
    'repo',
    'apis(act/exp)',
    'features(act/exp)',
    'L1', 'L2a', 'L2b-apis',
    'L3(act/exp)', 'L4(act/exp)', 'L5(act/exp)',
    'H', 'M', 'L',
];

const rows: string[][] = [];
for (const spec of repos) {
    const state = readJson<any>(
        path.join(realReposDir, spec.id, '.codeatlas/state.json'),
    );
    const exp = expectations[spec.id] ?? ({} as Expectation);
    if (!state) {
        rows.push([spec.id, 'MISSING', '', '', '', '', '', '', '', '', '', '']);
        continue;
    }
    const dumpStats = readJson<any>(
        path.join(realReposDir, spec.id, '.codeatlas/dump-stats.json'),
    );
    const w = state.working ?? {};
    // Match runVerify.ts (which expectations.json is keyed off): raw initStats.apiCount,
    // not apiIndex.size. Fall back to apiIndex size if dump-stats.json is missing.
    const apis = dumpStats?.initStats?.apiCount ?? Object.keys(w.apiIndex ?? {}).length;
    const features = Object.keys(w.clusters ?? {}).length;
    const graphs = w.graphs ?? {};
    const l1 = countByPrefix(graphs, 'microservice:');
    const l2a = countByPrefix(graphs, 'feature:');
    const l2b = l2bApiCount(graphs);
    const l3 = countByPrefix(graphs, 'sequence:');
    const l4 = countByPrefix(graphs, 'file:');
    const l5 = countByPrefix(graphs, 'flow:');
    const find = findingsByRepo[spec.id] ?? { high: 0, med: 0, low: 0 };
    rows.push([
        spec.id,
        `${apis}/${exp.minApiCount ?? '-'}`,
        `${features}/${exp.minFeatureClusters ?? '-'}`,
        String(l1),
        String(l2a),
        String(l2b),
        `${l3}/${exp.minSequenceGraphs ?? '-'}`,
        `${l4}/${exp.minFileGraphs ?? '-'}`,
        `${l5}/${exp.minFlowGraphs ?? '-'}`,
        String(find.high),
        String(find.med),
        String(find.low),
    ]);
}

const widths = HEADER.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
);
const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log(fmt(HEADER));
console.log(fmt(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(fmt(r));

const totals = rows.reduce(
    (a, r) => {
        a.h += parseInt(r[9] || '0', 10) || 0;
        a.m += parseInt(r[10] || '0', 10) || 0;
        a.l += parseInt(r[11] || '0', 10) || 0;
        return a;
    },
    { h: 0, m: 0, l: 0 },
);
console.log(`\nTotals: HIGH=${totals.h}  MED=${totals.m}  LOW=${totals.l}`);

// Regression flag: any actual < expected on any min* metric
const regressions: string[] = [];
for (const spec of repos) {
    const state = readJson<any>(
        path.join(realReposDir, spec.id, '.codeatlas/state.json'),
    );
    if (!state) continue;
    const dumpStats = readJson<any>(
        path.join(realReposDir, spec.id, '.codeatlas/dump-stats.json'),
    );
    const w = state.working ?? {};
    const exp = expectations[spec.id] ?? ({} as Expectation);
    const apis = dumpStats?.initStats?.apiCount ?? Object.keys(w.apiIndex ?? {}).length;
    const features = Object.keys(w.clusters ?? {}).length;
    const graphs = w.graphs ?? {};
    const l3 = countByPrefix(graphs, 'sequence:');
    const l4 = countByPrefix(graphs, 'file:');
    const l5 = countByPrefix(graphs, 'flow:');
    const checks: [string, number, number | undefined][] = [
        ['apis', apis, exp.minApiCount],
        ['features', features, exp.minFeatureClusters],
        ['L3', l3, exp.minSequenceGraphs],
        ['L4', l4, exp.minFileGraphs],
        ['L5', l5, exp.minFlowGraphs],
    ];
    for (const [name, actual, min] of checks) {
        if (typeof min === 'number' && actual < min) {
            regressions.push(`${spec.id}: ${name} actual=${actual} < expected=${min}`);
        }
    }
}
if (regressions.length) {
    console.log('\nRegressions vs expectations.json:');
    for (const r of regressions) console.log(`  ${r}`);
} else {
    console.log('\nNo regressions vs expectations.json (every actual >= min).');
}
