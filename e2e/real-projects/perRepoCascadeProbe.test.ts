/**
 * perRepoCascadeProbe.test.ts
 *
 * For every cloned real-project repo:
 *   1. Initialize the pipeline against a tmpdir copy.
 *   2. Auto-discover an editable function (we walk the initial snapshot's
 *      functions table and pick the most-substantial body we can find in a
 *      JS/TS/Python/Java/Go/Ruby/Kotlin/Rust/PHP/Swift/Dart/C# file).
 *   3. Apply an `addLinesToFunction` edit on the picked function via the
 *      existing cascade harness, which exercises rebuildFile end-to-end
 *      (L5 inline diff → L4 marker → L3 cascade → L2b api-list → L2a/L1 upgrade).
 *   4. Cross-check: baseline hash != working hash, at least one L4 file
 *      graph has a modified entity node, at least one L3 sequence graph
 *      has its file-participant marked modified (or zero if the chosen
 *      function isn't a route handler — many functions aren't).
 *
 * This is a deep coverage probe — it goes beyond `cascadeScenarios.test.ts`
 * (which only covers 5 hand-picked fixtures) and validates the cascade
 * pipeline across ALL 37 cloned repos. Any divergence here points to a
 * framework/language gap the unit suite hasn't surfaced.
 *
 * **DO NOT** add fixes from this file. Per project policy, observations
 * land in ISSUES.md with finish lines; fixes happen in dedicated commits.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario, applyEditOp } from './cascadeHarness';
import { isBackendRepo } from './repoCategories';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');
const REPOS_MANIFEST = path.join(__dirname, 'repos.json');

interface RepoEntry {
    id: string;
    language: string;
    framework: string;
}

const allRepos: RepoEntry[] = (() => {
    try {
        const m = JSON.parse(fs.readFileSync(REPOS_MANIFEST, 'utf-8'));
        return (m.repos as RepoEntry[])
            .filter(r => isBackendRepo(r.id))
            .filter(r => fs.existsSync(path.join(REAL_REPOS_DIR, r.id)));
    } catch {
        return [];
    }
})();

const isCi = !!process.env.CI;
const skip = isCi || allRepos.length === 0;

/**
 * Repos where the probe's auto-pick reliably lands on a function shape
 * the cascade pipeline mis-handles (constructors with same name as the
 * enclosing class, expression-bodied C# methods, etc.). Tracked as
 * separate ISSUES.md entries; remove a repo from this set once the
 * underlying cascade-skip is closed.
 */
const KNOWN_CASCADE_SKIPS = new Set<string>([
    // All known cascade-skips closed. New cases land here paired with an
    // ISSUES.md entry; remove a repo from this set once the underlying
    // cascade-skip is closed.
]);

/**
 * Pick a function to edit from the initial snapshot. We prefer functions
 * with bodies long enough to safely insert a line (at least ~3 statements).
 * Returns null if no suitable function exists — caller should skip the repo.
 */
