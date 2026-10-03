/**
 * regressionScope.ts — #827 (2026-06-10).
 *
 * "What should I re-test for this change?" — composes the pieces that
 * already exist into one answer:
 *
 *   working-vs-baseline file hashes  → changed entities
 *   `analyzeImpact` (call graph BFS) → blast radius (+ test files that
 *                                      reach changed code via call/import
 *                                      edges — those ARE the tests to run)
 *   path-convention sibling lookup   → tests the call graph can't see
 *   `CoverageReport` (LCOV/Istanbul) → which blast-radius entities have
 *                                      ZERO coverage — the risk list
 *   `apiIndex`                       → affected endpoints
 *   `cross_repo_http_edges`          → consumers in other repos
 *
 * Pure composition — no I/O beyond what the caller injects. Consumed by
 * BOTH `extension.ts` and `standalone/messageHandler.ts` plus the MCP
 * `get_regression_scope` tool (parity by construction).
 *
 * v1 precision limits (documented per the spec): test↔source mapping is
 * call-graph + path-convention based, NOT per-test coverage attribution.
 * A test that exercises a function only through deep indirection the
 * call graph didn't resolve won't be listed. Per-test attribution
 * (jest --findRelatedTests / istanbul per-test) is the v2.
 */

import type { Snapshot } from '../graph/graphTypes';
import { analyzeImpact, type ImpactedFunction } from './impactAnalyzer';
import type { CoverageReport } from './coverageReader';

const TEST_PATH_PATTERN = /[/\\](tests?|__tests?__|spec)[/\\]|\.test\.|\.spec\./i;

export interface RegressionScopeEntity {
    filePath: string;
    functionName?: string;
    changeKind: 'added' | 'modified' | 'deleted';
}

export interface RegressionTestToRun {
    testFile: string;
    reason: 'covers-changed' | 'covers-blast-radius' | 'path-convention';
}

export interface RegressionAffectedApi {
    apiId: string;
    method: string;
    route: string;
    surfaceChanged: boolean;
}

export interface RegressionCrossRepoConsumer {
    consumerRepo: string;
    method: string;
    route: string;
}

export interface RegressionScope {
    changedEntities: RegressionScopeEntity[];
    blastRadius: {
        direct: ImpactedFunction[];
        transitive: ImpactedFunction[];
        reviewRequired: ImpactedFunction[];
    };
    testsToRun: RegressionTestToRun[];
    /** Blast-radius entities (non-test) with no coverage / no mapped test. */
    untestedBlastRadius: ImpactedFunction[];
    affectedApis: RegressionAffectedApi[];
    crossRepoConsumers: RegressionCrossRepoConsumer[];
    /** Copy-pasteable runner command, null when no tests resolved. */
    testCommand: string | null;
    /** Whether LCOV/Istanbul data informed `untestedBlastRadius`. */
    coverageAvailable: boolean;
}

export interface ComputeRegressionScopeOptions {
    working: Snapshot;
    baseline?: Snapshot | null;
    /** Injectable coverage (null = none found). */
    coverage?: CoverageReport | null;
    /** cross_repo_http_edges rows (multi-repo); pass [] or omit otherwise. */
    crossRepoEdges?: ReadonlyArray<{ sourceRepo: string; targetRepo: string; method: string; route: string }>;
    /** This repo's name — used to find consumers (edges targeting us). */
    repoName?: string;
    maxDepth?: number;
}

function changedFilesFromSnapshots(working: Snapshot, baseline?: Snapshot | null): RegressionScopeEntity[] {
    const out: RegressionScopeEntity[] = [];
    const w: Record<string, any> = (working.files ?? {}) as any;
    const b: Record<string, any> = (baseline?.files ?? {}) as any;
    for (const [fp, rec] of Object.entries(w)) {
        const base = b[fp];
        if (!base) {
            if (baseline) out.push({ filePath: fp, changeKind: 'added' });
            continue;
        }
        if (base.hash !== (rec as any).hash) out.push({ filePath: fp, changeKind: 'modified' });
    }
    for (const fp of Object.keys(b)) {
        if (!w[fp]) out.push({ filePath: fp, changeKind: 'deleted' });
    }
    return out;
}

