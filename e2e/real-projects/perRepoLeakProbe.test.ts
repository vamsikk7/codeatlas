/**
 * perRepoLeakProbe.test.ts
 *
 * Companion to `perRepoCascadeProbe.test.ts`. The cascade probe asserts
 * that an edit FIRES the cascade across L1-L5. This probe asserts the
 * cascade also UNFIRES cleanly when the edit is reverted — i.e. no
 * layer leaks modified-state past the revert.
 *
 * The live-verify SKILL.md tracked the leak rate as the primary
 * cross-framework health metric. The 2026-05-16 baseline at
 * `.live-verify-snapshots/all37-perlayer-2026-05-16.txt` showed L2a
 * feature leaking 100% (35/35 repos) — every backend repo left the
 * feature cluster marked modified even after the source had been
 * restored to baseline content. The cascade rework (#423/#429) is the
 * fix; this probe is the regression gate so the leak rate stays low.
 *
 * For each backend fixture:
 *   1. Bootstrap → pick an editable function (same logic as the
 *      cascade probe).
 *   2. Apply an `addLinesToFunction` edit through the harness, assert
 *      the L4 file graph has at least one modified node (sanity:
 *      cascade fired, otherwise the revert assertion is meaningless).
 *   3. Write the original file content back to disk + call
 *      `rebuildFile` on the same absolute path so the cascade gets a
 *      second pass against the restored content.
 *   4. Re-read the working snapshot. Assert each per-layer modified
 *      count is back to ZERO: L5 flow, L4 file, L2b api-list,
 *      L2a feature:workspace, L1 microservice:workspace.
 *
 * Any non-zero count after revert is a cascade leak — that layer has
 * stale modified state, which surfaces in the live extension as a
 * persistent "modified" badge that won't clear until the user
 * re-initializes.
 *
 * **DO NOT** add fixes from this file. Observations land in ISSUES.md
 * with finish lines; fixes happen in dedicated commits.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    runScenario,
    applyEditOp,
    modifiedClusterLabels,
    modifiedServiceLabels,
    modifiedApiListEntries,
    modifiedFunctionLabels,
} from './cascadeHarness';
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
 * Repos with known pre-existing per-layer leaks (each tracked as its
 * own ISSUES.md entry). The probe SKIPS the asserted layers for these
 * repos but still asserts every other layer cleans up. Resolving the
 * underlying issue should let you remove the repo from this map.
 *
 * If a repo not in this map starts leaking, the probe fails — that's
 * the regression gate. If a repo IN this map STOPS leaking, the probe
 * also fails (because the unexpected pass means the quarantine is now
 * out of date — intentional, prompts the user to close the issue and
 * tighten the quarantine).
 */
const LEAK_QUARANTINE: Record<string, ReadonlyArray<'L4' | 'L5' | 'L2b' | 'L2a' | 'L1'>> = {
    // All known leaks closed in 6.1.3. New leaks land here paired with an
    // ISSUES.md entry; resolving the issue should also empty the row.
};
function isQuarantined(repoId: string, layer: 'L4' | 'L5' | 'L2b' | 'L2a' | 'L1'): boolean {
    return (LEAK_QUARANTINE[repoId] ?? []).includes(layer);
}

