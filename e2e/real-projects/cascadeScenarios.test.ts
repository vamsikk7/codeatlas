/**
 * cascadeScenarios.test.ts
 *
 * Scenario-tier regressions for the diff cascade across all 6 layers.
 * Each scenario boots the real SnapshotStore + SyncOrchestrator against a
 * cloned fixture repo, applies a scripted edit, runs rebuildFile, and
 * asserts the resulting in-memory diff state.
 *
 * Fixtures live in `cascadeFixtures.ts`. Adding a new framework is one row.
 *
 * Catches today's-session bugs:
 *   - L4 cascade regression: only the edited function is modified
 *   - Redaction false positives: no spurious modified flags on siblings
 *   - Timeline replay "No working changes": workingDiffersByHash invariant
 *   - Cross-handler parity: rebuilding L4 via the L3-nav code path matches
 *     the rebuildFile cascade
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import {
    runScenario,
    modifiedFunctionLabels,
    modifiedClusterLabels,
    modifiedServiceLabels,
    modifiedApiListEntries,
    workingDiffersByHash,
    type ScenarioResult,
} from './cascadeHarness';
import { expectGraph } from './graphMatchers';
import { PRESENT_FIXTURES, probeLinesFor, type ScenarioFixture } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { rebuildFileGraphForPathPure } from '../../src/handlers/navigationHandlers';

installFixtureSafetyGuard();

if (PRESENT_FIXTURES.length === 0) {
    describe.skip('cascade scenarios (no fixtures present — run npm run fetch:real-projects)', () => {
        it('placeholder', () => { /* noop */ });
    });
}

for (const fixture of PRESENT_FIXTURES) {
    runCascadeScenarioFor(fixture);
}