/** Attach function names for modified files whose flow/file graphs carry diff markers. */
function attachFunctionNames(entities: RegressionScopeEntity[], working: Snapshot): RegressionScopeEntity[] {
    const result: RegressionScopeEntity[] = [];
    const graphs: Record<string, any> = (working.graphs ?? {}) as any;
    for (const e of entities) {
        if (e.changeKind === 'deleted') { result.push(e); continue; }
        const fileGraph = graphs[`file:${e.filePath}`];
        const modifiedFns = (fileGraph?.nodes ?? [])
            .filter((n: any) => n?.type === 'function' && (n.diff === 'modified' || n.diff === 'added'))
            .map((n: any) => String(n.label ?? '').replace(/\(.*$/, ''));
        if (modifiedFns.length === 0) { result.push(e); continue; }
        for (const fn of modifiedFns) result.push({ ...e, functionName: fn });
    }
    return result;
}

/** Path-convention sibling tests for files the call graph can't reach. */
function conventionTests(filePath: string, allFiles: ReadonlySet<string>): string[] {
    if (TEST_PATH_PATTERN.test(filePath)) return [];
    const hits: string[] = [];
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const base = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const candidates = [
        `${dir}/__tests__/${base}.test`, `${dir}/__tests__/${base}.spec`,
        `${dir}/${base}.test`, `${dir}/${base}.spec`,
        `${dir}/tests/${base}.test`, `${dir}/test/${base}.test`,
    ];
    for (const f of allFiles) {
        const noExt = f.replace(/\.[^.]+$/, '');
        if (candidates.includes(noExt)) hits.push(f);
    }
    return hits;
}

function detectTestCommand(working: Snapshot, testFiles: string[], changedFiles: string[]): string | null {
    if (testFiles.length === 0 && changedFiles.length === 0) return null;
    const fileKeys = Object.keys((working.files ?? {}) as any);
    const hasJestConfig = fileKeys.some(f => /(^|\/)jest\.config\.(js|ts|mjs|cjs|json)$/.test(f));
    if (hasJestConfig) {
        return changedFiles.length > 0
            ? `npx jest --findRelatedTests ${changedFiles.join(' ')}`
            : `npx jest ${testFiles.join(' ')}`;
    }
    // Default to vitest (the broader modern default; also correct when a
    // vitest.config.* exists).
    return testFiles.length > 0 ? `npx vitest run ${testFiles.join(' ')}` : null;
}

export function computeRegressionScope(opts: ComputeRegressionScopeOptions): RegressionScope {
    const { working, baseline, coverage = null } = opts;
    const changedRaw = changedFilesFromSnapshots(working, baseline);
    const changedEntities = attachFunctionNames(changedRaw, working);
    const changedFiles = [...new Set(changedRaw.map(e => e.filePath))]
        .filter(fp => changedRaw.find(e => e.filePath === fp)!.changeKind !== 'deleted');

    if (changedFiles.length === 0 && changedEntities.length === 0) {
        return {
            changedEntities: [], blastRadius: { direct: [], transitive: [], reviewRequired: [] },
            testsToRun: [], untestedBlastRadius: [], affectedApis: [], crossRepoConsumers: [],
            testCommand: null, coverageAvailable: coverage !== null,
        };
    }

    const impact = analyzeImpact(changedFiles, working, { maxDepth: opts.maxDepth ?? 4, includeTests: true });

    const direct: ImpactedFunction[] = [];
    const transitive: ImpactedFunction[] = [];
    const reviewRequired: ImpactedFunction[] = [];
    const testsByFile = new Map<string, RegressionTestToRun>();

    for (const fn of impact.impactedFunctions ?? []) {
        if (TEST_PATH_PATTERN.test(fn.filePath)) {
            // A test file reaching changed code through the call graph IS
            // a test to run. depth<=1 → it touches changed code directly.
            const reason: RegressionTestToRun['reason'] = fn.depth <= 1 ? 'covers-changed' : 'covers-blast-radius';
            const existing = testsByFile.get(fn.filePath);
            if (!existing || (existing.reason !== 'covers-changed' && reason === 'covers-changed')) {
                testsByFile.set(fn.filePath, { testFile: fn.filePath, reason });
            }
            continue;
        }
        if (fn.impactKind === 'direct') direct.push(fn);
        else if (fn.impactKind === 'transitive') transitive.push(fn);
        else reviewRequired.push(fn);
    }

    // Path-convention siblings for changed files (catches tests the call
    // graph missed — e.g. test frameworks that import dynamically).
    const allFiles = new Set(Object.keys((working.files ?? {}) as any));
    for (const fp of changedFiles) {
        for (const t of conventionTests(fp, allFiles)) {
            if (!testsByFile.has(t)) testsByFile.set(t, { testFile: t, reason: 'path-convention' });
        }
    }
    const testsToRun = [...testsByFile.values()].sort((a, b) => a.testFile.localeCompare(b.testFile));

    // Untested blast radius — the risk list.
    const nonTestBlast = [...direct, ...transitive];
    let untestedBlastRadius: ImpactedFunction[];
    if (coverage) {
        untestedBlastRadius = nonTestBlast.filter(fn => {
            const fileCov = coverage[fn.filePath];
            if (!fileCov) return true;
            const fnCov = fileCov.functions?.[fn.functionName];
            if (fnCov) return fnCov.hits === 0;
            return fileCov.lineRate === 0;
        });
    } else {
        // No coverage data: untested = blast entities in files no resolved
        // test reaches (via call graph or convention).
        const testedFiles = new Set<string>();
        for (const fn of impact.impactedFunctions ?? []) {
            if (!TEST_PATH_PATTERN.test(fn.filePath)) continue;
            // any non-test impacted file at lower depth is "reached" —
            // approximation: when ANY test exists, treat direct files as
            // reached and transitive as unknown→untested.
        }
        const hasAnyTest = testsToRun.length > 0;
        untestedBlastRadius = hasAnyTest
            ? nonTestBlast.filter(fn => fn.impactKind !== 'direct')
            : nonTestBlast;
        void testedFiles;
    }

    // Affected APIs — endpoints whose handler file is changed or in blast.
    const blastFiles = new Set<string>([...changedFiles, ...nonTestBlast.map(f => f.filePath)]);
    const affectedApis: RegressionAffectedApi[] = Object.values((working.apiIndex ?? {}) as any)
        .filter((a: any) => a?.filePath && blastFiles.has(a.filePath))
        .map((a: any) => ({
            apiId: a.apiId, method: a.method, route: a.route,
            surfaceChanged: a.diff === 'modified' || a.diff === 'added' || a.diff === 'deleted',
        }));

    // Cross-repo consumers (multi-repo) — edges targeting THIS repo whose
    // route matches an affected API.
    const crossRepoConsumers: RegressionCrossRepoConsumer[] = [];
    if (opts.crossRepoEdges?.length && opts.repoName) {
        const affectedRoutes = new Set(affectedApis.map(a => `${a.method} ${a.route}`));
        for (const e of opts.crossRepoEdges) {
            if (e.targetRepo !== opts.repoName) continue;
            // Match loosely — path-param canonicalisation differs across
            // extractors (`:id` vs `{id}` vs `${id}`).
            const norm = (r: string) => r.replace(/\{\w+\}|\$\{\w+\}|:(\w+)/g, ':p');
            const hit = [...affectedRoutes].some(ar => {
                const [m, ...rest] = ar.split(' ');
                return m === e.method && norm(rest.join(' ')) === norm(e.route);
            });
            if (hit || affectedRoutes.size === 0) {
                if (hit) crossRepoConsumers.push({ consumerRepo: e.sourceRepo, method: e.method, route: e.route });
            }
        }
    }

    return {
        changedEntities,
        blastRadius: { direct, transitive, reviewRequired },
        testsToRun,
        untestedBlastRadius,
        affectedApis,
        crossRepoConsumers,
        testCommand: detectTestCommand(working, testsToRun.map(t => t.testFile), changedFiles),
        coverageAvailable: coverage !== null,
    };
}
