/**
 * cascadeEditOpScenarios.test.ts
 *
 * Issue #379: per-edit-op cascade scenarios.
 *
 * Locks in the diff-status transitions the live extension produces for the
 * four edit shapes that have no prior T3 coverage:
 *
 *  - addFunction      → expect at least one `added` function node
 *  - deleteFunction   → expect a `deleted` ghost node + workingDiffers
 *  - renameFunction   → expect an `added` + a `deleted` (key change)
 *  - createFile       → expect a brand-new L4 file:graph and a new L5 flow:graph
 *
 * Each scenario uses the `ts-express-realworld` fixture from
 * `cascadeFixtures.ts` (single canonical entry today; Issue #385 covers the
 * planned multi-framework rollout).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { runScenario, workingDiffersByHash, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

const NEW_FN_NAME = 'cascadeProbeNewFn';
const NEW_FILE_REL = 'src/app/routes/auth/cascade-probe.ts';

// Centralised fixture-safety guard (Issue #390). The leak check below
// protects against the createFile scenario writing into the SOURCE
// fixture path — a separate concern from the general sentinel hash.
installFixtureSafetyGuard();
afterAll(() => {
    if (TS_EXPRESS) {
        const addedAbs = path.join(TS_EXPRESS.repoPath, NEW_FILE_REL);
        if (fs.existsSync(addedAbs)) {
            throw new Error(`createFile scenario leaked ${addedAbs} into the source fixture.`);
        }
    }
});

d('cascade edit-op scenarios — ts-express-realworld', () => {

    describe('addFunction → new exported function appears as `added`', () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: TS_EXPRESS!.repoPath,
                edits: [
                    {
                        filePath: TS_EXPRESS!.canonical.relativePath,
                        op: {
                            op: 'addFunction',
                            declaration: `export const ${NEW_FN_NAME} = async (x: number) => {\n  return x + 1;\n};\n`,
                        },
                    },
                ],
            });
        }, 60_000);
        afterAll(() => scenario?.dispose());

        it('workingDiffersByHash is true', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it('L4 file:graph contains an `added` function node with the new name', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            expect(l4).toBeDefined();
            const addedFns = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'added')
                .map(n => n.label as string);
            expect(addedFns).toContain(NEW_FN_NAME);
        });

        it('L4 has no functions marked `deleted` (pure addition)', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const deletedFns = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'deleted');
            expect(deletedFns).toEqual([]);
        });

        it('L5 flow:graph is created for the added function', () => {
            const flowId = `flow:${TS_EXPRESS!.canonical.relativePath}:${NEW_FN_NAME}`;
            expect(scenario.working.graphs[flowId], `expected ${flowId} present`).toBeDefined();
        });
    });

    describe('deleteFunction → removed function appears as `deleted` ghost', () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: TS_EXPRESS!.repoPath,
                edits: [
                    {
                        filePath: TS_EXPRESS!.canonical.relativePath,
                        // updateUser is the last export — safe to remove; no callers inside auth.service.ts.
                        op: { op: 'deleteFunction', fnName: 'updateUser' },
                    },
                ],
            });
        }, 60_000);
        afterAll(() => scenario?.dispose());

        it('workingDiffersByHash is true', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it('L4 file:graph carries a `deleted` ghost node for the removed function', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            expect(l4).toBeDefined();
            // The L4 builder annotates ghost nodes with a " (deleted)" suffix
            // on the label so users can disambiguate baseline-only nodes from
            // live ones. Test against the base function name.
            const deletedBaseNames = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'deleted')
                .map(n => ((n.label as string) ?? '').replace(/\s*\(deleted\)\s*$/, ''));
            expect(deletedBaseNames).toContain('updateUser');
        });

        it('L4 has no other-side false `added` (delete is not an add)', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const addedFns = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'added');
            expect(addedFns).toEqual([]);
        });
    });

    describe('renameFunction → key change produces an added + deleted pair', () => {
        let scenario: ScenarioResult;
        const RENAMED = 'getCurrentUserRenamed';

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: TS_EXPRESS!.repoPath,
                edits: [
                    {
                        filePath: TS_EXPRESS!.canonical.relativePath,
                        op: { op: 'renameFunction', fromName: TS_EXPRESS!.canonical.fnName, toName: RENAMED },
                    },
                ],
            });
        }, 60_000);
        afterAll(() => scenario?.dispose());

        it('workingDiffersByHash is true', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it('L4 file:graph has the new name as `added`', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const addedFns = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'added')
                .map(n => n.label as string);
            expect(addedFns).toContain(RENAMED);
        });

        it('L4 file:graph has the old name as `deleted`', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const deletedBaseNames = (l4!.nodes ?? [])
                .filter(n => n.type === 'function' && n.diff === 'deleted')
                .map(n => ((n.label as string) ?? '').replace(/\s*\(deleted\)\s*$/, ''));
            expect(deletedBaseNames).toContain(TS_EXPRESS!.canonical.fnName);
        });

        it('L5 flow:graph for the new name exists', () => {
            const flowId = `flow:${TS_EXPRESS!.canonical.relativePath}:${RENAMED}`;
            expect(scenario.working.graphs[flowId], `expected ${flowId} present`).toBeDefined();
        });
    });

    describe('undo → modify then revert; every layer returns to clean state (Issue #380)', () => {
        let scenario: ScenarioResult;
        const PROBE_LINES = [`console.log('[undo-probe-1]');`, `console.log('[undo-probe-2]');`];

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: TS_EXPRESS!.repoPath,
                edits: [
                    // Phase 1: add two log lines into getCurrentUser.
                    {
                        filePath: TS_EXPRESS!.canonical.relativePath,
                        op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: PROBE_LINES },
                    },
                    // Phase 2: revert by removing the same two lines.
                    {
                        filePath: TS_EXPRESS!.canonical.relativePath,
                        op: {
                            op: 'replace',
                            oldText: PROBE_LINES.map(l => `  ${l}`).join('\n') + '\n',
                            newText: '',
                        },
                    },
                ],
            });
        }, 60_000);
        afterAll(() => scenario?.dispose());

        it('after revert: workingDiffersByHash is false', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(false);
        });

        it('after revert: L4 has zero modified/added/deleted entity nodes', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            expect(l4).toBeDefined();
            const dirty = (l4!.nodes ?? []).filter(
                n => n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
            );
            expect(dirty).toEqual([]);
        });

        it('after revert: L4 file root + section labels are back to clean form', () => {
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const fileRoot = l4?.nodes.find(n => n.type === 'file');
            expect(fileRoot?.diff ?? 'unchanged').toBe('unchanged');
            // Section labels must NOT contain "X changed + Y" — that's the
            // modified-mode form. Clean form is the bare count "(N)".
            const sections = (l4?.nodes ?? []).filter(n => n.type === 'section');
            for (const s of sections) {
                expect(typeof s.label === 'string' ? s.label : '').not.toMatch(/changed/i);
            }
        });

        it('after revert: L5 flow:graph for the edited function is fully unchanged', () => {
            const flowId = `flow:${TS_EXPRESS!.canonical.relativePath}:${TS_EXPRESS!.canonical.fnName}`;
            const l5 = scenario.working.graphs[flowId];
            expect(l5).toBeDefined();
            const dirty = (l5!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
            expect(dirty).toEqual([]);
        });

        it('after revert: L3 sequence for the affected route is fully unchanged', () => {
            const seqId = TS_EXPRESS!.canonical.expectedModified.sequenceGraphId;
            const l3 = scenario.working.graphs[seqId];
            expect(l3).toBeDefined();
            const dirty = (l3!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
            expect(dirty).toEqual([]);
        });

        it('after revert: L2a feature:workspace has zero modified clusters', () => {
            const l2a = scenario.working.graphs['feature:workspace'];
            expect(l2a).toBeDefined();
            const dirty = (l2a!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
            expect(dirty).toEqual([]);
        });

        it('after revert: L1 microservice:workspace has zero modified services', () => {
            const l1 = scenario.working.graphs['microservice:workspace'];
            expect(l1).toBeDefined();
            const dirty = (l1!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
            expect(dirty).toEqual([]);
        });
    });

    describe('createFile → brand-new file produces a new L4 + L5 graph', () => {
        let scenario: ScenarioResult;
        const NEW_CONTENT = `export const greet = (name: string) => {\n  return 'hello ' + name;\n};\n`;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: TS_EXPRESS!.repoPath,
                edits: [
                    { filePath: NEW_FILE_REL, op: { op: 'createFile', content: NEW_CONTENT } },
                ],
            });
        }, 60_000);
        afterAll(() => scenario?.dispose());

        it('workingDiffersByHash is true', () => {
            expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        });

        it('a new L4 file:graph exists for the created path', () => {
            const l4 = scenario.working.graphs[`file:${NEW_FILE_REL}`];
            expect(l4, `expected file:${NEW_FILE_REL} present`).toBeDefined();
        });

        it('the new L4 graph has a function node for the only exported function', () => {
            const l4 = scenario.working.graphs[`file:${NEW_FILE_REL}`];
            const fnLabels = (l4!.nodes ?? [])
                .filter(n => n.type === 'function')
                .map(n => n.label as string);
            expect(fnLabels).toContain('greet');
        });

        it('a new L5 flow:graph exists for the new file\'s function', () => {
            const flowId = `flow:${NEW_FILE_REL}:greet`;
            expect(scenario.working.graphs[flowId], `expected ${flowId} present`).toBeDefined();
        });

        it('the new file path is recorded in working.files (snapshot tracks it)', () => {
            expect(scenario.working.files[NEW_FILE_REL], `expected working.files[${NEW_FILE_REL}] present`).toBeDefined();
        });
    });
});