/**
 * Same logic as `perRepoCascadeProbe.test.ts`. Duplicated here because
 * a test file can't be imported. Kept narrow (~30 LOC) on purpose; if
 * a third probe shows up, promote to a shared helper.
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
            const labelRaw = (node.label ?? '').replace(/\(.*$/, '').trim();
            if (!labelRaw) continue;
            const fnName = labelRaw.includes('.') ? labelRaw.split('.').pop()! : labelRaw;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) continue;
            if (fnName.length < 3) continue;
            // Skip Java/C# constructors (label `ClassName.ClassName`).
            if (labelRaw.includes('.')) {
                const parts = labelRaw.split('.');
                if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) continue;
            }
            if (['main', 'constructor', 'toString', 'equals', 'hashCode', 'init', 'render',
                 'render!', 'build', 'create', 'show', 'get', 'set', 'index', 'name', 'id',
                 'update', 'delete', 'save', 'find', 'load'].includes(fnName)) continue;
            candidates.push({ filePath, fnName, nodeCount: fg.nodes.length });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.nodeCount - a.nodeCount);
    for (let i = 0; i < Math.min(30, candidates.length); i++) {
        const c = candidates[i];
        const src = fs.readFileSync(path.join(repoCopyDir, c.filePath), 'utf-8');
        const re = new RegExp(`\\b${c.fnName}\\s*\\(`);
        if (!re.test(src)) continue;
        try {
            applyEditOp(src, { op: 'addLinesToFunction', fnName: c.fnName, lines: ['// preflight'] });
            return c;
        } catch {
            continue;
        }
    }
    return null;
}

(skip ? describe.skip : describe)('PER-REPO leak probe — revert returns every layer to clean', () => {
    for (const repo of allRepos) {
        it(`${repo.id} (${repo.language}/${repo.framework}): revert clears all layers`, async () => {
            const repoPath = path.join(REAL_REPOS_DIR, repo.id);

            // ─── Step 1: bootstrap + pick a function ──────────────────
            const bootstrap = await runScenario({ repoPath, edits: [] });
            const target = pickEditTarget(bootstrap.baseline, bootstrap.repoCopyDir);
            bootstrap.dispose();
            if (!target) {
                console.warn(`[${repo.id}] no editable function — skipping leak probe`);
                return;
            }

            // ─── Step 2: apply the cascade edit ───────────────────────
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
                // Sanity: the cascade fired. Without this the revert assertion is meaningless
                // (clean state → trivially passes). Skip the leak assertions for this repo if
                // the picked target was unsuitable (e.g. Java constructor with the same name
                // as its class, where `addLinesToFunction` lands in the wrong place).
                const fileGraphAfterEdit = result.working.graphs?.[`file:${target.filePath}`];
                const modifiedAfterEdit = modifiedFunctionLabels(fileGraphAfterEdit);
                if (modifiedAfterEdit.length === 0) {
                    console.warn(`[${repo.id}] cascade didn't fire for ${target.filePath}::${target.fnName} — skipping leak assertions`);
                    return;
                }

                // ─── Step 3: revert by writing oldContent back ─────────
                const editEntry = result.appliedEdits[0];
                const absPath = path.join(result.repoCopyDir, editEntry.filePath);
                fs.writeFileSync(absPath, editEntry.oldContent, 'utf-8');
                await result.sync.rebuildFile(absPath);
                result.store.save();

                const postRevert = result.store.getWorking();

                // ─── Step 4: assert every layer back to clean ──────────
                // The quarantine pattern: if a layer is listed for this
                // repo, assert it STAYS leaking (so fixing the leak
                // upstream fails this test → forces the user to remove
                // the quarantine row). If not listed, assert clean.
                const assertLayer = <T>(layer: 'L4' | 'L5' | 'L2b' | 'L2a' | 'L1', actual: T, isClean: (v: T) => boolean, msg: string) => {
                    if (isQuarantined(repo.id, layer)) {
                        expect(
                            isClean(actual),
                            `${repo.id}: ${layer} is on the LEAK_QUARANTINE but probe found it clean — close the underlying issue and remove the quarantine row`,
                        ).toBe(false);
                    } else {
                        expect(isClean(actual), msg).toBe(true);
                    }
                };

                const fileGraphPost = postRevert.graphs?.[`file:${target.filePath}`];
                const l4Modified = modifiedFunctionLabels(fileGraphPost);
                assertLayer('L4', l4Modified, (v) => v.length === 0,
                    `${repo.id}: L4 file:${target.filePath} still has modified functions after revert: ${l4Modified.join(', ')}`);

                // L5 flow graph — only assert if a flow graph exists for the picked fn.
                const flowKey = Object.keys(postRevert.graphs ?? {}).find(k =>
                    k === `flow:${target.filePath}:${target.fnName}` ||
                    (k.startsWith(`flow:${target.filePath}:`) && k.endsWith(`.${target.fnName}`)),
                );
                if (flowKey) {
                    const flowGraph = postRevert.graphs?.[flowKey];
                    const l5Modified = (flowGraph?.nodes ?? []).filter((n: any) => n.diff && n.diff !== 'unchanged');
                    assertLayer('L5', l5Modified, (v) => v.length === 0,
                        `${repo.id}: L5 ${flowKey} still has ${l5Modified.length} modified node(s) after revert`);
                }

                // L2b — any api-list graph leaks fail the probe; quarantine applies workspace-wide for the repo.
                const l2bLeakingGraphs: string[] = [];
                for (const [gid, g] of Object.entries(postRevert.graphs ?? {})) {
                    if (!gid.startsWith('api-list:')) continue;
                    const modifiedApis = modifiedApiListEntries(g as any);
                    if (modifiedApis.length > 0) {
                        l2bLeakingGraphs.push(`${gid}=[${modifiedApis.join(', ')}]`);
                    }
                }
                assertLayer('L2b', l2bLeakingGraphs, (v) => v.length === 0,
                    `${repo.id}: L2b api-list graphs still show modified routes after revert: ${l2bLeakingGraphs.join(' | ')}`);

                // L2a feature:workspace — the canonical leak metric from the 2026-05-16 baseline.
                const featureGraph = postRevert.graphs?.['feature:workspace'];
                const l2aModified = modifiedClusterLabels(featureGraph);
                assertLayer('L2a', l2aModified, (v) => v.length === 0,
                    `${repo.id}: L2a feature:workspace still has modified clusters after revert: ${l2aModified.join(', ')}`);

                // L1 microservice:workspace — same shape as L2a.
                const microGraph = postRevert.graphs?.['microservice:workspace'];
                const l1Modified = modifiedServiceLabels(microGraph);
                assertLayer('L1', l1Modified, (v) => v.length === 0,
                    `${repo.id}: L1 microservice:workspace still has modified services after revert: ${l1Modified.join(', ')}`);
            } finally {
                result.dispose();
            }
        }, 120_000);
    }
});