function pickEditTarget(snap: any, repoCopyDir: string):
    | { filePath: string; fnName: string }
    | null {
    const fileGraphs: any[] = Object.values(snap.graphs || {})
        .filter((g: any) => g.type === 'file' && Array.isArray(g.nodes));

    const candidates: Array<{ filePath: string; fnName: string; nodeCount: number }> = [];
    for (const fg of fileGraphs) {
        const filePath = fg.meta?.filePath as string | undefined;
        if (!filePath) continue;
        const absPath = path.join(repoCopyDir, filePath);
        if (!fs.existsSync(absPath)) continue;
        if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|java|kt|go|rb|rs|cs|swift|dart|php)$/.test(filePath)) continue;

        for (const node of fg.nodes) {
            if (node.type !== 'function') continue;
            // Label shapes observed across languages:
            //   JS/TS:  "doStuff()"  or  "doStuff"
            //   Python/Go/Rust: "do_stuff"
            //   Java/Kotlin/C#/Swift/PHP/Ruby/Dart: "ClassName.methodName"
            //   ts decorator-controllers: "ClassName.method()"
            const labelRaw = (node.label ?? '').replace(/\(.*$/, '').trim();
            if (!labelRaw) continue;
            // Strip class prefix — we want the method/function name we can grep
            // for `name(` in source. (Most languages' function declarations
            // include the name followed by `(`.)
            const fnName = labelRaw.includes('.') ? labelRaw.split('.').pop()! : labelRaw;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) continue;
            if (fnName.length < 3) continue;
            // Skip very common collisions / noisy names.
            if (['main', 'constructor', 'toString', 'equals', 'hashCode', 'init', 'render',
                 'render!', 'build', 'create', 'show', 'get', 'set', 'index', 'name', 'id',
                 'update', 'delete', 'save', 'find', 'load'].includes(fnName)) continue;
            candidates.push({ filePath, fnName, nodeCount: fg.nodes.length });
        }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.nodeCount - a.nodeCount);
    // Try up to 30 candidates — addLinesToFunction is picky about body shapes
    // (decorator macros, Rust attribute headers, etc.). A repo that has zero
    // editable candidates among the top 30 is genuinely a coverage gap.
    // #420 / #421: preflight each candidate through applyEditOp so we skip
    // bodyless arrows and Ruby-shape blockers before runScenario fires the
    // full cascade pipeline.
    for (let i = 0; i < Math.min(30, candidates.length); i++) {
        const c = candidates[i];
        const src = fs.readFileSync(path.join(repoCopyDir, c.filePath), 'utf-8');
        const re = new RegExp(`\\b${c.fnName}\\s*\\(`);
        if (!re.test(src)) continue;
        try {
            applyEditOp(src, { op: 'addLinesToFunction', fnName: c.fnName, lines: ['// preflight'] });
            return c;
        } catch {
            // Candidate is bodyless / unsupported shape — try next.
            continue;
        }
    }
    return null;
}

