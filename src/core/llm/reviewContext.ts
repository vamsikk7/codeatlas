// #review-context — the shared review-context assembler. Given a SnapshotStore and
// a changed-file set, it returns everything an LLM needs to review a diff/branch/PR
// WITHOUT calling an LLM: the reviewer instructions (identical to the extension /
// PR-watcher prompt), per-entry packs for changed entry points, diff windows of the
// changed files, and cross-file dependents. This is the payload the MCP
// `get_review_context` tool returns, so the MCP and the extension review the same
// context with the same instructions (parity by construction).

import type { SnapshotStore } from '../storage/snapshotStore';
import { buildReviewSystemPrompt, diffWindow, SOURCE_EXT } from './projectLevelReviewer';
import { buildDependentsForFiles, type FileDependents, type DependencyStoreLike } from './dependencyContext';
import { getEntryPointPack, type EntryPointPack } from '../../mcp/contextPack';

export interface ReviewContextResult {
    /** System prompt: bug-class taxonomy + DEPENDENTS reasoning + PRECISION GATES + guidelines. */
    instructions: string;
    /** User-supplied review guidelines folded into the instructions. */
    guidelines: string;
    /** Normalized changed-file paths (the review scope). */
    changedFiles: string[];
    /** Diff windows (`+`/`-` hunks) of the changed source files — the project-pass payload. */
    fileDiffs: { filePath: string; diff: string }[];
    /** Per-entry packs (handler diff + call chain) for changed entry points. */
    entryPacks: EntryPointPack[];
    /** Cross-file callers / implementers / sibling-impls / tests of the changed files (#946). */
    dependents: FileDependents[];
}

const norm = (p: string): string => p.replace(/^\.\//, '').trim();

/**
 * Assemble review context for a changed-file set. Pure (no LLM call); deterministic
 * for a given snapshot. `changedFiles` comes from the git review-diff helpers
 * (diff / branch / working-tree).
 */
export function buildReviewContext(args: {
    store: SnapshotStore;
    changedFiles: string[];
    guidelines?: string;
    maxEntryPacks?: number;
}): ReviewContextResult {
    const { store, maxEntryPacks = 25 } = args;
    const snapshot = store.getWorking();
    const guidelines = args.guidelines ?? store.getReviewGuidelines?.()?.text ?? '';

    const changedSet = new Set(args.changedFiles.map(norm).filter(Boolean));
    const sourceFiles = [...changedSet].filter((f) => SOURCE_EXT.test(f));

    const working = (fp: string): string | undefined =>
        store.getFileContent?.('working', fp) ?? (snapshot.files as Record<string, { content?: string }> | undefined)?.[fp]?.content;
    const baseline = (fp: string): string | undefined => store.getFileContent?.('baseline', fp);

    // Project-pass payload: diff windows of every changed source file.
    const fileDiffs = sourceFiles.map((fp) => {
        const w = working(fp) ?? '';
        return { filePath: fp, diff: w ? diffWindow(w, baseline(fp)) : '' };
    });

    // Per-entry packs for entry points that live in a changed file.
    const apiIndex = (snapshot.apiIndex ?? {}) as Record<string, { method?: string; route?: string; filePath?: string; anchor?: { filePath?: string }; meta?: { routeDeclFile?: string } }>;
    const entryPacks: EntryPointPack[] = [];
    for (const rec of Object.values(apiIndex)) {
        if (entryPacks.length >= maxEntryPacks) break;
        // Match the resolved handler file (filePath / anchor.filePath) OR the
        // route-DECLARATION file (`meta.routeDeclFile`). Frameworks that split
        // the route (Django `urls.py`, Rails `routes.rb`) from the handler
        // (`views.py`, `*_controller.rb`) declare the endpoint in one file but
        // the LOGIC in another — the anchor passes re-anchor filePath onto the
        // handler and stash the route file in `meta.routeDeclFile`, so a change
        // to EITHER file must surface that endpoint's pack (TICKET-ANCHOR-1).
        const inChanged = (rec?.filePath && changedSet.has(norm(rec.filePath)))
            || (rec?.anchor?.filePath && changedSet.has(norm(rec.anchor.filePath)))
            || (rec?.meta?.routeDeclFile && changedSet.has(norm(rec.meta.routeDeclFile)));
        if (!inChanged) continue;
        if (!rec.method || !rec.route) continue;
        const pack = getEntryPointPack(snapshot, rec.method, rec.route, {
            workspaceFileContent: working,
            baselineFileContent: baseline,
            lean: true,
        });
        if (pack) entryPacks.push(pack);
    }

    const dependents = buildDependentsForFiles(store as unknown as DependencyStoreLike, [...changedSet]);

    return {
        instructions: buildReviewSystemPrompt(guidelines),
        guidelines,
        changedFiles: [...changedSet],
        fileDiffs,
        entryPacks,
        dependents,
    };
}