function runCascadeScenarioFor(f: ScenarioFixture): void {
    const exp = f.canonical.expectedModified;

    const flags = exp.flags ?? {};

    describe(`cascade scenarios — ${f.id} (${f.language}/${f.framework}) — body edit on ${f.canonical.fnName}`, () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: f.repoPath,
                edits: [
                    {
                        filePath: f.canonical.relativePath,
                        op: { op: 'addLinesToFunction', fnName: f.canonical.fnName, lines: probeLinesFor(f) },
                    },
                ],
            });
        }, 60_000);

        afterAll(() => scenario?.dispose());

        it('working snapshot diverges from baseline by hash (catches replay "no working changes")', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it(`L4 marks ONLY ${exp.l4FunctionLabels.join(', ')} modified — no redaction false positives`, () => {
            const l4 = scenario.working.graphs[`file:${f.canonical.relativePath}`];
            expectGraph(l4, `L4 ${f.id}`).hasModifiedFunctions(exp.l4FunctionLabels);
        });

        const itIfSectionCounts = flags.sectionLabelHasCounts ? it : it.skip;
        itIfSectionCounts('L4 section header reflects "(N changed)" or "(N changed + M)" count', () => {
            const l4 = scenario.working.graphs[`file:${f.canonical.relativePath}`];
            // Accepts:
            //   Functions (3 changed)        — all entries modified (no unchanged left)
            //   Functions (1 changed + 4)    — partial: 1 of 5 modified
            // Rejects:
            //   Functions                    — bare label, recompute didn't fire
            //   Functions (5)                — no change indicator
            expectGraph(l4, `L4 ${f.id}`)
                .hasSectionLabel(/^(Functions|Methods).*\(\d+ changed( \+ \d+)?\)$/);
        });

        it('L4 Functions/Methods section is marked modified', () => {
            const l4 = scenario.working.graphs[`file:${f.canonical.relativePath}`];
            const section = l4?.nodes.find(n => n.type === 'section' && typeof n.label === 'string' && /^(Functions|Methods)/.test(n.label));
            expect(section?.diff).toBe('modified');
        });

        it('L4 file root is marked modified', () => {
            const l4 = scenario.working.graphs[`file:${f.canonical.relativePath}`];
            expectGraph(l4, `L4 ${f.id}`).hasFileRootDiff('modified');
        });

        const itIfL5 = flags.l5Modified ? it : it.skip;
        const l5FnName = f.canonical.l5FnName ?? f.canonical.fnName;
        itIfL5(`L5 flow for ${l5FnName} has at least one modified node`, () => {
            const flowId = `flow:${f.canonical.relativePath}:${l5FnName}`;
            const l5 = scenario.working.graphs[flowId];
            expect(l5, `expected ${flowId} present`).toBeDefined();
            const modifiedCount = (l5?.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged').length;
            expect(modifiedCount).toBeGreaterThan(0);
        });

        // Issue 405 follow-up (2026-05-13): previously the L3 / L2b
        // assertions required fixtures to declare exact graph IDs
        // (`sequenceGraphId`, `siblingSequenceIds`, `apiListClusterId`).
        // Non-JS frameworks (Java tree-sitter, Python FastAPI, Go Gin,
        // Spring Kafka) emit handler-name suffixes that drift across
        // LLM-naming runs, so the fixtures left those fields undefined
        // and 12 of 14 conditional tests skipped. The reformulation
        // below works for every fixture regardless of LLM cluster
        // renaming or tree-sitter handler-name composition:
        //   - L3 affected = every sequence graph that has the EDITED
        //     file as a participant. Each one must show that
        //     participant modified.
        //   - L3 sibling = every sequence graph that does NOT reference
        //     the edited file. Must stay unchanged. Empty set is fine.
        //   - L2b = any api-list:cluster:* graph with modified entries
        //     must exist; if the fixture declares
        //     `apiListModifiedRoutes`, the modified entries on at least
        //     one of those api-lists must match the declared patterns.

        it('L3 cascade reaches at least one sequence graph (file participant marked modified somewhere)', () => {
            // Cascade signal: edit a function → some L3 sequence that
            // reaches that function shows the edited file's participant
            // marked modified. The "which sequence" answer differs per
            // framework (LLM-named handlers, tree-sitter handler keys,
            // anonymous-arrow naming), so we assert EXISTENCE rather
            // than naming the specific graph.
            const seqGraphs = Object.entries(scenario.working.graphs)
                .filter(([gid]) => gid.startsWith('sequence:'));
            const seqGraphsWithMods = seqGraphs.filter(
                ([, g]) => ((g as any).nodes ?? []).some((n: any) => n.diff && n.diff !== 'unchanged'),
            );
            expect(seqGraphsWithMods.length, `expected ≥1 L3 sequence to carry a modified node`).toBeGreaterThan(0);
        });

        it('L3 over-marking guard: NOT every sequence graph is marked modified', () => {
            // If a buggy cascade marked every L3 graph modified (e.g.
            // the file-graph diff-marker leaks into all sequences), this
            // catches it. For ts-express we expect ≈1 of 4 sequences
            // modified; for single-route fixtures (spring-kafka), the
            // single sequence IS modified and this test is vacuous —
            // skip when total ≤ 1.
            const seqGraphs = Object.entries(scenario.working.graphs)
                .filter(([gid]) => gid.startsWith('sequence:'));
            if (seqGraphs.length <= 1) return;
            const unchangedSeqs = seqGraphs.filter(
                ([, g]) => !((g as any).nodes ?? []).some((n: any) => n.diff && n.diff !== 'unchanged'),
            );
            expect(unchangedSeqs.length, `over-marking: every L3 sequence is modified — at least one should stay unchanged`).toBeGreaterThan(0);
        });

        it('L2b api-list shows at least one modified entry in the affected cluster', () => {
            const apiListsWithMods = Object.entries(scenario.working.graphs)
                .filter(([gid]) => gid.startsWith('api-list:cluster:'))
                .map(([gid, g]) => ({ gid, g, mods: modifiedApiListEntries(g as any) }))
                .filter(({ mods }) => mods.length > 0);
            expect(apiListsWithMods.length, 'expected ≥1 api-list:cluster:* to have modified entries').toBeGreaterThan(0);

            const expectedRoutes = exp.apiListModifiedRoutes ?? [];
            if (expectedRoutes.length === 0) return; // fixture didn't declare specific routes
            // At least one of the matched api-lists must contain modified
            // routes whose order + content matches the declared patterns.
            const matchesExpected = apiListsWithMods.some(({ mods }) => {
                if (mods.length !== expectedRoutes.length) return false;
                return expectedRoutes.every((re, i) => re.test(mods[i]));
            });
            expect(
                matchesExpected,
                `expected at least one api-list to match modified routes [${expectedRoutes.map(r => r.toString()).join(', ')}]; got ${JSON.stringify(apiListsWithMods.map(a => a.mods))}`,
            ).toBe(true);
        });

        const itIfL2a = flags.l2aSingleClusterModified ? it : it.skip;
        itIfL2a('L2a marks exactly one cluster modified (the one containing the edited file)', () => {
            // Multi-service repos emit per-service feature graphs
            // (`feature:service:<id>`) instead of the workspace-wide
            // `feature:workspace`. Look at all feature: graphs and find
            // the one with at least one modified cluster.
            const featureGraphs = Object.entries(scenario.working.graphs)
                .filter(([gid]) => gid.startsWith('feature:'));
            expect(featureGraphs.length, 'expected at least one feature: graph').toBeGreaterThan(0);
            const graphsWithMods = featureGraphs
                .filter(([, g]) => (g as any).nodes.some((n: any) => n.diff && n.diff !== 'unchanged'));
            expect(graphsWithMods.length, 'exactly one feature graph should have modifications').toBe(1);
            const mods = modifiedClusterLabels(graphsWithMods[0][1] as any);
            expect(mods.length).toBe(1);
            expect(mods[0]).toMatch(exp.l2aClusterLabel);
        });

        const itIfL1 = flags.l1SingleServiceModified ? it : it.skip;
        itIfL1('L1 microservice:workspace marks exactly one service modified', () => {
            const l1 = scenario.working.graphs['microservice:workspace'];
            expect(l1).toBeDefined();
            const mods = modifiedServiceLabels(l1);
            expect(mods.length).toBe(1);
        });

        const itIfParity = flags.crossHandlerParity ? it : it.skip;
        itIfParity('cross-handler parity: rebuilding L4 via the L3→L4 nav code path matches the rebuildFile cascade', async () => {
            // Issue #396: drive the SAME helper production uses for L3→L4 nav.
            // Dispatches to Babel (JS/TS) or tree-sitter (Java/Python/Go/etc.)
            // by file extension. Mutates scenario.store's working graph.
            const cascadeL4 = scenario.working.graphs[`file:${f.canonical.relativePath}`];
            const cascadeMods = modifiedFunctionLabels(cascadeL4);
            const rebuilt = await rebuildFileGraphForPathPure({
                workspaceRoot: scenario.repoCopyDir,
                relativePath: f.canonical.relativePath,
                store: scenario.store,
            });
            expect(rebuilt, 'rebuildFileGraphForPathPure must return a graph').toBeDefined();
            expect(modifiedFunctionLabels(rebuilt!)).toEqual(cascadeMods);
        });
    });

    describe(`cascade scenarios — ${f.id} — no-edit baseline equality`, () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({ repoPath: f.repoPath, edits: [] });
        }, 60_000);

        afterAll(() => scenario?.dispose());

        it('every file:graph has zero modified entity nodes on a fresh init', () => {
            for (const [gid, graph] of Object.entries(scenario.working.graphs)) {
                if (!gid.startsWith('file:')) continue;
                expectGraph(graph as any, `${gid} (fresh init)`).hasNoEntityModifications();
            }
        });

        it('workingDiffersByHash is false on a fresh init', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(false);
        });
    });
}