(skip ? describe.skip : describe)('PER-REPO cascade probe — every cloned real-project repo', () => {
    for (const repo of allRepos) {
        const testFn = KNOWN_CASCADE_SKIPS.has(repo.id) ? it.skip : it;
        testFn(`${repo.id} (${repo.language}/${repo.framework}): cascade fires for an arbitrary function edit`, async () => {
            const repoPath = path.join(REAL_REPOS_DIR, repo.id);

            // Step 1: bootstrap — run an empty scenario to get the initial
            // snapshot so we can pick an edit target.
            let bootstrap;
            try {
                bootstrap = await runScenario({ repoPath, edits: [] });
            } catch (err: any) {
                // Bootstrap itself failed — this is a pipeline initialization
                // bug for this repo. Record it.
                throw new Error(`bootstrap failed: ${err.message}`);
            }

            const target = pickEditTarget(bootstrap.baseline, bootstrap.repoCopyDir);
            bootstrap.dispose();

            if (!target) {
                // No suitable function detected — not a cascade bug per se,
                // but worth flagging on repos where the snapshot has truly
                // zero named functions in any file.
                console.warn(`[${repo.id}] no editable function in initial snapshot — repo may have low coverage`);
                return;
            }

            // Step 2: full scenario — apply addLinesToFunction and assert
            // the cascade markers.
            //
            // Comments don't generate L5 flow-graph nodes — they only flip
            // the bytewise file hash. To exercise the full L5 cascade we
            // insert a real per-language statement. (Mirrors the live-verify
            // driver `/tmp/verify-one-repo.sh`.)
            const probeStmt = (() => {
                const ext = target.filePath.split('.').pop() ?? '';
                const stamp = Date.now();
                switch (ext) {
                    case 'py': return `_probe_${stamp} = ${stamp}`;
                    case 'rb': return `_probe_${stamp} = ${stamp}`;
                    case 'php': return `$_probe_${stamp} = ${stamp};`;
                    case 'go':
                    case 'rs':
                    case 'kt':
                    case 'kts':
                    case 'java':
                    case 'cs':
                    case 'swift':
                    case 'dart':
                        return `var _probe_${stamp} = ${stamp};`;
                    default:
                        return `const _probe_${stamp} = ${stamp};`;
                }
            })();
            const result = await runScenario({
                repoPath,
                edits: [{
                    filePath: target.filePath,
                    op: { op: 'addLinesToFunction', fnName: target.fnName, lines: [probeStmt] },
                }],
            });

            try {
                // Cascade signal 1: baseline JSON != working JSON (working snapshot diverges).
                // Previously this compared `JSON.stringify(...).length`, but length equality
                // is a brittle false-positive proxy for content equality — character counts
                // can match between two structurally different graphs by coincidence
                // (Issue #723 — java-jaxrs LocalCache constructor pick coincidentally
                // produced length-equal but content-different graphs in the full suite).
                const baselineFileJson = JSON.stringify(result.baseline.graphs?.[`file:${target.filePath}`] ?? {});
                const workingFileJson = JSON.stringify(result.working.graphs?.[`file:${target.filePath}`] ?? {});
                expect(workingFileJson, `${repo.id}: working file graph identical to baseline`).not.toBe(baselineFileJson);

                // Cascade signal 2: at least one node in the L4 file graph carries diff != 'unchanged'.
                const fileGraph = result.working.graphs?.[`file:${target.filePath}`];
                expect(fileGraph, `${repo.id}: no L4 file graph at file:${target.filePath} (picked ${target.fnName})`).toBeDefined();
                const modifiedNodes = (fileGraph?.nodes ?? []).filter((n: any) => n.diff && n.diff !== 'unchanged');
                // #438 — historically Go method-receivers and Java/Rust
                // decorator-shapes didn't surface modified L4 nodes after a
                // body edit. The cascade rework (Issue #423 + #429) closed
                // that gap. We assert hard so any regression fails the test
                // — see Issues #437 / #438 / #439 for the original symptoms.
                expect(
                    modifiedNodes.length,
                    `${repo.id}: L4 file graph shows zero modified nodes for picked ${target.filePath}::${target.fnName} — cascade-skip regression (#438 cousin)`,
                ).toBeGreaterThan(0);

                // Cascade signal 3: the orchestrator's rebuild trail mentions
                // at least the L4 file graph (always) and ideally cascades up.
                expect(result.rebuiltGraphIds.length, `${repo.id}: rebuildFile returned an empty graphIds list`).toBeGreaterThan(0);
                expect(
                    result.rebuiltGraphIds.some(g => g === `file:${target.filePath}`),
                    `${repo.id}: file:${target.filePath} not in rebuilt graph trail`,
                ).toBe(true);

                // Cascade signal 4 (#424 / #437 / #439): when the picked
                // function has a baseline L5 flow graph, the body-insertion
                // edit must flip the working flow graph too. Originally a soft
                // warning because Java class methods and Rust attribute-
                // decorated functions tripped it (#437, #439); the cascade
                // rework closed those, so we now assert. A failure here means
                // the L4 cascade fired but the per-function L5 flow rebuild
                // got skipped — a real regression to investigate.
                const flowKeyExact = `flow:${target.filePath}:${target.fnName}`;
                const flowKeyClassMethod = Object.keys(result.working.graphs ?? {}).find(k =>
                    k.startsWith(`flow:${target.filePath}:`) && k.endsWith(`.${target.fnName}`),
                );
                const flowKey = result.working.graphs?.[flowKeyExact] ? flowKeyExact : flowKeyClassMethod;
                if (flowKey && result.baseline.graphs?.[flowKey]) {
                    const workingFlow = JSON.stringify(result.working.graphs[flowKey] ?? {});
                    const baselineFlow = JSON.stringify(result.baseline.graphs[flowKey] ?? {});
                    expect(
                        workingFlow,
                        `${repo.id}: L5 flow graph ${flowKey} identical to baseline despite body-insertion edit on ${target.fnName} — cascade-skip regression (#437 / #439 cousin)`,
                    ).not.toBe(baselineFlow);
                }
            } finally {
                result.dispose();
            }
        }, 120_000);
    }
});
